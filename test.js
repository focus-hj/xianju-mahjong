const T = require('./js/tiles');
const R = require('./js/rules');

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log('  PASS:', name); }
  else { fail++; console.log('  FAIL:', name); }
}
/** 每2字符一个牌：'w1w2w3' → wan1 wan2 wan3 */
function h(str) {
  const hand = [];
  const s = str.trim().replace(/\s+/g, '');
  for (let i = 0; i < s.length; i += 2) {
    const ch = s[i], n = parseInt(s[i + 1], 10);
    const suit = ch === 'w' ? 'wan' : ch === 't' ? 'tong' : ch === 'b' ? 'tiao' : ch === 'f' ? 'feng' : ch === 'j' ? 'jian' : 'flower';
    hand.push({ suit, num: n });
  }
  return hand;
}
const GODS = [{ suit: 'feng', num: 1 }]; // 东风为财神（测试用）

console.log('== 基础胡牌检测 ==');
assert(R.canWin(h('w1w2w3w4w5w6w7w8w9b1b2b3j3j3'), GODS) === true, '标准胡：三顺万+顺条+白板对');
assert(R.canWin(h('w1w2w3w4w5w6w7w8w9b1b2j3j3'), GODS) === false, '13张不是胡');
assert(R.isSevenPairs(h('w1w1w2w2w3w3b4b4b5b5f2f2f3f3'), GODS) === true, '七对（无财神）');

console.log('== 财神替牌 ==');
// 东风财神替9万：123万 456万 78万+东=789万 123条 白板对——但无硬章（白只是对子），新规则下不可胡
assert(R.canWin(h('w1w2w3w4w5w6w7w8f1b1b2b3j3j3'), GODS) === false, '财神替牌但无硬章（白板只是对子）不可胡');
// 同结构但加白板刻子做硬章：123万 456万 789万(神替) 白白白刻 + 将1条1条 → 可胡
assert(R.canWin(h('w1w2w3w4w5w6w7w8f1j3j3j3b1b1'), GODS) === true, '财神替9万成顺胡（白刻做硬章）');
// 财神做将：123 456 789万 + 123条 + 白+东(=白对) → 将用财神 → 不可
assert(R.canWin(h('w1w2w3w4w5w6w7w8w9b1b2b3j3f1'), GODS) === false, '财神不能做将');

console.log('== 硬章新形态（清一色/混一色/对对胡成型即硬章） ==');
// 对对胡成型：将5万5万 + 7万刻/2条刻/九筒刻 + 發發+东(神)替成發刻 → 可胡
assert(R.canWin(h('w5w5w7w7w7b2b2b2j2j2f1t9t9t9'), GODS, { seat: 1 }) === true, '对对胡成型可用财神胡');
// 混一色成型：123万456万 789万(神替) 南南南刻 + 将西西 → 万+风 两色 → 可胡
assert(R.canWin(h('w1w2w3w4w5w6w7w8f1f2f2f2f3f3'), GODS, { seat: 1 }) === true, '混一色成型可用财神胡');
// 清一色成型：1万2万3万刻 + 78万+东(神)替成789万 + 将4万4万 → 可胡
assert(R.canWin(h('w1w1w1w2w2w2w3w3w3w4w4f1w7w8'), GODS, { seat: 1 }) === true, '清一色成型可用财神胡');

console.log('== 锚规则回归（用户反馈场景） ==');
// 用户截图：财神=南+中；手牌 發發發 六七八萬 一二三筒 四五条 南(财神) 五萬五萬
// 五萬五萬做将 + 财神南替六条成四五六条 + 發發發为硬家锚 → 应胡
const GODS_SN = [{ suit: 'feng', num: 2 }, { suit: 'jian', num: 1 }]; // 南+中为财神
assert(R.canWin(h('j2j2j2w6w7w8t1t2t3b4b5f2w5w5'), GODS_SN, { seat: 1 }) === true, '锚规则放宽:将可为普通对,有硬家刻即锚');
// 反向：将=普通对 且 牌型无任何中发白/风对子做锚 + 用财神 → 应不可胡
// 123万456万789万 123条 + 6条6条(将) + 东风财神替? 需要财神参与但无锚：14张必须含财神
// 构造：123万456万 78万+东风(财神替9万) 123条 6条6条 无中发白无风对 → 无锚，应false
assert(R.canWin(h('w1w2w3w4w5w6w7w8f1b1b2b3b6b6'), GODS, { seat: 1 }) === false, '无锚财神不能胡');
// 有自家风刻子做锚：将=6条6条(普通对), 东风东风东风(自家风刻=锚) 财神中替9万
// 123万456万 + 78万+中(财神=9万) + 东风东风东风 + 6条6条
const GODS2 = [{ suit: 'jian', num: 1 }]; // 中为财神
assert(R.canWin(h('w1w2w3w4w5w6w7w8j1f1f1f1b6b6'), GODS2, { seat: 1 }) === true, '自家风刻做锚即可胡');

