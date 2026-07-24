'use strict';
/*
 * exit-study.js — "매도(청산) 방식" 비교 연구 (러너에서 실행)
 *
 * 진입 신호 = 우리가 알림 보내는 MACD 골든크로스(0선 아래) = gcBelowZero.
 *   (macd[i] < 0 AND macd 전일<=signal 전일 AND macd[i]>signal[i]) → 다음날 시가 진입.
 * 매도 방식만 바꿔가며(격리 비교) 어떤 청산이 좋은지 검증. 종목별 순차 비중첩 트레이드.
 * 거래별 기대값·승률·손익비·최대손실을 방식별로 집계 → data/sim/exit_study.json.
 */

const fs = require('fs');
const path = require('path');
const { fetchAllCandles } = require('./naver-candles');
const { recomputeIndicators } = require('./sim-engine');

const COST_BUY = 1 + 0.00015 + 0.001;   // 1.00115
const COST_SELL = 1 - 0.00015 - 0.001 - 0.0018; // 0.99725
const MAX_HOLD = 60;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/* ATR14 (Wilder) */
function atr14(candles) {
  const n = candles.length, out = new Array(n).fill(null);
  let prev = null, sum = 0, cnt = 0;
  for (let i = 1; i < n; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    if (!isNum(h) || !isNum(l) || !isNum(pc)) continue;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (prev == null) { sum += tr; cnt++; if (cnt === 14) { prev = sum / 14; out[i] = prev; } }
    else { prev = (prev * 13 + tr) / 14; out[i] = prev; }
  }
  return out;
}

/* 매도 방식들 — 각 trade(entryIdx 진입, candles/ind/atr) 시뮬 → {exitIdx,exitPx,reason,hold} */
const METHODS = [
  { id: 'deadcross', label: 'MACD 데드크로스' },
  { id: 'ma20break', label: 'MA20 이탈' },
  { id: 'rsi70', label: 'RSI 70 과열' },
  { id: 'tp15_sl8', label: '고정 익절+15%/손절-8%' },
  { id: 'chandelier_atr3', label: '샹들리에 ATR×3 트레일' },
  { id: 'trailclose12', label: '트레일링(종가 -12%)' },
  { id: 'dead_sl8', label: '데드크로스 + 손절-8%(콤보)' },
  { id: 'time20', label: '시간 청산(20일)' },
  { id: 'chand_sl10_dead', label: '샹들리에ATR3 + 손절-10% + 데드크로스(하이브리드)' },
];

function simTrade(methodId, candles, ind, atr, entryIdx) {
  const { macd, signal, rsi, ma20 } = ind;
  const entryPx = isNum(candles[entryIdx].open) ? candles[entryIdx].open : candles[entryIdx].close;
  const n = candles.length;
  let peakHigh = candles[entryIdx].high, peakClose = candles[entryIdx].close;
  let chandStop = -Infinity;
  let pendingClose = false; // 종가신호 → 다음날 시가 청산 예약
  for (let d = entryIdx + 1; d < n; d++) {
    const bar = candles[d];
    const O = isNum(bar.open) ? bar.open : bar.close, H = isNum(bar.high) ? bar.high : bar.close, L = isNum(bar.low) ? bar.low : bar.close, C = bar.close;
    // 0) 예약된 종가신호 청산 → 오늘 시가
    if (pendingClose) return mk(d, O, '신호청산');
    // 1) 방식별 장중 가격 트리거 (갭 우선)
    const hardStop = (pct) => { const s = entryPx * (1 - pct / 100); if (O <= s) return O; if (L <= s) return s; return null; };
    const target = (pct) => { const t = entryPx * (1 + pct / 100); if (O >= t) return O; if (H >= t) return t; return null; };
    if (methodId === 'tp15_sl8') { const s = hardStop(8); if (s != null) return mk(d, s, '손절'); const t = target(15); if (t != null) return mk(d, t, '익절'); }
    if (methodId === 'chandelier_atr3' || methodId === 'chand_sl10_dead') {
      if (chandStop > -Infinity) { if (O <= chandStop) return mk(d, O, '트레일청산'); if (L <= chandStop) return mk(d, chandStop, '트레일청산'); }
    }
    if (methodId === 'chand_sl10_dead') { const s = hardStop(10); if (s != null) return mk(d, s, '손절'); }
    if (methodId === 'trailclose12') { const s = peakClose * 0.88; if (O <= s) return mk(d, O, '트레일청산'); if (L <= s) return mk(d, s, '트레일청산'); }
    if (methodId === 'dead_sl8') { const s = hardStop(8); if (s != null) return mk(d, s, '손절'); }
    // 2) 종가 신호 (다음날 시가 청산 예약)
    let sigFire = false;
    if (methodId === 'deadcross' || methodId === 'dead_sl8' || methodId === 'chand_sl10_dead') {
      if (isNum(macd[d]) && isNum(signal[d]) && isNum(macd[d - 1]) && isNum(signal[d - 1]) && macd[d - 1] >= signal[d - 1] && macd[d] < signal[d]) sigFire = true;
    }
    if (methodId === 'ma20break' && isNum(ma20[d]) && C < ma20[d]) sigFire = true;
    if (methodId === 'rsi70' && isNum(rsi[d]) && rsi[d] >= 70) sigFire = true;
    if (sigFire) pendingClose = true;
    // 3) 시간 청산
    if (methodId === 'time20' && d - entryIdx >= 20) return mk(d, C, '시간청산');
    if (d - entryIdx >= MAX_HOLD) return mk(d, C, '시간청산');
    // 4) 피크·샹들리에 갱신 (인과적: 오늘까지 반영, 내일 판정에 사용)
    if (isNum(H) && H > peakHigh) peakHigh = H;
    if (isNum(C) && C > peakClose) peakClose = C;
    if ((methodId === 'chandelier_atr3' || methodId === 'chand_sl10_dead') && isNum(atr[d])) {
      const cs = peakHigh - 3 * atr[d];
      if (cs > chandStop) chandStop = cs; // 래칫업
    }
  }
  // 창 종료
  return mk(n - 1, candles[n - 1].close, '종료청산');

  function mk(exitIdx, exitPx, reason) {
    const gross = exitPx / entryPx;
    const net = (exitPx * COST_SELL) / (entryPx * COST_BUY);
    return { entryIdx, entryDate: candles[entryIdx].date, entryPx: Math.round(entryPx), exitIdx, exitDate: candles[exitIdx].date, exitPx: Math.round(exitPx), reason, hold: exitIdx - entryIdx, retPct: Math.round((net - 1) * 10000) / 100 };
  }
}

