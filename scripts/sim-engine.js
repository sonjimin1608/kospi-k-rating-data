'use strict';
/*
 * sim-engine.js — 백테스트 / 모의투자(전진 시뮬) 엔진 (CommonJS, 외부 의존성 0)
 *
 * 데이터: 종목별 일봉 캔들 {date,open,high,low,close,volume} 오름차순.
 * 지표는 캔들에서 인과적(causal)으로 재계산 — 과거 재무·수급·점수는 시계열이 없어 사용 불가.
 *
 * 룩어헤드 방지(백테스트): 신호는 D일 종가로 확정 → D+1 시가 체결(진입·신호청산 공통).
 *   손절/익절/트레일링은 당일 봉의 시가·고가·저가로 판정하되, 갭(open)을 먼저 해소한다.
 * 모의투자(전진): 실시간가 기준으로 매 호출 1스텝 전진(장중 10분마다). maxHoldDays 시간청산 포함.
 *
 * export: { STRATEGIES, DEFAULT_CFG, recomputeIndicators, decideExit,
 *           runPortfolioBacktest, advancePaper }
 */

const DEFAULT_CFG = {
  startCash: 10_000_000,
  maxPositions: 5,
  posFrac: 0.2,          // 1회 매수 상한 = 초기자본 × 0.2
  lookbackDays: 252,     // 백테스트 창(최근 거래일)
  commission: 0.00015,   // 편도 수수료
  slippage: 0.001,       // 편도 슬리피지
  sellTax: 0.0018,       // 매도세(거래세)
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);

/* ───────────────────────── 지표 재계산 (인과적) ───────────────────────── */

function emaSeries(vals, period) {
  const out = new Array(vals.length).fill(null);
  const k = 2 / (period + 1);
  let seedSum = 0, cnt = 0, prev = null, started = false;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!isNum(v)) { out[i] = started ? prev : null; continue; }
    if (!started) {
      seedSum += v; cnt++;
      if (cnt === period) { prev = seedSum / period; out[i] = prev; started = true; }
    } else { prev = v * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}