console.log('== 向听数 ==');
// 听牌：w1w2w3 w4w5w6 w7w8(等9) b1b2b3 j3j3 = 13张，等w9 → 胡
assert(R.shanten(h('w1w2w3w4w5w6w7w8b1b2b3j3j3'), GODS) === 0, '听牌(向听0)');
assert(R.isTenpai(h('w1w2w3w4w5w6w7w8b1b2b3j3j3'), GODS) === true, 'isTenpai判定');
// 已胡牌：向听 -1
assert(R.shanten(h('w1w2w3w4w5w6w7w8w9b1b2b3j3j3'), GODS) === -1, '已胡向听-1');

console.log('== 吃碰杠 ==');
// seat2(南) 吃 上家seat1(东)打的4万
const chi = R.canChi(h('w2w3w5w6w7b1b2b3b4b5j1j1j2'), { suit: 'wan', num: 4 }, 2, 1);
assert(chi.length >= 1, '可吃上家234万');
assert(R.canChi(h('w2w3w5w6w7b1b2b3b4b5j1j1j2'), { suit: 'wan', num: 4 }, 2, 3).length === 0, '非上家不能吃');
// 金碰：手有2张5万
const peng = R.canPeng(h('w5w5w7b1b2b3b4b5b6f1f1f2f2'), { suit: 'wan', num: 5 }, GODS);
assert(peng && peng.type === 'gold', '金碰优先');
// 财神碰：手有1张5万+1财神
const peng2 = R.canPeng(h('w5w7b1b2b3b4b5b6f1f1f2f2'), { suit: 'wan', num: 5 }, GODS);
assert(peng2 && peng2.type === 'god', '财神碰');
// 明杠：手有3张7筒
const gang = R.canGang(h('t7t7t7b1b2b3b4b5f1f1f2f2'), { suit: 'tong', num: 7 }, GODS);
assert(gang && gang.type === 'ming', '明杠判定');
// 暗杠：手有4张9万
const gang2 = R.canGang(h('w9w9w9w9b1b2b3b4b5f1f1f2'), null, GODS);
assert(gang2 && gang2.type === 'an', '暗杠判定');

console.log('== 手牌顺序回归（用户截图：摸牌序未判胡 bug） ==');
// 财神=西+七条；副露：東碰+發碰；手牌按摸牌顺序（二万最后摸进，在末尾）：
// 九条 七条(神) 七条(神) 白板 白板 三万 四万 二万 → 白板将+二三四万顺+九条财神刻 应判胡
const GODS_XJ = [{ suit: 'feng', num: 3 }, { suit: 'tiao', num: 7 }];
const MELDS2 = [{ type: 'peng', tile: { suit: 'feng', num: 1 } }, { type: 'peng', tile: { suit: 'jian', num: 2 } }];
assert(R.canWin(h('b9b7b7j3j3w3w4w2'), GODS_XJ, { seat: 1, melds: MELDS2 }) === true, '摸牌序（二万在末尾）应判胡');
assert(R.canWin(h('b9b7b7j3j3w2w3w4'), GODS_XJ, { seat: 1, melds: MELDS2 }) === true, '排序后同牌型也判胡（顺序无关）');
// 碰碰胡台数检测也应与手牌顺序无关
const infoPong = {
  hand: h('b9w5b9w5b9w5j3j3'), // 未排序：9条/5万交错 + 白板对（将）
  godTiles: GODS_XJ, seat: 1, zhuangSeat: 2,
  melds: MELDS2, winType: 'self', collectedFlowers: [],
};
const taiPong = R.calcTai(infoPong);
assert(taiPong.details.some(d => d.includes('碰碰胡')), '碰碰胡检测与手牌顺序无关');