function gcEntries(ind) {
  const { macd, signal } = ind;
  const out = [];
  for (let i = 1; i < macd.length; i++) {
    if (isNum(macd[i]) && isNum(signal[i]) && isNum(macd[i - 1]) && isNum(signal[i - 1]) &&
      macd[i] < 0 && macd[i - 1] <= signal[i - 1] && macd[i] > signal[i]) out.push(i);
  }
  return out;
}

function agg(trades) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const rets = trades.map((t) => t.retPct).sort((a, b) => a - b);
  const wins = trades.filter((t) => t.retPct > 0), losses = trades.filter((t) => t.retPct < 0);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sum = rets.reduce((a, b) => a + b, 0);
  const avgWin = mean(wins.map((t) => t.retPct)), avgLoss = mean(losses.map((t) => t.retPct));
  // 순차 복리(참고용): 시간순 정렬 후 (1+ret) 누적 — 자본/중첩 무시한 근사
  const byTime = [...trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  let eq = 1; for (const t of byTime) eq *= (1 + t.retPct / 100 * 0.2); // 트레이드당 20% 비중 근사
  return {
    trades: n,
    avgRetPct: Math.round(mean(rets) * 100) / 100,
    medianRetPct: rets[Math.floor(n / 2)],
    winRate: Math.round((wins.length / n) * 1000) / 10,
    avgWinPct: Math.round(avgWin * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    payoff: avgLoss !== 0 ? Math.round((avgWin / -avgLoss) * 100) / 100 : null,
    expectancyPct: Math.round(mean(rets) * 100) / 100,
    maxLossPct: rets[0], maxWinPct: rets[n - 1],
    avgHold: Math.round(mean(trades.map((t) => t.hold)) * 10) / 10,
    sumRetPct: Math.round(sum * 10) / 10,
    compoundApprox: Math.round((eq - 1) * 1000) / 10,
  };
}

async function main() {
  console.log('매도 방식 비교 연구 — MACD 골든크로스(0선 아래) 진입');
  const { universe } = await fetchAllCandles({ concurrency: 6 });
  console.log(`캔들 확보: ${universe.length}종목`);
  const prepared = universe.map((u) => ({ ...u, ind: recomputeIndicators(u.candles), atr: atr14(u.candles) }));

  let totalSignals = 0;
  const byMethod = {}; METHODS.forEach((m) => (byMethod[m.id] = []));
  for (const s of prepared) {
    const entries = gcEntries(s.ind);
    // 종목별 순차 비중첩: 각 방식 독립적으로 다음 진입은 직전 청산 이후
    for (const m of METHODS) {
      let cursor = -1;
      for (const ei of entries) {
        if (ei <= cursor) continue;
        const entryIdx = ei + 1; if (entryIdx >= s.candles.length) continue;
        const tr = simTrade(m.id, s.candles, s.ind, s.atr, entryIdx);
        tr.code = s.code; tr.name = s.name;
        byMethod[m.id].push(tr);
        cursor = tr.exitIdx;
      }
    }
    totalSignals += entries.length;
  }
  console.log(`총 진입 신호(종목 합산): ${totalSignals}`);

  const results = METHODS.map((m) => ({ id: m.id, label: m.label, metrics: agg(byMethod[m.id]), trades: byMethod[m.id] }));
  console.log('\n=== 매도 방식별 결과 (거래당 기대값 기준) ===');
  const ranked = [...results].sort((a, b) => (b.metrics.expectancyPct || -99) - (a.metrics.expectancyPct || -99));
  for (const r of ranked) {
    const m = r.metrics;
    console.log(`  ${r.label.padEnd(34)} 거래${String(m.trades).padStart(4)} 기대값${String(m.expectancyPct).padStart(7)}% 승률${String(m.winRate).padStart(5)}% 손익비${String(m.payoff).padStart(5)} 평균보유${String(m.avgHold).padStart(5)}일 최대손실${String(m.maxLossPct).padStart(7)}%`);
  }

  const out = {
    generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19) + '+09:00',
    entrySignal: 'MACD 골든크로스(0선 아래) = gcBelowZero, 다음날 시가 진입',
    universe: universe.length, totalSignals,
    note: '매도 방식 격리 비교(종목별 순차 비중첩). retPct는 매수/매도 비용 반영. compoundApprox는 트레이드당 20% 비중 순차 근사(중첩·자본제약 무시).',
    methods: results,
  };
  for (const dir of [path.join(__dirname, '..', 'public', 'data', 'sim'), path.join(__dirname, '..', 'data', 'sim')]) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'exit_study.json'), JSON.stringify(out)); } catch {}
  }
  console.log('\n저장: data/sim/exit_study.json');
}

if (require.main === module) main().catch((e) => { console.error('실패:', e.stack || e.message); process.exit(1); });
module.exports = { simTrade, gcEntries, atr14, agg, METHODS };
