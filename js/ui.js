/**
 * ui.js — 仙居麻将 UI 控制器（浏览器端）
 * 渲染牌桌、处理玩家交互、驱动 Game 状态机
 */

(function () {
  const T = window.Tiles;
  const R = window.Rules;
  const AI = window.AI;
  const GameClass = window.Game;

  let game = null;
  let selectedIdx = -1;      // 玩家选中的手牌下标
  let claimCandidates = [];  // 待玩家决策的声明
  let thinking = false;      // AI 思考中(防止连点)

  const $ = (id) => document.getElementById(id);

  /* ============ 牌面渲染（Wikimedia Commons 官方牌面素材） ============ */
  // 素材：assets/tiles/MJ*.svg —— 维基百科同款麻将牌面（作者 Cangjie6，CC BY-SA 4.0）
  // 出处与授权见 assets/tiles/ATTRIBUTION.md
  // 本地命名即游戏编号：
  //   MJw1-9 万子 / MJt1-9 筒子 / MJs1-9 条子 / MJf1-4 東南西北 / MJd1-3 中發白
  //   MJh1-8 梅兰竹菊春夏秋冬 / MJback 牌背
  const TILE_DIR = 'assets/tiles/';
  const TILE_PREFIX = { wan: 'MJw', tong: 'MJt', tiao: 'MJs', feng: 'MJf', jian: 'MJd', flower: 'MJh' };

  /** 牌 → 素材文件路径 */
  function tileImgSrc(t) {
    return TILE_DIR + TILE_PREFIX[t.suit] + t.num + '.svg';
  }

  /** 根据花色返回 CSS 类 */
  function tileClass(t, extra) {
    let cls = 'tile';
    if (extra) cls += ' ' + extra;
    if (t.suit === 'flower') cls += ' flower-bg';
    if (t.__god) cls += ' god-mark';
    return cls;
  }

  /** 创建牌 DOM 元素（Wikimedia 官方牌面图片） */
  function makeTileEl(t, opts = {}) {
    const el = document.createElement('div');
    el.className = tileClass(t, opts.extra);
    if (opts.small) el.classList.add('small');
    if (opts.tiny) el.classList.add('tiny');
    el.innerHTML = `<img class="tile-img" src="${tileImgSrc(t)}" alt="" draggable="false">`;
    return el;
  }

  /** 花色排序函数 */
  function suitOrder(t) {
    const order = { wan:0, tong:1, tiao:2, feng:3, jian:4, flower:5 };
    return (order[t.suit]||6) * 100 + t.num;
  }

  /* ============ 快照渲染 ============ */

  function render(snap) {
    // 财神标记
    $('god-tag').textContent = '财神: ' + snap.godTiles.map(T.tileToString).join(' ');
    $('wall-info').textContent = '牌墙 ' + snap.wallLeft;
    const me = snap.players.find(p => p.isHuman);
    const dealer = snap.players.find(p => p.seat === snap.zhuangSeat);
    $('dealer-tag').textContent = '庄家 ' + (dealer ? T.FENG_NAMES[dealer.seat-1] : '') + '家';

    // 显示当前行动提示
    const cur = snap.players.find(p => p.seat === snap.currentSeat);
    const PHASE_HINT = {
      waitHumanDiscard: '轮到你（双击/出牌）',
      waitHumanClaim: '碰/杠/胡/过？',
      waitHumanChi: '吃 / 过？',
    };
    $('turn-info').textContent = snap.phase === 'over' ? ''
      : (PHASE_HINT[snap.phase] || ((cur && cur.isHuman) ? '轮到你' : (cur ? T.FENG_NAMES[cur.seat - 1] + '家思考中' : '')));

    // 三家（2南 3西 4北）
    for (const seat of [2, 3, 4]) {
      const p = snap.players.find(x => x.seat === seat);
      if (!p) continue;
      const opp = $('opp-' + seat);
      if (!opp) continue;
      const nameEl = opp.querySelector('.seat-name');
      if (nameEl) {
        nameEl.textContent = T.FENG_NAMES[seat-1] + '家' + (p.isDealer ? '·庄' : '');
      }
      const tilesEl = opp.querySelector('.opp-tiles');
      if (tilesEl) tilesEl.textContent = p.handCount + ' 张';
      const meldEl = opp.querySelector('.opp-melds');
      if (meldEl) meldEl.textContent = p.melds.map(m => {
        if (m.type === 'gang') return (m.isAn ? '暗杠' : '杠') + T.tileToString(m.tile);
        if (m.type === 'peng') return '碰' + T.tileToString(m.tile);
        if (m.type === 'chi') return '吃' + (m.tile ? T.tileToString(m.tile) : '');
        return '';
      }).join(' ');
      const flowerEl = opp.querySelector('.opp-flowers');
      if (flowerEl) flowerEl.textContent = p.flowers.length ? '🌸×' + p.flowers.length : '';
      // 背面手牌
      const handEl = $('hand-' + seat);
      if (handEl) {
        handEl.innerHTML = '';
        const recentIdx = snap.lastDiscard && snap.lastDiscard.seat === seat ? snap.discards.length - 1 : -1;
        for (let i = 0; i < p.handCount; i++) {
          const back = document.createElement('div');
          back.className = 'back-tile';
          if (recentIdx >= 0 && i === p.handCount - 1) back.classList.add('recent');
          handEl.appendChild(back);
        }
      }
    }

    // 弃牌堆：每家的牌排在自己面前（#discard-1 我下 / 2 南右 / 3 西上 / 4 北左）
    // 全场最新打出且未被吃碰杠消费的牌 → 红圈圈注，直到下一张牌打出
    const latest = snap.discards && snap.discards.length ? snap.discards[snap.discards.length - 1] : null;
    for (const seat of [1, 2, 3, 4]) {
      const pile = $('discard-' + seat);
      if (!pile) continue;
      pile.innerHTML = '';
      const discs = snap.discards.filter(d => d.seat === seat);
      discs.forEach((d, di) => {
        const el = makeTileEl(d.tile, { tiny: true, extra: 'discard' });
        if (latest && latest.seat === seat && di === discs.length - 1) el.classList.add('fresh');
        pile.appendChild(el);
      });
    }

    // 玩家区
    const myFlowers = $('my-flowers');
    if (myFlowers) {
      myFlowers.innerHTML = '';
      me.flowers.forEach(f => myFlowers.appendChild(makeTileEl(f, { tiny: true, extra: 'flower' })));
    }
    const myScore = $('my-score');
    if (myScore) myScore.textContent = '本局分: ' + me.score;
    // melds
    const meldRow = $('my-melds');
    if (meldRow) {
      meldRow.innerHTML = '';
      me.melds.forEach(m => {
        const wrap = document.createElement('div');
        wrap.className = 'meld';
        if (m.type === 'chi' && m.tiles) {
          m.tiles.forEach(tt => wrap.appendChild(makeTileEl(tt, { tiny: true })));
        } else {
          // 碰/杠 显示3或4张
          const cnt = (m.type === 'gang' || m.type === 'bugang') ? 4 : 3;
          for (let i = 0; i < cnt; i++) {
            const el = makeTileEl(m.tile, { tiny: true });
            if (i === 0 && m.type === 'gang' && !m.isAn) el.textContent = (m.isAn ? '' : T.tileToString(m.tile));
            wrap.appendChild(el);
          }
        }
        meldRow.appendChild(wrap);
      });
    }
    // 手牌（可点击）
    const handRow = $('my-hand');
    if (handRow) {
      handRow.innerHTML = '';
      const sorted = me.hand.map((t, i) => ({ t, i }));
      sorted.sort((a, b) => suitOrder(a.t) - suitOrder(b.t));
      sorted.forEach(({ t, i }) => {
        const el = makeTileEl(t, {});
        if (t.suit === 'flower') {
          // 花牌不该在手牌里（正常已被摊开），兜底
        }
        // 标记财神
        if (R.isGod(t, snap.godTiles)) el.classList.add('god-mark');
        if (i === selectedIdx) el.classList.add('selected');
        el.dataset.idx = i;
        el.addEventListener('click', () => onMyTileClick(i, el));
        el.addEventListener('dblclick', () => onMyTileDblClick(i, t)); // 双击直接打出
        handRow.appendChild(el);
      });
    }

    renderActionButtons(snap);
    renderMessage(snap);
    renderThinking(snap);
  }

  /* ============ 倒计时钟（当前行动玩家前方） ============ */
  let thinkTicker = null;
  const RING_LEN = 163.4; // 2πr, r=26

  /** 渲染倒计时钟：挂在当前行动玩家前方（我上方/对家下方/左家右方/右家左方），250ms 自刷新 */
  function renderThinking(snap) {
    const info = snap.thinking || null;
    const clock = $('countdown-clock');
    const remainMs = info ? Math.max(0, info.until - Date.now()) : 0;
    const remain = Math.ceil(remainMs / 1000);
    if (clock) {
      if (info) {
        const total = Math.max(0.1, (info.until - info.startedAt) / 1000);
        clock.className = 'show pos-' + info.seat + (remain <= 5 ? ' urgent' : '');
        $('clock-num').textContent = remain;
        const ring = clock.querySelector('.clock-ring');
        if (ring) ring.style.strokeDashoffset = (RING_LEN * (1 - Math.min(1, remainMs / 1000 / total))).toFixed(1);
      } else {
        clock.className = '';
      }
    }
    // 顶栏提示（短文案，适配手机窄屏）
    const hint = $('turn-info');
    if (info && hint) {
      hint.textContent = info.seat === 1
        ? '你出牌 · ' + remain + 's'
        : T.FENG_NAMES[info.seat - 1] + '家 · ' + remain + 's';
    }
    // 有倒计时进行时启动自刷新，没有则停掉
    if (info && !thinkTicker) {
      thinkTicker = setInterval(() => { if (game) renderThinking(game.snapshot()); }, 250);
    } else if (!info && thinkTicker) {
      clearInterval(thinkTicker);
      thinkTicker = null;
    }
  }

  /* ============ 消息 ============ */

  function renderMessage(snap) {
    const bar = $('msg-bar');
    if (!bar) return;
    if (snap.roundInfo) {
      const ri = snap.roundInfo;
      if (ri.isHumanWin) bar.textContent = '恭喜胡牌！' + ri.winType === 'self' ? '自摸' : '点炮';
      else bar.textContent = ri.winnerName + (ri.winType === 'self' ? ' 自摸胡牌' : ' 胡牌');
    } else if (snap.drawGame) {
      bar.textContent = '牌墙摸完，流局';
    } else if (snap.log && snap.log.length) {
      bar.textContent = snap.log[snap.log.length-1].msg;
    }
  }

  /* ============ 操作按钮 ============ */

  /** 玩家手牌是否有暗杠（4张同牌，需真实牌非财神） */
  function canHumanAnGang(snap) {
    const me = snap.players.find(p => p.isHuman);
    if (!me || !me.hand) return false;
    const cnt = {};
    for (const t of me.hand) {
      if (R.isGod(t, snap.godTiles)) continue;
      const k = t.suit + '|' + t.num;
      cnt[k] = (cnt[k] || 0) + 1;
    }
    return Object.values(cnt).some(v => v >= 4);
  }

  /** 玩家是否有可补杠（碰过的牌手牌中还有第4张） */
  function canHumanBuGang(snap) {
    const me = snap.players.find(p => p.isHuman);
    if (!me || !me.hand) return false;
    const pengTiles = me.melds.filter(m => m.type === 'peng').map(m => m.tile);
    return pengTiles.some(pt => me.hand.some(t => T.sameTile(t, pt)));
  }

  function showAction(btnId, show) {
    const el = $(btnId);
    if (el) el.style.display = show ? '' : 'none';
  }

  function renderActionButtons(snap) {
    const phase = snap.phase;
    showAction('btn-chi', false);
    showAction('btn-peng', false);
    showAction('btn-gang', false);
    showAction('btn-hu', false);
    showAction('btn-pass', false);
    // 出牌按钮：仅轮到我打牌且有选中牌时出现
    showAction('btn-discard', phase === 'waitHumanDiscard' && selectedIdx >= 0);

    if (phase === 'waitHumanClaim') {
      const myClaims = claimCandidates.filter(c => c.seat === 1);
      const has = (a) => myClaims.some(c => c.action === a);
      showAction('btn-hu', has('hu'));
      showAction('btn-peng', has('peng'));
      showAction('btn-gang', has('gang'));
      showAction('btn-chi', has('chi'));
      showAction('btn-pass', true);
      if (has('chi')) $('btn-chi').style.display = '';
    } else if (phase === 'waitHumanChi') {
      // 吃法选择已由弹窗接管，隐藏按钮
      showAction('btn-chi', false);
      showAction('btn-pass', true);
    } else if (phase === 'waitHumanDiscard') {
      // 暗杠 / 补杠入口
      const hasAnGang = canHumanAnGang(snap);
      const hasBuGang = canHumanBuGang(snap);
      if (hasAnGang || hasBuGang) {
        const gangBtn = $('btn-gang');
        if (gangBtn) {
          gangBtn.textContent = hasBuGang ? '补杠' : '暗杠';
          gangBtn.dataset.mode = hasBuGang ? 'bugang' : 'angang';
          gangBtn.style.display = '';
          gangBtn.onclick = () => {
            if (hasBuGang) { if (game) game.humanBuGang(); }
            else { if (game) game.humanAnGang(); }
          };
        }
      } else {
        const gangBtn = $('btn-gang');
        if (gangBtn) {
          gangBtn.style.display = 'none';
          gangBtn.onclick = () => { if (game) game.humanClaim('gang'); };
        }
      }
    }
    // 若在等待打牌且无选中牌，给提示
    const hint = $('turn-info');
    if (hint && phase === 'waitHumanDiscard' && !snap.thinking) hint.textContent = '轮到你（双击/出牌）';
  }

  /* ============ 玩家点击手牌 ============ */

  function onMyTileClick(idx, el) {
    if (!game || game.phase !== 'waitHumanDiscard') return;
    if (selectedIdx === idx) {
      // 再次点击 = 确认打出
      game.humanDiscard(idx);
      selectedIdx = -1;
    } else {
      selectedIdx = idx;
      refreshSelection();
    }
  }

  /** 双击牌面直接打出 */
  function onMyTileDblClick(idx, t) {
    if (!game || game.phase !== 'waitHumanDiscard') return;
    selectedIdx = -1;
    game.humanDiscard(idx);
  }

  function refreshSelection() {
    const handRow = $('my-hand');
    const children = handRow.children;
    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      if (parseInt(el.dataset.idx, 10) === selectedIdx) el.classList.add('selected');
      else el.classList.remove('selected');
    }
    // 出牌按钮跟随选中状态
    const discBtn = $('btn-discard');
    if (discBtn) discBtn.style.display = (game && game.phase === 'waitHumanDiscard' && selectedIdx >= 0) ? '' : 'none';
  }

  function flashMsg(msg) {
    const bar = $('msg-bar');
    if (bar) {
      bar.textContent = msg;
      setTimeout(() => { if (game) renderMessage(game.snapshot()); }, 1500);
    }
  }

  /* ============ 按钮事件 ============ */

  function bindButtons() {
    // 出牌按钮：打出当前选中的牌
    $('btn-discard').addEventListener('click', () => {
      if (game && game.phase === 'waitHumanDiscard' && selectedIdx >= 0) {
        game.humanDiscard(selectedIdx);
        selectedIdx = -1;
      }
    });
    $('btn-pass').addEventListener('click', () => {
      if (!game || game.phase === 'waitHumanChi') {
        if (game && game.phase === 'waitHumanChi') {
          const chis = game.needChiChoice;
          game.needChiChoice = null;
          hideChiOverlay();
          // 放弃吃 → 走 pass
          game.pendingClaims = game.pendingClaims.filter(c => c.seat !== 1);
          game.claimsPassedCheck();
        } else if (game) {
          game.humanClaim('pass');
        }
        return;
      }
      game.humanClaim('pass');
    });
    $('btn-hu').addEventListener('click', () => game && game.humanClaim('hu'));
    $('btn-peng').addEventListener('click', () => game && game.humanClaim('peng'));
    $('btn-gang').addEventListener('click', () => game && game.humanClaim('gang'));
    $('btn-chi').addEventListener('click', () => {
      if (game && game.phase === 'waitHumanChi') {
        // 已进入吃法选择状态，忽略
      } else if (game) {
        game.humanClaim('chi');
      }
    });
    $('btn-restart').addEventListener('click', () => {
      if (confirm('确定重新开局吗？')) startNewGame();
    });
    $('btn-fullscreen').addEventListener('click', toggleFullscreen);
    $('btn-next').addEventListener('click', () => {
      hideOverlay();
      game.nextRound();
    });
    $('btn-again').addEventListener('click', () => {
      hideOverlay();
      startNewGame();
    });
    $('btn-chi-cancel').addEventListener('click', () => {
      if (game && game.phase === 'waitHumanChi') {
        game.needChiChoice = null;
        game.pendingClaims = game.pendingClaims.filter(c => c.seat !== 1);
        game.claimsPassedCheck();
      }
      hideChiOverlay();
    });
  }

  /* ============ 吃法选择弹窗 ============ */

  function showChiOverlay(chis) {
    const box = $('chi-options');
    box.innerHTML = '';
    chis.forEach((chi, vi) => {
      const opt = document.createElement('div');
      opt.className = 'chi-opt';
      chi.forEach(tt => opt.appendChild(makeTileEl(tt, { tiny: true })));
      opt.addEventListener('click', () => {
        hideChiOverlay();
        if (game) game.humanChiVariant(vi);
      });
      box.appendChild(opt);
    });
    $('chi-overlay').style.display = 'flex';
  }
  function hideChiOverlay() { $('chi-overlay').style.display = 'none'; }

  /* ============ 结算弹窗 ============ */

  function showOverlay(snap) {
    const ri = snap.roundInfo;
    if (!ri) {
      // 流局展示
      $('result-title').textContent = '🀄 牌墙摸完 · 流局';
      $('result-tai').textContent = '—';
      $('result-detail').textContent = '本局无人胡牌，重新开局吧';
      $('result-scores').innerHTML = '';
      $('result-hand').innerHTML = '';
      $('overlay').style.display = 'flex';
      return;
    }
    const title = $('result-title');
    title.textContent = (ri.isHumanWin ? '🎉 恭喜胡牌！' : ri.winnerName + ' 胡牌') + (ri.winType === 'self' ? '（自摸）' : '（点炮）');
    $('result-tai').textContent = ri.tai + ' 台';
    $('result-detail').textContent = ri.details.join('  ·  ');
    // 各家得分
    const meSeat = 1;
    let scoreHtml = '';
    for (const seat of [1, 2, 3, 4]) {
      const p = snap.players.find(x => x.seat === seat);
      const delta = (ri.scores && ri.scores[seat]) || 0;
      const prefix = seat === ri.winnerSeat ? '🏆' : '';
      const cls = seat === meSeat ? 'me' : '';
      scoreHtml += `<div class="${cls}">${prefix}${T.FENG_NAMES[seat-1]}家${p.isHuman ? '(我)' : ''}: ${delta > 0 ? '+' : ''}${delta} 分</div>`;
    }
    $('result-scores').innerHTML = scoreHtml;
    // 胡牌手牌展示（还原手牌+明面子）
    const winner = snap.players.find(x => x.seat === ri.winnerSeat);
    const handEl = $('result-hand');
    handEl.innerHTML = '';
    if (winner && winner.huInfo && (winner.huInfo.handRaw || winner.huInfo.meldsRaw)) {
      // 明面子优先
      const group = document.createElement('div');
      group.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
      if (winner.huInfo.meldsRaw && winner.huInfo.meldsRaw.length) {
        const meldWrap = document.createElement('div');
        meldWrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;';
        winner.huInfo.meldsRaw.forEach(m => {
          const mEl = document.createElement('div');
          mEl.style.cssText = 'display:flex;gap:1px;background:#d8cfae;border:1px solid #b8a97a;padding:2px;border-radius:4px;';
          const label = document.createElement('div');
          label.style.cssText = 'font-size:8px;color:#8a7a50;display:flex;align-items:center;padding:0 2px;writing-mode:vertical-lr;';
          label.textContent = m.type === 'chi' ? '吃' : (m.type === 'peng' ? '碰' : (m.type === 'gang' ? (m.isAn ? '暗杠' : '明杠') : '补杠'));
          mEl.appendChild(label);
          const tilesForMeld = m.type === 'chi' ? (m.tiles || []) : Array(m.type === 'gang' || m.type === 'bugang' ? 4 : 3).fill(m.tile);
          tilesForMeld.forEach(tt => mEl.appendChild(makeTileEl(tt, { small: true })));
          meldWrap.appendChild(mEl);
        });
        group.appendChild(meldWrap);
      }
      const handWrap = document.createElement('div');
      handWrap.style.cssText = 'display:flex;gap:2px;flex-wrap:wrap;justify-content:center;';
      (winner.huInfo.handRaw || []).forEach(tt => handWrap.appendChild(makeTileEl(tt, { small: true })));
      group.appendChild(handWrap);
      handEl.appendChild(group);
    } else if (winner && winner.huInfo && winner.huInfo.hand) {
      handEl.textContent = winner.huInfo.hand.join(' ');
    }
    $('overlay').style.display = 'flex';
  }
  function hideOverlay() { $('overlay').style.display = 'none'; }

  /* ============ 游戏生命周期 ============ */

  function startNewGame() {
    if (game && game.destroy) game.destroy(); // 清掉旧对局的人机思考计时器
    game = new GameClass({
      humanSeat: 1, bottom: 1, cap: 0,
      // 出牌统一 20s 倒计时：所有玩家规则相同——在倒计时 20~1s 之间的随机时刻出牌
      thinkDelayMs: (seat, kind) => {
        if (kind === 'claim') {
          // 声明决策（吃/碰/杠/胡）：0.5 ~ 4s 短思考
          return 500 + Math.floor(Math.random() * 3500);
        }
        // 出牌：1~19s 后打出（即倒计时走到 19~1s 之间的随机时刻）
        return 1000 + Math.floor(Math.random() * 18000);
      },
      // 人类玩家同样 20s 倒计时，超时未出牌 → 随机打出一张
      humanTimeoutMs: 20000,
    });
    selectedIdx = -1;
    claimCandidates = [];
    game.onUpdate = (snap) => {
      // 声明候选（同步给按钮逻辑用）
      claimCandidates = snap.pendingClaims.map(c => Object.assign({}, c));
      render(snap);
      if (snap.phase === 'waitHumanClaim') {
        const myHu = claimCandidates.find(c => c.seat === 1 && c.action === 'hu');
        // 自动胡：能胡必胡(简化体验)，否则等玩家操作
        if (myHu) {
          setTimeout(() => { if (game) game.humanClaim('hu'); }, 400);
        }
      } else if (snap.phase === 'waitHumanChi') {
        if (game.needChiChoice && game.needChiChoice.length) {
          showChiOverlay(game.needChiChoice);
        }
      } else if (snap.phase === 'waitHumanDiscard') {
        hideChiOverlay();
      }
      if (snap.roundInfo || snap.drawGame) {
        setTimeout(() => { if (game && (game.phase === 'over')) showOverlay(game.snapshot()); }, 500);
      }
    };
    game.start();
    window.__mj = game; // 调试句柄（控制台可用 __mj.snapshot() 查看引擎状态）
  }

  /* ============ 手机端强制横屏 ============ */
  /** 触屏手机：竖屏持机时给 body 加 landscape-lock，把整个牌桌旋转 90° 横屏显示 */
  function fitOrientation() {
    const b = document.body;
    const mobile = ('ontouchstart' in window) || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const portrait = window.innerHeight > window.innerWidth;
    b.classList.toggle('mobile', mobile);
    b.classList.toggle('landscape-lock', mobile && portrait);
  }

  /* ============ 全屏 ============ */

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function syncFsBtn() {
    const b = $('btn-fullscreen');
    if (b) b.textContent = isFullscreen() ? '退出全屏' : '全屏';
  }
  /** 切换全屏：整个屏幕都是牌桌；Android 全屏时同时锁定横屏。iOS 微信不支持时给"添加到主屏幕"兜底提示 */
  function toggleFullscreen() {
    const doc = document, el = doc.documentElement;
    if (isFullscreen()) {
      const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
      if (exit) exit.call(doc);
      try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
      return;
    }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        const p = req.call(el, { navigationUI: 'hide' });
        if (p && p.then) {
          p.then(() => {
            // Android：全屏后顺手锁定横屏（不支持的系统静默忽略）
            try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (e) {}
          });
          if (p.catch) p.catch(() => flashMsg('当前浏览器不支持全屏：可「添加到主屏幕」获得全屏体验'));
        }
      } catch (e) {
        flashMsg('当前浏览器不支持全屏：可「添加到主屏幕」获得全屏体验');
      }
    } else {
      flashMsg('当前浏览器不支持全屏：可「添加到主屏幕」获得全屏体验');
    }
  }

  /* ============ 初始化 ============ */

  function init() {
    fitOrientation();
    window.addEventListener('resize', fitOrientation);
    window.addEventListener('orientationchange', fitOrientation);
    document.addEventListener('fullscreenchange', syncFsBtn);
    document.addEventListener('webkitfullscreenchange', syncFsBtn);
    bindButtons();
    startNewGame();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
