/**
 * rules.js — 仙居麻将规则引擎（v2 重写）
 * 依赖调研确认的规则：
 *  - 144张牌（136基础 + 8花牌：1梅2兰3竹4菊 5春6夏7秋8冬）
 *  - 财神（百搭）：骰子定风头（4张）+ 牌墙翻牌（3张），共7张，可替任意牌
 *  - 财神不能做将（脚）；用财神替面子要求手牌有"硬家(中发白)或自家风头"对子锚
 *  - 吃只能吃上家（真实顺子，不用财神）；碰分金碰/财神碰/双夹，金碰优先
 *  - 台数：庄2平1、风头+1、硬家各+1、硬碰硬(无财神)+1、碰碰胡+1、杠开+1、
 *          齐花+1、齐季+1、混一色+1、清一色+3、地胡+3、天胡+4、对座花牌+1/张
 *  - 截胡：逆时针（座位号递增）近者优先；诈胡赔付
 *
 * 座位约定：1东 2南 3西 4北，行牌方向座位号递增(1→2→3→4→1)，
 * 即东的下家是南；"上家"= 座位号递减方向 = ((seat+2)%4)+1
 */
(function () {


const T = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
  ? require('./tiles')
  : (window.Tiles || window.tiles);

const WIN_INF = 1e9;

/* ============ 财神 ============ */

function diceToSeat(dice) {
  const m = { 5:1,9:1, 2:2,6:2,10:2, 3:3,7:3,11:3, 4:4,8:4,12:4 };
  return m[dice] || 1;
}

function buildGodTiles(zhuangSeat, dice, flippedTile) {
  const seat = diceToSeat(dice);
  const gods = [{ suit: 'feng', num: seat }];
  if (flippedTile) gods.push({ suit: flippedTile.suit, num: flippedTile.num });
  return gods;
}

function isGod(tile, godTiles) {
  return !!godTiles && godTiles.some(g => T.sameTile(g, tile));
}

function countGods(hand, godTiles) {
  return hand.filter(t => isGod(t, godTiles)).length;
}

function countInHand(hand, tile) {
  return hand.filter(t => T.sameTile(t, tile)).length;
}

/* ============ 胡牌判定（带财神） ============ */

function removeN(arr, tile, n) {
  const out = arr.slice();
  let removed = 0;
  for (let i = 0; i < out.length && removed < n; i++) {
    if (T.sameTile(out[i], tile)) { out.splice(i, 1); removed++; i--; }
  }
  return out;
}

/**
 * minReplaceMelds — 用 tiles（真牌）+ godsLeft 张财神，凑出 needSets 个面子，
 * 返回最小"需要替换的真牌数"（废牌换成有用的）。不可行返回 WIN_INF。
 */
function minReplaceMelds(tiles, godsLeft, needSets) {
  if (needSets === 0) return tiles.length; // 剩余真牌都是废牌（需替换）
  if (tiles.length === 0) {
    // 牌耗尽但还要面子：缺的靠未来摸牌补齐；gods 不足则判远
    return godsLeft >= needSets * 3 ? 0 : WIN_INF;
  }
  // 递归保护：剩余真牌永远填不满面子缺口时直接判远（防无限递归栈溢出）
  if (tiles.length + godsLeft < needSets * 3) return WIN_INF;
  const first = tiles[0];
  const c = countInHand(tiles, first);
  let best = WIN_INF;

  // 1) 刻子（用财神补缺）
  if (c >= 3) {
    best = Math.min(best, minReplaceMelds(tiles.slice(c), godsLeft, needSets - 1));
  } else if (godsLeft >= 3 - c) {
    best = Math.min(best, minReplaceMelds(tiles.slice(c), godsLeft - (3 - c), needSets - 1));
  }

  // 2) 顺子（仅数字牌，num<=7）
  if ((first.suit === 'wan' || first.suit === 'tong' || first.suit === 'tiao') && first.num <= 7) {
    const nt = [first, { suit: first.suit, num: first.num + 1 }, { suit: first.suit, num: first.num + 2 }];
    const have = nt.map(x => Math.min(countInHand(tiles, x), 1)).reduce((a, b) => a + b, 0);
    const miss = 3 - have;
    if (miss <= godsLeft) {
      let rem = tiles.slice();
      for (const x of nt) rem = removeN(rem, x, 1);
      best = Math.min(best, minReplaceMelds(rem, godsLeft - miss, needSets - 1));
    }
  }

  // 3) 跳过第一张（替换掉这张废牌）→ +1
  best = Math.min(best, 1 + minReplaceMelds(tiles.slice(c), godsLeft, needSets));

  return best;
}

/**
 * winReplace — 最小替换张数（0=已胡；1=听；2=一向听...）
 * 将(雀头)必须为真实对子（财神不能做脚）。
 * 硬章规则（仙居）：手牌含财神时，必须有硬章财神才能参与胡牌——
 * 硬章 = 中发白刻子 / 自家风刻子（均含副露）/ 成型结构(清一色、混一色、对对胡)；
 * 花牌不算硬章。将可以是任意真对。
 * @param opts { requireAnchor: 用财神时要求硬章, seat: 座位号, melds: 副露 }
 */

/**
 * 硬章（用财神胡牌的前提）——仙居规则：
 *   ① 中发白刻子（手牌真牌+副露合计 ≥3 张；财神不算，花牌不算）
 *   ② 自家风刻子（座位风，手牌真牌+副露合计 ≥3 张）
 *   ③ 成型结构：清一色 / 混一色 / 对对胡（对对胡允许财神补刻）
 * 注意：别家风、风牌对子、中发白对子（非刻）都不算硬章。
 */
function hasAnchor(rest, melds, gods, needSets, seat) {
  const meldAdd = (m) => (m.type === 'gang' || m.type === 'bugang') ? 4 : 3;
  // ① 中发白刻子（副露的碰/杠/补杠计入）
  for (const n of [1, 2, 3]) {
    let c = countInHand(rest, { suit: 'jian', num: n });
    for (const m of (melds || [])) {
      if (m.tile && m.tile.suit === 'jian' && m.tile.num === n) c += meldAdd(m);
    }
    if (c >= 3) return true;
  }
  // ② 自家风刻子（座位风；副露计入）
  if (seat > 0) {
    let c = countInHand(rest, { suit: 'feng', num: seat });
    for (const m of (melds || [])) {
      if (m.tile && m.tile.suit === 'feng' && m.tile.num === seat) c += meldAdd(m);
    }
    if (c >= 3) return true;
  }
  // ③ 成型结构·清一色 / 混一色（与 calcTai 同口径：财神不参与花色统计）
  const suits = new Set(rest.map(t => t.suit));
  const hasNum = ['wan', 'tong', 'tiao'].some(s => suits.has(s));
  if (hasNum && suits.size === 1) return true;                                    // 清一色
  if (hasNum && suits.size === 2 && (suits.has('feng') || suits.has('jian'))) return true; // 混一色
  // ③ 成型结构·对对胡（无吃副露；剩余真牌+财神能全成刻子+真将）
  if (!(melds || []).some(m => m.type === 'chi')) {
    const cnt = T.countTiles(rest);
    for (const [k, v] of cnt) {
      if (v < 2) continue;
      const [suit, num] = k.split('|');
      const rem = removeN(rest, { suit, num: parseInt(num, 10) }, 2);
      if (minReplaceMeldsOnlyKong(rem, gods, needSets) === 0) return true;
    }
  }
  return false;
}

function winReplace(hand, godTiles, opts = {}) {
  const requireAnchor = opts.requireAnchor !== false;
  const seat = opts.seat || 0;
  const needSets = 4 - (opts.melds || []).length; // 已完成的吃碰杠面子
  const gods = countGods(hand, godTiles);
  // 关键：必须排序！minReplaceMelds 假设同牌相邻、顺子从最小牌开始发现，
  // 未排序的手牌（如摸牌序 ...三万 四万 二万）会漏掉 234 顺子导致误判不胡
  const rest = hand.filter(t => !isGod(t, godTiles)).sort((a, b) => T.tileSortKey(a) - T.tileSortKey(b));
  const cnt = T.countTiles(rest);

  // 锚规则：若手中有财神，且不存在硬章（中发白刻/自家风刻/清一色/混一色/对对胡），财神无法参与胡牌
  if (requireAnchor && gods > 0 && !hasAnchor(rest, opts.melds || [], gods, needSets, seat)) {
    return WIN_INF;
  }

  let best = WIN_INF;

  // 枚举真将（财神不能做将，将可为任意真对）
  for (const [k, v] of cnt) {
    if (v < 2) continue;
    const [suit, num] = k.split('|');
    const pairTile = { suit, num: parseInt(num, 10) };
    const remaining = removeN(rest, pairTile, 2);
    const need = minReplaceMelds(remaining, gods, needSets);
    if (need < best) best = need;
  }

  return best;
}

function canWin(hand, godTiles, opts = {}) {
  return winReplace(hand, godTiles, opts) === 0;
}

/** 所有可进张的牌型（34种普通牌，花牌不算） */
function allDrawableTiles() {
  const res = [];
  for (const suit of ['wan', 'tong', 'tiao']) {
    for (let num = 1; num <= 9; num++) res.push({ suit, num });
  }
  for (let num = 1; num <= 4; num++) res.push({ suit: 'feng', num });
  for (let num = 1; num <= 3; num++) res.push({ suit: 'jian', num });
  return res;
}

/** 精确听牌判定：是否存在一张进张使手牌胡（支持任意张数，含吃碰后） */
function isTenpai(hand, godTiles, opts = {}) {
  for (const t of allDrawableTiles()) {
    if (countInHand(hand, t) >= 4) continue;
    if (winAfterDraw(hand, t, godTiles, opts)) return true;
  }
  return false;
}

/**
 * maxParts — 计算剩余牌最多能组成多少个 (面子, 搭子)
 * @param {Array} tilesArr 真牌数组
 * @returns {[melds, tatsu]}
 */
function maxParts(tilesArr) {
  const memo = new Map();
  function dfs(cnt) {
    let firstKey = null;
    for (const [k, v] of cnt) { if (v > 0) { firstKey = k; break; } }
    if (!firstKey) return [0, 0];
    const key = [...cnt.entries()].filter(([, v]) => v > 0).map(([k, v]) => k + ':' + v).sort().join(',');
    if (memo.has(key)) return memo.get(key);

    const [suit, numStr] = firstKey.split('|');
    const num = +numStr;
    let best = [0, 0];

    const consume = (tiles) => {
      const nc = new Map(cnt);
      for (const t of tiles) {
        const k = t.suit + '|' + t.num;
        if (!nc.has(k) || nc.get(k) <= 0) return null;
        nc.set(k, nc.get(k) - 1);
      }
      return nc;
    };
    const evalRes = (tiles, type) => {
      const nc = consume(tiles);
      if (!nc) return;
      const [m, t] = dfs(nc);
      const mm = m + (type === 'meld' ? 1 : 0);
      const tt = t + (type === 'tatsu' ? 1 : 0);
      const val = mm * 10 + Math.min(tt, 4 - mm);
      const curVal = best[0] * 10 + Math.min(best[1], 4 - best[0]);
      if (val > curVal) best = [mm, tt];
    };

    const isNum = suit === 'wan' || suit === 'tong' || suit === 'tiao';
    // 刻子
    if (cnt.get(firstKey) >= 3) evalRes([{ suit, num }, { suit, num }, { suit, num }], 'meld');
    // 顺子
    if (isNum && num <= 7) {
      evalRes([{ suit, num }, { suit, num: num + 1 }, { suit, num: num + 2 }], 'meld');
    }
    // 对子搭子
    if (cnt.get(firstKey) >= 2) evalRes([{ suit, num }, { suit, num }], 'tatsu');
    // 两面搭子
    if (isNum && num <= 8 && cnt.get(suit + '|' + (num + 1)) > 0) {
      evalRes([{ suit, num }, { suit, num: num + 1 }], 'tatsu');
    }
    // 嵌张搭子
    if (isNum && num <= 7 && cnt.get(suit + '|' + (num + 2)) > 0) {
      evalRes([{ suit, num }, { suit, num: num + 2 }], 'tatsu');
    }
    // 单张跳过
    {
      const nc = new Map(cnt);
      nc.set(firstKey, cnt.get(firstKey) - 1);
      const [m, t] = dfs(nc);
      const val = m * 10 + Math.min(t, 4 - m);
      const curVal = best[0] * 10 + Math.min(best[1], 4 - best[0]);
      if (val > curVal) best = [m, t];
    }
    memo.set(key, best);
    return best;
  }
  const cnt = new Map();
  for (const t of tilesArr) cnt.set(t.suit + '|' + t.num, (cnt.get(t.suit + '|' + t.num) || 0) + 1);
  return dfs(cnt);
}

/** 无财神向听数（部件法）：needSets*2 - 2*面子 - 搭子 - 雀头 */
function shantenNoGod(hand, needSets = 4) {
  const cnt = T.countTiles(hand);
  let bestSh = needSets * 2;
  // 无雀头
  {
    const tilesArr = hand.map(t => ({ suit: t.suit, num: t.num }));
    const [m, ta] = maxParts(tilesArr);
    const mm = Math.min(m, needSets);
    const t = Math.min(ta, needSets - mm);
    bestSh = Math.min(bestSh, needSets * 2 - 2 * mm - t);
  }
  // 枚举雀头（对子）
  for (const [k, v] of cnt) {
    if (v < 2) continue;
    const [suit, num] = k.split('|');
    const rest = removeN(hand, { suit, num: +num }, 2);
    const [m, ta] = maxParts(rest);
    const mm = Math.min(m, needSets);
    const t = Math.min(ta, needSets - mm);
    bestSh = Math.min(bestSh, needSets * 2 - 2 * mm - t - 1);
  }
  return bestSh;
}

/**
 * 向听数：-1已胡，0听牌，>0 步数（统一量纲）
 * 支持已完成的吃碰杠面子（opts.melds），手牌只需凑 (4-k) 个面子。
 */
function shanten(hand, godTiles, opts = {}) {
  const meldCount = (opts.melds || []).length;
  const needSets = 4 - meldCount;
  if (canWin(hand, godTiles, opts)) return -1;
  if (isTenpai(hand, godTiles, opts)) return 0;
  if (hand.length === 14) {
    // 14张未胡：打一张能否听牌 → 一向听
    for (let i = 0; i < hand.length; i++) {
      const rest = hand.slice(0, i).concat(hand.slice(i + 1));
      if (isTenpai(rest, godTiles, opts)) return 1;
    }
  }
  const gods = countGods(hand, godTiles);
  const rest = hand.filter(t => !isGod(t, godTiles));
  let st = shantenNoGod(rest, needSets);
  st = Math.max(0, st - gods); // 财神近似：每个财神减一向听
  return st;
}

function winAfterDraw(hand, tile, godTiles, opts = {}) {
  return canWin(hand.concat([tile]), godTiles, opts);
}

function isSevenPairs(hand, godTiles) {
  if (hand.length !== 14) return false;
  if (hand.some(t => isGod(t, godTiles))) return false;
  const cnt = T.countTiles(hand);
  for (const [, v] of cnt) if (v !== 2) return false;
  return true;
}

/* ============ 吃碰杠 ============ */

/** 吃只能吃上家（座位号递减方向）。真实顺子，不用财神。 */
function canChi(hand, discardTile, seat, lastDiscardSeat) {
  if (lastDiscardSeat !== ((seat + 2) % 4) + 1) return [];
  const t = discardTile;
  if (t.suit === 'feng' || t.suit === 'jian' || t.suit === 'flower') return [];
  const cnt = T.countTiles(hand);
  const res = [];
  for (const start of [t.num - 2, t.num - 1, t.num]) {
    if (start < 1 || start > 7) continue;
    const tiles = [start, start + 1, start + 2].map(n => ({ suit: t.suit, num: n }));
    let ok = true;
    for (const tt of tiles) {
      if (T.sameTile(tt, t)) continue;
      if ((cnt.get(tt.suit + '|' + tt.num) || 0) < 1) { ok = false; break; }
    }
    if (ok) res.push(tiles);
  }
  return res;
}

/** 碰：金碰(2真牌) > 财神碰(1真牌+1财神) > 双夹(2财神) */
function canPeng(hand, discardTile, godTiles) {
  // 仙居规则：碰可以用财神——金碰(2真牌) > 财神碰(1真1财神) > 双夹(2财神)
  const real = countInHand(hand, discardTile);
  const gods = countGods(hand, godTiles);
  if (real >= 2) return { type: 'gold' };
  if (real === 1 && gods >= 1) return { type: 'god' };
  if (real === 0 && gods >= 2) return { type: 'double' };
  return null;
}

/** 杠：discardTile 给定 → 明杠(手3张)；否则暗杠(手4张，财神不算) */
function canGang(hand, discardTile, godTiles) {
  if (discardTile) {
    if (countInHand(hand, discardTile) >= 3) return { type: 'ming', tile: discardTile };
    return null;
  }
  const cnt = T.countTiles(hand);
  for (const [k, v] of cnt) {
    if (v === 4) {
      const [suit, num] = k.split('|');
      return { type: 'an', tile: { suit, num: parseInt(num, 10) } };
    }
  }
  return null;
}

/** 补杠：碰过某牌又摸到第4张 */
function canBuGang(melds, hand, tile) {
  return melds.some(m => m.type === 'peng' && T.sameTile(m.tile, tile));
}

function isFlower(tile) { return tile.suit === 'flower'; }

/* ============ 台数计算 ============ */

function countWithMelds(hand, melds, tile) {
  let c = countInHand(hand, tile);
  for (const m of melds) {
    if (T.sameTile(m.tile, tile)) c += m.type === 'gang' ? 4 : (m.type === 'peng' ? 3 : 0);
  }
  return c;
}

/**
 * calcTai — 台数结算
 * info: { hand, godTiles, seat, zhuangSeat, melds, winType, gangKai, tianhu, dihu, collectedFlowers }
 */
function calcTai(info) {
  const { hand, godTiles, seat, zhuangSeat, melds = [], winType, gangKai = false, tianhu = false, dihu = false, collectedFlowers = [] } = info;
  const details = [];
  let tai = 0;

  // 庄2 平1
  const base = seat === zhuangSeat ? 2 : 1;
  tai += base; details.push(base === 2 ? '庄家 +2台' : '平家 +1台');

  // 自家风头 3/4张 +1
  const seatFeng = { suit: 'feng', num: seat };
  if (countWithMelds(hand, melds, seatFeng) >= 3) { tai += 1; details.push('自家风头 +1台'); }

  // 硬家（中发白）各3/4张 +1
  for (const n of [1, 2, 3]) {
    const jt = { suit: 'jian', num: n };
    if (countWithMelds(hand, melds, jt) >= 3) { tai += 1; details.push('硬家(' + T.tileToString(jt) + ') +1台'); }
  }

  // 硬碰硬：手牌无财神
  if (countGods(hand, godTiles) === 0) { tai += 1; details.push('硬碰硬(无财神) +1台'); }

  // 碰碰胡：无吃，所有面子为刻/杠
  if (!melds.some(m => m.type === 'chi')) {
    // 手牌能否全部分成刻子+将（含财神替）
    // 关键：minReplaceMeldsOnlyKong 依赖排序输入（同牌相邻），否则漏判
    const nonGod = hand.filter(t => !isGod(t, godTiles)).sort((a, b) => T.tileSortKey(a) - T.tileSortKey(b));
    const gods = countGods(hand, godTiles);
    // 枚举将后剩余凑刻子（手牌只需补 4-melds 个面子——此前硬编码 4，有副露时永远检测不到）
    const cnt = T.countTiles(nonGod);
    const needSets = 4 - melds.length;
    let pong = false;
    for (const [k, v] of cnt) {
      if (v < 2) continue;
      const [suit, num] = k.split('|');
      const rem = removeN(nonGod, { suit, num: parseInt(num, 10) }, 2);
      if (minReplaceMeldsOnlyKong(rem, gods, needSets) === 0) { pong = true; break; }
    }
    if (pong && melds.filter(m => m.type === 'peng' || m.type === 'gang').length + 0 >= 0) {
      tai += 1; details.push('碰碰胡 +1台');
    }
  }

  // 杠开
  if (gangKai) { tai += 1; details.push('杠上开花 +1台'); }

  // 齐花/齐季/对座花牌
  const fset = new Set(collectedFlowers.map(f => f.num));
  if ([1, 2, 3, 4].every(n => fset.has(n))) { tai += 1; details.push('齐花(梅兰竹菊) +1台'); }
  if ([5, 6, 7, 8].every(n => fset.has(n))) { tai += 1; details.push('齐季(春夏秋冬) +1台'); }
  const myF = T.flowersForSeat(seat);
  const seatFlower = collectedFlowers.filter(f => myF.includes(f.num)).length;
  if (seatFlower > 0) { tai += seatFlower; details.push('对座花牌 +' + seatFlower + '台'); }

  // 清一色/混一色（财神牌不参与）
  const nonGodSuits = new Set(hand.filter(t => !isGod(t, godTiles)).map(t => t.suit));
  const hasNum = ['wan', 'tong', 'tiao'].some(s => nonGodSuits.has(s));
  if (nonGodSuits.size === 1 && hasNum) {
    tai += 3; details.push('清一色 +3台');
  } else if (hasNum && nonGodSuits.size === 2 && (nonGodSuits.has('feng') || nonGodSuits.has('jian'))) {
    tai += 1; details.push('混一色 +1台');
  }

  if (tianhu) { tai += 4; details.push('天胡 +4台'); }
  if (dihu) { tai += 3; details.push('地胡 +3台'); }

  return { tai, details };
}

/** 只用刻子凑面子（碰碰胡/对对胡检测用），财神补缺 */
function minReplaceMeldsOnlyKong(tiles, godsLeft, needSets) {
  if (needSets === 0) return tiles.length === 0 ? 0 : WIN_INF;
  if (tiles.length === 0) return godsLeft >= needSets * 3 ? 0 : WIN_INF;
  if (tiles.length + godsLeft < needSets * 3) return WIN_INF; // 递归保护
  const first = tiles[0];
  const c = countInHand(tiles, first);
  let best = WIN_INF;
  if (c >= 3) {
    best = Math.min(best, minReplaceMeldsOnlyKong(tiles.slice(c), godsLeft, needSets - 1));
  } else if (godsLeft >= 3 - c) {
    best = Math.min(best, minReplaceMeldsOnlyKong(tiles.slice(c), godsLeft - (3 - c), needSets - 1));
  }
  // 跳过：仅当完全凑不出来时
  best = Math.min(best, 1 + minReplaceMeldsOnlyKong(tiles.slice(c), godsLeft, needSets));
  return best;
}

const RULES = {
  WIN_INF, diceToSeat, buildGodTiles, isGod, countGods, countInHand,
  winReplace, canWin, shanten, winAfterDraw, isSevenPairs, isTenpai, allDrawableTiles,
  canChi, canPeng, canGang, canBuGang, isFlower, calcTai
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RULES;
} else {
  window.Rules = RULES;
}
})();