console.log('== 用户截图回归（2024-09-30 反馈） ==');
// 财神=北(f4)+六条(b6)；吃123条副露
const GODS_XJ2 = [{ suit: 'feng', num: 4 }, { suit: 'tiao', num: 6 }];
const MELD_CHI123 = [{ type: 'chi', tile: { suit: 'tiao', num: 1 }, tiles: [{ suit: 'tiao', num: 1 }, { suit: 'tiao', num: 2 }, { suit: 'tiao', num: 3 }] }];
// 截图1：4筒5筒5筒 6条(神) 7条8条9条 东 北(神) 2万2万 —— 差一个面子且无硬章 → 不胡
assert(R.canWin(h('t4t5t5b6b7b8b9f1f4w2w2'), GODS_XJ2, { seat: 1, melds: MELD_CHI123 }) === false, '截图1：差一个面子且无硬章，判不胡');
// 截图2-碰前：手牌 4筒5筒6筒 6条(神) 9条 北(神) 2万2万 东，别人打东 → 仍差一个面子 → 不能点炮胡
assert(R.canWin(h('t4t5t6b6b9f4w2w2f1f1'), GODS_XJ2, { seat: 1, melds: MELD_CHI123 }) === false, '截图2-碰前：加东仍差一面子，不胡（只能碰）');
// 截图2-碰后：副露加碰东（自家风刻=硬章），手牌 4筒5筒6筒 6条(神) 9条 北(神) 2万2万 → 成型可胡
const MELD_CHI_PENG = MELD_CHI123.concat([{ type: 'peng', tile: { suit: 'feng', num: 1 } }]);
assert(R.canWin(h('t4t5t6b6b9f4w2w2'), GODS_XJ2, { seat: 1, melds: MELD_CHI_PENG }) === true, '截图2-碰后：将2万+456筒+9条财神刻+自家风刻硬章 → 胡');

console.log('== 胡牌分解 / 自摸按钮 / 财神抽回 ==');
// winDecompose：截图2-碰后牌型 → 将2万 + 456筒 + 9条财神刻（财神嵌在组内）
{
  const hand = h('t4t5t6b6b9f4w2w2'); // 6条、北为财神
  const decomp = R.winDecompose(hand, GODS_XJ2, { melds: [{}, {}] }); // 2 副露
  assert(!!decomp, 'winDecompose 可分解');
  const pairOk = decomp && decomp.pair[0].suit === 'wan' && decomp.pair[0].num === 2;
  assert(pairOk, '将=二万');
  const godSet = decomp && decomp.sets.find(g => g.some(t => R.isGod(t, GODS_XJ2)));
  const godInSetOk = godSet && godSet.filter(t => R.isGod(t, GODS_XJ2)).length === 2
    && godSet.some(t => t.suit === 'tiao' && t.num === 9);
  assert(!!godInSetOk, '财神嵌在九条刻子组内（2 张财神 + 9条）');
}
// 自摸按钮制：玩家摸成胡不自动胡，挂起 selfHu，点 humanSelfHu 才胡
{
  const { Game } = require('./js/game');
  const g = new Game({ humanSeat: 1 });
  g.onUpdate = () => {};
  g.start();
  const me = g.getPlayer(1);
  me.melds = [{ type: 'peng', tile: { suit: 'feng', num: 1 } }, { type: 'peng', tile: { suit: 'jian', num: 2 } }];
  me.hand = h('b9b7b7j3j3w3w4'); // 财神=西+七条（构造缺二万）
  g.godTiles = [{ suit: 'feng', num: 3 }, { suit: 'tiao', num: 7 }];
  g.currentSeat = 1; g.phase = 'draw';
  g.deck.push({ suit: 'wan', num: 2 });
  g.doDraw(1);
  assert(g.phase === 'waitHumanDiscard' && g.snapshot().selfHu === true, '玩家自摸不自动胡，挂起胡按钮');
  g.humanSelfHu();
  assert(g.phase === 'over' && g.winnerSeat === 1, '玩家点「胡」后结算');
}
// 财神抽回：财神碰碰中后用真中换回财神
{
  const { Game } = require('./js/game');
  const g = new Game({ humanSeat: 1 });
  g.onUpdate = () => {};
  g.start();
  const me = g.getPlayer(1);
  g.godTiles = [{ suit: 'feng', num: 4 }, { suit: 'tiao', num: 6 }]; // 北+六条
  // 副露：财神碰中（用 1 真中 + 1 财神北）
  me.melds = [{ type: 'peng', tile: { suit: 'jian', num: 1 }, claimType: 'god', godTilesUsed: [{ suit: 'feng', num: 4 }] }];
  me.hand = h('j1w2w3'); // 手牌有真中
  assert(g.canSwapGod(1) === true, '有真中可换回财神');
  const ok = g.swapGod(1);
  const gotGod = me.hand.some(t => t.suit === 'feng' && t.num === 4);
  const lostZhong = !me.hand.some(t => t.suit === 'jian' && t.num === 1);
  assert(ok && gotGod && lostZhong, '抽回后：财神回手牌、真中入副露');
  assert(me.melds[0].godTilesUsed.length === 0, '副露财神已清空');
}

