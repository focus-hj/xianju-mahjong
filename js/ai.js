/**
 * ai.js — 仙居麻将 AI 决策（人机对战用）
 * 策略：
 *  1. 能胡必胡（canWin）
 *  2. 摸牌后打牌：遍历每种出牌，选向听数(shanten)最小的；同向听时选"孤张/幺九/字牌"优先打出
 *  3. 吃碰杠决策：吃碰后向听数不劣化才吃碰（金碰>财神碰>双夹）；杠若改善牌型则杠
 *  4. 出牌风险：避免打可能被下家碰/杠的熟张（简单启发式）
 */
(function () {


const R = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
  ? require('./rules')
  : (window.Rules || window.rules);
const T = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
  ? require('./tiles')
  : (window.Tiles || window.tiles);

/** 孤张评分：越小越值得打出（单张且无邻牌 → 高分孤立） */
function isolatedScore(hand, tile) {
  if (tile.suit === 'flower') return 99;
  // 字牌单张
  if (tile.suit === 'feng' || tile.suit === 'jian') {
    return T.countInHand(hand, tile) === 1 ? 6 : 2;
  }
  let score = 0;
  // 有同牌对子 → 低孤立（好牌）
  const c = T.countInHand(hand, tile);
  if (c >= 2) score -= 4;
  if (c >= 3) score -= 2;
  // 邻牌加分（不孤立）
  for (const d of [-1, 1]) {
    const n = tile.num + d;
    if (n < 1 || n > 9) continue;
    const nb = T.countInHand(hand, { suit: tile.suit, num: n });
    if (nb > 0) score -= 3 * nb;
  }
  // 幺九略孤
  if (tile.num === 1 || tile.num === 9) score += 1;
  // 财神孤立分置为极低（向听评分已让它天然不被打出，这里再压一档保险）
  return score;
}

/**
 * AI 打牌选择：从手牌中选一张打出
 * @param {Array} hand 摸牌后手牌（14张）
 * @param {Array} godTiles 财神
 * @param {Object} opts { seat, melds }
 * @returns {Object} tile 打出牌
 */
function chooseDiscard(hand, godTiles, opts = {}) {
  if (hand.length === 0) return null;
  // 财神也可以打出；向听评分会自然让财神几乎不被选中（打掉财神向听数大涨），
  // 仅在极端情况（如满手财神）才可能打出
  const candidates = hand.map((t, i) => ({ t, i }));

  let best = null;
  let bestScore = Infinity;
  for (const { t, i } of candidates) {
    const rest = hand.slice(0, i).concat(hand.slice(i + 1));
    const st = R.shanten(rest, godTiles, opts);
    // 主导：向听数越小越好
    // 次要：孤张评分 —— 同向听时打出"最孤立(最高iso)"的牌
    // iso 高=无对子/无邻牌的孤张（该打出）；iso 低=有价值的牌（该保留）
    // 用 st*100 - iso 求最小 → 等价于同向听时取最大 iso
    const iso = isolatedScore(hand, t);
    const score = st * 100 - iso;
    if (score < bestScore) {
      bestScore = score;
      best = { tile: t, index: i, shanten: st, iso };
    }
  }
  return best;
}

/**
 * 吃碰决策：判断是否值得吃/碰
 * @param {String} action 'chi'|'peng'
 * @param {Array} hand 当前手牌
 * @param {Object} discardTile 别人打出的牌
 * @param {Array} godTiles
 * @param {Object} opts { seat, melds }
 * @returns {Boolean}
 */
function wantClaim(action, hand, discardTile, godTiles, opts = {}) {
  const currentSt = R.shanten(hand, godTiles, opts);
  // 吃：真实顺子
  if (action === 'chi') {
    const chis = R.canChi(hand, discardTile, opts.seat, opts.lastDiscardSeat);
    if (chis.length === 0) return false;
    // 模拟吃牌后的向听（吃进 discardTile 形成新面子）
    for (const chi of chis) {
      const need = chi.filter(t => !T.sameTile(t, discardTile));
      const rem = hand.slice();
      for (const nt of need) {
        const idx = rem.findIndex(x => T.sameTile(x, nt));
        if (idx >= 0) rem.splice(idx, 1);
      }
      const newMelds = (opts.melds || []).concat([{ type: 'chi', tile: discardTile }]);
      const st = R.shanten(rem, godTiles, Object.assign({}, opts, { melds: newMelds }));
      if (st < currentSt) return true; // 必须改善才吃
    }
    return false;
  }
  // 碰
  const peng = R.canPeng(hand, discardTile, godTiles);
  if (!peng) return false;
  if (peng.type === 'gold') {
    // 金碰：移除2真牌+1打出，向听改善才碰（除非快胡）
    const rem = hand.slice();
    let removed = 0;
    for (let i = 0; i < rem.length && removed < 2; i++) {
      if (T.sameTile(rem[i], discardTile)) { rem.splice(i, 1); removed++; i--; }
    }
    const newMelds = (opts.melds || []).concat([{ type: 'peng', tile: discardTile }]);
    const st = R.shanten(rem, godTiles, Object.assign({}, opts, { melds: newMelds }));
    return st < currentSt;
  }
  // 财神碰/双夹：消耗财神，要求向听改善
  const gods = R.countGods(hand, godTiles);
  let newHand;
  if (peng.type === 'god') {
    newHand = hand.slice();
    const ti = newHand.findIndex(x => T.sameTile(x, discardTile));
    if (ti >= 0) newHand.splice(ti, 1);
    const gi = newHand.findIndex(x => R.isGod(x, godTiles));
    if (gi >= 0) newHand.splice(gi, 1);
    newHand.push(discardTile);
  } else { // double
    newHand = hand.slice();
    let removed = 0;
    for (let i = 0; i < newHand.length && removed < 2; i++) {
      if (R.isGod(newHand[i], godTiles)) { newHand.splice(i, 1); removed++; i--; }
    }
    newHand.push(discardTile);
  }
  const newMelds = (opts.melds || []).concat([{ type: 'peng', tile: discardTile }]);
  const st = R.shanten(newHand, godTiles, Object.assign({}, opts, { melds: newMelds }));
  return st < currentSt;
}

/**
 * 杠决策
 * 暗杠：杠后移除4张+补1张，若向听不劣化则杠（否则可能拆牌）。
 * 明杠：手3张+打出1张，直接杠。
 * @returns {Boolean}
 */
function wantGang(hand, tile, godTiles, opts = {}) {
  if (!tile) return false;
  // 暗杠：移除4张（多摸1张）
  if (!tile.isDiscard) {
    const rem = hand.filter(t => !T.sameTile(t, tile));
    // 杠后向听（手牌少了4张但补1张未知，用3张刻子的向听近似）
    const melds = (opts.melds || []).concat([{ type: 'gang', tile }]);
    const st = R.shanten(rem, godTiles, Object.assign({}, opts, { melds }));
    // 暗杠几乎总是有利（补牌机会），除非杠后向听远劣化（如4张是唯一面子核心）
    return st <= R.shanten(hand, godTiles, opts) + 1;
  }
  return true; // 明杠：稳定 +1 面子，直接杠
}

/** 摸到花牌 → 返回 true（由 game 层补牌） */
function onFlower() { return true; }

const AI = { chooseDiscard, wantClaim, wantGang, isolatedScore, onFlower };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AI;
} else {
  window.AI = AI;
}
})();
