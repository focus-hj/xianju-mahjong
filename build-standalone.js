/**
 * build-standalone.js — 把游戏打包成单个 HTML 文件（内联 JS/CSS/全部 SVG 牌面）
 * 产物 xianju-mahjong-standalone.html 可直接发送微信文件，手机"用浏览器打开"即玩，零服务器依赖。
 * 用法：node build-standalone.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 1. 全部牌面 SVG → data URI
const TILE_DIR = path.join(ROOT, 'assets/tiles');
const tileData = {};
for (const f of fs.readdirSync(TILE_DIR)) {
  if (!f.endsWith('.svg')) continue;
  const b64 = fs.readFileSync(path.join(TILE_DIR, f)).toString('base64');
  tileData[f] = 'data:image/svg+xml;base64,' + b64;
}
console.log('内联 SVG 牌面:', Object.keys(tileData).length, '张');

// 2. CSS：牌背图片引用 → data URI
let css = read('style.css');
css = css.replace(/url\("assets\/tiles\/([^"]+)"\)/g, (m, name) => `url("${tileData[name]}")`);

// 3. ui.js：牌面路径优先读内联数据
let ui = read('js/ui.js');
ui = ui.replace(
  "function tileImgSrc(t) {\n    return TILE_DIR + TILE_PREFIX[t.suit] + t.num + '.svg';\n  }",
  "function tileImgSrc(t) {\n    const name = TILE_PREFIX[t.suit] + t.num + '.svg';\n    return (window.__TILE_DATA && window.__TILE_DATA[name]) || (TILE_DIR + name);\n  }"
);
if (!ui.includes('__TILE_DATA')) { console.error('ui.js 打补丁失败'); process.exit(1); }

// 4. 拼装单文件 HTML
let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${css}\n</style>`);
for (const js of ['tiles', 'rules', 'ai', 'game', 'ui']) {
  const code = js === 'ui' ? ui : read(`js/${js}.js`);
  const tag = `<script src="js/${js}.js"></script>`;
  // 牌面数据注入到第一个脚本（tiles.js）之前
  const inject = js === 'tiles' ? `<script>window.__TILE_DATA=${JSON.stringify(tileData)};</script>\n` : '';
  html = html.replace(tag, () => inject + `<script>\n${code}\n</script>`);
}
if (!html.includes('__TILE_DATA=')) { console.error('数据注入失败'); process.exit(1); }

const out = path.join(ROOT, 'xianju-mahjong-standalone.html');
fs.writeFileSync(out, html);
console.log('OK ->', out, (fs.statSync(out).size / 1024).toFixed(0) + 'KB');