console.log('== 台数计算 ==');
const info = {
  hand: h('w1w2w3w4w5w6w7w8w9b1b2b3j3j3'),
  godTiles: GODS, seat: 1, zhuangSeat: 1,
  melds: [], winType: 'self', collectedFlowers: [],
};
const tai = R.calcTai(info);
console.log('  台数:', tai.tai, tai.details.join(' / '));
assert(tai.tai >= 3, '庄家清一色自摸 台数>=3');

// 花牌台数：东家(seat1) 摸到 梅(1) 春(5) → 对座2台
const info2 = {
  hand: h('w1w2w3w4w5w6w7w8w9b1b2b3j3j3'),
  godTiles: GODS, seat: 1, zhuangSeat: 2,
  melds: [], winType: 'self', collectedFlowers: [{ suit: 'flower', num: 1 }, { suit: 'flower', num: 5 }],
};
const tai2 = R.calcTai(info2);
console.log('  台数2:', tai2.tai, tai2.details.join(' / '));
assert(tai2.details.some(d => d.includes('对座花牌')), '对座花牌计台');

console.log('== 清一色口径回归（副露花色计入） ==');
// 手牌全筒但副露有南风碰 → 应为混一色(+1)而非清一色(+3)
const info3 = {
  hand: h('t7t8t9t9t9'), godTiles: GODS, seat: 2, zhuangSeat: 1,
  melds: [{ type: 'peng', tile: { suit: 'tong', num: 1 } }, { type: 'peng', tile: { suit: 'tong', num: 2 } }, { type: 'peng', tile: { suit: 'feng', num: 2 } }],
  winType: 'discard', collectedFlowers: [],
};
const tai3 = R.calcTai(info3);
assert(tai3.details.some(d => d.includes('混一色')) && !tai3.details.some(d => d.includes('清一色')), '副露有字牌→混一色而非清一色');
// 手牌+副露全筒 → 清一色(+3)
const info4 = {
  hand: h('t7t8t9t9t9'), godTiles: GODS, seat: 2, zhuangSeat: 1,
  melds: [{ type: 'peng', tile: { suit: 'tong', num: 1 } }, { type: 'peng', tile: { suit: 'tong', num: 2 } }, { type: 'chi', tile: { suit: 'tong', num: 4 }, tiles: [{ suit: 'tong', num: 4 }, { suit: 'tong', num: 5 }, { suit: 'tong', num: 6 }] }],
  winType: 'discard', collectedFlowers: [],
};
const tai4 = R.calcTai(info4);
assert(tai4.details.some(d => d.includes('清一色')), '手牌+副露全同色→清一色');

console.log('== 点炮承包（包三家=3×） ==');
const { Game } = require('./js/game');

/** 构造受控对局：不 start()，手动摆牌后 doHu 点炮 */
function makeChengBaoGame(winnerSeat, winnerHand, winnerMelds, discarderSeat, discarderHand, winTile) {
  const g = new Game({ humanSeat: 1 });
  g.godTiles = GODS; // 东为财神
  g.getPlayer(winnerSeat).hand = h(winnerHand);
  g.getPlayer(winnerSeat).melds = winnerMelds || [];
  g.getPlayer(discarderSeat).hand = h(discarderHand); // 打出后剩余13张
  g.lastDiscard = { seat: discarderSeat, tile: winTile };
  g.discards = [{ seat: discarderSeat, tile: winTile }];
  g.doHu(winnerSeat, winTile, 'discard');
  return g;
}

const ZHONG = { suit: 'jian', num: 1 };
// 赢家通用手牌：123/456/789万 + 55条对 + 中中对（点中胡）
const WIN_ON_ZHONG = 'w1w2w3w4w5w6w7w8w9b5b5j1j1'; // 台数=平1+硬碰硬1+硬家中1=3

