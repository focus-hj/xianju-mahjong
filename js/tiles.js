/**
 * tiles.js — 仙居麻将 牌定义与工具
 * 牌张模型：{ suit, num }
 *  suit: 'wan'|'tong'|'tiao'|'feng'|'jian'|'flower'
 *  num:  1-9 数字牌；1-4 风牌(东南西北)；1-3 箭牌(中发白)；1-8 花牌(梅兰竹菊春夏秋冬)
 */
(function () {


const SUITS = ['wan', 'tong', 'tiao', 'feng', 'jian', 'flower'];

// 花牌编号：1梅 2兰 3竹 4菊（对应东1南2西3北4） 5春 6夏 7秋 8冬
const FLOWER_NAMES = ['梅', '兰', '竹', '菊', '春', '夏', '秋', '冬'];
const FENG_NAMES = ['东', '南', '西', '北'];
const JIAN_NAMES = ['中', '发', '白'];

// 花色中文名
const SUIT_NAMES = {
  wan: '万', tong: '筒', tiao: '条',
  feng: '风', jian: '箭', flower: '花'
};

/** 生成一副完整牌（144 张：136 基础 + 8 花牌） */
function createDeck(includeFlowers = true) {
  const deck = [];
  for (const suit of ['wan', 'tong', 'tiao']) {
    for (let num = 1; num <= 9; num++) {
      for (let i = 0; i < 4; i++) deck.push({ suit, num });
    }
  }
  for (let num = 1; num <= 4; num++) {
    for (let i = 0; i < 4; i++) deck.push({ suit: 'feng', num });
  }
  for (let num = 1; num <= 3; num++) {
    for (let i = 0; i < 4; i++) deck.push({ suit: 'jian', num });
  }
  if (includeFlowers) {
    for (let num = 1; num <= 8; num++) deck.push({ suit: 'flower', num });
  }
  return deck;
}

/** Fisher-Yates 洗牌（原地） */
function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 牌转中文名（含花牌） */
function tileToString(t) {
  if (!t) return '?';
  if (t.suit === 'flower') {
    return FLOWER_NAMES[t.num - 1];
  }
  const n = t.num;
  if (t.suit === 'feng') return FENG_NAMES[n - 1];
  if (t.suit === 'jian') return JIAN_NAMES[n - 1];
  const numStr = '一二三四五六七八九'[n - 1];
  return numStr + SUIT_NAMES[t.suit];
}

/** 花色+数字 → 统一排序键（排序用手牌） */
function tileSortKey(t) {
  const suitOrder = { wan: 0, tong: 1, tiao: 2, feng: 3, jian: 4, flower: 5 };
  return suitOrder[t.suit] * 100 + t.num;
}

/** 手牌排序（万→筒→条→风→箭→花） */
function sortHand(hand) {
  return hand.slice().sort((a, b) => tileSortKey(a) - tileSortKey(b));
}

/** 手牌 → 计数 Map（key: suit|num） */
function countTiles(hand) {
  const m = new Map();
  for (const t of hand) {
    const k = t.suit + '|' + t.num;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/** 手牌 → 编码数组（如 {suit:'wan', num:1} 出现2次 → ['wan1','wan1']）用于递归计算 */
function handToCodeArray(hand) {
  return hand.map(t => t.suit + '|' + t.num);
}

/** 同牌是否相等 */
function sameTile(a, b) {
  return a && b && a.suit === b.suit && a.num === b.num;
}

/** 牌是否字牌（风/箭） */
function isHonor(t) {
  return t.suit === 'feng' || t.suit === 'jian';
}

/** 牌是否幺九（1/9 数字牌 或 字牌） */
function isYaoJiu(t) {
  if (t.suit === 'feng' || t.suit === 'jian') return true;
  return t.num === 1 || t.num === 9;
}

/** 花牌所属风座：梅/春→东(1)，兰/夏→南(2)，竹/秋→西(3)，菊/冬→北(4) */
function flowerSeat(t) {
  if (t.suit !== 'flower') return 0;
  return ((t.num - 1) % 4) + 1;
}

/** 玩家座位(1东 2南 3西 4北)对应的两张花牌号 */
function flowersForSeat(seat) {
  // 东(1): 梅(1)春(5)  南(2): 兰(2)夏(6)  西(3): 竹(3)秋(7)  北(4): 菊(4)冬(8)
  return [seat, seat + 4];
}

/** 手牌中某牌数量 */
function countInHand(hand, tile) {
  return hand.filter(t => sameTile(t, tile)).length;
}

// 兼容 Node (module.exports) 与 浏览器 (window.Tiles)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SUITS, FLOWER_NAMES, FENG_NAMES, JIAN_NAMES, SUIT_NAMES,
    createDeck, shuffle, tileToString, tileSortKey, sortHand,
    countTiles, countInHand, handToCodeArray, sameTile, isHonor, isYaoJiu,
    flowerSeat, flowersForSeat
  };
} else {
  window.Tiles = {
    SUITS, FLOWER_NAMES, FENG_NAMES, JIAN_NAMES, SUIT_NAMES,
    createDeck, shuffle, tileToString, tileSortKey, sortHand,
    countTiles, countInHand, handToCodeArray, sameTile, isHonor, isYaoJiu,
    flowerSeat, flowersForSeat
  };
}
})();
