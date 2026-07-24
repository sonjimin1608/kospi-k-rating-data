'use strict';
/*
 * strategy-search.js — 진화적 전략 탐색 (러너에서 실행: 네이버 캔들 필요)
 *
 * 기존 4전술의 시그널 요소를 "유전자(게이트/청산/파라미터)"로 조합해 개체군을 만들고,
 * 최근 1년 포트폴리오 백테스트 적합도(총수익 - 0.5×MDD, 거래≥15)로 세대를 거쳐 개선한다.
 * 결과: 상위 5개 진화 전략 + 기존 4전략 지표 + 전체 거래로그를 data/sim/search_results.json 에 저장.
 *
 * 사용: node scripts/strategy-search.js  (선택: SEARCH_GENS, SEARCH_POP 환경변수)
 */

const fs = require('fs');
const path = require('path');
const sim = require('./sim-engine');

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };
const RETRIES = 2;
const CONCURRENCY = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } catch (e) {
    if (attempt >= RETRIES) throw new Error(`${url} 실패: ${e.message}`);
    await sleep(500 * Math.pow(2, attempt));
    return fetchText(url, attempt + 1);
  }
}
const fetchJson = async (u) => JSON.parse(await fetchText(u));

async function fetchKospi200() {
  const stocks = [];
  const seen = new Set();
  for (let page = 1; page <= 6; page++) {
    const arr = await fetchJson(`https://m.stock.naver.com/api/index/KPI200/enrollStocks?page=${page}&pageSize=60`);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const it of arr) {
      if (seen.has(it.itemCode)) continue;
      seen.add(it.itemCode);
      stocks.push({ code: it.itemCode, name: it.stockName });
    }
    if (arr.length < 60) break;
  }
  return stocks;
}

function parseFchart(xml) {
  const out = [];
  const re = /item\s+data="([^"]+)"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const p = m[1].split('|');
    if (p.length < 6) continue;
    const close = num(p[4]);
    if (close == null) continue;
    out.push({
      date: `${p[0].slice(0, 4)}-${p[0].slice(4, 6)}-${p[0].slice(6, 8)}`,
      open: num(p[1]), high: num(p[2]), low: num(p[3]), close, volume: num(p[5]) ?? 0,
    });
  }
  return out;
}

async function fetchCandles(code) {
  const xml = await fetchText(`https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=300&requestType=0`);
  return parseFchart(xml);
}

/* ───────── 시드 난수 (재현성) ───────── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260724);
const rand = () => rng();
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const randF = (lo, hi) => lo + rand() * (hi - lo);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;

/* ───────── 유전자 → 전략 ───────── */
const ENTRY_GATES = ['golden', 'macdPos', 'trendAlign', 'aboveMa20', 'aboveMa60', 'breakout20', 'volSurge', 'rsiBand', 'bandLower', 'bandUpper', 'momPos', 'scoreMin', 'snapback'];
const EXIT_GATES = ['dead', 'belowMa20', 'belowMa60', 'rsiHigh', 'bandMid', 'momFade'];
const req = (v) => v != null && Number.isFinite(v);