// ① 硬家承包：没听牌打中被胡 → 包三家（3×3=9）
{
  const g = makeChengBaoGame(2, WIN_ON_ZHONG, [], 1, 'w1w3w5w7w9t2t4t6t8b1b3b5b7', ZHONG);
  assert(g.huChengBao.some(r => r.includes('硬家承包')), '① 没听牌打中→硬家承包');
  assert(g.roundInfo.scores[1] === -9 && g.roundInfo.scores[2] === 9 && g.roundInfo.scores[3] === 0, '① 承包包三家：点炮者 -9，其余两家 0');
}
// ①b 对照：已听牌打中被胡 → 普通点炮（3×2=6）
{
  const g = makeChengBaoGame(2, WIN_ON_ZHONG, [], 1, 'w1w2w3w4w5w6w7w8b1b2b3j3j3', ZHONG);
  assert(g.huChengBao.length === 0, '①b 已听牌打中→不承包');
  assert(g.roundInfo.scores[1] === -6 && g.roundInfo.scores[2] === 6, '①b 普通点炮付2×');
}
// ② 清一色承包：三摊筒副露，打筒让对方清一色胡 → 包三家（台=平1+硬碰硬1+清一色3=5，5×3=15）
{
  const melds = [
    { type: 'peng', tile: { suit: 'tong', num: 1 }, fromSeat: 2 },
    { type: 'peng', tile: { suit: 'tong', num: 2 }, fromSeat: 2 },
    { type: 'chi', tile: { suit: 'tong', num: 4 }, tiles: [{ suit: 'tong', num: 4 }, { suit: 'tong', num: 5 }, { suit: 'tong', num: 6 }], fromSeat: 2 },
  ];
  // 赢家 seat3 手牌 t7t8t9t9，点炮者 seat4（已听牌，证明规则②不看自己听不听）打 t9
  const g = makeChengBaoGame(3, 't7t8t9t9', melds, 4, 'w1w2w3w4w5w6w7w8b1b2b3j3j3', { suit: 'tong', num: 9 });
  assert(g.huChengBao.some(r => r.includes('清一色承包')), '② 三摊同花色+清一色→承包');
  assert(g.roundInfo.scores[4] === -15 && g.roundInfo.scores[3] === 15, '② 承包包三家付3×');
}
// ②b 对照：三摊筒但赢家是混一色（手牌有风）→ 不承包（台=平1+硬碰硬1+混一色1=3，3×2=6）
{
  const melds = [
    { type: 'peng', tile: { suit: 'tong', num: 1 }, fromSeat: 2 },
    { type: 'peng', tile: { suit: 'tong', num: 2 }, fromSeat: 2 },
    { type: 'chi', tile: { suit: 'tong', num: 4 }, tiles: [{ suit: 'tong', num: 4 }, { suit: 'tong', num: 5 }, { suit: 'tong', num: 6 }], fromSeat: 2 },
  ];
  const g = makeChengBaoGame(3, 't7t8f2f2', melds, 4, 'w1w2w3w4w5w6w7w8b1b2b3j3j3', { suit: 'tong', num: 9 });
  assert(g.huChengBao.length === 0, '②b 混一色不算清一色承包');
  assert(g.roundInfo.scores[4] === -6 && g.roundInfo.scores[3] === 6, '②b 普通点炮付2×');
}
// ③ 连碰三摊：赢家3个碰全来自点炮者 seat1，再点炮 → 包三家（台=平1+硬碰硬1=2，2×3=6）
{
  const melds = [
    { type: 'peng', tile: { suit: 'wan', num: 1 }, fromSeat: 1 },
    { type: 'peng', tile: { suit: 'wan', num: 2 }, fromSeat: 1 },
    { type: 'peng', tile: { suit: 'wan', num: 3 }, fromSeat: 1 },
  ];
  const g = makeChengBaoGame(2, 'b5b5t7t8', melds, 1, 'w1w2w3w4w5w6w7w8b1b2b3j3j3', { suit: 'tiao', num: 6 });
  assert(g.huChengBao.some(r => r.includes('连碰三摊')), '③ 连碰三摊→承包');
  assert(g.roundInfo.scores[1] === -6 && g.roundInfo.scores[2] === 6, '③ 承包包三家付3×');
}
// ③b 对照：只有2摊来自点炮者 → 不承包（2×2=4）
{
  const melds = [
    { type: 'peng', tile: { suit: 'wan', num: 1 }, fromSeat: 1 },
    { type: 'peng', tile: { suit: 'wan', num: 2 }, fromSeat: 1 },
    { type: 'peng', tile: { suit: 'wan', num: 3 }, fromSeat: 3 },
  ];
  const g = makeChengBaoGame(2, 'b5b5t7t8', melds, 1, 'w1w2w3w4w5w6w7w8b1b2b3j3j3', { suit: 'tiao', num: 6 });
  assert(g.huChengBao.length === 0, '③b 仅2摊来自点炮者→不承包');
  assert(g.roundInfo.scores[1] === -4 && g.roundInfo.scores[2] === 4, '③b 普通点炮付2×');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
