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
      // 超时随机打出一张（财神也可能被打出）
      const idx = Math.floor(Math.random() * p.hand.length);
      this.pushLog('超时未出牌，随机打出 ' + T.tileToString(p.hand[idx]));
      this.humanDiscard(idx);
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
    // 庄家天胡检测
    const zhuang = this.getPlayer(this.zhuangSeat);
    if (R.canWin(zhuang.hand, this.godTiles, { seat: this.zhuangSeat, melds: zhuang.melds })) {
      this.pushLog('庄家天胡！');
      return this.finish(zhuang.seat, 'tianhu', zhuang.hand.slice(), null, true);
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
      if (this.deck.length === 0) break;
      p.hand.push(this.deck.pop()); // 从尾部补牌
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
    if (this.deck.length === 0) { this.drawGame = true; this.pushLog('牌墙摸完，流局'); return this.finish(0, 'draw', null, null, false); }
    const p = this.getPlayer(seat);
    const tile = this.deck.pop();
    p.hand.push(tile);
    p.gangKai = this.gangKaiSeat === seat; // 杠后摸的牌标记
    this.pushLog(this.seatName(seat) + ' 摸牌 ' + (p.isHuman ? T.tileToString(tile) : ''));
    // 补花
    if (tile.suit === 'flower') {
      // 摸到花牌：摊开并从牌墙尾部补牌（buHua 内部处理循环补花）
      this.buHua(seat);
      this.pushLog(this.seatName(seat) + ' 摸到花牌补花');
      // 补花后手牌数量回到 13（若补到花则继续补），重新检测自摸/暗杠
      if (this.deck.length === 0) { this.drawGame = true; return this.finish(0, 'draw', null, null, false); }
      if (R.canWin(p.hand, this.godTiles, { seat, melds: p.melds })) {
        this.pushLog(this.seatName(seat) + ' 补花后自摸胡！');
        return this.finish(seat, 'self', p.hand.slice(), null, false);
      }
      this.phase = 'discard';
      this.emit();
      this.autoRun();
      return;
    }
    // 自摸胡检测
    if (R.canWin(p.hand, this.godTiles, { seat, melds: p.melds })) {
      this.pushLog(this.seatName(seat) + ' 自摸胡！');
      return this.finish(seat, 'self', p.hand.slice(), null, false);
    }
    // 暗杠检测（玩家可决策，AI 自动）
    this.phase = 'discard';
    this.emit();
    this.autoRun();
  }

  /** AI 打牌 */
  aiDiscard(seat) {
    const p = this.getPlayer(seat);
    // 暗杠决策
    const anGang = R.canGang(p.hand, null, this.godTiles);
    if (anGang && AI.wantGang(p.hand, { ...anGang.tile, isDiscard: false }, this.godTiles, { seat })) {
      this.doAnGang(seat, anGang.tile);
      return;
    }
    const decision = AI.chooseDiscard(p.hand, this.godTiles, { seat, melds: p.melds });
    if (!decision) return;
    this.doDiscard(seat, decision.index);
  }

  /** 执行打牌 */
  doDiscard(seat, index) {
    const p = this.getPlayer(seat);
    if (index < 0 || index >= p.hand.length) return;
    const tile = p.hand.splice(index, 1)[0];
    this.discards.push({ seat, tile });
    this.lastDiscard = { seat, tile };
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
      const peng = R.canPeng(p.hand, tile, this.godTiles);
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
    // 从手牌移除2张真牌（或1真1财神/2财神）
    const peng = R.canPeng(p.hand, tile, this.godTiles);
    let removed = 0;
    if (peng.type === 'gold') {
      for (let i = 0; i < p.hand.length && removed < 2; i++) {
        if (T.sameTile(p.hand[i], tile)) { p.hand.splice(i, 1); removed++; i--; }
      }
    } else if (peng.type === 'god') {
      const ti = p.hand.findIndex(x => T.sameTile(x, tile));
      if (ti >= 0) p.hand.splice(ti, 1);
      const gi = p.hand.findIndex(x => R.isGod(x, this.godTiles));
      if (gi >= 0) p.hand.splice(gi, 1);
    } else { // double
      for (let i = 0; i < p.hand.length && removed < 2; i++) {
        if (R.isGod(p.hand[i], this.godTiles)) { p.hand.splice(i, 1); removed++; i--; }
      }
    }
    p.melds.push({ type: 'peng', tile: Object.assign({}, tile), claimType: peng.type });
    this.removeDiscard(tile);
    this.pushLog(this.seatName(seat) + ' 碰 ' + T.tileToString(tile) + '（' + (peng.type === 'gold' ? '金碰' : peng.type === 'god' ? '财神碰' : '双夹') + '）');
    this.currentSeat = seat;
    this.phase = 'discard';
    this.emit();
    this.autoRun();
  }

  doChi(seat, tile, chiTiles) {
    const p = this.getPlayer(seat);
    // 从手牌移除顺子中非打出牌的两张
    const need = chiTiles.filter(t => !T.sameTile(t, tile));
    for (const nt of need) {
      const idx = p.hand.findIndex(x => T.sameTile(x, nt));
      if (idx >= 0) p.hand.splice(idx, 1);
    }
    p.melds.push({ type: 'chi', tile: Object.assign({}, tile), tiles: chiTiles.map(t => Object.assign({}, t)) });
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
    let removed = 0;
    for (let i = 0; i < p.hand.length && removed < 3; i++) {
      if (T.sameTile(p.hand[i], tile)) { p.hand.splice(i, 1); removed++; i--; }
    }
    p.melds.push({ type: 'gang', tile: Object.assign({}, tile), isAn: false });
    this.removeDiscard(tile);
    this.gangKaiSeat = seat;
    this.pushLog(this.seatName(seat) + ' 明杠 ' + T.tileToString(tile));
    this.afterGang(seat);
  }

  doAnGang(seat, tile) {
    const p = this.getPlayer(seat);
    let removed = 0;
    for (let i = 0; i < p.hand.length && removed < 4; i++) {
      if (T.sameTile(p.hand[i], tile)) { p.hand.splice(i, 1); removed++; i--; }
    }
    p.melds.push({ type: 'gang', tile: Object.assign({}, tile), isAn: true });
    this.gangKaiSeat = seat;
    this.pushLog(this.seatName(seat) + ' 暗杠 ' + T.tileToString(tile));
    this.afterGang(seat);
  }

  /** 杠后补牌（从牌墙尾部），补花循环；自摸胡检测 */
  afterGang(seat) {
    const p = this.getPlayer(seat);
    this.pendingClaims = []; // 杠已执行，清空所有残留声明
    if (this.deck.length === 0) { this.drawGame = true; return this.finish(0, 'draw', null, null, false); }
    const tile = this.deck.pop();
    p.hand.push(tile);
    p.gangKai = true;
    this.pushLog(this.seatName(seat) + ' 杠后补牌');
    if (tile.suit === 'flower') {
      this.buHua(seat);
      this.pushLog(this.seatName(seat) + ' 补花');
      if (this.deck.length === 0) { this.drawGame = true; return this.finish(0, 'draw', null, null, false); }
      // 补花后回到打牌回合（补花补进的牌也可能自摸）
      if (R.canWin(p.hand, this.godTiles, { seat, melds: p.melds })) {
        this.pushLog(this.seatName(seat) + ' 杠后补花自摸！');
        return this.finish(seat, 'self', p.hand.slice(), null, false, true);
      }
      this.phase = 'discard';
      this.emit(); this.autoRun();
      return;
    }
    // 杠上开花
    if (R.canWin(p.hand, this.godTiles, { seat, melds: p.melds })) {
      this.pushLog(this.seatName(seat) + ' 杠上开花自摸！');
      return this.finish(seat, 'self', p.hand.slice(), null, false, true);
    }
    this.phase = 'discard';
    this.emit();
    this.autoRun();
  }

  /** 胡牌 */
  doHu(seat, tile, type, gangKai = false) {
    const p = this.getPlayer(seat);
    const hand14 = type === 'self' ? p.hand.slice() : p.hand.concat([tile]);
    // 记录放炮者（点炮胡结算用）
    this.huPayerSeat = 0;
    if (type === 'discard' && this.lastDiscard) {
      this.huPayerSeat = this.lastDiscard.seat;
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

    // 分差：自摸三家付；点炮点炮者付2倍
    let scores = { 1: 0, 2: 0, 3: 0, 4: 0 };
    if (winType === 'self') {
      for (const s of SEATS) {
        if (s === winnerSeat) continue;
        const pay = tai * this.bottom;
        scores[s] -= pay;
        scores[winnerSeat] += pay;
      }
    } else {
      const payer = this.huPayerSeat || 0;
      if (payer && payer !== winnerSeat) {
        const pay = tai * 2 * this.bottom;
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
    };
    this.roundInfo = {
      winnerSeat, winnerName: this.seatName(winnerSeat),
      winType, tai, details: taiRes.details, scores,
      isHumanWin: winnerSeat === this.humanSeat,
    };
    this.emit();
  }

  /* ============ 玩家交互 ============ */

  /** 玩家摸牌后打牌（选择手牌index；财神也可以打出） */
  humanDiscard(index) {
    if (this.phase !== 'waitHumanDiscard') return;
    this.clearThink(); // 打出即取消本回合倒计时
    const p = this.getPlayer(this.humanSeat);
    if (index < 0 || index >= p.hand.length) return;
    this.doDiscard(this.humanSeat, index);
  }

  /** 玩家声明决策 */
  humanClaim(action) {
    if (this.phase !== 'waitHumanClaim') return;
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
        this.emit();
      } else {
        // 无有效吃法 → 按过处理
        this.pendingClaims = this.pendingClaims.filter(c => c.seat !== this.humanSeat);
        this.claimsPassedCheck();
      }
    } else if (action === 'pass') {
      this.pendingClaims = this.pendingClaims.filter(c => c.seat !== this.humanSeat);
      this.claimsPassedCheck();
    }
  }

  /** 玩家选择吃法 */
  humanChiVariant(v) {
    if (this.phase !== 'waitHumanChi' || !this.needChiChoice) return;
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

  /** 玩家补杠 */
  humanBuGang() {
    if (this.phase !== 'waitHumanDiscard') return;
    this.clearThink(); // 消耗本回合（杠后重新进入出牌倒计时）
    const p = this.getPlayer(this.humanSeat);
    // 找手牌中能与碰牌组成补杠的牌
    for (const m of p.melds) {
      if (m.type === 'peng' && T.countInHand(p.hand, m.tile) >= 1) {
        const idx = p.hand.findIndex(x => T.sameTile(x, m.tile));
        p.hand.splice(idx, 1);
        p.melds = p.melds.map(x => x === m ? { type: 'bugang', tile: m.tile } : x);
        this.gangKaiSeat = this.humanSeat;
        this.pushLog(this.seatName(this.humanSeat) + ' 补杠 ' + T.tileToString(m.tile));
        this.afterGang(this.humanSeat);
        return;
      }
    }
  }

  /** 下一局（轮庄） */
  nextRound() {
    // 庄家轮转：流局/胡牌都顺时针换庄（简化规则）
    const prev = this.zhuangSeat || this.humanSeat;
    this._nextZhuang = (prev % 4) + 1;
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