function makeStrategy(g, id) {
  const P = g.params, G = g.gates, X = g.exits;
  const entry = (ind, i, c) => {
    if (i < 1) return false;
    const { rsi, macd, signal, hist, ma20, ma60, pctB, mom20, hi20, volZ } = ind;
    const close = c[i].close;
    if (G.golden) { if (!req(macd[i]) || !req(signal[i]) || !req(macd[i - 1]) || !req(signal[i - 1]) || !(macd[i - 1] <= signal[i - 1] && macd[i] > signal[i])) return false; }
    if (G.macdPos) { if (!req(macd[i]) || !req(signal[i]) || !req(hist[i]) || !(macd[i] > signal[i] && hist[i] > 0)) return false; }
    if (G.trendAlign) { if (!req(ma20[i]) || !req(ma60[i]) || !(ma20[i] > ma60[i])) return false; }
    if (G.aboveMa20) { if (!req(ma20[i]) || !(close > ma20[i])) return false; }
    if (G.aboveMa60) { if (!req(ma60[i]) || !(close > ma60[i])) return false; }
    if (G.breakout20) { if (!req(hi20[i]) || !(close > hi20[i])) return false; }
    if (G.volSurge) { if (!req(volZ[i]) || !(volZ[i] >= P.volZ)) return false; }
    if (G.rsiBand) { if (!req(rsi[i]) || !(rsi[i] >= P.rsiLo && rsi[i] <= P.rsiHi)) return false; }
    if (G.bandLower) { if (!req(pctB[i]) || !(pctB[i] <= P.bandLo)) return false; }
    if (G.bandUpper) { if (!req(pctB[i]) || !(pctB[i] >= 0.5)) return false; }
    if (G.momPos) { if (!req(mom20[i]) || !(mom20[i] > 0)) return false; }
    if (G.scoreMin) { const sc = sim.multifactorScore(ind, i, c); if (!sc || !(sc.score >= P.score && sc.agree >= P.agree)) return false; }
    if (G.snapback) { if (!req(c[i].open) || !req(c[i - 1].close) || !(close > c[i].open && close > c[i - 1].close)) return false; }
    return true;
  };
  const exitSignal = (ind, i, c) => {
    const { rsi, macd, signal, hist, ma20, ma60 } = ind;
    const close = c[i].close;
    if (X.dead && req(macd[i]) && req(signal[i]) && req(macd[i - 1]) && req(signal[i - 1]) && macd[i - 1] >= signal[i - 1] && macd[i] < signal[i]) return true;
    if (X.belowMa20 && req(ma20[i]) && close < ma20[i]) return true;
    if (X.belowMa60 && req(ma60[i]) && close < ma60[i]) return true;
    if (X.rsiHigh && req(rsi[i]) && rsi[i] >= P.rsiExit) return true;
    if (X.bandMid && req(ma20[i]) && close >= ma20[i]) return true;
    if (X.momFade && req(macd[i]) && req(signal[i]) && req(hist[i]) && req(hist[i - 1]) && macd[i] < signal[i] && hist[i] < hist[i - 1]) return true;
    return false;
  };
  return { id, name: id, entry, exitSignal, stopPct: P.stopPct, takeProfitPct: P.tpPct, trailingPct: P.trailPct, maxHoldDays: P.maxHold };
}

function randomParams() {
  const rsiLo = randInt(25, 55);
  return {
    stopPct: randInt(3, 12), tpPct: randInt(8, 40), trailPct: chance(0.6) ? randInt(3, 20) : 0, maxHold: randInt(6, 55),
    volZ: Math.round(randF(-0.5, 2.5) * 10) / 10, rsiLo, rsiHi: randInt(Math.max(rsiLo + 5, 58), 85),
    bandLo: Math.round(randF(0.05, 0.35) * 100) / 100, score: randInt(55, 80), agree: randInt(2, 4), rsiExit: randInt(48, 82),
  };
}
function randomGenome() {
  const gates = {}; ENTRY_GATES.forEach((k) => { gates[k] = chance(0.32); });
  if (!ENTRY_GATES.some((k) => gates[k])) gates[pick(ENTRY_GATES)] = true;
  // bandLower(과매도)와 breakout/신고가는 상충 → 동시선택 시 하나 제거
  if (gates.bandLower && gates.breakout20) gates.breakout20 = false;
  const exits = {}; EXIT_GATES.forEach((k) => { exits[k] = chance(0.4); });
  return { gates, exits, params: randomParams() };
}

