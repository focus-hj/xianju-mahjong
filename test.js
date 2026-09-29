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
// 东风财神替9万：123万 456万 78万+东=789万 123条 白板对
assert(R.canWin(h('w1w2w3w4w5w6w7w8f1b1b2b3j3j3'), GODS) === true, '财神替9万成顺胡');
// 财神做将：123 456 789万 + 123条 + 白+东(=白对) → 将用财神 → 不可
assert(R.canWin(h('w1w2w3w4w5w6w7w8w9b1b2b3j3f1'), GODS) === false, '财神不能做将');

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

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
