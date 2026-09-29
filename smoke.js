/** 状态机冒烟测试：AI 全自动跑完整对局（外部驱动） */
const { Game } = require('./js/game');
const R = require('./js/rules');

let rounds = 0, wins = 0, draws = 0;
const startTime = Date.now();

/** 驱动一步：处理所有需要玩家（模拟）的操作 */
function drive(game) {
  const s = game.snapshot();
  if (s.phase === 'waitHumanDiscard') {
    // 选第一张非财神牌打出
    const p = game.getPlayer(game.humanSeat);
    const idx = p.hand.findIndex(t => !R.isGod(t, game.godTiles));
    game.humanDiscard(idx >= 0 ? idx : 0);
    return true;
  }
  if (s.phase === 'waitHumanClaim') {
    game.humanClaim('pass');
    return true;
  }
  if (s.phase === 'waitHumanChi') {
    game.humanChiVariant(0);
    return true;
  }
  return false;
}

function runRound(i) {
  const game = new Game({ humanSeat: 1, bottom: 1 });
  game.onUpdate = () => {};
  game.start();
  let guard = 0;
  while (game.phase !== 'over' && guard++ < 800) {
    if (!drive(game)) {
      // autoRun 已同步处理，等下一次事件；若 idle 则强推
      break;
    }
  }
  // 若因同步推进中断（phase 在 discard/draw/claim 但非 waitHuman），继续自动推进
  let g2 = 0;
  while (game.phase !== 'over' && g2++ < 800) {
    const before = game.phase;
    if (game.phase === 'discard' || game.phase === 'draw' || game.phase === 'claim') {
      // 直接触发 autoRun
      game._forceProceed = true;
      // autoRun 是私有，但我们只需再调一次入口
      // 通过再次 snapshot 触发? 不行——直接调内部方法
      break;
    }
    break;
  }
  rounds++;
  if (game.drawGame) draws++;
  else if (game.winnerSeat) wins++;
  return game;
}

for (let i = 1; i <= 50; i++) {
  const g = runRound(i);
  if (g.roundInfo) {
    const ri = g.roundInfo;
    console.log(`局${i}: ${ri.winnerName} ${ri.winType} ${ri.tai}台 [${ri.details.join(', ')}]`);
  } else {
    console.log(`局${i}: ${g.drawGame ? '流局' : '异常中断(phase=' + g.phase + ')'}`);
  }
}
console.log(`\n总计: ${rounds}局, ${wins}胜, ${draws}流局, 耗时 ${((Date.now()-startTime)/1000).toFixed(1)}s`);
