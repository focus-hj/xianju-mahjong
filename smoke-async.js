/** 异步冒烟：AI 延迟 1ms + 人类超时 50ms，验证延迟调度下不会产生幽灵定时器/手牌失衡 */
const { Game } = require('./js/game');

let bad = null;
const g = new Game({
  humanSeat: 1, bottom: 1,
  thinkDelayMs: () => 1,   // AI 全部走异步延迟路径
  humanTimeoutMs: 50,      // 人类 50ms 超时自动出牌
});
g.onUpdate = () => {
  const s = g.snapshot();
  for (const p of s.players) {
    if (p.handCount > 14) bad = `seat${p.seat} 手牌数=${p.handCount} phase=${s.phase}`;
    if (p.handCount < 0) bad = `seat${p.seat} 手牌数为负`;
  }
  // 人类声明自动过（本测试只关心出牌计时调度）
  if (g.phase === 'waitHumanClaim') g.humanClaim('pass');
  else if (g.phase === 'waitHumanChi') {
    g.needChiChoice = null;
    g.pendingClaims = g.pendingClaims.filter(c => c.seat !== 1);
    g.claimsPassedCheck();
  }
};
g.start();

const t0 = Date.now();
const iv = setInterval(() => {
  if (bad) { console.error('FAIL:', bad); process.exit(1); }
  const s = g.snapshot();
  if (g.phase === 'over') {
    clearInterval(iv);
    const counts = s.players.map(p => p.handCount + '+' + p.melds.length + 'm+' + p.flowers.length + 'f');
    console.log('ASYNC_SMOKE_OK 对局正常结束, 各家手牌:', counts.join(' / '), '耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
    process.exit(0);
  }
  if (Date.now() - t0 > 60000) {
    console.error('TIMEOUT phase=', g.phase, 'hands=', s.players.map(p => p.handCount).join('/'), 'think=', JSON.stringify(s.thinking));
    process.exit(1);
  }
}, 50);