// 기존 4전략의 유전자 인코딩(시드)
const SEEDS = [
  { gates: { golden: 1, trendAlign: 1, aboveMa20: 1, rsiBand: 1, volSurge: 1 }, exits: { dead: 1, belowMa20: 1 }, params: { stopPct: 5, tpPct: 15, trailPct: 8, maxHold: 20, volZ: 0, rsiLo: 45, rsiHi: 65, bandLo: 0.1, score: 70, agree: 3, rsiExit: 60 } },
  { gates: { rsiBand: 1, bandLower: 1, snapback: 1, volSurge: 1 }, exits: { rsiHigh: 1, bandMid: 1 }, params: { stopPct: 5, tpPct: 8, trailPct: 4, maxHold: 8, volZ: 1.0, rsiLo: 0, rsiHi: 32, bandLo: 0.1, score: 70, agree: 3, rsiExit: 50 } },
  { gates: { breakout20: 1, volSurge: 1, aboveMa60: 1, trendAlign: 1, aboveMa20: 1, macdPos: 1, rsiBand: 1 }, exits: { belowMa20: 1, momFade: 1 }, params: { stopPct: 7, tpPct: 30, trailPct: 12, maxHold: 40, volZ: 1.5, rsiLo: 55, rsiHi: 80, bandLo: 0.1, score: 70, agree: 3, rsiExit: 60 } },
  { gates: { scoreMin: 1, trendAlign: 1, aboveMa20: 1, macdPos: 1, rsiBand: 1 }, exits: { belowMa60: 1, momFade: 1, dead: 1 }, params: { stopPct: 7, tpPct: 20, trailPct: 10, maxHold: 25, volZ: 0, rsiLo: 0, rsiHi: 72, bandLo: 0.1, score: 70, agree: 3, rsiExit: 60 } },
];

function cloneGenome(g) { return { gates: { ...g.gates }, exits: { ...g.exits }, params: { ...g.params } }; }
function normGates(o, keys) { const r = {}; keys.forEach((k) => { if (o[k]) r[k] = 1; }); return r; }
function sig(g) {
  const P = g.params;
  return JSON.stringify([normGates(g.gates, ENTRY_GATES), normGates(g.exits, EXIT_GATES),
    P.stopPct, P.tpPct, P.trailPct, P.maxHold, P.volZ, P.rsiLo, P.rsiHi, P.bandLo, P.score, P.agree, P.rsiExit]);
}

function crossover(a, b) {
  const gates = {}; ENTRY_GATES.forEach((k) => { gates[k] = (chance(0.5) ? a.gates[k] : b.gates[k]) ? 1 : 0; });
  if (!ENTRY_GATES.some((k) => gates[k])) gates[pick(ENTRY_GATES)] = 1;
  if (gates.bandLower && gates.breakout20) gates.breakout20 = 0;
  const exits = {}; EXIT_GATES.forEach((k) => { exits[k] = (chance(0.5) ? a.exits[k] : b.exits[k]) ? 1 : 0; });
  const params = {};
  for (const k of Object.keys(a.params)) params[k] = chance(0.5) ? a.params[k] : b.params[k];
  if (params.rsiHi <= params.rsiLo + 4) params.rsiHi = params.rsiLo + 5;
  return { gates, exits, params };
}
function mutate(g) {
  const n = cloneGenome(g);
  if (chance(0.5)) { const k = pick(ENTRY_GATES); n.gates[k] = n.gates[k] ? 0 : 1; if (!ENTRY_GATES.some((x) => n.gates[x])) n.gates[pick(ENTRY_GATES)] = 1; if (n.gates.bandLower && n.gates.breakout20) n.gates.breakout20 = 0; }
  if (chance(0.4)) { const k = pick(EXIT_GATES); n.exits[k] = n.exits[k] ? 0 : 1; }
  if (chance(0.7)) {
    const P = n.params; const k = pick(Object.keys(P));
    const jitter = { stopPct: [3, 12], tpPct: [8, 40], trailPct: [0, 20], maxHold: [6, 55], volZ: [-0.5, 2.5], rsiLo: [25, 55], rsiHi: [58, 85], bandLo: [0.05, 0.35], score: [55, 80], agree: [2, 4], rsiExit: [48, 82] };
    const [lo, hi] = jitter[k];
    if (k === 'volZ' || k === 'bandLo') P[k] = Math.round(Math.min(hi, Math.max(lo, P[k] + randF(-0.3, 0.3))) * 100) / 100;
    else P[k] = Math.min(hi, Math.max(lo, Math.round(P[k] + randInt(-3, 3))));
    if (P.rsiHi <= P.rsiLo + 4) P.rsiHi = P.rsiLo + 5;
  }
  return n;
}

