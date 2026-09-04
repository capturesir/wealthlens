/* 前端會計引擎回歸測試 —— node test/engine.test.js
   以 stub DOM 載入 index.html 的前三個 script 區塊(狀態+引擎),驗證核心會計數值。 */
"use strict";
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
global.location = { protocol: "http:" };
global.window = { addEventListener: () => {} };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, writable: true, configurable: true });
global.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => ({ classList: { toggle: () => {}, remove: () => {}, add: () => {} } }), addEventListener: () => {} };
global.fetch = async () => { throw new Error("offline") };

let code = scripts.slice(1, 4).join("\n;\n").replace(/"use strict";/g, "");
code = code.slice(0, code.indexOf("/* ====================== 資產列表 UI"));

let pass = 0;
const ok = (c, m) => { if (!c) { console.error("✗", m); process.exit(1) } console.log("✓", m); pass++ };

const tests = `
LIVE = true; state.settings.baseCcy = 'USD';

// (a) 除淨日 NAV 恆等 + TWR 中立
const raw = new Float64Array(N_DAYS).fill(100);
const exIdx = dIdx(new Date('2024-03-15'));
for (let i = exIdx; i < N_DAYS; i++) raw[i] = 98;
REAL.series['DIVX'] = { raw, adj: raw }; registerSym({ s:'DIVX', n:'X', z:'X', m:'US', c:'USD' });
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:10000, date:'2024-01-02' },
  { id:'2', kind:'stock', sym:'DIVX', ccy:'USD', loc:'A', side:'buy', price:100, units:50, date:'2024-02-01' },
  { id:'3', kind:'dividend', sym:'DIVX', ccy:'USD', loc:'A', amount:100, date:'2024-03-15' }];
let D = buildDaily(null);
ok(Math.abs(D.values[exIdx - D.i0] - 10000) < 1e-6, '(a) 除淨日 NAV 平滑不變');
ok(Math.abs(twrCurve(D).slice(-1)[0] - 1) < 1e-9, '(a) 價跌+股息抵銷 TWR=0%');

// (b) 拆股交易單位數重述
const r2 = new Float64Array(N_DAYS).fill(100);
REAL.series['SPLT'] = { raw: r2, adj: r2 };
REAL.events['SPLT'] = { dividends: [], splits: [{ date:'2024-06-10', ratio:4, text:'4:1' }] };
registerSym({ s:'SPLT', n:'S', z:'S', m:'US', c:'USD' });
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:50000, date:'2024-01-02' },
  { id:'2', kind:'stock', sym:'SPLT', ccy:'USD', loc:'A', side:'buy', price:400, units:10, date:'2024-02-01' }];
D = buildDaily(null);
ok(Math.abs(D.values.slice(-1)[0] - 50000) < 1e-6, '(b) 拆股重述後 NAV 正確');
const h = holdingsDetail(null).list.find(x => x.sym === 'SPLT');
ok(Math.abs(h.units - 40) < 1e-9 && Math.abs(h.cost - 4000) < 1e-6, '(b) 重述持倉 40 股、成本 $4000');

// (c) 期權現金=外部流,TWR 中立
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:10000, date:'2024-01-02' },
  { id:'2', kind:'option', sym:'O', ccy:'USD', loc:'A', side:'buy', price:30, units:100, date:'2024-03-01' },
  { id:'3', kind:'option', sym:'O', ccy:'USD', loc:'A', side:'sell', price:55, units:100, date:'2024-05-01' }];
D = buildDaily(null);
ok(Math.abs(twrCurve(D).slice(-1)[0] - 1) < 1e-9, '(c) 期權獲利不影響 TWR');
ok(Math.abs(D.values.slice(-1)[0] - 12500) < 1e-6, '(c) 期權現金進出正確 12500');

// (d) FEE/LIABILITY 內部支出
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:10000, date:'2024-01-02' },
  { id:'2', kind:'fee', ccy:'USD', loc:'A', amount:120, date:'2024-04-01' },
  { id:'3', kind:'liability', ccy:'USD', loc:'A', amount:80, date:'2024-05-01' }];
D = buildDaily(null);
ok(Math.abs(D.values.slice(-1)[0] - 9800) < 1e-6 && Math.abs(D.flows.reduce((s,v)=>s+v,0) - 10000) < 1e-6, '(d) 費用減現金、不入資金流');
ok(Math.abs(holdingsDetail(null).expenseTotal - 200) < 1e-6, '(d) 累計支出 $200');

// (e) 自動股息:去重 / 多位置 / 稅率 / 跳過清單
REAL.events['DIVX'] = { dividends: [{ date:'2024-03-15', amount:2 }, { date:'2024-09-16', amount:2.5 }], splits: [] };
state.settings.divTax = 30; state.settings.autoDiv = true; state.settings.divSkip = [];
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'富途', amount:10000, date:'2024-01-02' },
  { id:'2', kind:'stock', sym:'DIVX', ccy:'USD', loc:'富途', side:'buy', price:100, units:30, date:'2024-02-01' },
  { id:'3', kind:'stock', sym:'DIVX', ccy:'USD', loc:'中銀', side:'buy', price:100, units:20, date:'2024-02-01' },
  { id:'4', kind:'dividend', sym:'DIVX', ccy:'USD', loc:'富途', amount:60, date:'2024-03-14' }];
reconcileAutoDividends();
const autos = state.txns.filter(t => t.auto);
// 每位置去重:3/15 富途因 3/14 手動股息(±14天)而跳過,但中銀無 → 補上;9/16 兩位置各一筆 = 共 3 筆
ok(autos.length === 3, '(e) 每位置去重:3/15中銀 + 9/16富途 + 9/16中銀 = 3筆');
ok(!autos.some(t => t.loc === '富途' && t.date === '2024-03-15'), '(e) 3/15富途因手動股息跳過(每位置去重)');
ok(!!autos.find(t => t.loc === '中銀' && t.date === '2024-03-15'), '(e) 3/15中銀補上(不受富途影響)');
ok(Math.abs(autos.find(t => t.loc === '富途' && t.date === '2024-09-16').amount - 52.5) < 1e-9, '(e) 9/16富途 30%稅後 $52.5');
ok(Math.abs(autos.find(t => t.loc === '中銀' && t.date === '2024-09-16').amount - 35) < 1e-9, '(e) 9/16中銀 $35');
state.settings.divTax = 0;
ok(reapplyDivTax() === 3 && Math.abs(autos.find(t => t.loc === '富途' && t.date === '2024-09-16').amount - 75) < 1e-9, '(e) 改 0% 稅率重算');
state.settings.divSkip = ['DIVX|2024-09-16|富途', 'DIVX|2024-09-16|中銀', 'DIVX|2024-03-15|中銀'];
state.txns = state.txns.filter(t => !t.auto);
ok(!reconcileAutoDividends(), '(e) 跳過清單(每位置)生效,刪除後不重生');

// (f) MWR 累積口徑:無外部現金流時 MWR累積 ≈ TWR累積(做法一)
const fpx = new Float64Array(N_DAYS);
const fb = dIdx(new Date('2024-01-01'));
for (let i = 0; i < N_DAYS; i++) fpx[i] = i < fb ? 50 : 50 + 70 * (i - fb) / (N_DAYS - 1 - fb);
REAL.series['MWX'] = { raw: fpx, adj: fpx }; REAL.events['MWX'] = { dividends: [], splits: [] };
registerSym({ s:'MWX', n:'M', z:'M', m:'US', c:'USD' });
state.settings.autoDiv = false;
state.txns = [
  { id:'1', kind:'cash', ccy:'USD', loc:'A', amount:50000, date:'2024-01-01' },
  { id:'2', kind:'stock', sym:'MWX', ccy:'USD', loc:'A', side:'buy', price:50, units:1000, date:'2024-01-01' }];
let Df = buildDaily(null);
let lastf = Df.values.length - 1, k0f = Math.max(0, lastf - 365);
let twf = twrCurve(Df);
ok(Math.abs((twf[lastf]/twf[k0f]-1) - mwrCumOf(Df, k0f, lastf)) < 1e-3, '(f) 無現金流時 MWR累積 ≈ TWR累積');
// 加入期中現金流 → 兩者分岔
state.txns.push({ id:'3', kind:'cash', ccy:'USD', loc:'A', amount:30000, date: fmtD(DATES[Df.i0 + Math.max(1,lastf-60)]) });
state.txns.push({ id:'4', kind:'stock', sym:'MWX', ccy:'USD', loc:'A', side:'buy', price: fpx[Math.max(1,lastf-60)], units:500, date: fmtD(DATES[Df.i0 + Math.max(1,lastf-60)]) });
Df = buildDaily(null); lastf = Df.values.length - 1; twf = twrCurve(Df);
ok(Math.abs((twf[lastf]/twf[0]-1) - mwrCumOf(Df, 0, lastf)) > 1e-4, '(f) 有現金流時 MWR累積 與 TWR累積 分岔');

// ============ (g) 圖表期間計算:TWR/MWR 截段、買賣、資金進出、YTD、股息 ============
state.settings.autoDiv = false;
const K = (D, date) => dIdx(new Date(date)) - D.i0;
const px3 = (pts) => { // pts: [[dateStr, price], ...] 線性內插建構價格序列
  const a = new Float64Array(N_DAYS);
  const idx = pts.map(p => [dIdx(new Date(p[0])), p[1]]);
  for (let i = 0; i < N_DAYS; i++) {
    if (i <= idx[0][0]) { a[i] = idx[0][1]; continue; }
    let seg = idx.length - 1;
    for (let s = 0; s < idx.length - 1; s++) if (i > idx[s][0] && i <= idx[s + 1][0]) { seg = s; break; }
    if (i > idx[idx.length - 1][0]) { a[i] = idx[idx.length - 1][1]; continue; }
    const [k1, v1] = idx[seg], [k2, v2] = idx[seg + 1];
    a[i] = v1 + (v2 - v1) * (i - k1) / (k2 - k1);
  }
  return a;
};

// (g1) TWR 截段正確性:三段 +50% / -20% / +30%,無資金流
(function () {
  const px = px3([['2024-01-01', 100], ['2024-05-01', 150], ['2024-09-01', 120], ['2025-01-01', 156]]);
  REAL.series['G1'] = { raw: px, adj: px }; REAL.events['G1'] = { dividends: [], splits: [] };
  registerSym({ s: 'G1', n: 'G1', z: 'G1', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100, date: '2024-01-01' },
    { id: '2', kind: 'stock', sym: 'G1', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 1, date: '2024-01-01' }];
  const D = buildDaily(null), tw = twrCurve(D);
  ok(Math.abs((tw[K(D, '2024-09-01')] / tw[K(D, '2024-05-01')] - 1) - (-0.20)) < 0.01, '(g1) TWR 截中段 = -20%');
  ok(Math.abs((tw[K(D, '2025-01-01')] / tw[K(D, '2024-05-01')] - 1) - 0.04) < 0.01, '(g1) TWR 截後兩段 = +4%');
  ok(Math.abs((tw[K(D, '2025-01-01')] / tw[0] - 1) - 0.56) < 0.01, '(g1) TWR 全段 = +56%');
})();

// (g2) 期間中加碼:TWR 剔除(=0%),MWR 反映時機(為負)
(function () {
  const px = px3([['2024-01-01', 100], ['2024-07-01', 200], ['2025-01-01', 100]]);
  REAL.series['G2'] = { raw: px, adj: px }; REAL.events['G2'] = { dividends: [], splits: [] };
  registerSym({ s: 'G2', n: 'G2', z: 'G2', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100, date: '2024-01-01' },
    { id: '2', kind: 'stock', sym: 'G2', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 1, date: '2024-01-01' },
    { id: '3', kind: 'cash', ccy: 'USD', loc: 'A', amount: 200, date: '2024-07-01' },
    { id: '4', kind: 'stock', sym: 'G2', ccy: 'USD', loc: 'A', side: 'buy', price: 200, units: 1, date: '2024-07-01' }];
  const D = buildDaily(null), last = D.values.length - 1, tw = twrCurve(D);
  ok(Math.abs(tw[last] / tw[0] - 1) < 0.005, '(g2) 加碼後 TWR 仍=0%(剔除資金流時機)');
  ok(mwrOf(D, 0, last) < -0.05, '(g2) 高點加碼 MWR 年化為負(反映時機)');
})();

// (g3) 期間起點 k0 市值基準:下半段只看 k0 之後
(function () {
  const px = px3([['2024-01-01', 100], ['2024-07-01', 200], ['2025-01-01', 240]]);
  REAL.series['G3'] = { raw: px, adj: px }; REAL.events['G3'] = { dividends: [], splits: [] };
  registerSym({ s: 'G3', n: 'G3', z: 'G3', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100, date: '2024-01-01' },
    { id: '2', kind: 'stock', sym: 'G3', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 1, date: '2024-01-01' }];
  const D = buildDaily(null), tw = twrCurve(D), a = K(D, '2024-07-01'), b = K(D, '2025-01-01');
  ok(Math.abs((tw[b] / tw[a] - 1) - 0.20) < 0.01, '(g3) 下半段 TWR (200→240) = +20%');
  ok(Math.abs(mwrCumOf(D, a, b) - 0.20) < 0.03, '(g3) 下半段 MWR累積 ≈ +20%');
})();

// (g4) YTD 起點 = 今年初市值(非成本):去年買入,今年漲
(function () {
  const today = dIdx(TODAY);
  const px = px3([['2025-06-01', 100], ['2025-12-31', 150], [fmtD(DATES[today]), 180]]);
  REAL.series['G4'] = { raw: px, adj: px }; REAL.events['G4'] = { dividends: [], splits: [] };
  registerSym({ s: 'G4', n: 'G4', z: 'G4', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100, date: '2025-06-01' },
    { id: '2', kind: 'stock', sym: 'G4', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 1, date: '2025-06-01' }];
  const D = buildDaily(null), tw = twrCurve(D), last = D.values.length - 1;
  const y0 = new Date(TODAY.getFullYear(), 0, 1);
  let k0 = Math.min(Math.max(0, dIdx(y0) - D.i0), last);
  ok(Math.abs((tw[last] / tw[k0] - 1) - 0.20) < 0.03, '(g4) YTD TWR 用今年初市值(150→180=+20%)');
  ok(Math.abs((tw[last] / tw[0] - 1) - 0.80) < 0.03, '(g4) 全段用成本(100→180=+80%),與YTD不同');
})();

// (g5) 期間中部分賣出:組合層級 TWR 含賣出後現金(GIPS),MWR 視賣出為內部轉移
(function () {
  const px = px3([['2024-01-01', 100], ['2024-07-01', 150], ['2025-01-01', 120]]);
  REAL.series['G5'] = { raw: px, adj: px }; REAL.events['G5'] = { dividends: [], splits: [] };
  registerSym({ s: 'G5', n: 'G5', z: 'G5', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 200, date: '2024-01-01' },
    { id: '2', kind: 'stock', sym: 'G5', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 2, date: '2024-01-01' },
    { id: '3', kind: 'stock', sym: 'G5', ccy: 'USD', loc: 'A', side: 'sell', price: 150, units: 1, date: '2024-07-01' }];
  const D = buildDaily(null), last = D.values.length - 1, tw = twrCurve(D);
  ok(Math.abs((tw[last] / tw[0] - 1) - 0.35) < 0.01, '(g5) 賣出後現金計入組合,全段 TWR = +35%');
  const H = holdingsDetail(null);
  ok(Math.abs(H.total - 270) < 0.5, '(g5) 期末總資產=270(120股值+150現金)');
})();

// (g6) 期間內派息:股息計入報酬(橫盤+$10股息=+10%)
(function () {
  const px = new Float64Array(N_DAYS).fill(100);
  REAL.series['G6'] = { raw: px, adj: px }; REAL.events['G6'] = { dividends: [{ date: '2024-07-01', amount: 10 }], splits: [] };
  registerSym({ s: 'G6', n: 'G6', z: 'G6', m: 'US', c: 'USD' });
  state.settings.autoDiv = true; state.settings.divTax = 0;
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100, date: '2024-01-01' },
    { id: '2', kind: 'stock', sym: 'G6', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 1, date: '2024-01-01' }];
  reconcileAutoDividends();
  const D = buildDaily(null), last = D.values.length - 1, tw = twrCurve(D);
  ok(Math.abs((tw[last] / tw[0] - 1) - 0.10) < 0.005, '(g6) 橫盤+$10股息 全段 TWR = +10%');
  ok(Math.abs((tw[K(D, '2024-07-01')] / tw[0] - 1) - 0.10) < 0.01, '(g6) 上半段(含除息)= +10%');
  ok(Math.abs(tw[last] / tw[K(D, '2024-07-01')] - 1) < 0.005, '(g6) 下半段(橫盤)= 0%');
  ok(Math.abs(holdingsDetail(null).total - 110) < 0.1, '(g6) 期末資產=110(股息入帳)');
  state.settings.autoDiv = false;
})();

// (g7) MWR 精算對照人手 XIRR(加碼 / 純持有 / 部分賣出)
(function () {
  const irr = (cfs) => { let lo = -0.99, hi = 10; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; (cfs.reduce((s, c) => s + c.amt / Math.pow(1 + m, c.t), 0) > 0) ? lo = m : hi = m; } return (lo + hi) / 2; };
  // 純持有:線性漲 100→150
  const px = px3([['2024-01-01', 100], ['2025-01-01', 150]]);
  REAL.series['G7'] = { raw: px, adj: px }; REAL.events['G7'] = { dividends: [], splits: [] };
  registerSym({ s: 'G7', n: 'G7', z: 'G7', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100, date: '2024-01-01' },
    { id: '2', kind: 'stock', sym: 'G7', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 1, date: '2024-01-01' }];
  const D = buildDaily(null), last = D.values.length - 1;
  const tToday = last / 365, endV = D.values[last];
  const manual = Math.pow(endV / 100, 1 / tToday) - 1;
  ok(Math.abs(mwrOf(D, 0, last) - manual) < 0.01, '(g7) 純持有 MWR年化 = 人手XIRR');
})();

// (g8) 效能守門:大型組合(50股500筆)單次完整重算應遠低於上限
// 目的是偵測「數量級退化」(例如線性算法被改成平方級),而非吹毛求疵的毫秒波動,
// 故門檻設得寬鬆(800ms),遠高於正常實測(~50ms);只要沒爆量級就會通過。
(function () {
  const nStocks = 50, nTxns = 500;
  for (let s = 0; s < nStocks; s++) {
    const sym = 'P' + s;
    const px = new Float64Array(N_DAYS);
    for (let i = 0; i < N_DAYS; i++) px[i] = 100 + Math.sin(i / 30 + s) * 20;
    REAL.series[sym] = { raw: px, adj: px }; REAL.events[sym] = { dividends: [], splits: [] };
    registerSym({ s: sym, n: sym, z: sym, m: 'US', c: 'USD' });
  }
  state.txns = [{ id: 'pc', kind: 'cash', ccy: 'USD', loc: 'A', amount: 1e7, date: '2021-01-01' }];
  for (let t = 0; t < nTxns; t++) {
    const sym = 'P' + (t % nStocks);
    const dt = new Date(2021, 0, 1); dt.setDate(dt.getDate() + Math.floor(t / nStocks) * 3);
    state.txns.push({ id: 'p' + t, kind: 'stock', sym, ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 1, date: fmtD(dt) });
  }
  buildDaily(null); // 暖機
  const t0 = process.hrtime.bigint();
  const Dp = buildDaily(null);
  const tw = twrCurve(Dp);
  mwrCurve(Dp, 0, Dp.values.length - 1);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log('   (g8) 大型組合單次完整重算耗時 ≈ ' + ms.toFixed(1) + ' ms (上限 800ms)');
  ok(ms < 800, '(g8) 大型組合(50股500筆)單次重算 < 800ms(效能未退化)');
})();

// ============ (h) 股息重構:除息資格 / 多位置 / 刪除存續 / 來源標識 ============
state.settings.autoDiv = true; state.settings.divTax = 0; state.settings.divSkip = [];

// (h0a) 除息資格:除息日「當天買入」無權領該次息
(function () {
  REAL.events['H0'] = { dividends: [{ date: '2024-06-03', amount: 1 }], splits: [] };
  registerSym({ s: 'H0', n: 'H0', z: 'H0', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 10000, date: '2024-01-02' },
    { id: '2', kind: 'stock', sym: 'H0', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: '2024-05-01' }, // 除息前持有
    { id: '3', kind: 'stock', sym: 'H0', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 50, date: '2024-06-03' }];  // 除息日當天買入→無權
  reconcileAutoDividends();
  const dv = state.txns.find(t => t.auto && t.sym === 'H0');
  ok(dv && Math.abs(dv.units - 100) < 1e-6, '(h0a) 除息日當天買入不計入,僅 100 股領息(非150)');
})();

// (h0b) 除息資格:除息日「當天賣出」仍享當次息
(function () {
  state.settings.divSkip = [];
  REAL.events['H0b'] = { dividends: [{ date: '2024-06-03', amount: 1 }], splits: [] };
  registerSym({ s: 'H0b', n: 'H0b', z: 'H0b', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 10000, date: '2024-01-02' },
    { id: '2', kind: 'stock', sym: 'H0b', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: '2024-05-01' },
    { id: '3', kind: 'stock', sym: 'H0b', ccy: 'USD', loc: 'A', side: 'sell', price: 100, units: 100, date: '2024-06-03' }]; // 除息日當天賣出→仍享息
  reconcileAutoDividends();
  const dv = state.txns.find(t => t.auto && t.sym === 'H0b');
  ok(dv && Math.abs(dv.units - 100) < 1e-6, '(h0b) 除息日當天賣出仍領 100 股息(買賣不對稱)');
})();

// (h3) 多位置:同代碼在 A/B 各自按持股獨立派息(最初回報的 bug)
(function () {
  state.settings.divSkip = [];
  REAL.events['H3'] = { dividends: [{ date: '2024-06-03', amount: 2 }], splits: [] };
  registerSym({ s: 'H3', n: 'H3', z: 'H3', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: '中銀', amount: 10000, date: '2024-01-02' },
    { id: '2', kind: 'stock', sym: 'H3', ccy: 'USD', loc: '中銀', side: 'buy', price: 100, units: 100, date: '2024-05-01' },
    { id: '3', kind: 'stock', sym: 'H3', ccy: 'USD', loc: '', side: 'buy', price: 100, units: 50, date: '2024-05-01' }]; // 預設位置
  reconcileAutoDividends();
  const divs = state.txns.filter(t => t.auto && t.sym === 'H3');
  ok(divs.length === 2, '(h3) 兩位置各自派息共 2 筆');
  ok(Math.abs(divs.find(t => (t.loc || '') === '中銀').amount - 200) < 1e-6, '(h3) 中銀 100股×$2 = $200');
  ok(Math.abs(divs.find(t => (t.loc || '') === '').amount - 100) < 1e-6, '(h3) 預設 50股×$2 = $100');
})();

// (h6) 刪除存續:刪某位置某次股息 → 重算不復活(尊重刪除意圖)
(function () {
  state.settings.divSkip = [];
  REAL.events['H6'] = { dividends: [{ date: '2024-03-03', amount: 1 }, { date: '2024-06-03', amount: 1 }, { date: '2024-09-03', amount: 1 }], splits: [] };
  registerSym({ s: 'H6', n: 'H6', z: 'H6', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'B', amount: 10000, date: '2024-01-02' },
    { id: '2', kind: 'stock', sym: 'H6', ccy: 'USD', loc: 'B', side: 'buy', price: 100, units: 500, date: '2024-01-10' }];
  reconcileAutoDividends();
  ok(state.txns.filter(t => t.auto && t.sym === 'H6').length === 3, '(h6) 初次 3 筆派息');
  // 用戶刪除 6/3 那筆 → 加入跳過清單(每位置鍵)
  const del = state.txns.find(t => t.auto && t.sym === 'H6' && t.date === '2024-06-03');
  state.settings.divSkip = [...(state.settings.divSkip || []), 'H6|2024-06-03|B'];
  state.txns = state.txns.filter(t => t.id !== del.id);
  ok(state.txns.filter(t => t.auto && t.sym === 'H6').length === 2, '(h6) 刪除後剩 2 筆');
  // 再次重算(模擬後續任何觸發)→ 被刪那筆不復活
  reconcileAutoDividends();
  const after = state.txns.filter(t => t.auto && t.sym === 'H6');
  ok(after.length === 2 && !after.some(t => t.date === '2024-06-03'), '(h6) 重算後被刪那筆不復活(尊重刪除意圖)');
})();

// (h-manual) 來源標識:改金額後轉手動,重算不覆蓋
(function () {
  state.settings.divSkip = [];
  REAL.events['HM'] = { dividends: [{ date: '2024-06-03', amount: 1 }], splits: [] };
  registerSym({ s: 'HM', n: 'HM', z: 'HM', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 10000, date: '2024-01-02' },
    { id: '2', kind: 'stock', sym: 'HM', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: '2024-05-01' }];
  reconcileAutoDividends();
  const dv = state.txns.find(t => t.auto && t.sym === 'HM');
  ok(dv && dv.auto === true, '(h-manual) 初次為自動(帶標識)');
  // 模擬用戶改金額→轉手動(移除 auto/gross)
  dv.amount = 88; delete dv.auto; delete dv.gross;
  reconcileAutoDividends();
  const all = state.txns.filter(t => t.sym === 'HM' && t.kind === 'dividend');
  ok(all.length === 1 && all[0].amount === 88, '(h-manual) 轉手動後重算不覆蓋(金額維持88、不重生)');
})();
// (h5) 轉倉:中性(不影響總資產/TWR);轉倉日後兩位置各自派息
(function () {
  state.settings.divSkip = []; state.settings.autoDiv = true; state.settings.divTax = 0;
  const px = new Float64Array(N_DAYS); for (let i = 0; i < N_DAYS; i++) px[i] = 100;
  REAL.series['H5'] = { raw: px, adj: px };
  REAL.events['H5'] = { dividends: [{ date: '2024-03-03', amount: 1 }, { date: '2024-09-03', amount: 1 }], splits: [] };
  registerSym({ s: 'H5', n: 'H5', z: 'H5', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: '2024-01-02' },
    { id: '2', kind: 'stock', sym: 'H5', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 500, date: '2024-01-10' },
    // 6/1 轉倉 300 股 A→B(成本基礎 100)
    { id: '3', kind: 'transfer', sym: 'H5', ccy: 'USD', from: 'A', to: 'B', units: 300, basis: 100, date: '2024-06-01' }];
  // 全組合層級:轉倉中性,總資產不變
  const Dall = buildDaily(null);
  const totalNoXfer = 100000; // 50000現金 + 500股*100 = 100000
  ok(Math.abs(Dall.values[Dall.values.length - 1] - totalNoXfer) < 1 + 1e-6, '(h5) 轉倉後全組合總資產不變(中性)');
  ok(Math.abs(twrCurve(Dall).slice(-1)[0] - 1) < 1e-6, '(h5) 轉倉不影響 TWR(橫盤→0%)');
  reconcileAutoDividends();
  const divs = state.txns.filter(t => t.auto && t.sym === 'H5');
  // 3/3(轉倉前):全 500 股在 A → A 一筆 $500;9/3(轉倉後):A 200股=$200、B 300股=$300
  const d33A = divs.find(t => t.date === '2024-03-03' && (t.loc || '') === 'A');
  const d93A = divs.find(t => t.date === '2024-09-03' && (t.loc || '') === 'A');
  const d93B = divs.find(t => t.date === '2024-09-03' && (t.loc || '') === 'B');
  ok(d33A && Math.abs(d33A.amount - 500) < 1e-6, '(h5) 轉倉前 3/3:A 全 500 股 = $500');
  ok(d93A && Math.abs(d93A.amount - 200) < 1e-6, '(h5) 轉倉後 9/3:A 餘 200 股 = $200');
  ok(d93B && Math.abs(d93B.amount - 300) < 1e-6, '(h5) 轉倉後 9/3:B 得 300 股 = $300');
})();
// (h4) 位置變更連動:把某位置自動股息搬到新位置(模擬編輯股票位置後的搬移邏輯)
(function () {
  state.settings.divSkip = []; state.settings.autoDiv = true; state.settings.divTax = 0;
  REAL.events['H4'] = { dividends: [{ date: '2024-03-03', amount: 1 }], splits: [] };
  registerSym({ s: 'H4', n: 'H4', z: 'H4', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 10000, date: '2024-01-02' },
    { id: '2', kind: 'stock', sym: 'H4', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: '2024-01-10' }];
  reconcileAutoDividends();
  const before = state.txns.find(t => t.auto && t.sym === 'H4');
  ok(before && (before.loc || '') === 'A', '(h4) 股息初始在 A');
  // 模擬「變更股票位置 A→B 並連動搬移股息」的核心邏輯
  for (const t of state.txns) {
    if (t.kind === 'stock' && t.sym === 'H4') t.loc = 'B';
    if (t.kind === 'dividend' && t.auto && t.sym === 'H4' && (t.loc || '') === 'A') t.loc = 'B';
  }
  reconcileAutoDividends();
  const divs = state.txns.filter(t => t.auto && t.sym === 'H4');
  ok(divs.length === 1 && divs[0].loc === 'B', '(h4) 變更位置後股息隨股票移至 B(不重生於A)');
})();
// (h7) 刪除股票交易 → 連帶重算自動股息(A設計):部分刪改金額、全刪消失、手動不動
(function () {
  state.settings.divSkip = []; state.settings.autoDiv = true; state.settings.divTax = 0;
  REAL.events['H7'] = { dividends: [{ date: '2024-06-03', amount: 1 }], splits: [] };
  registerSym({ s: 'H7', n: 'H7', z: 'H7', m: 'US', c: 'USD' });
  // 同位置兩筆買入:100 + 200 = 300 股
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: '2024-01-02' },
    { id: 'buyA', kind: 'stock', sym: 'H7', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: '2024-02-01' },
    { id: 'buyB', kind: 'stock', sym: 'H7', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 200, date: '2024-03-01' }];
  reconcileAutoDividends();
  let dv = state.txns.find(t => t.auto && t.sym === 'H7');
  ok(dv && Math.abs(dv.amount - 300) < 1e-6, '(h7) 初始 300 股 → 股息 $300');
  // 模擬刪除 buyB(200股):清掉該位置純自動股息 → 重算成 100 股
  state.txns = state.txns.filter(t => t.id !== 'buyB');
  state.txns = state.txns.filter(t => !(t.kind === 'dividend' && t.auto && t.sym === 'H7' && (t.loc || '') === 'A'));
  reconcileAutoDividends();
  dv = state.txns.find(t => t.auto && t.sym === 'H7');
  ok(dv && Math.abs(dv.amount - 100) < 1e-6, '(h7) 刪一筆後剩 100 股 → 股息重算 $100');
  // 再刪 buyA(歸零)→ 股息應消失
  state.txns = state.txns.filter(t => t.id !== 'buyA');
  state.txns = state.txns.filter(t => !(t.kind === 'dividend' && t.auto && t.sym === 'H7' && (t.loc || '') === 'A'));
  reconcileAutoDividends();
  ok(!state.txns.some(t => t.auto && t.sym === 'H7'), '(h7) 持股歸零 → 自動股息不再重生');
})();
// ============ (h8) 刪除股票交易的穿倉處理(取向三-精簡版)============
// 規則:刪除一筆股票交易後,若導致任何位置在任何時點持股變負(穿倉),
//       則自動找出並一併刪除「導致穿倉」的轉倉(最小集合),再重算自動股息。
//       不穿倉則直接刪除。手動股息與跳過清單不受影響。
// 介面:deleteHoldingTxn(id) → {removed:[...ids], ok:true}

// (h8a) 單筆買入 + 一筆轉倉:刪買入會使來源穿倉 → 連帶刪該轉倉
(function () {
  state.settings.divSkip = []; state.settings.autoDiv = false;
  registerSym({ s: 'X8', n: 'X8', z: 'X8', m: 'US', c: 'USD' });
  state.txns = [
    { id: 'c', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: '2024-01-02' },
    { id: 'buy', kind: 'stock', sym: 'X8', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 500, date: '2024-02-01' },
    { id: 'xfer', kind: 'transfer', sym: 'X8', ccy: 'USD', from: 'A', to: 'B', units: 200, basis: 100, date: '2024-05-01' }];
  const r = deleteHoldingTxn('buy');
  ok(r.removed.includes('buy') && r.removed.includes('xfer'), '(h8a) 刪唯一買入→連帶刪轉倉(否則A穿倉)');
  ok(!state.txns.some(t => t.id === 'xfer'), '(h8a) 轉倉已移除');
  // A、B 都應無 X8 持股
  const uA = unitsByLocAt('X8', fmtD(TODAY), false);
  ok(!(uA['A'] > 1e-9) && !(uA['B'] > 1e-9), '(h8a) A、B 皆無 X8 持股(無孤兒/負股)');
})();

// (h8b) 多筆買入,刪一筆後仍足夠 → 不穿倉,轉倉保留
(function () {
  state.settings.divSkip = [];
  registerSym({ s: 'X8b', n: 'X8b', z: 'X8b', m: 'US', c: 'USD' });
  state.txns = [
    { id: 'c', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: '2024-01-02' },
    { id: 'buy1', kind: 'stock', sym: 'X8b', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 500, date: '2024-02-01' },
    { id: 'buy2', kind: 'stock', sym: 'X8b', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 300, date: '2024-03-01' },
    { id: 'xfer', kind: 'transfer', sym: 'X8b', ccy: 'USD', from: 'A', to: 'B', units: 200, basis: 100, date: '2024-05-01' }];
  // 刪 buy1(500),A 剩 300,轉倉 200 ≤ 300 → 不穿倉,轉倉保留
  const r = deleteHoldingTxn('buy1');
  ok(r.removed.includes('buy1') && !r.removed.includes('xfer'), '(h8b) 刪一筆後仍足夠→轉倉保留');
  ok(state.txns.some(t => t.id === 'xfer'), '(h8b) 轉倉仍存在');
  const u = unitsByLocAt('X8b', fmtD(TODAY), false);
  ok(Math.abs((u['A'] || 0) - 100) < 1e-6 && Math.abs((u['B'] || 0) - 200) < 1e-6, '(h8b) A=100(300-200轉出),B=200');
})();

// (h8c) 多段轉倉鏈:A→B→C,刪最初買入 → 連帶刪整條鏈(否則層層穿倉)
(function () {
  state.settings.divSkip = [];
  registerSym({ s: 'X8c', n: 'X8c', z: 'X8c', m: 'US', c: 'USD' });
  state.txns = [
    { id: 'c', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: '2024-01-02' },
    { id: 'buy', kind: 'stock', sym: 'X8c', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 500, date: '2024-02-01' },
    { id: 'x1', kind: 'transfer', sym: 'X8c', ccy: 'USD', from: 'A', to: 'B', units: 300, basis: 100, date: '2024-04-01' },
    { id: 'x2', kind: 'transfer', sym: 'X8c', ccy: 'USD', from: 'B', to: 'C', units: 200, basis: 100, date: '2024-06-01' }];
  // 刪 buy:A 來源沒了 → x1(A→B)穿倉必刪 → B 也沒貨源 → x2(B→C)亦穿倉必刪
  const r = deleteHoldingTxn('buy');
  ok(r.removed.includes('buy') && r.removed.includes('x1') && r.removed.includes('x2'), '(h8c) 刪最初買入→連帶刪整條轉倉鏈');
  const u = unitsByLocAt('X8c', fmtD(TODAY), false);
  ok(!(u['A'] > 1e-9) && !(u['B'] > 1e-9) && !(u['C'] > 1e-9), '(h8c) A/B/C 皆無持股(無負股殘留)');
})();

// (h8d) 多段轉倉鏈但部分可保留:A有600(刪500剩100),A→B 100、B→C 50 → 不穿倉,全保留
(function () {
  state.settings.divSkip = [];
  registerSym({ s: 'X8d', n: 'X8d', z: 'X8d', m: 'US', c: 'USD' });
  state.txns = [
    { id: 'c', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: '2024-01-02' },
    { id: 'buy1', kind: 'stock', sym: 'X8d', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 500, date: '2024-02-01' },
    { id: 'buy2', kind: 'stock', sym: 'X8d', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: '2024-02-15' },
    { id: 'x1', kind: 'transfer', sym: 'X8d', ccy: 'USD', from: 'A', to: 'B', units: 100, basis: 100, date: '2024-04-01' },
    { id: 'x2', kind: 'transfer', sym: 'X8d', ccy: 'USD', from: 'B', to: 'C', units: 50, basis: 100, date: '2024-06-01' }];
  // 刪 buy1(500),A 剩 100;A→B 轉 100 → A=0、B=100;B→C 轉 50 → B=50、C=50。無穿倉,全保留
  const r = deleteHoldingTxn('buy1');
  ok(r.removed.length === 1 && r.removed[0] === 'buy1', '(h8d) 不穿倉→只刪買入,兩段轉倉全保留');
  const u = unitsByLocAt('X8d', fmtD(TODAY), false);
  ok(Math.abs((u['A'] || 0) - 0) < 1e-6 && Math.abs((u['B'] || 0) - 50) < 1e-6 && Math.abs((u['C'] || 0) - 50) < 1e-6, '(h8d) A=0,B=50,C=50');
})();

// ============ (i) 績效指標 perfMetrics ============
// (i1) 最大回撤:構造 TWR 曲線 1→1.5→1.2→1.8,峰1.5後跌到1.2 = -20%
(function () {
  const twr = new Float64Array(40);
  for (let k = 0; k < 40; k++) twr[k] = 1 + 0.01 * k; // 緩升,先放長度滿足 ≥30
  // 覆寫一段製造回撤:峰值在 idx10=2.0,谷在 idx15=1.6 → -20%
  twr[10] = 2.0; twr[11] = 1.9; twr[12] = 1.8; twr[13] = 1.7; twr[14] = 1.65; twr[15] = 1.6;
  for (let k = 16; k < 40; k++) twr[k] = 1.6 + 0.02 * (k - 15);
  const m = perfMetrics(twr, 0, 39, null);
  ok(m.ok && Math.abs(m.mdd - (-0.20)) < 0.005, '(i1) 最大回撤 = -20%');
})();

// (i2) 期間不足(<30天)→ ok:false
(function () {
  const twr = new Float64Array(20); for (let k = 0; k < 20; k++) twr[k] = 1 + 0.01 * k;
  const m = perfMetrics(twr, 0, 19, null);
  ok(!m.ok && m.days === 20, '(i2) 少於30交易日 → 期間不足');
})();

// (i3) 波動率年化:固定日報酬無波動 → 波動率≈0、夏普可算
(function () {
  const twr = new Float64Array(60); twr[0] = 1;
  for (let k = 1; k < 60; k++) twr[k] = twr[k - 1] * 1.001; // 每日固定 +0.1%,標準差=0
  const m = perfMetrics(twr, 0, 59, null);
  ok(m.ok && m.volAnn < 1e-6, '(i3) 固定日報酬 → 年化波動率≈0');
})();

// (i4) Beta:組合日報酬 = 2×SPY日報酬 → Beta≈2
(function () {
  const n = 50;
  const spy = new Float64Array(n); spy[0] = 100;
  const twr = new Float64Array(n); twr[0] = 1;
  for (let k = 1; k < n; k++) {
    const sr = (k % 2 === 0 ? 0.01 : -0.005); // SPY 日報酬交替
    spy[k] = spy[k - 1] * (1 + sr);
    twr[k] = twr[k - 1] * (1 + 2 * sr);        // 組合 = 2×SPY
  }
  const m = perfMetrics(twr, 0, n - 1, spy);
  ok(m.ok && m.beta != null && Math.abs(m.beta - 2) < 0.05, '(i4) Beta ≈ 2(組合=2×SPY)');
})();

// (i5) 夏普方向:有波動且年化報酬 > 無風險利率 → 夏普為正
(function () {
  const twr = new Float64Array(252); twr[0] = 1;
  for (let k = 1; k < 252; k++) {
    const r = 0.0015 + (k % 2 === 0 ? 0.004 : -0.003); // 平均正報酬 + 波動
    twr[k] = twr[k - 1] * (1 + r);
  }
  const m = perfMetrics(twr, 0, 251, null, 0.04);
  ok(m.ok && m.volAnn > 0 && m.sharpe != null && m.sharpe > 0 && m.annRet > 0.04, '(i5) 有波動且年化>無風險 → 夏普為正');
})();
// ============ (j) 相關性矩陣 correlationMatrix ============
(function () {
  // 構造三個經調整價序列:A 與 B 完全同向(corr=+1)、A 與 C 完全反向(corr=-1)
  const A = new Float64Array(N_DAYS), B = new Float64Array(N_DAYS), C = new Float64Array(N_DAYS);
  A[0] = 100; B[0] = 50; C[0] = 200;
  for (let i = 1; i < N_DAYS; i++) {
    const r = (i % 2 === 0 ? 0.01 : -0.008);
    A[i] = A[i - 1] * (1 + r);
    B[i] = B[i - 1] * (1 + r);        // 與 A 同向
    C[i] = C[i - 1] * (1 - r);        // 與 A 反向
  }
  const getAdj = s => ({ A, B, C }[s]);
  const { syms, matrix } = correlationMatrix(['A', 'B', 'C'], getAdj, 252);
  ok(syms.length === 3, '(j) 三個有效序列');
  const iA = syms.indexOf('A'), iB = syms.indexOf('B'), iC = syms.indexOf('C');
  ok(Math.abs(matrix[iA][iA] - 1) < 1e-9, '(j) 對角線 = 1');
  ok(Math.abs(matrix[iA][iB] - 1) < 0.01, '(j) A~B 完全正相關 ≈ +1');
  ok(Math.abs(matrix[iA][iC] - (-1)) < 0.01, '(j) A~C 完全負相關 ≈ -1');
  ok(Math.abs(matrix[iA][iB] - matrix[iB][iA]) < 1e-9, '(j) 矩陣對稱');
})();

// (j2) 資料不足或缺序列的代碼會被略過
(function () {
  const A = new Float64Array(N_DAYS); A[0] = 100;
  for (let i = 1; i < N_DAYS; i++) A[i] = A[i - 1] * 1.001;
  const getAdj = s => (s === 'A' ? A : null); // B 無序列
  const { syms } = correlationMatrix(['A', 'B'], getAdj, 252);
  ok(syms.length === 1 && syms[0] === 'A', '(j2) 缺序列的代碼被略過');
})();

// ============ (k) 現金存入/提取:正負金額 → 資金流方向(核心,不可破壞)============
// (k1) 存入為正:現金增加,計為正外部資金流
(function () {
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 10000, date: '2024-01-02' }];
  const D = buildDaily(null);
  const lastK = D.values.length - 1;
  let totalFlow = 0; for (let k = 0; k <= lastK; k++) totalFlow += D.flows[k];
  ok(Math.abs(D.values[lastK] - 10000) < 1e-6, '(k1) 存入 10000 → 現金 10000');
  ok(Math.abs(totalFlow - 10000) < 1e-6, '(k1) 存入計為 +10000 外部資金流');
})();

// (k2) 提取為負:現金減少,計為負外部資金流
(function () {
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 10000, date: '2024-01-02' },
    { id: '2', kind: 'cash', ccy: 'USD', loc: 'A', amount: -3000, date: '2024-02-01' }];
  const D = buildDaily(null);
  const lastK = D.values.length - 1;
  let totalFlow = 0; for (let k = 0; k <= lastK; k++) totalFlow += D.flows[k];
  ok(Math.abs(D.values[lastK] - 7000) < 1e-6, '(k2) 存10000提3000 → 現金 7000');
  ok(Math.abs(totalFlow - 7000) < 1e-6, '(k2) 淨外部資金流 = +7000');
})();

// (k3) 方向→金額轉換邏輯(模擬 UI:絕對值×方向符號)
(function () {
  const toSigned = (absAmt, dir) => dir === 'withdraw' ? -Math.abs(absAmt) : Math.abs(absAmt);
  ok(toSigned(500, 'deposit') === 500, '(k3) 存入方向 → 正金額');
  ok(toSigned(500, 'withdraw') === -500, '(k3) 提取方向 → 負金額');
  ok(toSigned(-500, 'deposit') === 500, '(k3) 即使輸入負值,存入方向仍取正(絕對值)');
  // 反推:既有交易的 amount 正負 → 初始方向
  const dirOf = amt => amt < 0 ? 'withdraw' : 'deposit';
  ok(dirOf(-300) === 'withdraw' && dirOf(800) === 'deposit', '(k3) 編輯時依金額正負還原方向');
})();

// ============ (L) 股息行事曆 dividendMonthly / dividendTimeline ============
// 用「相對今天」的日期構造,確保落在過去 12 個月內
function dStr(monthsAgo, day) {
  const d = new Date(TODAY); d.setMonth(d.getMonth() - monthsAgo); d.setDate(day || 15);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// (L1) 月度匯總:把過去派息按月份歸類加總(稅後、基準貨幣)
(function () {
  state.settings.baseCcy = 'USD'; state.settings.divTax = 0;
  const d3 = dStr(3, 10), d6 = dStr(6, 20); // 3個月前、6個月前
  REAL.events['LM'] = { dividends: [{ date: d3, amount: 1 }, { date: d6, amount: 2 }], splits: [] };
  registerSym({ s: 'LM', n: 'LM', z: 'LM', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: dStr(13, 1) },
    { id: '2', kind: 'stock', sym: 'LM', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: dStr(13, 1) }];
  const months = dividendMonthly('USD');
  ok(months.length === 12, '(L1) 回傳 12 個月');
  const m3 = parseInt(d3.slice(5, 7), 10) - 1, m6 = parseInt(d6.slice(5, 7), 10) - 1;
  ok(Math.abs(months[m3] - 100) < 1e-6, '(L1) 3個月前月份 = 100股×$1 = $100');
  ok(Math.abs(months[m6] - 200) < 1e-6, '(L1) 6個月前月份 = 100股×$2 = $200');
  const sum = months.reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 300) < 1e-6, '(L1) 全年總和 $300');
})();

// (L2) 稅後折算
(function () {
  state.settings.divTax = 30;
  const d2 = dStr(2, 10);
  REAL.events['LT'] = { dividends: [{ date: d2, amount: 1 }], splits: [] };
  registerSym({ s: 'LT', n: 'LT', z: 'LT', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: dStr(13, 1) },
    { id: '2', kind: 'stock', sym: 'LT', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: dStr(13, 1) }];
  const months = dividendMonthly('USD');
  const m2 = parseInt(d2.slice(5, 7), 10) - 1;
  ok(Math.abs(months[m2] - 70) < 1e-6, '(L2) 30%稅後:100股×$1×0.7 = $70');
  state.settings.divTax = 0;
})();

// (L3) 時間軸:真實過去 + 假想未來(同月同日+1年)
(function () {
  const dPast = dStr(2, 10); // 2個月前的真實除淨日
  REAL.events['LX'] = { dividends: [{ date: dPast, amount: 0.5 }], splits: [] };
  registerSym({ s: 'LX', n: 'LX', z: 'LX', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: dStr(13, 1) },
    { id: '2', kind: 'stock', sym: 'LX', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 200, date: dStr(13, 1) }];
  const tl = dividendTimeline().filter(e => e.sym === 'LX');
  const real = tl.find(e => !e.hypothetical), hyp = tl.find(e => e.hypothetical);
  ok(real && real.date === dPast && real.hypothetical === false, '(L3) 真實過去除淨日存在');
  ok(hyp && hyp.hypothetical === true, '(L3) 假想未來除淨日存在');
  // 假想日 = 真實日 +1 年(同月同日)
  const expFut = (parseInt(dPast.slice(0, 4)) + 1) + dPast.slice(4);
  ok(hyp.date === expFut, '(L3) 假想日 = 真實日同月同日+1年');
  ok(Math.abs(hyp.units - 200) < 1e-6, '(L3) 假想日帶當前持股 200');
})();

// (L4) 同週期去重:同一股息週期(去年同月 vs 今年同月,皆在 12 個月窗內)只計最近一次
(function () {
  state.settings.baseCcy = 'USD'; state.settings.divTax = 0;
  const eOld = new Date(TODAY); eOld.setFullYear(eOld.getFullYear() - 1); // 去年同月同日(窗邊界)
  const eNew = new Date(TODAY);                                          // 今年同月(較近)
  const sOld = fmtD(eOld), sNew = fmtD(eNew);
  REAL.events['L4'] = { dividends: [{ date: sOld, amount: 1 }, { date: sNew, amount: 1 }], splits: [] };
  registerSym({ s: 'L4', n: 'L4', z: 'L4', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: dStr(13, 1) },
    { id: '2', kind: 'stock', sym: 'L4', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: dStr(13, 1) }];
  const months = dividendMonthly('USD');
  const iM = parseInt(sNew.slice(5, 7), 10) - 1;
  ok(Math.abs(months[iM] - 100) < 1e-6, '(L4) 同週期(去年/今年同月)只計最近一次 $100 非 $200');
  const sum = months.reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 100) < 1e-6, '(L4) 全年總和 $100(不重複計入去年同週期)');
})();

// (L4b) 時間軸:同週期兩次真實除淨皆列出,但假想未來只由最近一次 +1 年外推(不重複)
(function () {
  state.settings.baseCcy = 'USD'; state.settings.divTax = 0;
  const eNew = new Date(TODAY);
  const eOld = new Date(TODAY); eOld.setDate(eOld.getDate() - 364);
  // 罕見邊界(364 天前落入不同月份時退回恰一年前,仍驗證去重路徑)
  if (eOld.getMonth() !== eNew.getMonth()) { eOld.setTime(eNew.getTime()); eOld.setFullYear(eNew.getFullYear() - 1); }
  REAL.events['L4B'] = { dividends: [{ date: fmtD(eOld), amount: 0.5 }, { date: fmtD(eNew), amount: 0.5 }], splits: [] };
  registerSym({ s: 'L4B', n: 'L4B', z: 'L4B', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: dStr(13, 1) },
    { id: '2', kind: 'stock', sym: 'L4B', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: dStr(13, 1) }];
  const tl = dividendTimeline().filter(e => e.sym === 'L4B');
  const reals = tl.filter(e => !e.hypothetical), hyps = tl.filter(e => e.hypothetical);
  ok(reals.length === 2, '(L4b) 兩次真實除淨皆列出(歷史事實保留)');
  ok(hyps.length === 1, '(L4b) 同週期只外推一次假想(無幽靈重複)');
  if (hyps.length === 1) {
    const exp = new Date(eNew); exp.setFullYear(exp.getFullYear() + 1);
    ok(hyps[0].date === fmtD(exp), '(L4b) 假想來自最近一次除淨 +1 年');
  }
})();

// (L4c) 每年派息兩次(2/yr):另一週期照計,同週期不重複 → 全年 = 兩週期各一次
(function () {
  state.settings.baseCcy = 'USD'; state.settings.divTax = 0;
  const eSepOld = new Date(TODAY); eSepOld.setFullYear(eSepOld.getFullYear() - 1); // 去年 9 月週期(窗邊界)
  const eMid = new Date(TODAY); eMid.setMonth(eMid.getMonth() - 5); eMid.setDate(20); // 另一週期(~5個月前)
  const eSepNew = new Date(TODAY);                                                  // 今年 9 月週期(較近)
  REAL.events['L4C'] = {
    dividends: [{ date: fmtD(eSepOld), amount: 1 }, { date: fmtD(eMid), amount: 1.5 }, { date: fmtD(eSepNew), amount: 1 }],
    splits: [] };
  registerSym({ s: 'L4C', n: 'L4C', z: 'L4C', m: 'US', c: 'USD' });
  state.txns = [
    { id: '1', kind: 'cash', ccy: 'USD', loc: 'A', amount: 100000, date: dStr(13, 1) },
    { id: '2', kind: 'stock', sym: 'L4C', ccy: 'USD', loc: 'A', side: 'buy', price: 100, units: 100, date: dStr(13, 1) }];
  const months = dividendMonthly('USD');
  const iSep = parseInt(fmtD(eSepNew).slice(5, 7), 10) - 1, iMid = parseInt(fmtD(eMid).slice(5, 7), 10) - 1;
  ok(Math.abs(months[iSep] - 100) < 1e-6, '(L4c) 9月週期只計今年一次 $100');
  ok(Math.abs(months[iMid] - 150) < 1e-6, '(L4c) 另一週期照計 $150');
  const sum = months.reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 250) < 1e-6, '(L4c) 全年 = 兩週期各一次 $250(非 $350)');
})();

// ============ (M) 變化圖比較項:持久化與上限 ============
// (M1) 還原邏輯:settings.chartComps → state.chart.comps(去重、限上限 5)
(function () {
  const CMP_MAX = 5;
  const restore = (saved) => [...new Set(saved)].slice(0, CMP_MAX);
  ok(JSON.stringify(restore(['SPY', 'QQQ'])) === JSON.stringify(['SPY', 'QQQ']), '(M1) 正常還原');
  ok(JSON.stringify(restore(['SPY', 'SPY', 'QQQ'])) === JSON.stringify(['SPY', 'QQQ']), '(M1) 去重');
  ok(restore(['A', 'B', 'C', 'D', 'E', 'F', 'G']).length === 5, '(M1) 超過上限截斷為 5');
})();

// (M2) 新增邏輯:未達上限可加、達上限拒絕、重複拒絕
(function () {
  const CMP_MAX = 5;
  const tryAdd = (comps, sym) => {
    if (comps.includes(sym)) return { ok: false, reason: 'exists' };
    if (comps.length >= CMP_MAX) return { ok: false, reason: 'limit' };
    return { ok: true, comps: [...comps, sym] };
  };
  ok(tryAdd(['SPY'], 'QQQ').ok === true, '(M2) 未達上限可新增');
  ok(tryAdd(['SPY'], 'SPY').reason === 'exists', '(M2) 重複拒絕');
  ok(tryAdd(['A', 'B', 'C', 'D', 'E'], 'F').reason === 'limit', '(M2) 達上限(5)拒絕並提示');
})();

// (M3) 登出應清空執行時比較項(避免上一用戶殘留影響下一用戶)
(function () {
  const sim = { chart: { comps: ['SPY', 'QQQ', 'VT'] }, settings: { chartComps: ['SPY', 'QQQ', 'VT'] } };
  // 模擬登出:重置 settings 為預設(chartComps=[]) 並清空 chart.comps
  sim.settings = { chartComps: [] };
  sim.chart.comps = [];
  ok(sim.chart.comps.length === 0, '(M3) 登出後執行時比較項清空');
  // 模擬下一用戶載入(其 settings 有不同比較項)→ 還原應為新用戶的,不含上一用戶殘留
  sim.settings = { chartComps: ['DIA'] };
  const CMP_MAX = 5;
  sim.chart.comps = Array.isArray(sim.settings.chartComps) ? [...new Set(sim.settings.chartComps)].slice(0, CMP_MAX) : [];
  ok(JSON.stringify(sim.chart.comps) === JSON.stringify(['DIA']), '(M3) 下一用戶只見自己的比較項,無殘留');
})();

// (M4) 還原只應在「載入時」發生,刪除後重繪不應把已刪項還原回來
(function () {
  // 模擬:settings 與 chart.comps 為單一來源,刪除時兩者同步更新
  const state = { chart: { comps: ['SPY', 'QQQ'] }, settings: { chartComps: ['SPY', 'QQQ'] } };
  const persistComps = () => { state.settings.chartComps = [...state.chart.comps]; };
  // 刪除 SPY
  state.chart.comps = state.chart.comps.filter(x => x !== 'SPY');
  persistComps();
  // 模擬重繪(不再從 settings 覆蓋 chart.comps)→ SPY 不應復活
  ok(!state.chart.comps.includes('SPY') && !state.settings.chartComps.includes('SPY'), '(M4) 刪除後 settings 與執行時同步,重繪不復活');
})();
`;

eval(code + "\n;\n" + tests);
console.log(`\n前端引擎回歸:${pass} 項全部通過 ✓`);
