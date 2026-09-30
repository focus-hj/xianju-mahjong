/**
 * game.js — 仙居麻将 对局状态机（人机对战）
 *
 * 座位：1东(玩家) 2南 3西 4北，行牌方向 1→2→3→4→1（逆时针）
 * 上家 = ((seat+2)%4)+1（给 seat 喂牌的玩家）
 *
 * 流程：
 *  start() → 洗牌/发牌/定庄/翻财神/补花 → 逐回合：
 *   [当前家] 摸牌 → 若花循环补花 → 可自摸胡 / 暗杠 → 打牌
 *   [其他家] 可 吃(仅上家)/碰/杠/胡(点炮) → 逆时针近者优先
 * 结算：自摸三家各付(台数)；点炮者付(台数×2)；封顶可配
 */
(function () {


const T = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
  ? require('./tiles')
  : (window.Tiles || window.tiles);
const R = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
  ? require('./rules')
  : (window.Rules || window.rules);
const AI = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
  ? require('./ai')
  : (window.AI || window.ai);

const SEATS = [1, 2, 3, 4];
// 黄牌：牌墙剩 8 对（16 张）即流局（官方台州规则）；生牌阶段：剩 15 对（30 张）
const WALL_RESERVE = 16;
const SHENG_STAGE = 30;

class Game {
  /**
   * @param {Object} opts {
   *   humanSeat: 1（玩家固定东），
   *   bottom: 底分（默认1），
   *   cap: 封顶台数（默认0=不封顶），
   *   onUpdate: (snapshot)=>void，每步更新回调,
   *   thinkDelayMs: (seat, kind:'discard'|'claim')=>ms 人机行动延迟（默认 0=立即，测试用）,
   *   humanTimeoutMs: 人类出牌倒计时（默认 0=不限时；>0 时超时随机打出一张）,
   * }
   */
  constructor(opts = {}) {
    this.humanSeat = opts.humanSeat || 1;
    this.bottom = opts.bottom || 1;
    this.cap = opts.cap || 0;
    this.onUpdate = opts.onUpdate || (() => {});
    this.thinkDelayMs = typeof opts.thinkDelayMs === 'function' ? opts.thinkDelayMs : (() => 0);
    this.humanTimeoutMs = opts.humanTimeoutMs || 0;
    this.thinkTimer = null;
    this.thinkInfo = null;
    this.log = [];
    this.reset();
  }

  reset() {
    this.clearThink();
    this.players = SEATS.map(seat => ({
      seat,
      hand: [],        // 手牌（花牌摊开后仍从手牌移出）
      melds: [],       // {type:'chi'|'peng'|'gang'|'bugang', tile, tiles?, isAn?}
      flowers: [],     // 摸到的花牌（摊开放自己面前）
      isHuman: seat === this.humanSeat,
      huInfo: null,    // 胡牌记录
      score: 0,        // 本局得分
      gangKai: false,
      chiBanTile: null, // 吃张当巡禁打同张（吃进来的那张牌面，打出其他牌后解除）
    }));
    this.deck = [];
    this.discards = [];       // {seat, tile}
    this.godTiles = [];
    // 庄家：若有预设轮庄值沿用（nextRound 设置）；否则默认玩家先做庄
    if (this._nextZhuang) { this.zhuangSeat = this._nextZhuang; this._nextZhuang = 0; }
    else { this.zhuangSeat = this.humanSeat; }
    this.dice = 0;
    this.currentSeat = 0;
    this.phase = 'idle';      // idle|draw|discard|claim|over
    this.lastDiscard = null;  // {seat, tile}
    this.pendingClaims = [];  // 当前可声明集合
    this.wallLeft = 0;
    this.turnCount = 0;
    this.roundInfo = null;    // 结算信息
    this.winnerSeat = 0;
    this.drawGame = false;
    this.needChiChoice = null; // 待玩家选择吃法
    this.autoPassTimer = null;
    this.gangKaiSeat = 0;      // 刚杠完的座位（杠后补牌标记）
    this.lastDrawn = null;     // 刚摸上来的牌 {seat, tile}（UI 圈示用），打出后清空
    this.huPayerSeat = 0;      // 点炮者座位（结算用）
    this.huChengBao = [];      // 承包触发原因列表（空=普通点炮付2×，非空=承包付3×）
    this.passLock = {};        // 同巡限制：seat → [{action:'hu'|'peng', tile}]，动牌后解除
    this.playedTypes = new Set(); // 本局所有被打过的牌面（含被吃碰杠消费的），生牌判定用
    this.lastDiscardWasSheng = false; // 上一张打出牌在打出前是否为生牌
    this.shengStage = false;   // 是否已进入生牌阶段（剩15对）
    this.selfHu = null;        // 玩家自摸待确认 {tianhu?, gangKai?}（胡牌由玩家点「胡」决定，不自动胡）
  }

  /** 记录日志 */
  pushLog(msg) {
    this.log.push({ turn: this.turnCount, msg });
    // console.log('[game]', msg);
  }

  /** 清空待执行的人机思考计时器（重新开局/销毁时调用） */
  clearThink() {
    if (this.thinkTimer) { clearTimeout(this.thinkTimer); this.thinkTimer = null; }
    this.thinkInfo = null;
  }

  /** 销毁：防止旧对局的延迟回调污染新对局 */
  destroy() { this.clearThink(); this.onUpdate = () => {}; }

  /**
   * 行动延迟调度：
   * - kind='discard'（出牌）：统一 20s 倒计时窗口（until = 开始+20s），
   *   fn 在窗口内随机时刻触发（ms 由 thinkDelayMs 给）→ 倒计时 20~1s 之间随机出牌
   * - kind='claim'（声明）：短思考，倒计时即实际时长
   * thinkInfo={seat,kind,startedAt,until} 随快照给 UI 显示倒计时
   */
  _scheduleThink(seat, kind, fn) {
    if (this.thinkTimer) return; // 已有待执行的行动调度（嵌套 autoRun 帧重复触发），忽略重复调度
    const ms = Math.max(0, Math.round(Number(this.thinkDelayMs(seat, kind)) || 0));
    if (ms <= 0) { fn(); return; }
    const now = Date.now();
    const budget = (kind === 'discard') ? 20000 : ms;
    this.thinkInfo = { seat, kind, startedAt: now, until: now + budget };
    this.emit();
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null;
      this.thinkInfo = null;
      fn();
    }, ms);
  }

  /** 人类出牌倒计时：humanTimeoutMs 内未出牌 → 随机打出一张（优先非财神） */
  _scheduleHumanDiscardTimer() {
    if (!this.humanTimeoutMs) return;
    if (this.thinkTimer) return; // 防重复调度（嵌套 autoRun 帧）
    const now = Date.now();
    this.thinkInfo = { seat: this.humanSeat, kind: 'discard', startedAt: now, until: now + this.humanTimeoutMs };
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null;
      this.thinkInfo = null;
      if (this.phase !== 'waitHumanDiscard') return;
      const p = this.getPlayer(this.humanSeat);
      const idx = Math.floor(Math.random() * p.hand.length);
      this.pushLog('超时未出牌，随机打出 ' + T.tileToString(p.hand[idx]));
      this.humanDiscard(idx);
    }, this.humanTimeoutMs);
  }

  /** 玩家声明（吃/碰/杠/胡/过）倒计时：超时自动「过」 */
  _scheduleHumanClaimTimer() {
    if (!this.humanTimeoutMs) return;
    if (this.thinkTimer) return;
    const now = Date.now();
    this.thinkInfo = { seat: this.humanSeat, kind: 'claim', startedAt: now, until: now + this.humanTimeoutMs };
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null;
      this.thinkInfo = null;
      if (this.phase === 'waitHumanClaim') {
        this.pushLog('超时未决定，自动过');
        this.humanClaim('pass');
      } else if (this.phase === 'waitHumanChi') {
        this.pushLog('超时未选择吃法，自动过');
        this.needChiChoice = null;
        this.pendingClaims = this.pendingClaims.filter(c => c.seat !== this.humanSeat);
        this.claimsPassedCheck();
      }
    }, this.humanTimeoutMs);
  }

  /** 生成快照给 UI */
  snapshot() {
    return {
      players: this.players.map(p => ({
        seat: p.seat,
        isHuman: p.isHuman,
        handCount: p.hand.length,
        hand: p.isHuman ? p.hand.slice() : null,
        melds: p.melds.map(m => Object.assign({}, m)),
        flowers: p.flowers.map(f => Object.assign({}, f)),
        isDealer: p.seat === this.zhuangSeat,
        score: p.score,
        huInfo: p.huInfo,
      })),
      discards: this.discards.map(d => Object.assign({}, d)),
      godTiles: this.godTiles.map(g => Object.assign({}, g)),
      zhuangSeat: this.zhuangSeat,
      dice: this.dice,
      currentSeat: this.currentSeat,
      phase: this.phase,
      lastDiscard: this.lastDiscard ? Object.assign({}, this.lastDiscard) : null,
      wallLeft: this.deck.length,
      winnerSeat: this.winnerSeat,
      drawGame: this.drawGame,
      roundInfo: this.roundInfo,
      pendingClaims: this.pendingClaims.map(c => Object.assign({}, c)),
      needChiChoice: this.needChiChoice,
      turnCount: this.turnCount,
      log: this.log.slice(-6),
      // 人机思考倒计时（无则为 null）
      thinking: this.thinkInfo ? { seat: this.thinkInfo.seat, kind: this.thinkInfo.kind, startedAt: this.thinkInfo.startedAt, until: this.thinkInfo.until } : null,
      // 刚摸上来的牌（仅用于 UI 圈示；打出后为 null）
      lastDrawn: this.lastDrawn ? { seat: this.lastDrawn.seat, tile: this.lastDrawn.tile } : null,
      // 玩家自摸待确认（亮「胡」按钮由玩家决定）
      selfHu: !!this.selfHu,
    };
  }

  /** 通知 UI */
  emit() { this.onUpdate(this.snapshot()); }

  /* ============ 开局 ============ */

  start() {
    this.reset();
    // 洗牌
    this.deck = T.shuffle(T.createDeck(true));
    // 掷骰 + 翻财神
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    this.dice = d1 + d2;
    // 翻牌财神：从牌墙尾部取一张亮出（不放回），财神=风头4张+该牌型剩余3张=7张
    const flipped = this.deck.pop();
    this.godTiles = R.buildGodTiles(this.zhuangSeat, this.dice, flipped);
    this.pushLog('掷骰 ' + this.dice + '，财神：' + T.tileToString({ suit: 'feng', num: R.diceToSeat(this.dice) }) + ' + ' + T.tileToString(flipped) + '（翻牌）');

    // 发牌：庄14，闲13
    for (const seat of SEATS) {
      const n = seat === this.zhuangSeat ? 14 : 13;
      const p = this.getPlayer(seat);
      for (let i = 0; i < n; i++) p.hand.push(this.deck.pop());
    }
    // 全场补花（循环）
    for (const seat of SEATS) this.buHua(seat, true);
    // 庄家天胡检测（AI 自动胡；玩家亮「胡」按钮自行决定）
    const zhuang = this.getPlayer(this.zhuangSeat);
    if (R.canWin(zhuang.hand, this.godTiles, { seat: this.zhuangSeat, melds: zhuang.melds })) {
      if (zhuang.isHuman) {
        this.selfHu = { tianhu: true };
      } else {
        this.pushLog('庄家天胡！');
        return this.finish(zhuang.seat, 'tianhu', zhuang.hand.slice(), null, true);
      }
    }
    this.currentSeat = this.zhuangSeat;
    this.phase = 'discard';
    this.pushLog('开局：庄家 ' + this.seatName(this.zhuangSeat) + ' 请打牌');
    this.emit();
    this.autoRun();
  }

  getPlayer(seat) { return this.players.find(p => p.seat === seat); }
  seatName(seat) { return T.FENG_NAMES[seat - 1] + '家'; }

  /** 补花：手中有花牌则摊开并补牌（循环） */
  buHua(seat, isStart = false) {
    const p = this.getPlayer(seat);
    let count = 0;
    while (true) {
      const fi = p.hand.findIndex(t => t.suit === 'flower');
      if (fi < 0) break;
      const flower = p.hand.splice(fi, 1)[0];
      p.flowers.push(flower);
      count++;
      if (this.deck.length <= WALL_RESERVE) break; // 牌墙保留 8 对（黄牌线），不再补
      p.hand.push(this.deck.pop()); // 从尾部补牌
      if (!isStart) this.lastDrawn = { seat, tile: p.hand[p.hand.length - 1] }; // 补进的牌也圈示
    }
    if (count > 0) {
      this.pushLog(this.seatName(seat) + ' 补花 ' + count + ' 张');
    }
    return count;
  }

  /* ============ 回合推进 ============ */

  /** 自动运行：非玩家回合或无需玩家决策时持续推进（AI 行动经思考延迟调度） */
  autoRun() {
    if (this.thinkTimer) return; // 有 AI 正在思考，等计时器回调
    while (this.phase !== 'over' && this.phase !== 'waitHumanDiscard' && this.phase !== 'waitHumanClaim' && this.phase !== 'waitHumanChi') {
      const before = this.phase;
      if (this.phase === 'discard') {
        const seat = this.currentSeat;
        const p = this.getPlayer(seat);
        if (p.isHuman) {
          this.phase = 'waitHumanDiscard';
          this._scheduleHumanDiscardTimer(); // 人类出牌倒计时（超时随机打出）
          this.emit();
          break;
        } else {
          // AI 打牌：随机思考倒计时（延迟 0 时同步执行，保持测试即时性）
          this._scheduleThink(seat, 'discard', () => this.aiDiscard(seat));
          return;
        }
      } else if (this.phase === 'draw') {
        this.doDraw(this.currentSeat);
      } else if (this.phase === 'claim') {
        this.processClaims();
        if (this.thinkTimer) return; // AI 声明进入思考
      } else {
        break;
      }
      if (this.phase === before) break; // 防死循环
    }
  }

  /** 摸牌（当前家） */
  doDraw(seat) {
    if (this.deck.length <= WALL_RESERVE) { this.drawGame = true; this.pushLog('牌墙剩 8 对（16 张），黄牌流局'); return this.finish(0, 'draw', null, null, false); }
    delete this.passLock[seat]; // 动牌（摸牌）解除该家同巡限制
    // 进入生牌阶段提示（剩 15 对）
    if (!this.shengStage && this.deck.length <= SHENG_STAGE) {
      this.shengStage = true;
      this.pushLog('⚠️ 进入生牌阶段（剩 15 对）：打生牌被胡将承包');
    }
    const p = this.getPlayer(seat);
    const tile = this.deck.pop();
    p.hand.push(tile);
    this.lastDrawn = { seat, tile }; // 记录刚摸上来的牌（若补花，buHua 会覆盖为补进的最后一张）
    p.gangKai = this.gangKaiSeat === seat; // 杠后摸的牌标记
    this.pushLog(this.seatName(seat) + ' 摸牌 ' + (p.isHuman ? T.tileToString(tile) : ''));
    // 补花
    if (tile.suit === 'flower') {
      // 摸到花牌：摊开并从牌墙尾部补牌（buHua 内部处理循环补花）
      this.buHua(seat);
      this.pushLog(this.seatName(seat) + ' 摸到花牌补花');
      // 补花后手牌数量回到 13（若补到花则继续补），重新检测自摸/暗杠
      if (this.deck.length <= WALL_RESERVE) { this.drawGame = true; this.pushLog('牌墙剩 8 对（16 张），黄牌流局'); return this.finish(0, 'draw', null, null, false); }
      if (this._checkSelfHu(seat, false)) return;
      this.phase = 'discard';
      this.emit();
      this.autoRun();
      return;
    }
    // 自摸胡检测（AI 自动胡；玩家亮「胡」按钮）
    if (this._checkSelfHu(seat, false)) return;
    // 暗杠检测（玩家可决策，AI 自动）
    this.phase = 'discard';
    this.emit();
    this.autoRun();
  }

  /** AI 打牌 */
  aiDiscard(seat) {
    const p = this.getPlayer(seat);
    // 财神碰/双夹的副露里若压着财神，且手里摸到了对应真牌 → 抽回财神（永远划算）
    this.swapGod(seat);
    // 暗杠决策
    const anGang = R.canGang(p.hand, null, this.godTiles);
    if (anGang && AI.wantGang(p.hand, { ...anGang.tile, isDiscard: false }, this.godTiles, { seat })) {
      this.doAnGang(seat, anGang.tile);
      return;
    }
    const decision = AI.chooseDiscard(p.hand, this.godTiles, { seat, melds: p.melds });
    if (!decision) return;
    let idx = decision.index;
    // 吃张当巡禁打同张：AI 选中禁打牌时改打第一张可打的
    if (p.chiBanTile && T.sameTile(p.hand[idx], p.chiBanTile)) {
      idx = p.hand.findIndex(t => !T.sameTile(t, p.chiBanTile));
      if (idx < 0) idx = 0;
    }
    this.doDiscard(seat, idx);
  }

  /* ============ 财神抽回（财神碰/双夹后，摸到真牌可换回） ============ */

  /** 检查是否有可抽回财神的副露：副露为碰、曾用财神、且手牌有该牌真牌 */
  canSwapGod(seat) {
    const p = this.getPlayer(seat);
    return p.melds.some(m =>
      m.type === 'peng' && (m.godTilesUsed || []).length > 0 && T.countInHand(p.hand, m.tile) >= 1
    );
  }

  /** 抽回财神：手牌移除 1 张对应真牌入副露，副露中 1 张财神回到手牌 */
  swapGod(seat) {
    const p = this.getPlayer(seat);
    const m = p.melds.find(m =>
      m.type === 'peng' && (m.godTilesUsed || []).length > 0 && T.countInHand(p.hand, m.tile) >= 1
    );
    if (!m) return false;
    const idx = p.hand.findIndex(x => T.sameTile(x, m.tile));
    if (idx < 0) return false;
    p.hand.splice(idx, 1);                    // 真牌补进副露
    const godBack = m.godTilesUsed.pop();     // 财神抽回手牌
    p.hand.push(godBack);
    this.pushLog(this.seatName(seat) + ' 用 ' + T.tileToString(m.tile) + ' 换回财神 ' + T.tileToString(godBack));
    this.emit();
    return true;
  }

  /* ============ 自摸胡检测（玩家点按钮制） ============ */

  /**
   * 自摸检测：AI 自动胡；玩家只亮「胡」按钮（selfHu 挂起），由玩家决定要不要胡
   * @returns true=已处理（胡或挂起）
   */
  _checkSelfHu(seat, gangKai = false) {
    const p = this.getPlayer(seat);
    const win = R.canWin(p.hand, this.godTiles, { seat, melds: p.melds });
    if (p.isHuman) {
      // 始终刷新自摸挂起状态（能胡则亮按钮，不能胡则清除）
      this.selfHu = win ? Object.assign(this.selfHu || {}, { gangKai }) : null;
      if (win) {
        this.phase = 'waitHumanDiscard';
        this.emit();
        return true;
      }
      return false;
    }
    if (!win) return false;
    this.pushLog(this.seatName(seat) + (gangKai ? ' 杠上开花自摸！' : ' 自摸胡！'));
    this.finish(seat, 'self', p.hand.slice(), null, false, gangKai);
    return true;
  }

  /** 玩家确认自摸胡（点「胡」按钮）；也可以放弃按钮改打牌 */
  humanSelfHu() {
    if (this.phase !== 'waitHumanDiscard' || !this.selfHu) return;
    this.clearThink();
    const p = this.getPlayer(this.humanSeat);
    const opts = this.selfHu;
    this.selfHu = null;
    this.pushLog('你 自摸胡！');
    this.finish(this.humanSeat, 'self', p.hand.slice(), null, !!opts.tianhu, !!opts.gangKai);
  }

  /** 执行打牌（返回 false=未打出，如吃张当巡禁打同张） */
  doDiscard(seat, index) {
    const p = this.getPlayer(seat);
    if (index < 0 || index >= p.hand.length) return false;
    // 吃张当巡禁打同张：本巡刚吃进的牌面不能打出（大吊除外规则暂不涉及）
    if (p.chiBanTile && T.sameTile(p.hand[index], p.chiBanTile)) {
      this.pushLog('吃张当巡不能打同张（' + T.tileToString(p.chiBanTile) + '）');
      return false;
    }
    p.chiBanTile = null; // 打出即解除
    const tile = p.hand.splice(index, 1)[0];
    // 生牌记录：该牌面打出前是否从未被打过
    const key = tile.suit + '|' + tile.num;
    this.lastDiscardWasSheng = !this.playedTypes.has(key);
    this.playedTypes.add(key);
    this.discards.push({ seat, tile });
    this.lastDiscard = { seat, tile };
    this.lastDrawn = null; // 打出后，"刚摸上来的牌"圈示消失
    p.gangKai = false;
    this.gangKaiSeat = 0;
    this.pushLog(this.seatName(seat) + ' 打出 ' + T.tileToString(tile));
    // 检查其他家声明（吃/碰/杠/胡）
    this.gatherClaims(seat, tile);
    if (this.pendingClaims.length === 0) {
      this.nextTurn(seat);
    } else {
      this.phase = 'claim';
      this.emit();
      this.autoRun();
    }
    return true;
  }

  /** 同巡限制查询：该家本巡是否被锁了对这张牌的 hu/peng */
  _isPassLocked(seat, action, tile) {
    return (this.passLock[seat] || []).some(l => l.action === action && T.sameTile(l.tile, tile));
  }

  /** 同巡限制记录：放弃可胡/可碰 → 本巡内同牌再出现不能胡/碰 */
  _lockPass(seat, action, tile) {
    if (!tile) return;
    const list = this.passLock[seat] || (this.passLock[seat] = []);
    if (!list.some(l => l.action === action && T.sameTile(l.tile, tile))) {
      list.push({ action, tile: Object.assign({}, tile) });
      this.pushLog(this.seatName(seat) + (action === 'hu' ? ' 能胡不胡，本巡锁定 ' : ' 能碰不碰，本巡锁定 ') + T.tileToString(tile));
    }
  }

  /** 收集声明：逆时针（seat+1 开始）依次检查胡/碰/杠/吃 */
  gatherClaims(discardSeat, tile) {
    this.pendingClaims = [];
    // 财神打出入河为废：不能被吃/碰/杠/胡
    if (R.isGod(tile, this.godTiles)) return;
    const order = [];
    for (let i = 1; i <= 3; i++) order.push(((discardSeat + i - 1) % 4) + 1);
    // 胡牌优先收集（截胡规则：逆时针近者优先）
    const winClaims = [];
    for (const seat of order) {
      const p = this.getPlayer(seat);
      if (p.huInfo) continue;
      if (this._isPassLocked(seat, 'hu', tile)) continue; // 同巡能胡不胡限制
      if (R.canWin(p.hand.concat([tile]), this.godTiles, { seat, melds: p.melds })) {
        winClaims.push({ seat, action: 'hu', priority: order.indexOf(seat) });
      }
    }
    // 非胡声明
    const otherClaims = [];
    for (const seat of order) {
      const p = this.getPlayer(seat);
      if (p.huInfo) continue;
      if (winClaims.some(c => c.seat === seat)) continue;
      // 已有 4 个面子 → 只能胡，不能再吃碰杠
      if (p.melds.length >= 4) continue;
      const peng = this._isPassLocked(seat, 'peng', tile) ? null : R.canPeng(p.hand, tile, this.godTiles); // 同巡能碰不碰限制
      const gang = R.canGang(p.hand, tile, this.godTiles);
      const chi = R.canChi(p.hand, tile, seat, discardSeat);
      const list = [];
      if (peng) list.push({ seat, action: 'peng', type: peng.type });
      if (gang) list.push({ seat, action: 'gang', type: gang.type });
      if (chi.length > 0) list.push({ seat, action: 'chi', variants: chi.length });
      for (const c of list) otherClaims.push(c);
    }
    this.pendingClaims = winClaims.concat(otherClaims);
  }

  /** 处理声明（AI 决策先经思考延迟，玩家等待输入） */
  processClaims() {
    if (this.pendingClaims.length === 0) { return; }
    // 防御：如果 lastDiscard 已被消费（某声明已执行），直接清空回到正常流程
    if (!this.lastDiscard) {
      this.pendingClaims = [];
      this.phase = 'draw';
      this.emit();
      this.autoRun();
      return;
    }
    // 找当前轮次最先应该处理的：胡 > 其他；同优先级的胡优先
    const humanClaims = this.pendingClaims.filter(c => this.getPlayer(c.seat).isHuman);
    if (humanClaims.length > 0) {
      this.phase = 'waitHumanClaim';
      this._scheduleHumanClaimTimer(); // 声明决策 20s 倒计时，超时自动过
      this.emit();
      return;
    }
    // AI 声明：随机思考倒计时后再决策（胡牌也会有"长考后胡牌"的张力）
    const first = this.pendingClaims[0];
    this._scheduleThink(first.seat, 'claim', () => this._aiProcessClaims());
  }

  /** AI 声明决策（思考倒计时结束后执行） */
  _aiProcessClaims() {
    for (const claim of this.pendingClaims) {
      const p = this.getPlayer(claim.seat);
      if (claim.action === 'hu') { // 必胡
        this.doHu(claim.seat, this.lastDiscard.tile, 'discard');
        return;
      }
      if (claim.action === 'peng') {
        if (AI.wantClaim('peng', p.hand, this.lastDiscard.tile, this.godTiles, { seat: claim.seat, melds: p.melds, lastDiscardSeat: this.lastDiscard.seat })) {
          this.doPeng(claim.seat, this.lastDiscard.tile);
          return;
        }
        // AI 能碰不碰 → 本巡锁定同牌碰
        this._lockPass(claim.seat, 'peng', this.lastDiscard.tile);
      } else if (claim.action === 'gang') {
        this.doGang(claim.seat, this.lastDiscard.tile);
        return;
      } else if (claim.action === 'chi') {
        if (AI.wantClaim('chi', p.hand, this.lastDiscard.tile, this.godTiles, { seat: claim.seat, melds: p.melds, lastDiscardSeat: this.lastDiscard.seat })) {
          const chis = R.canChi(p.hand, this.lastDiscard.tile, claim.seat, this.lastDiscard.seat);
          this.doChi(claim.seat, this.lastDiscard.tile, chis[0]);
          return;
        }
      }
    }
    // 无人声明 → 过
    this.claimsPassed();
  }

  /** 所有声明被放弃 → 下家摸牌 */
  claimsPassed() {
    this.pendingClaims = [];
    this.lastDiscard = null;
    const nextSeat = ((this.currentSeat) % 4) + 1;
    this.currentSeat = nextSeat;
    this.turnCount++;
    this.phase = 'draw';
    this.emit();
    this.autoRun();
  }

  /** 下家摸牌 */
  nextTurn(discardSeat) {
    this.pendingClaims = [];
    const nextSeat = (discardSeat % 4) + 1;
    this.currentSeat = nextSeat;
    this.turnCount++;
    this.phase = 'draw';
    this.emit();
    this.autoRun();
  }

  /* ============ 声明执行 ============ */

  doPeng(seat, tile) {
    const p = this.getPlayer(seat);
    this.selfHu = null; // 碰后无摸牌，清掉可能残留的自摸挂起
    delete this.passLock[seat]; // 动牌解除同巡限制
    // 从手牌移除2张真牌（或1真1财神/2财神）；用掉的财神记录在副露里，后续摸到真牌可抽回
    const peng = R.canPeng(p.hand, tile, this.godTiles);
    const godTilesUsed = [];
    let removed = 0;
    if (peng.type === 'gold') {
      for (let i = 0; i < p.hand.length && removed < 2; i++) {
        if (T.sameTile(p.hand[i], tile)) { p.hand.splice(i, 1); removed++; i--; }
      }
    } else if (peng.type === 'god') {
      const ti = p.hand.findIndex(x => T.sameTile(x, tile));
      if (ti >= 0) p.hand.splice(ti, 1);
      const gi = p.hand.findIndex(x => R.isGod(x, this.godTiles));
      if (gi >= 0) godTilesUsed.push(p.hand.splice(gi, 1)[0]);
    } else { // double
      for (let i = 0; i < p.hand.length && removed < 2; i++) {
        if (R.isGod(p.hand[i], this.godTiles)) { godTilesUsed.push(p.hand.splice(i, 1)[0]); removed++; i--; }
      }
    }
    p.melds.push({ type: 'peng', tile: Object.assign({}, tile), claimType: peng.type, godTilesUsed, fromSeat: this.lastDiscard ? this.lastDiscard.seat : 0 });
    this.removeDiscard(tile);
    this.pushLog(this.seatName(seat) + ' 碰 ' + T.tileToString(tile) + '（' + (peng.type === 'gold' ? '金碰' : peng.type === 'god' ? '财神碰' : '双夹') + '）');
    this.currentSeat = seat;
    this.phase = 'discard';
    this.emit();
    this.autoRun();
  }

  doChi(seat, tile, chiTiles) {
    const p = this.getPlayer(seat);
    this.selfHu = null; // 吃后无摸牌，清掉可能残留的自摸挂起
    delete this.passLock[seat]; // 动牌解除同巡限制
    p.chiBanTile = Object.assign({}, tile); // 吃张当巡禁打同张
    // 从手牌移除顺子中非打出牌的两张
    const need = chiTiles.filter(t => !T.sameTile(t, tile));
    for (const nt of need) {
      const idx = p.hand.findIndex(x => T.sameTile(x, nt));
      if (idx >= 0) p.hand.splice(idx, 1);
    }
    p.melds.push({ type: 'chi', tile: Object.assign({}, tile), tiles: chiTiles.map(t => Object.assign({}, t)), fromSeat: this.lastDiscard ? this.lastDiscard.seat : 0 });
    this.removeDiscard(tile);
    this.pushLog(this.seatName(seat) + ' 吃 ' + chiTiles.map(T.tileToString).join(''));
    this.currentSeat = seat;
    this.phase = 'discard';
    this.emit();
    this.autoRun();
  }

  doGang(seat, tile) {
    // 明杠：手牌3张 + 打出1张
    const p = this.getPlayer(seat);
    delete this.passLock[seat]; // 动牌解除同巡限制
    let removed = 0;
    for (let i = 0; i < p.hand.length && removed < 3; i++) {
      if (T.sameTile(p.hand[i], tile)) { p.hand.splice(i, 1); removed++; i--; }
    }
    p.melds.push({ type: 'gang', tile: Object.assign({}, tile), isAn: false, fromSeat: this.lastDiscard ? this.lastDiscard.seat : 0 });
    this.removeDiscard(tile);
    this.gangKaiSeat = seat;
    this.pushLog(this.seatName(seat) + ' 明杠 ' + T.tileToString(tile));
    this.afterGang(seat);
  }

  doAnGang(seat, tile) {
    const p = this.getPlayer(seat);
    delete this.passLock[seat]; // 动牌解除同巡限制
    let removed = 0;
    for (let i = 0; i < p.hand.length && removed < 4; i++) {
      if (T.sameTile(p.hand[i], tile)) { p.hand.splice(i, 1); removed++; i--; }
    }
    p.melds.push({ type: 'gang', tile: Object.assign({}, tile), isAn: true, fromSeat: 0 });
    this.gangKaiSeat = seat;
    this.pushLog(this.seatName(seat) + ' 暗杠 ' + T.tileToString(tile));
    this.afterGang(seat);
  }

  /** 杠后补牌（从牌墙尾部），补花循环；自摸胡检测 */
  afterGang(seat) {
    const p = this.getPlayer(seat);
    this.pendingClaims = []; // 杠已执行，清空所有残留声明
    if (this.deck.length <= WALL_RESERVE) { this.drawGame = true; this.pushLog('牌墙剩 8 对（16 张），黄牌流局'); return this.finish(0, 'draw', null, null, false); }
    const tile = this.deck.pop();
    p.hand.push(tile);
    this.lastDrawn = { seat, tile }; // 杠后补的牌也圈示（若补花，buHua 覆盖为最后一张）
    p.gangKai = true;
    this.pushLog(this.seatName(seat) + ' 杠后补牌');
    if (tile.suit === 'flower') {
      this.buHua(seat);
      this.pushLog(this.seatName(seat) + ' 补花');
      if (this.deck.length <= WALL_RESERVE) { this.drawGame = true; this.pushLog('牌墙剩 8 对（16 张），黄牌流局'); return this.finish(0, 'draw', null, null, false); }
      // 补花后回到打牌回合（补花补进的牌也可能自摸）
      if (this._checkSelfHu(seat, true)) return;
      this.phase = 'discard';
      this.emit(); this.autoRun();
      return;
    }
    // 杠上开花
    if (this._checkSelfHu(seat, true)) return;
    this.phase = 'discard';
    this.emit();
    this.autoRun();
  }

  /**
   * 承包（包牌）检测 —— 点炮胡时调用，返回触发原因数组（空=普通点炮）。
   * 仙居规则三触发条件：
   *  ① 硬家承包：点炮者自己没听牌，打出中发白被胡
   *  ② 清一色承包：赢家副露≥3摊同花色（万/筒/条），点炮者打同花色让其清一色胡
   *  ③ 连碰三摊：赢家≥3个碰/杠类副露全部来自点炮者，再点炮给他
   *  ④ 生牌阶段承包：剩15对（30张）进入生牌阶段后，打出从未有人打过的生牌被胡
   * @param {number} winnerSeat 胡牌者
   * @param {number} discarderSeat 点炮者
   * @param {Object} winTile 所点之牌
   * @param {Array} hand14 赢家胡牌手牌（14张）
   * @returns {string[]} 触发原因（可同时多条）
   */
  checkChengBao(winnerSeat, discarderSeat, winTile, hand14) {
    const reasons = [];
    const winner = this.getPlayer(winnerSeat);
    const discarder = this.getPlayer(discarderSeat);

    // ① 硬家承包：打中发白 + 自己没听牌（以打出后剩余13张判定听牌）
    if (winTile.suit === 'jian') {
      const tenpai = R.isTenpai(discarder.hand, this.godTiles, { seat: discarderSeat, melds: discarder.melds });
      if (!tenpai) reasons.push('硬家承包（没听牌打' + T.tileToString(winTile) + '）');
    }

    // ④ 生牌阶段承包：剩 15 对后打出从未有人打过的生牌被胡
    if (this.deck.length <= SHENG_STAGE && this.lastDiscardWasSheng) {
      reasons.push('生牌阶段打生牌承包');
    }

    // ② 清一色承包：赢家副露≥3摊同一数字花色，且所点牌同花色，且赢家确为清一色
    const suitMeldCount = { wan: 0, tong: 0, tiao: 0 };
    for (const m of winner.melds) {
      const suit = m.type === 'chi'
        ? (m.tiles && m.tiles.length ? m.tiles[0].suit : (m.tile ? m.tile.suit : null))
        : (m.tile ? m.tile.suit : null);
      if (suit && suitMeldCount[suit] !== undefined) suitMeldCount[suit]++;
    }
    const dangerSuit = Object.keys(suitMeldCount).find(s => suitMeldCount[s] >= 3);
    if (dangerSuit && winTile.suit === dangerSuit) {
      // 赢家必须确为清一色（手牌+副露同口径，财神不参与）
      const suits = R.handSuits(hand14, winner.melds, this.godTiles);
      const hasNum = ['wan', 'tong', 'tiao'].some(s => suits.has(s));
      if (suits.size === 1 && hasNum) {
        reasons.push('清一色承包（对方已三摊' + T.SUIT_NAMES[dangerSuit] + '）');
      }
    }

    // ③ 连碰三摊：赢家≥3个碰/杠类副露（吃不算）全部来自点炮者
    const fedCount = winner.melds.filter(m =>
      (m.type === 'peng' || m.type === 'gang' || m.type === 'bugang') && m.fromSeat === discarderSeat
    ).length;
    if (fedCount >= 3) reasons.push('连碰三摊承包');

    return reasons;
  }

  /** 胡牌（extraChengBao：抢杠等场景附加的承包原因） */
  doHu(seat, tile, type, gangKai = false, extraChengBao = null) {
    const p = this.getPlayer(seat);
    const hand14 = type === 'self' ? p.hand.slice() : p.hand.concat([tile]);
    // 记录放炮者（点炮胡结算用）+ 承包检测
    this.huPayerSeat = 0;
    this.huChengBao = [];
    if (type === 'discard' && this.lastDiscard) {
      this.huPayerSeat = this.lastDiscard.seat;
      this.huChengBao = this.checkChengBao(seat, this.lastDiscard.seat, tile, hand14);
      if (extraChengBao) this.huChengBao.push(extraChengBao);
      if (this.huChengBao.length) {
        this.pushLog('💥 ' + this.seatName(this.lastDiscard.seat) + ' 触发' + this.huChengBao.join('、') + '，包三家！');
      }
      this.removeDiscard(tile);
    }
    this.pushLog(this.seatName(seat) + ' 胡牌！');
    this.finish(seat, type, hand14, tile, false, gangKai);
  }

  removeDiscard(tile) {
    const idx = this.discards.findIndex(d => d.seat === this.lastDiscard.seat && T.sameTile(d.tile, tile));
    if (idx >= 0) this.discards.splice(idx, 1);
    this.lastDiscard = null;
  }

  /* ============ 结算 ============ */

  /**
   * finish(winnerSeat, winType, hand14, winTile, tianhu, gangKai)
   */
  finish(winnerSeat, winType, hand14, winTile, tianhu = false, gangKai = false) {
    this.phase = 'over';
    this.winnerSeat = winnerSeat;
    this.roundInfo = null;
    if (winType === 'draw') { this.drawGame = true; this.emit(); return; }

    const winner = this.getPlayer(winnerSeat);
    const melds = winner.melds;
    // 地胡：闲家第一轮摸牌胡
    let dihu = false;
    if (winType === 'self' && winnerSeat !== this.zhuangSeat && this.turnCount <= 1 && melds.length === 0) {
      dihu = true;
    }
    const info = {
      hand: hand14, godTiles: this.godTiles, seat: winnerSeat, zhuangSeat: this.zhuangSeat,
      melds, winType, gangKai: gangKai || winner.gangKai,
      tianhu, dihu, collectedFlowers: winner.flowers,
    };
    const taiRes = R.calcTai(info);
    let tai = taiRes.tai;
    if (this.cap > 0 && tai > this.cap) tai = this.cap;

    // 分差：自摸/天胡三家各付(台数)；点炮者付2倍；触发承包则承包者包三家付3倍
    let scores = { 1: 0, 2: 0, 3: 0, 4: 0 };
    if (winType === 'self' || winType === 'tianhu') {
      // 清一色自摸追包：赢家清一色且 ≥3 摊副露全部来自上家 → 上家承包（包三家）
      this.huPayerSeat = 0; this.huChengBao = [];
      const upper = ((winnerSeat + 2) % 4) + 1; // 上家=座位号递减方向
      const suitsW = R.handSuits(hand14, melds, this.godTiles);
      const hasNumW = ['wan', 'tong', 'tiao'].some(s => suitsW.has(s));
      const fedFromUpper = melds.filter(m => m.fromSeat === upper).length;
      if (suitsW.size === 1 && hasNumW && fedFromUpper >= 3) {
        this.huPayerSeat = upper;
        this.huChengBao = ['清一色自摸追包（上家喂三摊）'];
        this.pushLog('💥 ' + this.seatName(upper) + ' 触发清一色自摸追包，包三家！');
      }
      if (this.huPayerSeat) {
        const pay3 = tai * 3 * this.bottom;
        scores[this.huPayerSeat] -= pay3;
        scores[winnerSeat] += pay3;
      } else {
        for (const s of SEATS) {
          if (s === winnerSeat) continue;
          const pay = tai * this.bottom;
          scores[s] -= pay;
          scores[winnerSeat] += pay;
        }
      }
    } else {
      const payer = this.huPayerSeat || 0;
      if (payer && payer !== winnerSeat) {
        const chengBao = this.huChengBao && this.huChengBao.length > 0;
        const pay = tai * (chengBao ? 3 : 2) * this.bottom;
        scores[payer] -= pay;
        scores[winnerSeat] += pay;
      }
    }
    for (const s of SEATS) this.getPlayer(s).score += scores[s];

    winner.huInfo = {
      winType, tai, details: taiRes.details,
      hand: hand14.map(T.tileToString),
      handRaw: hand14.map(t => ({ suit: t.suit, num: t.num })),
      meldsRaw: melds.map(m => Object.assign({}, m)),
      winTile: winTile ? T.tileToString(winTile) : null,
      tianhu, dihu, gangKai: gangKai || winner.gangKai,
      chengBao: (this.huChengBao || []).slice(),
      payerSeat: this.huPayerSeat || 0,
    };
    this.roundInfo = {
      winnerSeat, winnerName: this.seatName(winnerSeat),
      winType, tai, details: taiRes.details, scores,
      isHumanWin: winnerSeat === this.humanSeat,
      chengBao: (this.huChengBao || []).slice(),
      payerSeat: this.huPayerSeat || 0,
    };
    this.emit();
  }

  /* ============ 玩家交互 ============ */

  /** 玩家摸牌后打牌（选择手牌index；财神也可以打出） */
  humanDiscard(index) {
    if (this.phase !== 'waitHumanDiscard') return;
    this.clearThink(); // 打出即取消本回合倒计时
    this.selfHu = null; // 选择打牌即放弃本次自摸
    const p = this.getPlayer(this.humanSeat);
    if (index < 0 || index >= p.hand.length) return;
    this.doDiscard(this.humanSeat, index);
  }

  /** 玩家声明决策 */
  humanClaim(action) {
    if (this.phase !== 'waitHumanClaim') return;
    this.clearThink(); // 玩家已决定，取消声明倒计时
    const myClaim = this.pendingClaims.find(c => c.seat === this.humanSeat);
    if (!myClaim) return;
    if (action === 'hu') {
      this.doHu(this.humanSeat, this.lastDiscard.tile, 'discard');
    } else if (action === 'peng') {
      this.doPeng(this.humanSeat, this.lastDiscard.tile);
    } else if (action === 'gang') {
      this.doGang(this.humanSeat, this.lastDiscard.tile);
    } else if (action === 'chi') {
      const chis = R.canChi(this.getPlayer(this.humanSeat).hand, this.lastDiscard.tile, this.humanSeat, this.lastDiscard.seat);
      if (chis.length > 0) {
        this.needChiChoice = chis;
        this.phase = 'waitHumanChi';
        this._scheduleHumanClaimTimer(); // 吃法选择同样 20s 倒计时
        this.emit();
      } else {
        // 无有效吃法 → 按过处理
        this.pendingClaims = this.pendingClaims.filter(c => c.seat !== this.humanSeat);
        this.claimsPassedCheck();
      }
    } else if (action === 'pass') {
      // 能胡不胡/能碰不碰：记录本巡锁定（超时自动过同样生效）
      const tile = this.lastDiscard ? this.lastDiscard.tile : null;
      for (const c of this.pendingClaims.filter(c => c.seat === this.humanSeat)) {
        if (c.action === 'hu' || c.action === 'peng') this._lockPass(this.humanSeat, c.action, tile);
      }
      this.pendingClaims = this.pendingClaims.filter(c => c.seat !== this.humanSeat);
      this.claimsPassedCheck();
    }
  }

  /** 玩家选择吃法 */
  humanChiVariant(v) {
    if (this.phase !== 'waitHumanChi' || !this.needChiChoice) return;
    this.clearThink();
    const chis = this.needChiChoice;
    this.needChiChoice = null;
    this.doChi(this.humanSeat, this.lastDiscard.tile, chis[v]);
  }

  /** 玩家放弃所有声明 */
  claimsPassedCheck() {
    if (this.pendingClaims.length === 0) {
      this.claimsPassed();
    } else {
      // 还有AI声明则让AI处理
      this.phase = 'claim';
      this.emit();
      this.autoRun();
    }
  }

  /** 玩家暗杠 */
  humanAnGang() {
    if (this.phase !== 'waitHumanDiscard') return;
    this.clearThink(); // 消耗本回合（杠后重新进入出牌倒计时）
    const p = this.getPlayer(this.humanSeat);
    const anGang = R.canGang(p.hand, null, this.godTiles);
    if (anGang) {
      this.doAnGang(this.humanSeat, anGang.tile);
    }
  }

  /** 玩家补杠（补杠牌可能被抢杠胡：被抢则补杠者承包包三家） */
  humanBuGang() {
    if (this.phase !== 'waitHumanDiscard') return;
    this.clearThink(); // 消耗本回合（杠后重新进入出牌倒计时）
    delete this.passLock[this.humanSeat]; // 动牌解除同巡限制
    const p = this.getPlayer(this.humanSeat);
    // 找手牌中能与碰牌组成补杠的牌
    for (const m of p.melds) {
      if (m.type === 'peng' && T.countInHand(p.hand, m.tile) >= 1) {
        // 抢杠检测：逆时针近者优先，任意其他家能胡这张补杠牌 → 抢杠胡，补杠者承包
        for (let i = 1; i <= 3; i++) {
          const s = ((this.humanSeat + i - 1) % 4) + 1;
          const op = this.getPlayer(s);
          if (op.huInfo) continue;
          if (R.canWin(op.hand.concat([m.tile]), this.godTiles, { seat: s, melds: op.melds })) {
            const ri = p.hand.findIndex(x => T.sameTile(x, m.tile));
            p.hand.splice(ri, 1); // 补杠牌被抢走，作为赢家胡牌张
            this.pushLog('💥 ' + this.seatName(s) + ' 抢杠胡！' + this.seatName(this.humanSeat) + ' 补杠 ' + T.tileToString(m.tile) + ' 被抢');
            this.lastDiscard = { seat: this.humanSeat, tile: Object.assign({}, m.tile) };
            this.doHu(s, m.tile, 'discard', false, '被抢杠承包');
            return;
          }
        }
        const idx = p.hand.findIndex(x => T.sameTile(x, m.tile));
        p.hand.splice(idx, 1);
        p.melds = p.melds.map(x => x === m ? { type: 'bugang', tile: m.tile, fromSeat: m.fromSeat } : x);
        this.gangKaiSeat = this.humanSeat;
        this.pushLog(this.seatName(this.humanSeat) + ' 补杠 ' + T.tileToString(m.tile));
        this.afterGang(this.humanSeat);
        return;
      }
    }
  }

  /** 下一局（庄家胡牌连庄；闲家胡或黄牌流局则下庄） */
  nextRound() {
    const prev = this.zhuangSeat || this.humanSeat;
    this._nextZhuang = (this.winnerSeat && this.winnerSeat === prev) ? prev : (prev % 4) + 1;
    for (const p of this.players) { p.score = 0; p.huInfo = null; }
    this.start();
  }
}

// Node / 浏览器双端
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Game, SEATS };
} else {
  window.Game = Game;
}
})();