function fitness(m) {
  if (!m || m.trades < 15) return -1000 + (m ? m.trades * 10 : 0);
  return m.totalReturnPct - 0.5 * m.mddPct;
}
function calmar(m) { return m.mddPct > 0.01 ? Math.round((m.cagrPct / m.mddPct) * 100) / 100 : null; }

function ruleText(g) {
  const P = g.params;
  const gm = {
    golden: 'MACD 골든크로스', macdPos: 'MACD>시그널&히스토그램>0', trendAlign: 'MA20>MA60(정배열)',
    aboveMa20: '종가>MA20', aboveMa60: '종가>MA60', breakout20: '20일 신고가 돌파',
    volSurge: `거래량Z≥${P.volZ}`, rsiBand: `RSI ${P.rsiLo}~${P.rsiHi}`, bandLower: `볼린저 %b≤${P.bandLo}`,
    bandUpper: '볼린저 %b≥0.5', momPos: '20일 모멘텀>0', scoreMin: `다요인점수≥${P.score}&합의≥${P.agree}`, snapback: '당일 반등(양봉·전일종가 상회)',
  };
  const xm = { dead: '데드크로스', belowMa20: '종가<MA20', belowMa60: '종가<MA60', rsiHigh: `RSI≥${P.rsiExit}`, bandMid: '종가≥MA20', momFade: '모멘텀 소진(MACD<시그널&히스토 감소)' };
  const entry = ENTRY_GATES.filter((k) => g.gates[k]).map((k) => gm[k]);
  const exit = EXIT_GATES.filter((k) => g.exits[k]).map((k) => xm[k]);
  return {
    entry, exit,
    risk: `손절 -${P.stopPct}% · 익절 +${P.tpPct}% · 트레일 ${P.trailPct || '없음'}${P.trailPct ? '%' : ''} · 최대 ${P.maxHold}일`,
  };
}