function rsiWilder(close, period = 14) {
  const out = new Array(close.length).fill(null);
  let ag = 0, al = 0, cnt = 0, seeded = false;
  for (let i = 1; i < close.length; i++) {
    if (!isNum(close[i]) || !isNum(close[i - 1])) { continue; }
    const d = close[i] - close[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (!seeded) {
      ag += g; al += l; cnt++;
      if (cnt === period) { ag /= period; al /= period; seeded = true; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
    } else {
      ag = (ag * (period - 1) + g) / period;
      al = (al * (period - 1) + l) / period;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
  }
  return out;
}

function smaAt(vals, i, period) {
  if (i < period - 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) { if (!isNum(vals[k])) return null; s += vals[k]; }
  return s / period;
}

function popStdAt(vals, i, period, mean) {
  if (i < period - 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) { if (!isNum(vals[k])) return null; const d = vals[k] - mean; s += d * d; }
  return Math.sqrt(s / period);
}

/** 캔들 → 지표 시계열 (초기 워밍업은 null) */
function recomputeIndicators(candles) {
  const n = candles.length;
  const close = candles.map((c) => (isNum(c.close) ? c.close : null));
  const high = candles.map((c) => (isNum(c.high) ? c.high : null));
  const vol = candles.map((c) => (isNum(c.volume) ? c.volume : null));

  const rsi = rsiWilder(close, 14);
  const ema12 = emaSeries(close, 12);
  const ema26 = emaSeries(close, 26);
  const macd = close.map((_, i) => (isNum(ema12[i]) && isNum(ema26[i]) ? ema12[i] - ema26[i] : null));
  const signal = emaSeries(macd, 9);
  const hist = macd.map((m, i) => (isNum(m) && isNum(signal[i]) ? m - signal[i] : null));

  const ma20 = new Array(n).fill(null);
  const ma60 = new Array(n).fill(null);
  const pctB = new Array(n).fill(null);
  const mom20 = new Array(n).fill(null);
  const hi20 = new Array(n).fill(null);
  const volZ = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    ma20[i] = smaAt(close, i, 20);
    ma60[i] = smaAt(close, i, 60);
    if (isNum(ma20[i])) {
      const sd = popStdAt(close, i, 20, ma20[i]);
      if (isNum(sd) && sd > 0) {
        const upper = ma20[i] + 2 * sd, lower = ma20[i] - 2 * sd;
        pctB[i] = (close[i] - lower) / (upper - lower);
      }
    }
    if (i >= 20 && isNum(close[i]) && isNum(close[i - 20]) && close[i - 20] !== 0) {
      mom20[i] = ((close[i] - close[i - 20]) / close[i - 20]) * 100;
    }
    if (i >= 20) {
      let mx = -Infinity, ok = true;
      for (let k = i - 20; k <= i - 1; k++) { if (!isNum(high[k])) { ok = false; break; } if (high[k] > mx) mx = high[k]; }
      hi20[i] = ok ? mx : null;
    }
    const vm = smaAt(vol, i, 20);
    if (isNum(vm)) { const vsd = popStdAt(vol, i, 20, vm); volZ[i] = isNum(vsd) && vsd > 0 ? (vol[i] - vm) / vsd : 0; }
  }
  return { rsi, macd, signal, hist, ma20, ma60, pctB, mom20, hi20, volZ };
}

/* ───────────────────────── 전략 정의 ───────────────────────── */

function multifactorScore(ind, i, c) {
  const { rsi, macd, signal, hist, ma20, ma60, pctB, mom20, hi20, volZ } = ind;
  if (i < 1 || [rsi[i], macd[i], signal[i], hist[i], hist[i - 1], ma20[i], ma60[i], pctB[i], mom20[i], hi20[i], volZ[i]].some((v) => !isNum(v))) return null;
  const close = c[i].close;
  let tb = ma20[i] > ma60[i] ? 60 : 20;
  if (close > ma20[i]) tb += 20;
  if (close > ma60[i]) tb += 20;
  const sTrend = clamp(tb, 0, 100);
  const rv = rsi[i];
  const sRsi = rv <= 35 ? 20 : rv < 50 ? 45 : rv <= 65 ? 90 : rv <= 72 ? 70 : 25;
  let sMacd;
  if (macd[i] > signal[i] && hist[i] > 0) sMacd = macd[i] > 0 ? 90 : 70;
  else if (macd[i] > signal[i]) sMacd = 60; else sMacd = 30;
  const distHigh = ((close - hi20[i]) / hi20[i]) * 100;
  const sHigh = close >= hi20[i] ? 95 : distHigh >= -3 ? 75 : distHigh >= -8 ? 55 : 35;
  const sBand = pctB[i] >= 1.05 ? 40 : pctB[i] >= 0.5 ? 85 : pctB[i] >= 0.2 ? 60 : 35;
  const sVol = volZ[i] >= 1.5 ? 90 : volZ[i] >= 0.5 ? 75 : volZ[i] >= -0.5 ? 55 : 40;
  const score = 0.28 * sTrend + 0.2 * sRsi + 0.22 * sMacd + 0.15 * sHigh + 0.08 * sBand + 0.07 * sVol;
  let agree = 0;
  if (hist[i] > hist[i - 1]) agree++;
  if (mom20[i] > 0) agree++;
  if (pctB[i] > 0.5) agree++;
  if (close >= hi20[i]) agree++;
  if (volZ[i] > 0.5) agree++;
  return { score, agree };
}

const STRATEGIES = [
  {
    id: 'trend_macd_ma_align',
    name: 'MACD 골든크로스 정배열 추세추종',
    archetype: '추세추종',
    stopPct: 5, takeProfitPct: 15, trailingPct: 8, maxHoldDays: 20,
    entry(ind, i, c) {
      const { rsi, macd, signal, ma20, ma60, volZ } = ind;
      if (i < 1 || [rsi[i], macd[i], signal[i], macd[i - 1], signal[i - 1], ma20[i], ma60[i], volZ[i]].some((v) => !isNum(v))) return false;
      const gc = macd[i - 1] <= signal[i - 1] && macd[i] > signal[i];
      return gc && ma20[i] > ma60[i] && c[i].close > ma20[i] && rsi[i] >= 45 && rsi[i] <= 65 && volZ[i] >= 0;
    },
    exitSignal(ind, i, c) {
      const { macd, signal, ma20 } = ind;
      if (i < 1 || [macd[i], signal[i], macd[i - 1], signal[i - 1], ma20[i]].some((v) => !isNum(v))) return false;
      const dc = macd[i - 1] >= signal[i - 1] && macd[i] < signal[i];
      return dc || c[i].close < ma20[i];
    },
  },
  {
    id: 'reversion_rsi_bb_snapback',
    name: '과매도 볼린저 하단 반등',
    archetype: '역추세 반등',
    stopPct: 5, takeProfitPct: 8, trailingPct: 4, maxHoldDays: 8,
    entry(ind, i, c) {
      const { rsi, pctB, volZ } = ind;
      if (i < 1 || [rsi[i], pctB[i], volZ[i]].some((v) => !isNum(v)) || !isNum(c[i - 1].close) || !isNum(c[i].open)) return false;
      return rsi[i] <= 32 && pctB[i] <= 0.10 && c[i].close > c[i].open && c[i].close > c[i - 1].close && volZ[i] >= 1.0;
    },
    exitSignal(ind, i, c) {
      const { rsi, ma20 } = ind;
      if ([rsi[i], ma20[i]].some((v) => !isNum(v))) return false;
      return rsi[i] >= 50 || c[i].close >= ma20[i];
    },
  },
  {
    id: 'breakout_high20_volsurge_trend',
    name: '20일 신고가 돌파 + 거래량 급증',
    archetype: '신고가 돌파',
    stopPct: 7, takeProfitPct: 30, trailingPct: 12, maxHoldDays: 40,
    entry(ind, i, c) {
      const { rsi, macd, signal, hist, ma20, ma60, hi20, volZ } = ind;
      if ([rsi[i], macd[i], signal[i], hist[i], ma20[i], ma60[i], hi20[i], volZ[i]].some((v) => !isNum(v))) return false;
      return c[i].close > hi20[i] && volZ[i] >= 1.5 && c[i].close > ma60[i] && ma20[i] > ma60[i] &&
        c[i].close > ma20[i] && macd[i] > signal[i] && hist[i] > 0 && rsi[i] >= 55 && rsi[i] < 80;
    },
    exitSignal(ind, i, c) {
      const { macd, signal, hist, ma20 } = ind;
      if ([macd[i], signal[i], hist[i], ma20[i]].some((v) => !isNum(v))) return false;
      return c[i].close < ma20[i] || (macd[i] < signal[i] && hist[i] < 0);
    },
  },
  {
    id: 'multifactor_consensus_regime',
    name: '다요인 합의 추세-돌파 종합',
    archetype: '다요인 종합',
    stopPct: 7, takeProfitPct: 20, trailingPct: 10, maxHoldDays: 25,
    entry(ind, i, c) {
      const { rsi, macd, signal, ma20, ma60, volZ } = ind;
      const sc = multifactorScore(ind, i, c);
      if (!sc) return false;
      return sc.score >= 70 && ma20[i] > ma60[i] && c[i].close > ma20[i] && macd[i] > signal[i] &&
        rsi[i] < 72 && volZ[i] > -0.5 && sc.agree >= 3;
    },
    exitSignal(ind, i, c) {
      const { rsi, macd, signal, hist, ma20, ma60 } = ind;
      const sc = multifactorScore(ind, i, c);
      if (!sc || [rsi[i], macd[i], signal[i], hist[i], hist[i - 1], ma20[i], ma60[i]].some((v) => !isNum(v))) return false;
      const close = c[i].close;
      const breakTrend = close < ma20[i] && macd[i] < signal[i];
      const regimeBreak = close < ma60[i];
      const momFade = macd[i] < signal[i] && hist[i] < hist[i - 1];
      const overheat = rsi[i] >= 80 && hist[i] < hist[i - 1];
      return breakTrend || regimeBreak || momFade || overheat || sc.score <= 45;
    },
  },
];

/* ───────────────────────── 청산 판정 (갭 우선) ───────────────────────── */

/**
 * 당일 봉의 가격 트리거로 청산 여부 판정. 갭(open)을 먼저 해소한 뒤 장중 저가/고가 순.
 * 장중 저가·고가가 둘 다 스톱/타깃에 닿는 경우 스톱 우선(보수적).
 * @returns {null | {reason, fill}}
 */
function decideExit(pos, bar, strat) {
  const O = isNum(bar.open) ? bar.open : bar.close;
  const H = isNum(bar.high) ? bar.high : bar.close;
  const L = isNum(bar.low) ? bar.low : bar.close;
  const trailStop = strat.trailingPct ? pos.peakClose * (1 - strat.trailingPct / 100) : -Infinity;
  const effStop = Math.max(pos.stopBase, trailStop);
  const take = pos.targetPrice;
  const stopReason = effStop > pos.stopBase + 1e-9 ? '트레일청산' : '손절';
  if (O <= effStop) return { reason: stopReason, fill: O };      // 갭다운
  if (O >= take) return { reason: '익절', fill: O };             // 갭업(손절 오분류 방지)
  if (L <= effStop) return { reason: stopReason, fill: effStop };
  if (H >= take) return { reason: '익절', fill: take };
  return null;
}

/* ───────────────────────── 백테스트 ───────────────────────── */

function runPortfolioBacktest(universe, strat, cfg = DEFAULT_CFG) {
  const buyMult = 1 + cfg.commission + cfg.slippage;
  const sellMult = 1 - cfg.commission - cfg.slippage - cfg.sellTax;
  const perBudget = cfg.startCash * cfg.posFrac;

  const stocks = [];
  const byCode = new Map();
  for (const s of universe) {
    const c = s.candles || [];
    if (c.length < 61) continue;
    const obj = { code: s.code, name: s.name, c, ind: s.ind || recomputeIndicators(c), dateIdx: new Map(c.map((k, ix) => [k.date, ix])) };
    stocks.push(obj); byCode.set(s.code, obj);
  }
  const allDates = [...new Set(stocks.flatMap((s) => s.c.map((k) => k.date)))].sort();
  const windowDates = allDates.slice(-cfg.lookbackDays);
  if (windowDates.length === 0) return emptyResult(cfg);

  let cash = cfg.startCash;
  const positions = new Map();
  const trades = [];
  const equityCurve = [];
  let pending = [];   // 어제 종가 진입 신호 → 오늘 시가 체결

  const heldCount = () => positions.size;

  const sell = (p, fill, reason, date, li) => {
    const proceeds = p.shares * fill * sellMult;
    cash += proceeds;
    const pnl = proceeds - p.entryCost;
    trades.push({
      code: p.code, name: p.name,
      entryDate: p.entryDate, entryPrice: Math.round(p.entryPrice),
      exitDate: date, exitPrice: Math.round(fill), shares: p.shares,
      targetPrice: Math.round(p.targetPrice), stopPrice: Math.round(p.stopBase),
      reason, returnPct: r2((pnl / p.entryCost) * 100), pnl: Math.round(pnl),
      holdDays: li - p.entryLi,
    });
  };

  for (let w = 0; w < windowDates.length; w++) {
    const date = windowDates[w];

    // A. 어제 신호 진입 체결 (오늘 시가)
    for (const code of pending) {
      if (heldCount() >= cfg.maxPositions) break;
      const s = byCode.get(code); if (!s) continue;
      const li = s.dateIdx.get(date); if (li == null) continue;
      const openPx = isNum(s.c[li].open) ? s.c[li].open : s.c[li].close;
      if (!isNum(openPx) || openPx <= 0) continue;
      const budget = Math.min(cash, perBudget);
      const shares = Math.floor(budget / (openPx * buyMult));
      if (shares <= 0) continue;
      const spend = shares * openPx * buyMult;
      if (spend > cash + 1e-6) continue;
      cash -= spend;
      positions.set(code, {
        code, name: s.name, shares, entryPrice: openPx, entryCost: spend,
        entryDate: date, entryLi: li, peakClose: isNum(s.c[li].close) ? s.c[li].close : openPx,
        targetPrice: openPx * (1 + strat.takeProfitPct / 100), stopBase: openPx * (1 - strat.stopPct / 100),
        pendingSignalExit: false,
      });
    }
    pending = [];

    // B. 보유 청산
    for (const code of [...positions.keys()]) {
      const p = positions.get(code); const s = byCode.get(code);
      const li = s.dateIdx.get(date); if (li == null) continue; // 결측일 → 보유 유지
      const bar = s.c[li];
      // 1) 가격 트리거(손절/익절/트레일 — 갭 우선)
      const px = decideExit(p, bar, strat);
      if (px) { sell(p, px.fill, px.reason, date, li); positions.delete(code); continue; }
      // 2) 어제 종가 신호청산 → 오늘 시가
      if (p.pendingSignalExit) { sell(p, isNum(bar.open) ? bar.open : bar.close, '신호청산', date, li); positions.delete(code); continue; }
      // 3) 최대보유일(로컬 거래일) 초과 → 시간청산(종가)
      if (li - p.entryLi >= strat.maxHoldDays) { sell(p, bar.close, '시간청산', date, li); positions.delete(code); continue; }
      // 유지: 피크 갱신(인과적 — 오늘 종가까지) + 신호청산 예약
      if (isNum(bar.close) && bar.close > p.peakClose) p.peakClose = bar.close;
      p.pendingSignalExit = strat.exitSignal(s.ind, li, s.c);
    }

    // C. 신규 진입 신호(오늘 종가) → 내일 체결 예약
    const sig = [];
    for (const s of stocks) {
      if (positions.has(s.code)) continue;
      const li = s.dateIdx.get(date); if (li == null || li < 1) continue;
      if (strat.entry(s.ind, li, s.c)) sig.push(s.code);
    }
    sig.sort();
    pending = sig;

    // D. 자산 평가(종가 기준)
    let mtm = cash;
    for (const p of positions.values()) {
      const s = byCode.get(p.code); const li = s.dateIdx.get(date);
      const px = li != null && isNum(s.c[li].close) ? s.c[li].close : p.entryPrice;
      mtm += p.shares * px;
    }
    equityCurve.push({ date, equity: Math.round(mtm) });
  }

  // 창 종료 — 잔여 청산
  const lastDate = windowDates[windowDates.length - 1];
  for (const code of [...positions.keys()]) {
    const p = positions.get(code); const s = byCode.get(code);
    const li = s.dateIdx.get(lastDate) != null ? s.dateIdx.get(lastDate) : s.c.length - 1;
    sell(p, s.c[li].close, '종료청산', lastDate, li); positions.delete(code);
  }
  if (equityCurve.length) equityCurve[equityCurve.length - 1].equity = Math.round(cash);

  return buildResult(trades, equityCurve, cash, windowDates.length, cfg);
}

function emptyResult(cfg) {
  return { metrics: { totalReturnPct: 0, cagrPct: 0, winRate: 0, trades: 0, avgWinPct: 0, avgLossPct: 0, mddPct: 0, avgHoldDays: 0, finalEquity: cfg.startCash }, equityCurve: [], trades: [] };
}

function buildResult(trades, equityCurve, finalEquity, windowLen, cfg) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const totalReturnPct = (finalEquity / cfg.startCash - 1) * 100;
  const years = windowLen > 0 ? windowLen / 252 : 1;
  const cagrPct = finalEquity > 0 && years > 0 ? (Math.pow(finalEquity / cfg.startCash, 1 / years) - 1) * 100 : 0;
  let peak = -Infinity, mdd = 0;
  for (const e of equityCurve) { if (e.equity > peak) peak = e.equity; if (peak > 0) { const dd = (peak - e.equity) / peak; if (dd > mdd) mdd = dd; } }
  const avg = (arr, f) => (arr.length ? arr.reduce((a, x) => a + f(x), 0) / arr.length : 0);
  return {
    metrics: {
      totalReturnPct: r2(totalReturnPct),
      cagrPct: r2(cagrPct),
      winRate: trades.length ? r2((wins.length / trades.length) * 100) : 0,
      trades: trades.length,
      avgWinPct: r2(avg(wins, (t) => t.returnPct)),
      avgLossPct: r2(avg(losses, (t) => t.returnPct)),
      mddPct: r2(mdd * 100),
      avgHoldDays: r2(avg(trades, (t) => t.holdDays)),
      finalEquity: Math.round(finalEquity),
    },
    equityCurve,
    trades,
  };
}

/* ───────────────────────── 모의투자(전진 시뮬) ───────────────────────── */

/**
 * prevState=null이면 초기화. universe=[{code,name,candles,price(현재가)}].
 * 매 호출 1스텝: 보유 청산(손절/익절/트레일/시간/신호) → 신규 진입. 실시간가 체결.
 */
function advancePaper(prevState, universe, strat, cfg = DEFAULT_CFG) {
  const buyMult = 1 + cfg.commission + cfg.slippage;
  const sellMult = 1 - cfg.commission - cfg.slippage - cfg.sellTax;
  const perBudget = cfg.startCash * cfg.posFrac;

  const byCode = new Map(universe.map((u) => [u.code, u]));
  const anyC = universe.find((u) => u.candles && u.candles.length);
  const today = anyC ? anyC.candles[anyC.candles.length - 1].date : (prevState && prevState.updatedAt) || '';

  const state = prevState || {
    strategyId: strat.id, name: strat.name, startedAt: today, startCash: cfg.startCash,
    cash: cfg.startCash, equity: cfg.startCash, returnPct: 0, updatedAt: today,
    holdings: {}, positions: [], tradeLog: [], equityCurve: [],
  };
  const holdings = state.holdings || {};
  let cash = state.cash;
  const exitedNow = new Set();

  const priceOf = (u) => (u && isNum(u.price) ? u.price : (u && u.candles && u.candles.length ? u.candles[u.candles.length - 1].close : null));

  // A. 청산
  for (const code of Object.keys(holdings).sort()) {
    const p = holdings[code]; const u = byCode.get(code);
    if (!u || !u.candles || !u.candles.length) continue;
    const c = u.candles; const li = c.length - 1;
    const price = priceOf(u); if (!isNum(price)) continue;
    const ind = recomputeIndicators(c);
    if (price > p.peakClose) p.peakClose = price; // 전진 시 실시간 피크(현재가 관측됨)
    const trailStop = strat.trailingPct ? p.peakClose * (1 - strat.trailingPct / 100) : -Infinity;
    const effStop = Math.max(p.stopPrice, trailStop);
    let entryIx = c.findIndex((k) => k.date === p.entryDate); if (entryIx < 0) entryIx = li;
    const held = li - entryIx;
    let reason = null;
    if (price <= effStop) reason = effStop > p.stopPrice + 1e-9 ? '트레일청산' : '손절';
    else if (price >= p.targetPrice) reason = '익절';
    else if (held >= strat.maxHoldDays) reason = '시간청산';
    else if (strat.exitSignal(ind, li, c)) reason = '신호청산';
    if (reason) {
      const proceeds = p.shares * price * sellMult; cash += proceeds;
      const cost = isNum(p.entryCost) ? p.entryCost : p.shares * p.entryPrice * buyMult;
      const pnl = proceeds - cost;
      state.tradeLog.push({ type: 'sell', date: today, code, name: p.name, price: Math.round(price), shares: p.shares, targetPrice: Math.round(p.targetPrice), reason, returnPct: r2((pnl / cost) * 100), pnl: Math.round(pnl) });
      delete holdings[code]; exitedNow.add(code);
    }
  }

  // B. 신규 진입
  const heldCount = () => Object.keys(holdings).length;
  const cands = [];
  for (const u of universe) {
    if (holdings[u.code] || exitedNow.has(u.code)) continue;
    if (!u.candles || u.candles.length < 61) continue;
    const c = u.candles; const li = c.length - 1;
    if (strat.entry(recomputeIndicators(c), li, c)) cands.push(u);
  }
  cands.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (const u of cands) {
    if (heldCount() >= cfg.maxPositions) break;
    const price = priceOf(u); if (!isNum(price) || price <= 0) continue;
    const budget = Math.min(cash, perBudget);
    const shares = Math.floor(budget / (price * buyMult));
    if (shares <= 0) continue;
    const spend = shares * price * buyMult; if (spend > cash + 1e-6) continue;
    cash -= spend;
    const tp = Math.round(price * (1 + strat.takeProfitPct / 100));
    holdings[u.code] = { code: u.code, name: u.name, shares, entryPrice: Math.round(price), entryCost: spend, entryDate: today, peakClose: price, targetPrice: tp, stopPrice: Math.round(price * (1 - strat.stopPct / 100)) };
    state.tradeLog.push({ type: 'buy', date: today, code: u.code, name: u.name, price: Math.round(price), shares, targetPrice: tp });
  }

  // C. 평가 + 뷰 구성
  let equity = cash;
  const positions = [];
  for (const code of Object.keys(holdings).sort()) {
    const p = holdings[code]; const u = byCode.get(code);
    const px = priceOf(u); const cur = isNum(px) ? px : p.entryPrice;
    equity += p.shares * cur;
    positions.push({ code, name: p.name, shares: p.shares, entryDate: p.entryDate, entryPrice: p.entryPrice, targetPrice: p.targetPrice, stopPrice: p.stopPrice, curPrice: Math.round(cur), unrealizedPct: r2((cur / p.entryPrice - 1) * 100) });
  }
  state.cash = Math.round(cash);
  state.equity = Math.round(equity);
  state.returnPct = r2((equity / cfg.startCash - 1) * 100);
  state.updatedAt = today;
  state.holdings = holdings;
  state.positions = positions;
  const ec = state.equityCurve;
  if (ec.length && ec[ec.length - 1].date === today) ec[ec.length - 1].equity = Math.round(equity);
  else ec.push({ date: today, equity: Math.round(equity) });
  if (state.tradeLog.length > 500) state.tradeLog = state.tradeLog.slice(-500);
  return state;
}

module.exports = { STRATEGIES, DEFAULT_CFG, recomputeIndicators, multifactorScore, decideExit, runPortfolioBacktest, advancePaper };
