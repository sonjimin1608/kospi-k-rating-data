'use strict';
/*
 * score-study.js — 우리 점수(BUY/SELL) 기반 전술 백테스트 (러너 실행)
 *
 * 과거 재무·컨센서스·수급은 시계열이 없어 완전 복원 불가 → 캔들로 복원 가능한
 * "기술적 BUY/SELL 점수"로 재구성한다(룩어헤드 없음).
 *   BUY  = 다요인 종합점수(0~100, sim-engine.multifactorScore) — 우리 TECH_buy 핵심과 동일 구조
 *   SELL = 기술적 매도신호 이벤트 가산 점수(0~100) — 우리 TECH_sell 드라이버(데드크로스·역배열·과열·밴드워크 등) 반영
 * 여러 임계값 조합으로 진입(BUY≥X)·청산(SELL≥Y 또는 점수 급락)을 백테스트.
 */

const fs = require('fs');
const path = require('path');
const { fetchAllCandles } = require('./naver-candles');
const sim = require('./sim-engine');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const req = (v) => isNum(v);

function buyScore(ind, i, c) { const s = sim.multifactorScore(ind, i, c); return s ? s.score : null; }

function sellScore(ind, i, c) {
  if (i < 1) return null;
  const { rsi, macd, signal, ma20, ma60, pctB, mom20 } = ind;
  const close = c[i].close;
  let s = 0, any = false;
  if (req(macd[i]) && req(signal[i]) && req(macd[i - 1]) && req(signal[i - 1])) { any = true; if (macd[i - 1] >= signal[i - 1] && macd[i] < signal[i]) s += 25; }
  if (req(ma20[i]) && req(ma60[i])) { any = true; if (close < ma20[i] && close < ma60[i]) s += 20; if (ma20[i] < ma60[i]) s += 15; }
  if (req(rsi[i])) { any = true; if (rsi[i] >= 80) s += 18; else if (rsi[i] >= 75) s += 12; }
  if (req(pctB[i]) && pctB[i] <= 0.05) s += 12;
  if (req(mom20[i]) && mom20[i] < 0) s += 10;
  if (req(ma20[i]) && close < ma20[i]) s += 8;
  return any ? Math.min(100, s) : null;
}

/* 점수 기반 전략 (BUY≥buyMin 진입 / SELL≥sellMin 또는 BUY≤buyExit 청산 + 손절/익절) */
function makeScoreStrategy(id, name, o) {
  return {
    id, name,
    stopPct: o.stopPct, takeProfitPct: o.tpPct, trailingPct: o.trailPct || 0, maxHoldDays: o.maxHold,
    entry(ind, i, c) { const b = buyScore(ind, i, c); return b != null && b >= o.buyMin; },
    exitSignal(ind, i, c) {
      const se = sellScore(ind, i, c); if (se != null && se >= o.sellMin) return true;
      if (o.buyExit != null) { const b = buyScore(ind, i, c); if (b != null && b <= o.buyExit) return true; }
      return false;
    },
  };
}

const STRATS = [
  makeScoreStrategy('score_a', 'BUY≥70 진입 / SELL≥55 청산 (손절8·익절25)', { buyMin: 70, sellMin: 55, stopPct: 8, tpPct: 25, maxHold: 40 }),
  makeScoreStrategy('score_b', 'BUY≥70 / SELL≥50 또는 BUY≤45 (손절8·목표없음)', { buyMin: 70, sellMin: 50, buyExit: 45, stopPct: 8, tpPct: 200, maxHold: 60 }),
  makeScoreStrategy('score_c', 'BUY≥75 엄격 / SELL≥55 (손절7·익절20)', { buyMin: 75, sellMin: 55, stopPct: 7, tpPct: 20, maxHold: 30 }),
  makeScoreStrategy('score_d', 'BUY≥65 / SELL≥60 (손절10·익절30·트레일12)', { buyMin: 65, sellMin: 60, stopPct: 10, tpPct: 30, trailPct: 12, maxHold: 50 }),
  makeScoreStrategy('score_e', 'BUY≥72 / BUY≤48 점수반전 (손절8·목표없음)', { buyMin: 72, sellMin: 101, buyExit: 48, stopPct: 8, tpPct: 200, maxHold: 60 }),
];

async function main() {
  console.log('점수(BUY/SELL) 기반 전술 백테스트');
  const { universe } = await fetchAllCandles({ concurrency: 6 });
  const prepared = universe.map((u) => ({ ...u, ind: sim.recomputeIndicators(u.candles) }));
  console.log(`캔들 확보: ${prepared.length}종목`);
  const cfg = sim.DEFAULT_CFG;
  const results = STRATS.map((st) => {
    const r = sim.runPortfolioBacktest(prepared, st, cfg);
    console.log(`  ${st.name.padEnd(42)} 수익 ${String(r.metrics.totalReturnPct).padStart(7)}% 승률 ${String(r.metrics.winRate).padStart(5)}% MDD ${String(r.metrics.mddPct).padStart(6)}% 거래 ${String(r.metrics.trades).padStart(4)}`);
    return { id: st.id, name: st.name, metrics: r.metrics, equityCurve: r.equityCurve, trades: r.trades };
  });
  const out = {
    generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19) + '+09:00',
    note: 'BUY=다요인 종합점수(캔들 복원), SELL=기술적 매도신호 가산점수(캔들 복원). 과거 재무·수급·컨센서스는 시계열 부재로 제외 — 점수의 기술적 부분만 정직하게 재구성(룩어헤드 없음).',
    startCash: cfg.startCash, universe: prepared.length, strategies: results,
  };
  for (const dir of [path.join(__dirname, '..', 'public', 'data', 'sim'), path.join(__dirname, '..', 'data', 'sim')]) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'score_study.json'), JSON.stringify(out)); } catch {}
  }
  console.log('\n저장: data/sim/score_study.json');
}

if (require.main === module) main().catch((e) => { console.error('실패:', e.stack || e.message); process.exit(1); });
module.exports = { buyScore, sellScore, STRATS };