async function main() {
  const GENS = Number(process.env.SEARCH_GENS || 12);
  const POP = Number(process.env.SEARCH_POP || 48);
  const ELITE = 8;
  console.log(`전략 진화 탐색 시작 — 세대 ${GENS} · 개체군 ${POP}`);

  // 1) 캔들 수집
  const codes = await fetchKospi200();
  console.log(`코스피200 ${codes.length}개 — 캔들 수집…`);
  const universe = [];
  let cur = 0;
  async function worker() {
    while (cur < codes.length) {
      const it = codes[cur++];
      try {
        const candles = await fetchCandles(it.code);
        if (candles.length >= 61) universe.push({ code: it.code, name: it.name, candles, ind: sim.recomputeIndicators(candles) });
      } catch (e) { /* skip */ }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`캔들 확보: ${universe.length}종목 (지표 사전계산 완료)`);

  const cfg = sim.DEFAULT_CFG;
  const evalGenome = (g, id) => {
    const res = sim.runPortfolioBacktest(universe, makeStrategy(g, id), cfg);
    return { g, metrics: res.metrics, res };
  };

  // 2) 기존 4전략 baseline
  const baseline = sim.STRATEGIES.map((st) => {
    const res = sim.runPortfolioBacktest(universe, st, cfg);
    console.log(`  [기존] ${st.name}: 수익 ${res.metrics.totalReturnPct}% · 승률 ${res.metrics.winRate}% · MDD ${res.metrics.mddPct}% · 거래 ${res.metrics.trades} · Calmar ${calmar(res.metrics)}`);
    return { id: st.id, name: st.name, metrics: res.metrics, trades: res.trades, equityCurve: res.equityCurve };
  });

  // 3) 진화
  const seen = new Map(); // sig -> {g, metrics, res, fit}
  const evalCached = (g, id) => {
    const s = sig(g);
    if (seen.has(s)) return seen.get(s);
    const e = evalGenome(g, id); e.fit = fitness(e.metrics); e.sigStr = s;
    seen.set(s, e); return e;
  };

  let pop = [];
  SEEDS.forEach((g, i) => pop.push(cloneGenome(g)));
  while (pop.length < POP) pop.push(randomGenome());

  const progression = [];
  let best = null;
  for (let gen = 0; gen < GENS; gen++) {
    const scored = pop.map((g, i) => evalCached(g, `g${gen}_${i}`)).sort((a, b) => b.fit - a.fit);
    if (!best || scored[0].fit > best.fit) best = scored[0];
    const bm = scored[0].metrics;
    progression.push({ gen, bestFit: Math.round(scored[0].fit * 100) / 100, totalReturnPct: bm.totalReturnPct, mddPct: bm.mddPct, trades: bm.trades, winRate: bm.winRate });
    console.log(`  세대 ${gen}: 최고 적합도 ${Math.round(scored[0].fit * 100) / 100} (수익 ${bm.totalReturnPct}% · MDD ${bm.mddPct}% · 거래 ${bm.trades} · 승률 ${bm.winRate}%)`);
    // 다음 세대
    const next = scored.slice(0, ELITE).map((e) => e.g);
    const poolTop = scored.slice(0, Math.max(ELITE, Math.floor(POP / 2)));
    let guard = 0;
    while (next.length < POP && guard < POP * 20) {
      guard++;
      const a = pick(poolTop).g, b = pick(poolTop).g;
      let child = crossover(a, b);
      if (chance(0.8)) child = mutate(child);
      if (!seen.has(sig(child)) || chance(0.3)) next.push(child);
    }
    while (next.length < POP) next.push(randomGenome());
    pop = next;
  }

  // 4) 전체 유니크 개체 중 상위 5
  const all = [...seen.values()].filter((e) => e.metrics.trades >= 15).sort((a, b) => b.fit - a.fit);
  const top5 = all.slice(0, 5).map((e, i) => {
    const id = `evolved_${i + 1}`;
    return { id, fitness: Math.round(e.fit * 100) / 100, calmar: calmar(e.metrics), rules: ruleText(e.g), params: e.g.params, gates: normGates(e.g.gates, ENTRY_GATES), exits: normGates(e.g.exits, EXIT_GATES), metrics: e.metrics, equityCurve: e.res.equityCurve, trades: e.res.trades };
  });

  console.log('\n=== 진화 결과 TOP 5 ===');
  top5.forEach((t, i) => console.log(`  #${i + 1} ${t.id}: 수익 ${t.metrics.totalReturnPct}% · 승률 ${t.metrics.winRate}% · MDD ${t.metrics.mddPct}% · 거래 ${t.metrics.trades} · Calmar ${t.calmar} · 적합도 ${t.fitness}`));

  const out = {
    generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19) + '+09:00',
    universe: universe.length, generations: GENS, populationSize: POP,
    objective: '적합도 = 총수익률% − 0.5×MDD% (거래 15건 미만 페널티)',
    baseline, progression, evolved: top5,
  };
  const SIM_DIR = path.join(__dirname, '..', 'public', 'data', 'sim');
  fs.mkdirSync(SIM_DIR, { recursive: true });
  fs.writeFileSync(path.join(SIM_DIR, 'search_results.json'), JSON.stringify(out));
  // data/ 에도 복사(러너 커밋 대상)
  const DATA_SIM = path.join(__dirname, '..', 'data', 'sim');
  try { fs.mkdirSync(DATA_SIM, { recursive: true }); fs.writeFileSync(path.join(DATA_SIM, 'search_results.json'), JSON.stringify(out)); } catch {}
  console.log(`\n저장: data/sim/search_results.json (baseline 4 + 진화 5 + 세대기록 ${GENS})`);
}

module.exports = { makeStrategy, randomGenome, crossover, mutate, sig, ruleText, fitness, SEEDS, ENTRY_GATES, EXIT_GATES };

if (require.main === module) {
  main().catch((e) => { console.error('탐색 실패:', e.stack || e.message); process.exit(1); });
}
