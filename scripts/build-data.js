#!/usr/bin/env node
/**
 * K-Rating 데이터 파이프라인 V2
 * 코스피200 전 종목을 수집해 public/data/summary.json, public/data/stocks/{code}.json,
 * public/data/alerts.json 생성.
 *
 * V2 변경 (docs/SCORING_V2.md §5·§6, docs/V2_CONTRACT.md §2):
 *  - 수집: 일봉 open/high/low, 52주 고저, 배당수익률, BPS, 외인소진율,
 *    목표주가 컨센서스(priceTargetMean/recommMean), 투자자별 5일 수급(dealTrendInfos: 외국인·기관·개인)
 *  - 신규 지표: 볼린저 %b(20,2), 52주 위치, 거래대금 Z-score(20), MA20 이격도, ATR14%, 수급 flowRatio
 *  - FIN/OUT/TECH_buy 수정 + SELL 전면 재설계 (0.25×FINRISK + 0.20×OUTRISK + 0.55×TECH_sell 이벤트 가산형)
 *  - parts 객체화({score,label,explain,inputs,reasons}) + indicators + targetPrice + verdict + confidence
 *  - alerts.json: MACD 0선 아래 골든크로스(gc_below_zero) 감지, 30일 이력 병합
 *
 * 사용: node scripts/build-data.js
 * 의존성: 없음 (Node 22 내장 fetch)
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'data');
const STOCK_DIR = path.join(OUT_DIR, 'stocks');
const CONCURRENCY = 6;
const RETRIES = 2; // 최초 시도 + 2회 재시도
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "3,336,059" / "25.70배" / "0.53%" / "-" / "N/A" → number | null */
function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s || s === '-' || s === 'N/A' || s === 'null') return null;
  const cleaned = s.replace(/[,+\s]/g, '').replace(/[%배원]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const roundScore = (v) => (v == null ? null : Math.round(clamp(v, 0, 100)));
const fmtComma = (v) => (v == null ? null : Math.round(v).toLocaleString('en-US'));
const fmtWon = (v) => (v == null ? null : `${fmtComma(v)}원`);
const fmtEok = (v) => (v == null ? null : `${fmtComma(v)}억원`);

/** 성장률 공용 매핑 S_g(g) = 50 + 45·tanh(g/60) (SCORING_V2 §5 공통 표기) */
const S_g = (g) => (g == null ? null : 50 + 45 * Math.tanh(g / 60));

/** P2-2: 극단 성장률 표기 캡 — |g|>300%면 완화 표기 */
function fmtGrowth(g) {
  if (g == null) return null;
  if (g > 300) return '+300% 이상(저기저 효과)';
  if (g < -300) return '-300% 이하';
  return `${g >= 0 ? '+' : ''}${round1(g)}%`;
}

function pctLabel(p) {
  if (p == null) return '';
  return p >= 0.5
    ? `상위 ${Math.max(1, Math.round((1 - p) * 100))}%`
    : `하위 ${Math.max(1, Math.round(p * 100))}%`;
}

function nowKstIso() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 19) + '+09:00';
}

function todayKst() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 지수 백오프 재시도 fetch → text */
async function fetchText(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt >= RETRIES) throw new Error(`${url} 실패: ${e.message}`);
    await sleep(500 * Math.pow(2, attempt));
    return fetchText(url, attempt + 1);
  }
}

async function fetchJson(url) {
  const t = await fetchText(url);
  return JSON.parse(t);
}

// ---------------------------------------------------------------------------
// 1. 코스피200 구성종목 (주의: pageSize 최대 60 — 100이면 HTTP 400)
// ---------------------------------------------------------------------------
async function fetchKospi200() {
  const stocks = [];
  const seen = new Set();
  for (let page = 1; page <= 6; page++) {
    const url = `https://m.stock.naver.com/api/index/KPI200/enrollStocks?page=${page}&pageSize=60`;
    const arr = await fetchJson(url);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const it of arr) {
      if (seen.has(it.itemCode)) continue;
      seen.add(it.itemCode);
      const sign =
        it.compareToPreviousPrice && ['4', '5'].includes(it.compareToPreviousPrice.code) ? -1 : 1;
      const rawChange = num(it.compareToPreviousClosePrice);
      stocks.push({
        code: it.itemCode,
        name: it.stockName,
        price: num(it.closePrice),
        change: rawChange == null ? null : sign * Math.abs(rawChange),
        changeRate: num(it.fluctuationsRatio),
        marketCap: num(it.marketValue), // 단위: 억원
      });
    }
    if (arr.length < 60) break;
  }
  return stocks;
}

// ---------------------------------------------------------------------------
// 2. 종목별 원천 데이터
// ---------------------------------------------------------------------------
/** fchart XML → [{date,open,high,low,close,volume}] (V2: open/high/low 추가 — ATR 전제) */
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
      open: num(p[1]),
      high: num(p[2]),
      low: num(p[3]),
      close,
      volume: num(p[5]) ?? 0,
    });
  }
  return out;
}

/** finance/annual → { years:[{key,title,isConsensus}], rows: {제목: {key: number|null}} } */
function parseFinance(fin) {
  const info = fin && fin.financeInfo;
  if (!info || !Array.isArray(info.trTitleList) || !Array.isArray(info.rowList)) return null;
  const years = info.trTitleList.map((t) => ({
    key: t.key,
    title: String(t.title || '').replace(/\.$/, ''),
    isConsensus: t.isConsensus === 'Y',
  }));
  const rows = {};
  for (const row of info.rowList) {
    const vals = {};
    for (const y of years) {
      const cell = row.columns && row.columns[y.key];
      vals[y.key] = cell ? num(cell.value) : null;
    }
    rows[row.title] = vals;
  }
  return { years, rows };
}

function emptyIntegration() {
  return {
    per: null, pbr: null, cnsPer: null, cnsEps: null, dividendYield: null,
    bps: null, foreignRate: null, high52: null, low52: null,
    priceTargetMean: null, recommMean: null,
    dealTrend: null, // { netForeign5, netOrgan5, netIndiv5, vol5, days }
    industryCode: null,
  };
}

/** integration → V2 확장 파싱 (SCORING_V2 §5.6-2) */
function parseIntegration(integ) {
  const out = emptyIntegration();
  if (!integ) return out;
  out.industryCode = integ.industryCode != null ? String(integ.industryCode) : null;
  const infos = integ.totalInfos;
  if (Array.isArray(infos)) {
    for (const it of infos) {
      if (it.code === 'per') out.per = num(it.value);
      else if (it.code === 'pbr') out.pbr = num(it.value);
      else if (it.code === 'cnsPer') out.cnsPer = num(it.value);
      else if (it.code === 'cnsEps') out.cnsEps = num(it.value);
      else if (it.code === 'dividendYieldRatio') out.dividendYield = num(it.value);
      else if (it.code === 'bps') out.bps = num(it.value);
      else if (it.code === 'foreignRate') out.foreignRate = num(it.value);
      else if (it.code === 'highPriceOf52Weeks') out.high52 = num(it.value);
      else if (it.code === 'lowPriceOf52Weeks') out.low52 = num(it.value);
    }
  }
  if (integ.consensusInfo) {
    out.priceTargetMean = num(integ.consensusInfo.priceTargetMean);
    out.recommMean = num(integ.consensusInfo.recommMean);
  }
  if (Array.isArray(integ.dealTrendInfos) && integ.dealTrendInfos.length > 0) {
    let nf = 0, no = 0, ni = 0, vol = 0, days = 0, indivDays = 0;
    for (const d of integ.dealTrendInfos.slice(0, 5)) {
      const f = num(d.foreignerPureBuyQuant);
      const o = num(d.organPureBuyQuant);
      const iv = num(d.individualPureBuyQuant);
      const v = num(d.accumulatedTradingVolume);
      if (f == null && o == null && iv == null && v == null) continue;
      nf += f ?? 0;
      no += o ?? 0;
      if (iv != null) { ni += iv; indivDays++; }
      vol += v ?? 0;
      days++;
    }
    if (days > 0) {
      out.dealTrend = {
        netForeign5: nf, netOrgan5: no,
        netIndiv5: indivDays > 0 ? ni : null,
        vol5: vol, days,
      };
    }
  }
  return out;
}

async function fetchStockRaw(meta, idx, total) {
  const { code, name } = meta;
  const chartXml = await fetchText(
    `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=300&requestType=0`
  );
  const candles = parseFchart(chartXml);
  if (candles.length < 70) throw new Error(`일봉 부족 (${candles.length}개)`);

  let finance = null;
  try {
    finance = parseFinance(
      await fetchJson(`https://m.stock.naver.com/api/stock/${code}/finance/annual`)
    );
  } catch (e) {
    console.warn(`  [${idx}/${total}] ${code} ${name} finance/annual 실패(계속): ${e.message}`);
  }
  let integration = emptyIntegration();
  try {
    integration = parseIntegration(
      await fetchJson(`https://m.stock.naver.com/api/stock/${code}/integration`)
    );
  } catch (e) {
    console.warn(`  [${idx}/${total}] ${code} ${name} integration 실패(계속): ${e.message}`);
  }
  console.log(`  [${idx}/${total}] ${code} ${name} 수집 완료 (일봉 ${candles.length}개)`);
  return { meta, candles, finance, integration };
}

// ---------------------------------------------------------------------------
// 3. 기술적 지표
// ---------------------------------------------------------------------------
/** RSI(14) — Wilder smoothing. closes와 같은 길이의 배열 (앞부분 null) */
function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** EMA — 앞 (period-1)개 null, SMA 시딩 */
function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  let start = -1;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    if (start === -1) start = i;
    count++;
    sum += values[i];
    if (count === period) {
      out[i] = sum / period;
      const k = 2 / (period + 1);
      for (let j = i + 1; j < values.length; j++) {
        out[j] = values[j] * k + out[j - 1] * (1 - k);
      }
      break;
    }
  }
  return out;
}

/** MACD(12,26,9) */
function macdSeries(closes) {
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const macd = closes.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null));
  const signal = emaSeries(macd, 9);
  const hist = macd.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { macd, signal, hist };
}

function sma(values, period, endIdx) {
  if (endIdx + 1 < period) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += values[i];
  return s / period;
}

/** 표본표준편차 (n-1) */
function sampleStd(values) {
  const n = values.length;
  if (n < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const ss = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return Math.sqrt(ss / (n - 1));
}

/**
 * V2 기술 지표 일괄 계산.
 * candles: OHLCV 배열, integ: parseIntegration 결과 (52주 고저·수급).
 */
function computeTechnicals(candles, integ) {
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const n = closes.length;
  const last = n - 1;

  const rsi = rsiSeries(closes);
  const { macd, signal, hist } = macdSeries(closes);

  const ma20 = sma(closes, 20, last);
  const ma60 = n >= 60 ? sma(closes, 60, last) : null;
  const momentum20 = n >= 21 ? ((closes[last] - closes[last - 20]) / closes[last - 20]) * 100 : null;
  const dayChange = n >= 2 ? closes[last] - closes[last - 1] : null;

  // --- 볼린저밴드 %b (20, 2) — §2.1 ---
  let bollingerB = null;
  if (n >= 20 && ma20 != null) {
    const sd = sampleStd(closes.slice(last - 19, last + 1));
    if (sd != null && sd > 0) bollingerB = (closes[last] - (ma20 - 2 * sd)) / (4 * sd);
  }

  // --- MA20 이격도 — §2.6 (절대 캡 ±25) ---
  const disparity20 =
    ma20 != null && ma20 > 0 ? clamp((closes[last] / ma20 - 1) * 100, -25, 25) : null;

  // --- 거래대금 Z-score(20) — §2.3 (마지막 봉 제외 20봉 기준, 절대 캡 ±4) ---
  let volumeZ = null;
  if (n >= 21) {
    const tv = candles.map((c) => c.close * c.volume);
    const base = tv.slice(last - 20, last);
    const mean = base.reduce((a, b) => a + b, 0) / base.length;
    const std = sampleStd(base);
    if (std != null && std > 0) volumeZ = clamp((tv[last] - mean) / std, -4, 4);
  }

  // --- ATR14% (Wilder) — §2.7 ---
  let atrPct = null;
  {
    const trs = [];
    for (let i = 1; i < n; i++) {
      const h = candles[i].high;
      const l = candles[i].low;
      const pc = candles[i - 1].close;
      if (h == null || l == null || pc == null) continue;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    if (trs.length >= 14) {
      let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
      for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
      if (closes[last] > 0) atrPct = (atr / closes[last]) * 100;
    }
  }

  // --- 52주 위치 — §2.2 (integration 우선, 300봉 근사 폴백) ---
  let pos52 = null;
  let pos52Approx = false;
  let high52 = integ ? integ.high52 : null;
  let low52 = integ ? integ.low52 : null;
  if (high52 == null || low52 == null || high52 <= low52) {
    high52 = Math.max(...closes);
    low52 = Math.min(...closes);
    pos52Approx = true;
  }
  if (high52 > low52) pos52 = clamp(((closes[last] - low52) / (high52 - low52)) * 100, 0, 100);

  // --- 투자자별 5일 수급 — §2.8 (외국인·기관·개인) ---
  let flowRatio = null; // 외인+기관 순매수/거래량 (기존 유지 — 하위호환)
  let flow = null;      // 투자자별 5일 net & net/거래량
  if (integ && integ.dealTrend && integ.dealTrend.vol5 > 0) {
    const dt = integ.dealTrend;
    flowRatio = (dt.netForeign5 + dt.netOrgan5) / dt.vol5;
    flow = {
      foreign5: dt.netForeign5,
      organ5: dt.netOrgan5,
      indiv5: dt.netIndiv5,
      vol5: dt.vol5,
      foreignRatio: dt.netForeign5 / dt.vol5,
      organRatio: dt.netOrgan5 / dt.vol5,
      indivRatio: dt.netIndiv5 == null ? null : dt.netIndiv5 / dt.vol5,
    };
  }

  // 최근 3봉 내 크로스 탐지
  let crossUp = false;
  let crossDown = false;
  for (let i = Math.max(1, n - 3); i < n; i++) {
    if (macd[i] == null || signal[i] == null || macd[i - 1] == null || signal[i - 1] == null) continue;
    if (macd[i - 1] <= signal[i - 1] && macd[i] > signal[i]) crossUp = true;
    if (macd[i - 1] >= signal[i - 1] && macd[i] < signal[i]) crossDown = true;
  }
  const histRising =
    hist[last] != null && hist[last - 1] != null ? hist[last] > hist[last - 1] : null;

  // 알림용: 당일(마지막 봉) MACD 0선 아래 골든크로스 (V2_CONTRACT §1)
  const gcBelowZero =
    macd[last] != null && signal[last] != null &&
    macd[last - 1] != null && signal[last - 1] != null &&
    macd[last] < 0 && macd[last - 1] <= signal[last - 1] && macd[last] > signal[last];

  // 추세 상태 — §5.3.1
  const close = closes[last];
  let trendState = 'mixed';
  if (ma60 != null && ma20 != null) {
    if (close > ma60 && ma20 >= ma60) trendState = 'up';
    else if (close < ma60 && ma20 < ma60) trendState = 'down';
  } else if (ma20 != null) {
    if (close > ma20) trendState = 'up';
    else if (close < ma20) trendState = 'down';
  }

  return {
    rsi: rsi[last],
    rsiSeries: rsi,
    macdSeries: macd,
    signalSeries: signal,
    macd: macd[last],
    signal: signal[last],
    hist: hist[last],
    histRising,
    crossUp,
    crossDown,
    gcBelowZero,
    ma20,
    ma60,
    momentum20,
    dayChange,
    bollingerB,
    disparity20,
    volumeZ,
    atrPct,
    pos52,
    pos52Approx,
    high52,
    low52,
    flowRatio,
    flow,
    trendState,
    close,
    lastDate: candles[last].date,
  };
}

// ---------------------------------------------------------------------------
// 4. 재무/전망 원시 지표 추출
// ---------------------------------------------------------------------------
/**
 * 금융업 판별 (P1-1): 수신·보험부채를 부채로 집계하는 업종은 부채비율 1000%+가
 * 정상이므로 안정성(부채비율) 평가에서 제외해야 함.
 * 1순위: integration API의 업종코드 (301 은행 / 315 손해보험 / 321 증권 / 330 생명보험 / 337 카드)
 * 2순위(업종코드 결측 시): 종목명 키워드 폴백
 */
const FIN_INDUSTRY_CODES = new Set(['301', '315', '321', '330', '337']);
const FIN_NAME_RE = /금융지주|금융그룹|은행|증권|생명|손해보험|해상화재|화재해상|카드|캐피탈|보험/;
function isFinancialStock(industryCode, name) {
  if (industryCode != null) return FIN_INDUSTRY_CODES.has(String(industryCode));
  return FIN_NAME_RE.test(name || '');
}

function extractFundamentals(finance, integration, name) {
  const f = {
    hasFinance: !!finance,
    roe: null, opMargin: null, revYoY: null, opYoY: null, debtRatio: null,
    revCagr2: null, opCagr2: null,
    netIncome: null, prevNetIncome: null, deficit: false,
    consRevG: null, consOpG: null, consEpsG: null, hasConsensus: false,
    per: null, pbr: null, cnsPer: null, cnsEps: null, perUsed: null,
    divYield: null, bps: null, foreignRate: null,
    priceTargetMean: null, recommMean: null,
    consYearLabel: null, latestYearLabel: null,
    consRev: null, consOp: null, consEps: null,
    latestRev: null, latestOp: null, latestEps: null,
    prevRev: null, prevOp: null,
    isFinancial: isFinancialStock(integration ? integration.industryCode : null, name),
  };
  if (integration) {
    f.per = integration.per != null && integration.per > 0 ? integration.per : null;
    f.pbr = integration.pbr != null && integration.pbr > 0 ? integration.pbr : null;
    f.cnsPer = integration.cnsPer != null && integration.cnsPer > 0 ? integration.cnsPer : null;
    f.cnsEps = integration.cnsEps;
    f.divYield = integration.dividendYield;
    f.bps = integration.bps;
    f.foreignRate = integration.foreignRate;
    f.priceTargetMean = integration.priceTargetMean;
    f.recommMean = integration.recommMean;
  }
  if (!finance) {
    f.perUsed = f.cnsPer != null ? f.cnsPer : f.per;
    return f;
  }

  const confirmed = finance.years.filter((y) => !y.isConsensus);
  const consensus = finance.years.find((y) => y.isConsensus) || null;
  const latest = confirmed[confirmed.length - 1] || null;
  const prev = confirmed[confirmed.length - 2] || null;
  const prev2 = confirmed[confirmed.length - 3] || null;
  const R = finance.rows;
  const g = (row, key) => (R[row] ? R[row][key] : null);

  if (latest) {
    f.latestYearLabel = latest.title;
    f.roe = g('ROE', latest.key);
    f.opMargin = g('영업이익률', latest.key);
    f.debtRatio = g('부채비율', latest.key);
    f.netIncome = g('당기순이익', latest.key);
    f.deficit = f.netIncome != null && f.netIncome < 0;
    f.latestRev = g('매출액', latest.key);
    f.latestOp = g('영업이익', latest.key);
    f.latestEps = g('EPS', latest.key);
    if (f.opMargin == null && f.latestRev && f.latestOp != null && f.latestRev !== 0) {
      f.opMargin = (f.latestOp / f.latestRev) * 100;
    }
    // PER/PBR 폴백 (integration 실패/결측 시)
    if (f.per == null) {
      const p = g('PER', latest.key);
      if (p != null && p > 0 && !f.deficit) f.per = p;
    }
    if (f.pbr == null) {
      const p = g('PBR', latest.key);
      if (p != null && p > 0) f.pbr = p;
    }
    if (f.divYield == null) {
      const d = g('배당수익률', latest.key);
      if (d != null && d >= 0) f.divYield = d;
    }
  }
  // 적자기업 확정 PER 결측 처리 (V1 유지)
  if (f.deficit) f.per = null;
  // forward PER 우선 (§5.2.3)
  f.perUsed = f.cnsPer != null ? f.cnsPer : f.per;

  const yoy = (cur, base) => {
    if (cur == null || base == null || base === 0) return null;
    return ((cur - base) / Math.abs(base)) * 100;
  };
  if (latest && prev) {
    f.prevRev = g('매출액', prev.key);
    f.prevOp = g('영업이익', prev.key);
    f.prevNetIncome = g('당기순이익', prev.key);
    f.revYoY = yoy(g('매출액', latest.key), f.prevRev);
    f.opYoY = yoy(g('영업이익', latest.key), f.prevOp);
  }
  // 2년 CAGR (§5.1) — 확정 3개년, 분모·부호 가드
  if (latest && prev2) {
    const rev0 = g('매출액', prev2.key);
    const op0 = g('영업이익', prev2.key);
    if (rev0 != null && rev0 > 0 && f.latestRev != null && f.latestRev > 0) {
      f.revCagr2 = (Math.sqrt(f.latestRev / rev0) - 1) * 100;
    }
    if (op0 != null && op0 > 0 && f.latestOp != null && f.latestOp > 0) {
      f.opCagr2 = (Math.sqrt(f.latestOp / op0) - 1) * 100;
    }
  }
  if (consensus && latest) {
    f.consYearLabel = consensus.title;
    f.consRev = g('매출액', consensus.key);
    f.consOp = g('영업이익', consensus.key);
    f.consEps = g('EPS', consensus.key);
    f.consRevG = yoy(f.consRev, f.latestRev);
    f.consOpG = yoy(f.consOp, f.latestOp);
    f.consEpsG = yoy(f.consEps, f.latestEps);
    f.hasConsensus = f.consRevG != null || f.consOpG != null || f.consEpsG != null;
  }
  return f;
}

// ---------------------------------------------------------------------------
// 5. Percentile / Winsorize (코스피200 내 상대평가)
// ---------------------------------------------------------------------------
function makePercentiler(values) {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return () => null;
  return (v) => {
    if (v == null || !Number.isFinite(v)) return null;
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
    const below = lo;
    let hi2 = n; lo = below;
    while (lo < hi2) { const m = (lo + hi2) >> 1; if (sorted[m] <= v) lo = m + 1; else hi2 = m; }
    const equal = lo - below;
    return (below + equal * 0.5) / n; // 0(최하)~1(최상)
  };
}

/** 분위수 (선형 보간) */
function quantile(values, q) {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 유니버스 통계 컨텍스트 X 구축 (§5.5 winsorize 규칙 + percentile 2차 패스).
 *  - X.w(key, v): winsorize (성장률 [p5,p95], roe/opMargin/debtRatio [p1,p99], 그 외 원값)
 *  - X.P[key](v): winsorize된 값 기준 percentile (0~1)
 *  - X.perMkt: cnsPer>0 집합 winsorize[p10,p90] 후 중앙값 (목표주가 공식용)
 */
function buildUniverseStats(results) {
  const fundVals = (key) => results.map((r) => r.fund[key]);
  const GROWTH_KEYS = ['revYoY', 'opYoY', 'revCagr2', 'opCagr2', 'consRevG', 'consOpG', 'consEpsG'];
  const P1_KEYS = ['roe', 'opMargin', 'debtRatio'];
  const bounds = {};
  for (const k of GROWTH_KEYS) {
    const vals = fundVals(k);
    bounds[k] = [quantile(vals, 0.05), quantile(vals, 0.95)];
  }
  for (const k of P1_KEYS) {
    const vals = fundVals(k);
    bounds[k] = [quantile(vals, 0.01), quantile(vals, 0.99)];
  }
  const w = (key, v) => {
    if (v == null || !Number.isFinite(v)) return null;
    const b = bounds[key];
    if (!b || b[0] == null || b[1] == null) return v;
    return clamp(v, b[0], b[1]);
  };
  const P = {};
  for (const k of [...GROWTH_KEYS, ...P1_KEYS]) {
    P[k] = makePercentiler(results.map((r) => w(k, r.fund[k])));
  }
  for (const k of ['divYield', 'perUsed', 'pbr']) {
    P[k] = makePercentiler(fundVals(k));
  }
  P.atrPct = makePercentiler(results.map((r) => r.tech.atrPct));

  // PER_mkt: cnsPer>0 집합 winsorize [p10,p90] 후 중앙값 (V2_CONTRACT §2.3)
  let perMkt = null;
  const cns = fundVals('cnsPer').filter((v) => v != null && v > 0);
  if (cns.length > 0) {
    const lo = quantile(cns, 0.1);
    const hi = quantile(cns, 0.9);
    perMkt = quantile(cns.map((v) => clamp(v, lo, hi)), 0.5);
  }
  return { w, P, perMkt };
}

// ---------------------------------------------------------------------------
// 6. 스코어링 (V2)
// ---------------------------------------------------------------------------
/** 가중 평균 (null 항목은 가중치 재정규화). 전부 null이면 null */
function weightedAvg(pairs) {
  let sum = 0;
  let wsum = 0;
  for (const [v, w] of pairs) {
    if (v == null) continue;
    sum += v * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : null;
}

/** 결측 재정규화된 가중치 비중 (confidence 판정용, §5.5) */
function missingWeightFrac(pairs) {
  let miss = 0;
  let tot = 0;
  for (const [v, w] of pairs) {
    tot += w;
    if (v == null) miss += w;
  }
  return tot > 0 ? miss / tot : 1;
}

/** percentile(0~1)과 절대점수 블렌딩 (한쪽 결측 시 다른 쪽 100%) */
function blend(pct, abs) {
  const p = pct == null ? null : pct * 100;
  if (p == null && abs == null) return null;
  if (p == null) return abs;
  if (abs == null) return p;
  return 0.5 * p + 0.5 * abs;
}

/**
 * 부호 전환 보정 turnFix:
 *  - 적자→흑자(흑자전환): turnVal (FIN 확정연도 90 = V1 유지 / OUT 컨센서스 80, 저기저 70 — §1.6-B)
 *  - 적자→적자(적자 지속): 40~55 캡 (축소) / ≤40 (확대)
 *  - 흑자→적자(적자전환): ≤20
 */
function turnFix(cur, base, score, turnVal) {
  if (cur == null || base == null) return score;
  if (base < 0 && cur > 0) return turnVal;
  if (cur < 0 && base >= 0) return score == null ? 20 : Math.min(score, 20);
  if (cur < 0 && base < 0) {
    if (score == null) return null;
    return cur > base ? clamp(score, 40, 55) : Math.min(score, 40);
  }
  return score;
}

/** 파트 객체 공통 생성 (V2_CONTRACT §2.1) */
function partObj(score, label, explainParts, inputs, reasons) {
  return {
    score: roundScore(score),
    label,
    explain: explainParts.filter(Boolean).join(' '),
    inputs: inputs.filter((it) => it.value != null && it.value !== ''),
    reasons: (reasons || []).filter(Boolean).slice(0, 4),
  };
}

// ---------------- FIN (§5.1) ----------------
function scoreFin(f, X) {
  const { w, P } = X;

  // 수익성 (ROE 60% + 영업이익률 40%) — winsorize [p1,p99]
  const roeW = w('roe', f.roe);
  const omW = w('opMargin', f.opMargin);
  const roeScore = blend(P.roe(roeW), roeW == null ? null : clamp(20 + roeW * 4, 0, 100));
  const marginScore = blend(P.opMargin(omW), omW == null ? null : clamp(25 + omW * 2.5, 0, 100));
  const profitability = weightedAvg([[roeScore, 0.6], [marginScore, 0.4]]);

  // 성장성 = 0.4×revGrowth + 0.6×opGrowth, 각 성분 = 0.6×YoY + 0.4×2Y CAGR
  const gComp = (yoyKey, yoyVal, cagrKey, cagrVal) => {
    const y = w(yoyKey, yoyVal);
    const c = w(cagrKey, cagrVal);
    const sY = y == null ? null : blend(P[yoyKey](y), S_g(y));
    const sC = c == null ? null : blend(P[cagrKey](c), S_g(c));
    return weightedAvg([[sY, 0.6], [sC, 0.4]]);
  };
  const revGrowth = gComp('revYoY', f.revYoY, 'revCagr2', f.revCagr2);
  let opGrowth = gComp('opYoY', f.opYoY, 'opCagr2', f.opCagr2);
  opGrowth = turnFix(f.latestOp, f.prevOp, opGrowth, 90); // V1 turnFix 로직 확정연도 적용
  // 저기저 가드: |op_{t-1}| < rev_{t-1}×2%
  let lowBase = false;
  if (
    f.prevOp != null && f.prevRev != null && f.prevRev > 0 &&
    Math.abs(f.prevOp) < f.prevRev * 0.02
  ) {
    lowBase = true;
    if (opGrowth != null && opGrowth > 70) opGrowth = 70;
  }
  const growth = weightedAvg([[revGrowth, 0.4], [opGrowth, 0.6]]);

  // 안정성: 비금융 0.65×부채 + 0.35×배당 / 금융업 배당 100%
  const drW = w('debtRatio', f.debtRatio);
  let debtScore = null;
  if (!f.isFinancial && drW != null) {
    const pct = P.debtRatio(drW);
    debtScore = blend(pct == null ? null : 1 - pct, clamp(105 - drW * 0.35, 5, 98));
  }
  let divScore = null;
  if (f.divYield != null) {
    divScore = blend(P.divYield(f.divYield), clamp(30 + f.divYield * 12, 20, 90));
  }
  let stability = f.isFinancial ? divScore : weightedAvg([[debtScore, 0.65], [divScore, 0.35]]);
  if (f.deficit) stability = clamp((stability == null ? 60 : stability) - 30, 0, 100);

  const pairs = [[profitability, 0.4], [growth, 0.3], [stability, 0.3]];
  const total = weightedAvg(pairs);

  // FINRISK (§5.4.1) — base 0 이벤트 가산
  let risk = null;
  const riskSignals = [];
  if (f.hasFinance) {
    if (f.deficit) {
      riskSignals.push({ label: '당기순이익 적자', pts: 40 });
      if (f.prevNetIncome != null && f.prevNetIncome < 0)
        riskSignals.push({ label: '2년 연속 적자', pts: 10 });
    }
    if (f.latestOp != null && f.latestOp < 0)
      riskSignals.push({ label: '영업이익 적자', pts: 15 });
    if (!f.isFinancial && f.debtRatio != null) {
      if (f.debtRatio > 400)
        riskSignals.push({ label: `부채비율 ${round1(f.debtRatio)}%`, pts: 25 });
      else if (f.debtRatio > 200)
        riskSignals.push({ label: `부채비율 ${round1(f.debtRatio)}%`, pts: 10 });
    }
    if (f.revYoY != null && f.revYoY < -10)
      riskSignals.push({ label: `매출 YoY ${fmtGrowth(f.revYoY)}`, pts: 10 });
    if (f.roe != null && f.roe < 0)
      riskSignals.push({ label: `ROE ${round1(f.roe)}%`, pts: 10 });
    risk = clamp(riskSignals.reduce((a, s) => a + s.pts, 0), 0, 100);
  }

  return {
    total: total == null ? 50 : roundScore(total),
    dataMissing: total == null,
    missFrac: missingWeightFrac(pairs),
    profitability, growth, stability, risk,
    roeScore, marginScore, revGrowth, opGrowth, debtScore, divScore,
    lowBase, riskSignals,
  };
}

/** FIN 파트 객체 조립 (§6.1 템플릿) */
function buildFinParts(f, fin, X) {
  const { P, w } = X;
  const y = f.latestYearLabel;

  // profitability
  const profB = [];
  if (f.roe != null) profB.push(`ROE ${round1(f.roe)}%`);
  if (f.opMargin != null) profB.push(`영업이익률 ${round1(f.opMargin)}%`);
  const profC = [];
  if (f.roe != null) profC.push(`ROE 코스피200 ${pctLabel(P.roe(w('roe', f.roe)))}`);
  if (f.opMargin != null) profC.push(`영업이익률 ${pctLabel(P.opMargin(w('opMargin', f.opMargin)))}`);
  const profitability = partObj(
    fin.profitability, '수익성',
    [
      '자본과 매출을 이익으로 바꾸는 효율을 ROE와 영업이익률로 측정합니다.',
      profB.length ? `${y ? `${y} 확정 기준 ` : ''}${profB.join(', ')}.` : null,
      f.deficit ? '당기순이익 적자로 ROE 해석에 유의가 필요합니다.' : null,
      profC.length && fin.profitability != null
        ? `${profC.join(' · ')} → 수익성 ${roundScore(fin.profitability)}점`
        : fin.profitability == null ? '재무 데이터가 부족해 평가에서 제외했습니다.' : null,
    ],
    [
      { label: `ROE${y ? `(${y})` : ''}`, value: f.roe == null ? null : `${round1(f.roe)}%` },
      { label: '영업이익률', value: f.opMargin == null ? null : `${round1(f.opMargin)}%` },
    ],
    profC
  );

  // growth
  const turnDown = f.latestOp != null && f.prevOp != null && f.latestOp < 0 && f.prevOp >= 0;
  const growthBParts = [];
  if (turnDown) growthBParts.push(`${y} 영업이익 적자전환`);
  else {
    if (f.revYoY != null) growthBParts.push(`매출 YoY ${fmtGrowth(f.revYoY)}`);
    if (f.opYoY != null && !(f.latestOp != null && f.latestOp < 0)) growthBParts.push(`영업이익 YoY ${fmtGrowth(f.opYoY)}`);
    if (f.revCagr2 != null) growthBParts.push(`2년 연평균 매출 ${fmtGrowth(f.revCagr2)}`);
  }
  const growth = partObj(
    fin.growth, '성장성',
    [
      '매출과 영업이익이 얼마나 빠르게 늘고 있는지를 최근 1년과 2년 추세로 함께 봅니다.',
      growthBParts.length ? `${y ? `${y} ` : ''}${growthBParts.join(', ')}.` : null,
      fin.growth != null && f.opYoY != null
        ? `영업이익 성장 코스피200 ${pctLabel(P.opYoY(w('opYoY', f.opYoY)))} 수준 → 성장성 ${roundScore(fin.growth)}점` +
          (fin.lowBase ? ' (직전 이익 기저가 낮아 성장률 해석에 기저효과 반영, 점수 상한 적용)' : '')
        : fin.growth != null ? `성장성 ${roundScore(fin.growth)}점` : '성장률 산출에 필요한 데이터가 부족합니다.',
    ],
    [
      { label: '매출 YoY', value: fmtGrowth(f.revYoY) },
      { label: '영업이익 YoY', value: turnDown ? '적자전환' : fmtGrowth(f.opYoY) },
      { label: '2년 매출 CAGR', value: fmtGrowth(f.revCagr2) },
      { label: '2년 영업이익 CAGR', value: fmtGrowth(f.opCagr2) },
    ],
    [
      turnDown ? `${y} 영업이익 적자전환` : null,
      fin.lowBase ? '직전 영업이익 기저가 낮아 기저효과 상한(70점) 적용' : null,
    ]
  );

  // stability
  const drLabel =
    f.debtRatio == null ? null
    : f.debtRatio < 100 ? '안정적'
    : f.debtRatio < 200 ? '보통'
    : f.debtRatio < 400 ? '다소 높음'
    : '매우 높음';
  const stabB = [];
  if (!f.isFinancial && f.debtRatio != null) stabB.push(`부채비율 ${round1(f.debtRatio)}%${y ? ` (${y})` : ''}`);
  if (f.divYield != null) stabB.push(`배당수익률 ${round1(f.divYield)}%`);
  const stabC = [];
  if (!f.isFinancial && drLabel) stabC.push(`부채비율 ${drLabel}`);
  if (f.divYield != null) stabC.push(`배당 ${pctLabel(P.divYield(f.divYield))}`);
  const stability = partObj(
    fin.stability, '안정성',
    [
      '부채 부담과 배당 여력으로 재무 하방 안정성을 측정합니다.',
      f.isFinancial ? '금융업 특성상 부채비율은 평가에서 제외했습니다.' : null,
      stabB.length ? `${stabB.join(', ')}.` : null,
      stabC.length && fin.stability != null
        ? `${stabC.join(' · ')} → 안정성 ${roundScore(fin.stability)}점`
        : fin.stability == null ? '안정성 평가 데이터가 부족합니다.' : null,
      f.deficit ? '당기순이익 적자로 30점 페널티가 반영되었습니다.' : null,
    ],
    [
      f.isFinancial ? { label: '부채비율', value: null } : { label: `부채비율${y ? `(${y})` : ''}`, value: f.debtRatio == null ? null : `${round1(f.debtRatio)}%` },
      { label: '배당수익률', value: f.divYield == null ? null : `${round1(f.divYield)}%` },
    ],
    [
      f.isFinancial ? '금융업 특성상 부채비율 평가 제외' : drLabel ? `부채비율 ${round1(f.debtRatio)}%로 ${drLabel}` : null,
      f.deficit ? `최근 확정연도(${y}) 당기순이익 적자 페널티 −30점` : null,
    ]
  );

  // risk (FINRISK)
  const sigLabels = fin.riskSignals.map((s) => `${s.label}(${s.pts >= 0 ? '+' : ''}${s.pts})`);
  const risk = partObj(
    fin.risk, '재무 리스크',
    [
      '재무제표에서 확인되는 위험 신호(적자, 과다 부채, 매출 급감)를 누적 가산합니다.',
      fin.risk == null
        ? '재무 데이터 결측으로 리스크를 평가하지 못했습니다.'
        : fin.riskSignals.length === 0
          ? '확인된 재무 위험 신호가 없습니다 (0점).'
          : `발동 신호: ${sigLabels.join(', ')}. 위험 신호 ${fin.riskSignals.length}건 → 재무 리스크 ${roundScore(fin.risk)}점 (신호 없음 = 0점이 기본)`,
    ],
    fin.riskSignals.map((s) => ({ label: s.label, value: `+${s.pts}점` })),
    sigLabels
  );

  return { profitability, growth, stability, risk };
}

// ---------------- OUT (§5.2) ----------------
function scoreOut(f, X, price) {
  const { w, P } = X;
  const gScore = (key, g) => {
    const gw = w(key, g);
    return gw == null ? null : blend(P[key](gw), S_g(gw));
  };

  let revenueGrowth, opGrowth, epsGrowth;
  let usedFallback = false;
  let lowBase = false;
  if (f.hasConsensus) {
    revenueGrowth = gScore('consRevG', f.consRevG);
    // 흑자전환 80, 저기저(컨센 영업이익 < 매출×1%) 70 — §1.6-B
    const turnVal =
      f.consOp != null && f.consRev != null && f.consRev > 0 && f.consOp < f.consRev * 0.01
        ? 70 : 80;
    opGrowth = turnFix(f.consOp, f.latestOp, gScore('consOpG', f.consOpG), turnVal);
    epsGrowth = turnFix(f.consEps, f.latestEps, gScore('consEpsG', f.consEpsG), 80);
    // 저기저 가드 (§5.1 동일): |latestOp| < latestRev×2%
    if (
      f.latestOp != null && f.latestRev != null && f.latestRev > 0 &&
      Math.abs(f.latestOp) < f.latestRev * 0.02
    ) {
      lowBase = true;
      if (opGrowth != null && opGrowth > 70) opGrowth = 70;
    }
  } else {
    // 컨센서스 부재: 최근 실적 추세 폴백 (§5.2.4)
    usedFallback = true;
    revenueGrowth = gScore('revYoY', f.revYoY);
    opGrowth = turnFix(f.latestOp, f.prevOp, gScore('opYoY', f.opYoY), 80);
    epsGrowth = null;
  }

  // targetUpside (§2.5): winsorize u [−40, +80], 중심 +15%
  let upside = null;
  let targetUpside = null;
  if (f.priceTargetMean != null && f.priceTargetMean > 0 && price != null && price > 0) {
    upside = clamp((f.priceTargetMean / price - 1) * 100, -40, 80);
    targetUpside = 50 + 45 * Math.tanh((upside - 15) / 25);
  }

  // valuation (§5.2.3): forward PER 우선, PER 70 / PBR 30, pct:abs = 40:60
  const perAbsScore = (p) =>
    f.isFinancial
      ? (p <= 5 ? 85 : p <= 8 ? 70 : p <= 12 ? 55 : 40)
      : (p <= 6 ? 85 : p <= 10 ? 75 : p <= 15 ? 62 : p <= 25 ? 48 : p <= 40 ? 35 : 22);
  let perScore = null;
  if (f.perUsed != null && f.perUsed > 0) {
    const pp = P.perUsed(f.perUsed);
    const abs = perAbsScore(f.perUsed);
    perScore = pp == null ? abs : 0.4 * (1 - pp) * 100 + 0.6 * abs;
  }
  let pbrScore = null;
  if (!f.isFinancial && f.pbr != null && f.pbr > 0) {
    const pb = P.pbr(f.pbr);
    const abs = f.pbr <= 0.5 ? 80 : f.pbr <= 1 ? 68 : f.pbr <= 2 ? 52 : f.pbr <= 4 ? 38 : 25;
    pbrScore = pb == null ? abs : 0.4 * (1 - pb) * 100 + 0.6 * abs;
  }
  const valuation = weightedAvg([[perScore, 0.7], [pbrScore, 0.3]]);

  const pairs = [
    [revenueGrowth, 0.2],
    [opGrowth, 0.3],
    [epsGrowth, 0.15],
    [targetUpside, 0.2],
    [valuation, 0.15],
  ];
  let total = weightedAvg(pairs);
  // 컨센서스 부재 시 중립 수축 (§5.2.4)
  if (usedFallback && total != null) total = 50 + (total - 50) * 0.6;

  // OUTRISK (§5.4.2)
  const riskSignals = [];
  {
    // 영업이익 전망 계열 — 중복 시 큰 쪽만
    const cands = [];
    if (f.hasConsensus && f.consOpG != null && f.consOpG < 0 && !(f.consOp != null && f.consOp < 0)) {
      const gw = w('consOpG', f.consOpG);
      cands.push({ label: `컨센서스 영업이익 ${fmtGrowth(f.consOpG)} 전망`, pts: Math.round(Math.min(35, Math.abs(gw) * 0.8)) });
    }
    if (f.hasConsensus && f.consOp != null && f.consOp < 0 && f.latestOp != null) {
      if (f.latestOp >= 0) cands.push({ label: '컨센서스 영업이익 적자전환 전망', pts: 40 });
      else cands.push({ label: '컨센서스 영업이익 적자 지속 전망', pts: 30 });
    }
    if (cands.length > 0) riskSignals.push(cands.sort((a, b) => b.pts - a.pts)[0]);
    if (upside != null && upside < 0) {
      riskSignals.push({
        label: `현재가가 목표주가 평균 상회(괴리율 ${round1(upside)}%)`,
        pts: Math.round(Math.min(25, Math.abs(upside) * 1.5)),
      });
    }
    const pp = f.perUsed != null ? P.perUsed(f.perUsed) : null;
    if (pp != null && pp >= 0.8 && f.consEpsG != null && f.consEpsG < 10) {
      riskSignals.push({ label: 'PER 지수 상위 20% + EPS 성장 10% 미만(성장 없는 고평가)', pts: 15 });
    }
    if (!f.hasConsensus) riskSignals.push({ label: '애널리스트 컨센서스 부재(불확실성)', pts: 10 });
  }
  const risk = clamp(riskSignals.reduce((a, s) => a + s.pts, 0), 0, 100);

  return {
    total: total == null ? 50 : roundScore(total),
    dataMissing: total == null,
    missFrac: missingWeightFrac(pairs),
    hasConsensus: f.hasConsensus && !usedFallback,
    usedFallback, lowBase,
    revenueGrowth, opGrowth, epsGrowth, targetUpside, valuation, risk,
    upside, perScore, pbrScore, riskSignals,
  };
}

/** OUT 파트 객체 조립 (§6.2 템플릿) */
function buildOutParts(f, out, X, price) {
  const { P, w } = X;
  const cy = f.consYearLabel;
  const ly = f.latestYearLabel;

  const growthPart = (kind, score) => {
    // kind: rev | op | eps
    const nameKo = kind === 'rev' ? '매출액' : kind === 'op' ? '영업이익' : 'EPS';
    const label = kind === 'rev' ? '매출 성장 전망' : kind === 'op' ? '영업이익 성장 전망' : 'EPS 성장 전망';
    const latestVal = kind === 'rev' ? f.latestRev : kind === 'op' ? f.latestOp : f.latestEps;
    const consVal = kind === 'rev' ? f.consRev : kind === 'op' ? f.consOp : f.consEps;
    const g = kind === 'rev' ? f.consRevG : kind === 'op' ? f.consOpG : f.consEpsG;
    const pKey = kind === 'rev' ? 'consRevG' : kind === 'op' ? 'consOpG' : 'consEpsG';
    const fmtVal = (v) => (kind === 'eps' ? fmtWon(v) : fmtEok(v));

    if (out.usedFallback) {
      // 폴백: 실적 추세 대체
      const fbG = kind === 'rev' ? f.revYoY : kind === 'op' ? f.opYoY : null;
      const fbKey = kind === 'rev' ? 'revYoY' : 'opYoY';
      const a = '컨센서스가 없어 최근 실적 추세로 대신 추정합니다(신뢰도 낮음).';
      if (kind === 'eps') {
        return partObj(null, label, [a, 'EPS 성장 전망은 컨센서스 부재로 평가에서 제외했습니다.'], [], []);
      }
      return partObj(
        score, label,
        [
          a,
          fbG != null ? `${ly} ${nameKo} YoY ${fmtGrowth(fbG)}를 대체 지표로 사용했습니다.` : null,
          score != null
            ? `실적 추세 코스피200 ${pctLabel(P[fbKey](w(fbKey, fbG)))} → ${roundScore(score)}점. 컨센서스 부재로 전망 축 점수에 중립 수축(×0.6)이 적용되었습니다.`
            : '대체 지표도 결측이라 평가에서 제외했습니다.',
        ],
        [{ label: `${nameKo} YoY(${ly || '최근'})`, value: fmtGrowth(fbG) }],
        ['컨센서스 부재 — 실적 추세 대체(중립 수축 적용)']
      );
    }

    const a = `애널리스트들이 전망하는 ${cy} ${nameKo}이 최근 확정 실적 대비 얼마나 늘어나는지를 봅니다.`;
    const turnUp = latestVal != null && consVal != null && latestVal < 0 && consVal > 0;
    const stillLoss = latestVal != null && consVal != null && consVal < 0 && latestVal < 0;
    const turnLoss = latestVal != null && consVal != null && consVal < 0 && latestVal >= 0;
    let b = null;
    let c = null;
    if (turnUp) {
      b = `${ly} ${fmtVal(latestVal)} → ${cy} 적자 → 흑자전환 전망.`;
      c = `흑자전환 전망으로 ${roundScore(score)}점 부여`;
    } else if (stillLoss) {
      b = `${cy} 적자 지속(${consVal > latestVal ? '적자폭 축소' : '적자폭 확대'}) 전망.`;
      c = `적자 지속으로 점수 상한(55)이 적용되었습니다 → ${roundScore(score)}점`;
    } else if (turnLoss) {
      b = `${ly} ${fmtVal(latestVal)} → ${cy} 적자전환 전망.`;
      c = `적자전환 전망으로 점수 상한(20) 적용 → ${roundScore(score)}점`;
    } else if (latestVal != null && consVal != null && g != null) {
      b = `${ly} ${fmtVal(latestVal)} → ${cy} 컨센서스 ${fmtVal(consVal)} (${fmtGrowth(g)}).`;
      c = `전망 성장률 코스피200 ${pctLabel(P[pKey](w(pKey, g)))} → ${roundScore(score)}점`;
    }
    if (kind === 'op' && out.lowBase && c) {
      c += ' (직전 이익 기저가 낮아 기저효과 반영, 점수 상한 적용)';
    }
    return partObj(
      score, label,
      [a, b, score != null ? c : `${nameKo} 컨센서스가 없어 평가에서 제외했습니다.`],
      [
        { label: `${nameKo}(${ly || '최근'})`, value: fmtVal(latestVal) },
        { label: `컨센서스(${cy || '차기'})`, value: fmtVal(consVal) },
        { label: '전망 성장률', value: turnUp ? '흑자전환' : stillLoss ? '적자 지속' : turnLoss ? '적자전환' : fmtGrowth(g) },
      ],
      [
        turnUp ? `${cy} ${nameKo} 흑자전환 전망` : null,
        stillLoss ? `${cy} ${nameKo} 적자 지속 전망` : null,
        turnLoss ? `${cy} ${nameKo} 적자전환 전망` : null,
      ]
    );
  };

  const revenueGrowth = growthPart('rev', out.revenueGrowth);
  const opGrowth = growthPart('op', out.opGrowth);
  const epsGrowth = growthPart('eps', out.epsGrowth);

  // targetUpside
  let targetUpside;
  if (out.targetUpside == null) {
    targetUpside = partObj(
      null, '목표주가',
      [
        '애널리스트 평균 목표주가가 현재 주가보다 얼마나 높은지(괴리율)를 봅니다.',
        '목표주가 컨센서스가 없어 이 항목은 평가에서 제외했습니다.',
      ],
      [], []
    );
  } else {
    const u = out.upside;
    const rel = u >= 30 ? '을 크게 상회' : u >= 5 ? ' 수준' : '에 못 미침';
    targetUpside = partObj(
      out.targetUpside, '목표주가',
      [
        '애널리스트 평균 목표주가가 현재 주가보다 얼마나 높은지(괴리율)를 봅니다.',
        `평균 목표주가 ${fmtWon(f.priceTargetMean)} vs 현재가 ${fmtWon(price)} → 괴리율 ${round1(u)}%.`,
        `괴리율 ${round1(u)}%는 통상적 상방 편향(+15% 내외)${rel} → ${roundScore(out.targetUpside)}점` +
          (f.recommMean != null ? ` (참고: 투자의견 평균 ${round2(f.recommMean)}/5)` : ''),
      ],
      [
        { label: '평균 목표주가', value: fmtWon(f.priceTargetMean) },
        { label: '현재가', value: fmtWon(price) },
        { label: '괴리율', value: `${u >= 0 ? '+' : ''}${round1(u)}%` },
        { label: '투자의견 평균', value: f.recommMean == null ? null : `${round2(f.recommMean)}/5` },
      ],
      [u < 0 ? '현재가가 목표주가 평균을 웃돌아 감점' : u >= 30 ? '목표주가 괴리율이 상방 편향을 크게 상회' : null]
    );
  }

  // valuation
  const perAbsLabel = (p) =>
    f.isFinancial
      ? (p <= 5 ? '매우 저평가' : p <= 8 ? '저평가' : p <= 12 ? '적정' : '고평가')
      : (p <= 6 ? '매우 저평가' : p <= 10 ? '저평가' : p <= 15 ? '적정 하단' : p <= 25 ? '적정' : p <= 40 ? '다소 고평가' : '고평가');
  const usedFwd = f.cnsPer != null;
  const valB = [];
  if (f.perUsed != null) valB.push(usedFwd ? `추정PER ${round1(f.perUsed)}배(전망 이익 기준)` : `PER ${round1(f.perUsed)}배`);
  if (f.pbr != null) valB.push(`PBR ${round1(f.pbr)}배`);
  const pp = f.perUsed != null ? X.P.perUsed(f.perUsed) : null;
  const valuation = partObj(
    out.valuation, '밸류에이션',
    [
      '이익·자산 대비 주가 수준(PER·PBR)이 싼지 비싼지를 절대 구간과 지수 내 상대 위치로 함께 봅니다.',
      f.deficit && !usedFwd ? '적자로 PER 산출 불가 — PBR 중심 평가.' : null,
      f.isFinancial ? '금융업은 구조적 저PBR 특성을 감안해 PER 중심으로 평가합니다.' : null,
      valB.length ? `${valB.join(', ')}.` : null,
      out.valuation != null && f.perUsed != null
        ? `PER 절대 구간 ${perAbsLabel(f.perUsed)} · 지수 내 ${pctLabel(pp == null ? null : 1 - pp)} → ${roundScore(out.valuation)}점`
        : out.valuation != null ? `→ ${roundScore(out.valuation)}점` : 'PER·PBR 모두 결측이라 평가에서 제외했습니다.',
    ],
    [
      { label: usedFwd ? '추정PER' : 'PER', value: f.perUsed == null ? null : `${round1(f.perUsed)}배` },
      { label: 'PBR', value: f.pbr == null ? null : `${round1(f.pbr)}배` },
    ],
    [
      pp != null && pp <= 0.35 ? `PER ${round1(f.perUsed)}배로 지수 하위 ${Math.max(1, Math.round(pp * 100))}% 저평가` : null,
      pp != null && pp >= 0.7 ? `PER ${round1(f.perUsed)}배로 지수 상위 ${Math.max(1, Math.round((1 - pp) * 100))}% 고평가 부담` : null,
    ]
  );

  // risk (OUTRISK)
  const sigLabels = out.riskSignals.map((s) => `${s.label}(+${s.pts})`);
  const risk = partObj(
    out.risk, '전망 리스크',
    [
      '전망 측면의 위험 신호(이익 감소 전망, 목표주가 하회, 성장 없는 고평가)를 누적 가산합니다.',
      out.riskSignals.length === 0
        ? '확인된 전망 위험 신호가 없습니다 (0점).'
        : `발동 신호: ${sigLabels.join(', ')}. 위험 신호 ${out.riskSignals.length}건 → 전망 리스크 ${roundScore(out.risk)}점 (신호 없음 = 0점이 기본)`,
    ],
    out.riskSignals.map((s) => ({ label: s.label, value: `+${s.pts}점` })),
    sigLabels
  );

  return { revenueGrowth, opGrowth, epsGrowth, targetUpside, valuation, risk };
}

// ---------------- TECH (§5.3 buy / §5.4.3 sell) ----------------
function scoreTech(t, X) {
  const st = t.trendState; // 'up' | 'down' | 'mixed'

  // ---- rsi (20%) — 추세 조건부 (§5.3.1) ----
  const rsiUp = (r) =>
    r <= 30 ? 85
    : r <= 45 ? 85 - ((r - 30) / 15) * 15   // 85→70
    : r <= 60 ? 70 - ((r - 45) / 15) * 15   // 70→55
    : r <= 70 ? 55 - ((r - 60) / 10) * 20   // 55→35
    : Math.max(10, 35 - (r - 70) * 1.5);
  const rsiDown = (r) => (r <= 30 ? 55 : r <= 50 ? 50 - ((r - 30) / 20) * 10 : 45);
  let rsiBuy = null;
  if (t.rsi != null) {
    rsiBuy = st === 'up' ? rsiUp(t.rsi) : st === 'down' ? rsiDown(t.rsi) : (rsiUp(t.rsi) + rsiDown(t.rsi)) / 2;
    rsiBuy = clamp(rsiBuy, 0, 100);
  }

  // ---- macd (25%) — V1 로직 유지 ----
  let macdBuy = null;
  if (t.macd != null && t.signal != null) {
    macdBuy = 50;
    macdBuy += t.macd > t.signal ? 15 : -15;
    if (t.histRising === true) macdBuy += 10;
    else if (t.histRising === false) macdBuy -= 10;
    if (t.crossUp) macdBuy += 12;
    if (t.crossDown) macdBuy -= 8;
    macdBuy += t.macd > 0 ? 5 : -5;
    macdBuy = clamp(macdBuy, 0, 100);
  }

  // ---- trend (30%) ----
  let trendBuy = null;
  if (t.ma20 != null) {
    trendBuy = 50;
    const aboveMa20 = t.close > t.ma20;
    const aboveMa60 = t.ma60 != null ? t.close > t.ma60 : null;
    trendBuy += aboveMa20 ? 12 : -12;
    if (aboveMa60 != null) {
      trendBuy += aboveMa60 ? 8 : -8;
      trendBuy += t.ma20 > t.ma60 ? 5 : -5;
    }
    if (t.momentum20 != null) trendBuy += clamp(t.momentum20, -15, 15) * 0.7; // V1 ±18 → ±10.5
    if (t.pos52 != null) {
      if (t.pos52 >= 60) trendBuy += 6;
      else if (t.pos52 <= 15) trendBuy -= 6;
    }
    if (t.flowRatio != null && t.flowRatio >= 0.05) trendBuy += 3;
    // 투자자별 확증(V2.1): 외국인·기관 동반 순매수(+2), 개인 순매도로 확증(+1)
    if (t.flow) {
      if (t.flow.foreignRatio > 0 && t.flow.organRatio > 0) trendBuy += 2;
      if (t.flow.indivRatio != null && t.flow.indivRatio <= -0.05 && t.flowRatio >= 0) trendBuy += 1;
    }
    if (t.volumeZ != null && t.volumeZ >= 2 && t.momentum20 != null && t.momentum20 > 0) trendBuy += 4;
    trendBuy = clamp(trendBuy, 0, 100);
  }

  // ---- band (25%): 0.6×%b + 0.4×이격도 ----
  const bUp = (b) =>
    b <= 0.2 ? 80
    : b <= 0.5 ? 80 - ((b - 0.2) / 0.3) * 20
    : b <= 0.8 ? 60 - ((b - 0.5) / 0.3) * 10
    : b <= 1.0 ? 50 - ((b - 0.8) / 0.2) * 15
    : 30;
  const bDown = (b) => (b <= 0.05 ? 40 : b <= 0.5 ? 45 : 50);
  let bScore = null;
  if (t.bollingerB != null) {
    bScore = st === 'up' ? bUp(t.bollingerB) : st === 'down' ? bDown(t.bollingerB) : (bUp(t.bollingerB) + bDown(t.bollingerB)) / 2;
  }
  let dispScore = null;
  if (t.disparity20 != null) {
    dispScore =
      st === 'up' ? (t.disparity20 <= -12 ? 70 : t.disparity20 < 8 ? 55 : 35)
      : st === 'down' ? 45
      : 50;
  }
  const band = weightedAvg([[bScore, 0.6], [dispScore, 0.4]]);

  const buyPairs = [[rsiBuy, 0.2], [macdBuy, 0.25], [trendBuy, 0.3], [band, 0.25]];
  let buy = weightedAvg(buyPairs);
  // 복합 보너스: 골든크로스 + RSI≤40 — uptrend/mixed에서만
  if (buy != null && t.crossUp && t.rsi != null && t.rsi <= 40 && st !== 'down') {
    buy = clamp(buy + 7, 0, 100);
  }

  // ---- TECH_sell (§5.4.3): base 15 이벤트 가산 ----
  const sellSignals = [];
  let sell = 15;
  if (t.rsi != null && t.rsi >= 70) {
    const pts = t.rsi >= 80 ? 24 : 18;
    sellSignals.push({ label: `RSI ${round1(t.rsi)} 과매수`, pts });
  }
  if (t.bollingerB != null && t.bollingerB >= 1.0)
    sellSignals.push({ label: `볼린저 상단 돌파(%b ${round2(t.bollingerB)})`, pts: 12 });
  if (t.disparity20 != null && t.disparity20 >= 10)
    sellSignals.push({ label: `MA20 이격도 +${round1(t.disparity20)}% 과열`, pts: 10 });
  if (t.pos52 != null && t.pos52 >= 95 && t.rsi != null && t.rsi >= 65)
    sellSignals.push({ label: '52주 신고가 부근 과열', pts: 8 });
  if (t.crossDown) sellSignals.push({ label: '데드크로스', pts: 15 });
  if (t.ma20 != null && t.ma60 != null && t.close < t.ma20 && t.close < t.ma60)
    sellSignals.push({ label: '종가 MA20·MA60 동시 하회', pts: 12 });
  if (t.ma20 != null && t.ma60 != null && t.ma20 < t.ma60)
    sellSignals.push({ label: 'MA20 < MA60 역배열', pts: 8 });
  if (t.bollingerB != null && t.bollingerB <= 0.05 && st === 'down')
    sellSignals.push({ label: '하락 밴드워크(%b ≤ 0.05)', pts: 8 });
  if (
    t.volumeZ != null && t.volumeZ >= 2 &&
    ((t.dayChange != null && t.dayChange < 0) || (t.momentum20 != null && t.momentum20 < 0))
  )
    sellSignals.push({ label: `하락 동반 거래대금 급증(Z ${round1(t.volumeZ)})`, pts: 10 });
  if (t.flowRatio != null && t.flowRatio <= -0.05)
    sellSignals.push({ label: '외인+기관 5일 순매도', pts: 5 });
  // 투자자별 확증(V2.1): 외국인·기관 동반 순매도(+3), 개인 순매수·스마트머니 이탈(+3)
  if (t.flow) {
    if (t.flow.foreignRatio < 0 && t.flow.organRatio < 0)
      sellSignals.push({ label: '외국인·기관 동반 순매도', pts: 3 });
    if (t.flow.indivRatio != null && t.flow.indivRatio >= 0.05 && t.flowRatio <= 0)
      sellSignals.push({ label: '개인 순매수·외인/기관 이탈', pts: 3 });
  }
  if (
    t.atrPct != null && X.P.atrPct(t.atrPct) != null && X.P.atrPct(t.atrPct) >= 0.9 &&
    t.momentum20 != null && t.momentum20 < 0
  )
    sellSignals.push({ label: `변동성 급등(ATR ${round1(t.atrPct)}%) 속 하락`, pts: 5 });
  if (
    st === 'up' && t.rsi != null && t.rsi >= 40 && t.rsi <= 60 &&
    t.bollingerB != null && t.bollingerB >= 0.3 && t.bollingerB <= 0.8
  )
    sellSignals.push({ label: '건전한 추세 진행(감산)', pts: -10 });
  sell += sellSignals.reduce((a, s) => a + s.pts, 0);
  sell = clamp(sell, 0, 100);

  return {
    buy: buy == null ? 50 : roundScore(buy),
    sell: roundScore(sell),
    buyMissing: buy == null,
    missFrac: missingWeightFrac(buyPairs),
    rsiBuy, macdBuy, trendBuy, band, bScore, dispScore,
    sellSignals,
  };
}

/** TECH 파트 객체 조립 (§6.3 템플릿) */
function buildTechParts(t, tc) {
  const st = t.trendState;
  const stKo = st === 'up' ? '상승추세' : st === 'down' ? '하락추세' : '중립';

  // rsi
  let rsiC = null;
  if (t.rsi != null) {
    if (st === 'up' && t.rsi <= 45) rsiC = `상승추세 속 눌림목(과매도권)으로 매수 관점 가점 → ${roundScore(tc.rsiBuy)}점`;
    else if (st === 'down' && t.rsi <= 30) rsiC = `과매도권이지만 하락추세가 진행 중이라 가점하지 않았습니다(중립 처리) → ${roundScore(tc.rsiBuy)}점`;
    else if (t.rsi >= 70) rsiC = `과매수권으로 매수 관점 감점, 매도 관점 가점 → buy ${roundScore(tc.rsiBuy)}점`;
    else rsiC = `중립권 → ${roundScore(tc.rsiBuy)}점`;
  }
  const rsi = partObj(
    tc.rsiBuy, 'RSI',
    [
      '최근 14일 상승/하락 강도로 과매수·과매도를 측정하되, 추세 방향에 따라 해석을 달리합니다.',
      t.rsi != null ? `RSI(14) ${round1(t.rsi)} / 추세 상태: ${stKo}.` : 'RSI 산출 데이터가 부족합니다.',
      rsiC,
    ],
    [
      { label: 'RSI(14)', value: round1(t.rsi) },
      { label: '추세 상태', value: stKo },
    ],
    [t.rsi != null && t.rsi >= 70 ? `RSI ${round1(t.rsi)} 과매수권` : t.rsi != null && t.rsi <= 30 ? `RSI ${round1(t.rsi)} 과매도권` : null]
  );

  // macd
  const macdStatus =
    t.macd == null || t.signal == null ? '데이터 부족'
    : t.crossUp ? '골든크로스'
    : t.crossDown ? '데드크로스'
    : t.macd > t.signal ? '시그널 상회'
    : '시그널 하회';
  const histDir = t.histRising === true ? '확대' : t.histRising === false ? '축소' : null;
  const macd = partObj(
    tc.macdBuy, 'MACD',
    [
      '단기(12일)·장기(26일) 이동평균 차이로 모멘텀의 방향 전환을 포착합니다.',
      t.macd != null
        ? `MACD ${round2(t.macd)} / 시그널 ${round2(t.signal)}${t.hist != null ? ` / 히스토그램 ${round2(t.hist)}${histDir ? ` (${histDir})` : ''}` : ''} / 상태: ${macdStatus}.`
        : 'MACD 산출 데이터가 부족합니다.',
      tc.macdBuy != null ? `${macdStatus}${histDir ? ` + 히스토그램 ${histDir}` : ''} → ${roundScore(tc.macdBuy)}점` : null,
    ],
    [
      { label: 'MACD', value: round2(t.macd) },
      { label: '시그널', value: round2(t.signal) },
      { label: '히스토그램', value: round2(t.hist) },
      { label: '상태', value: macdStatus },
    ],
    [t.crossUp ? 'MACD 시그널 상향 돌파(골든크로스)' : t.crossDown ? 'MACD 시그널 하향 이탈(데드크로스)' : null]
  );

  // trend
  const maLabel =
    t.ma20 == null ? '데이터 부족'
    : t.ma60 == null
      ? (t.close > t.ma20 ? 'MA20 상회' : 'MA20 하회')
      : t.close > t.ma20 && t.close > t.ma60 ? 'MA20/60 상회'
      : t.close < t.ma20 && t.close < t.ma60 ? 'MA20/60 하회'
      : t.close > t.ma20 ? 'MA20 상회/MA60 하회'
      : 'MA20 하회/MA60 상회';
  const posLabel =
    t.pos52 == null ? null : t.pos52 >= 60 ? '고점권(추세 건재)' : t.pos52 <= 15 ? '바닥권(추세 훼손)' : '중간권';
  const trend = partObj(
    tc.trendBuy, '추세',
    [
      '주가가 20일·60일 이동평균 위에 있는지, 최근 20일 상승 폭과 52주 내 위치로 추세 건강도를 봅니다.',
      t.ma20 != null
        ? `종가 ${fmtComma(t.close)} vs MA20 ${fmtComma(t.ma20)}${t.ma60 != null ? ` / MA60 ${fmtComma(t.ma60)}` : ''}` +
          `${t.momentum20 != null ? `, 20일 모멘텀 ${fmtGrowth(t.momentum20)}` : ''}` +
          `${t.pos52 != null ? `, 52주 위치 ${round1(t.pos52)} (0=최저가, 100=최고가)${t.pos52Approx ? ' — 300봉 근사' : ''}` : ''}.`
        : '이동평균 산출 데이터가 부족합니다.',
      tc.trendBuy != null
        ? `${maLabel}${t.momentum20 != null ? ` · 모멘텀 ${fmtGrowth(t.momentum20)}` : ''}${posLabel ? `, 52주 ${posLabel}` : ''} → ${roundScore(tc.trendBuy)}점`
        : null,
    ],
    [
      { label: '종가', value: fmtComma(t.close) },
      { label: 'MA20', value: fmtComma(t.ma20) },
      { label: 'MA60', value: fmtComma(t.ma60) },
      { label: '20일 모멘텀', value: fmtGrowth(t.momentum20) },
      { label: '52주 위치', value: round1(t.pos52) },
    ],
    [
      `${maLabel}`,
      posLabel ? `52주 ${posLabel}` : null,
    ]
  );

  // band
  let bandC = null;
  if (t.bollingerB != null) {
    const b = t.bollingerB;
    const desc =
      b >= 1 ? '상단 밴드 돌파(단기 과열)'
      : b <= 0.05 && st === 'down' ? '하락 밴드워크(가점 없음)'
      : b <= 0.2 && st === 'up' ? '상승추세 속 하단 접근(눌림목)'
      : '밴드 중간';
    bandC = `%b ${desc} → ${roundScore(tc.band)}점`;
  }
  const band = partObj(
    tc.band, '볼린저밴드',
    [
      '20일 평균 대비 주가가 통계적 밴드(±2σ)의 어디에 있는지로 단기 과열·눌림을 측정합니다.',
      t.bollingerB != null
        ? `%b ${round2(t.bollingerB)} (0=하단 밴드, 1=상단 밴드)${t.disparity20 != null ? `, MA20 이격도 ${fmtGrowth(t.disparity20)}` : ''}.`
        : '볼린저밴드 산출 데이터가 부족합니다.',
      bandC,
    ],
    [
      { label: '%b(20,2)', value: round2(t.bollingerB) },
      { label: 'MA20 이격도', value: t.disparity20 == null ? null : fmtGrowth(t.disparity20) },
    ],
    [
      t.bollingerB != null && t.bollingerB >= 1 ? '상단 밴드 돌파(단기 과열)' : null,
      t.bollingerB != null && t.bollingerB <= 0.2 && st === 'up' ? '상승추세 속 하단 접근(눌림목)' : null,
    ]
  );

  // volume (거래대금 Z + 수급) — 가중 파트가 아니라 trend/sell 가감 반영 (score=null)
  const zUp = t.volumeZ != null && t.volumeZ >= 2 && t.momentum20 != null && t.momentum20 > 0;
  const zDown =
    t.volumeZ != null && t.volumeZ >= 2 &&
    ((t.dayChange != null && t.dayChange < 0) || (t.momentum20 != null && t.momentum20 < 0));
  const flowPct = t.flowRatio == null ? null : round2(t.flowRatio * 100);
  const fPct = t.flow && t.flow.foreignRatio != null ? round2(t.flow.foreignRatio * 100) : null;
  const oPct = t.flow && t.flow.organRatio != null ? round2(t.flow.organRatio * 100) : null;
  const iPct = t.flow && t.flow.indivRatio != null ? round2(t.flow.indivRatio * 100) : null;
  const volume = partObj(
    null, '거래량·수급',
    [
      '거래대금이 최근 20일 평균 대비 통계적으로 얼마나 튀었는지(Z-score)와 투자자별(외국인·기관·개인) 5일 순매수 방향을 봅니다.',
      t.volumeZ != null || flowPct != null
        ? `${t.volumeZ != null ? `거래대금 Z ${round1(t.volumeZ)} (2 이상이면 급증)` : ''}${t.volumeZ != null && flowPct != null ? ', ' : ''}${flowPct != null ? `외인+기관 5일 순매수/거래량 ${flowPct}%` : ''}${iPct != null ? ` (개인 ${iPct}%)` : ''}.`
        : '거래대금·수급 데이터가 부족합니다.',
      zUp ? '상승 동반 대금 급증(매수 관점 가점) → 추세 파트에 +4점 반영'
        : zDown ? '하락 동반 대금 급증(매도 관점 가점) → 매도 신호에 +10점 반영'
        : t.flowRatio != null && t.flowRatio >= 0.05 ? '외인+기관 순매수 우위 → 추세 파트에 +3점 반영'
        : t.flowRatio != null && t.flowRatio <= -0.05 ? '외인+기관 순매도 우위 → 매도 신호에 +5점 반영'
        : '특이 신호 없음 → 가감 없음',
    ],
    [
      { label: '거래대금 Z(20)', value: round1(t.volumeZ) },
      { label: '외국인 5일 순매수/거래량', value: fPct == null ? null : `${fPct}%` },
      { label: '기관 5일 순매수/거래량', value: oPct == null ? null : `${oPct}%` },
      { label: '개인 5일 순매수/거래량', value: iPct == null ? null : `${iPct}%` },
      { label: '외인+기관 5일 순매수/거래량', value: flowPct == null ? null : `${flowPct}%` },
    ],
    [zUp ? '상승 동반 거래대금 급증' : null, zDown ? '하락 동반 거래대금 급증' : null]
  );
  volume.buyScore = zUp ? 4 : t.flowRatio != null && t.flowRatio >= 0.05 ? 3 : 0;
  volume.sellScore = zDown ? 10 : t.flowRatio != null && t.flowRatio <= -0.05 ? 5 : 0;

  // sellSignals (TECH_sell 종합)
  const fired = tc.sellSignals.filter((s) => s.pts > 0);
  const sigLabels = tc.sellSignals.map((s) => `${s.label}(${s.pts >= 0 ? '+' : ''}${s.pts})`);
  const sellSignals = partObj(
    tc.sell, '매도 신호',
    [
      '과열·추세이탈·투매 등 "지금 팔 이유"가 되는 이벤트를 하나씩 가산합니다(기본 15점).',
      fired.length === 0
        ? '현재 뚜렷한 매도 신호가 없습니다.'
        : `발동 신호: ${sigLabels.join(', ')}. 매도 신호 ${fired.length}건 → TECH_sell ${roundScore(tc.sell)}점`,
    ],
    tc.sellSignals.map((s) => ({ label: s.label, value: `${s.pts >= 0 ? '+' : ''}${s.pts}점` })),
    sigLabels
  );
  sellSignals.sellScore = roundScore(tc.sell);

  return { rsi, macd, trend, band, volume, sellSignals };
}

// ---------------------------------------------------------------------------
// 7. 축 요약 reasons (V1 유지 + V2 보강)
// ---------------------------------------------------------------------------
function finReasons(f, fin, X) {
  const { P, w } = X;
  const rs = [];
  if (f.roe != null) rs.push(`ROE ${round1(f.roe)}%로 코스피200 ${pctLabel(P.roe(w('roe', f.roe)))}`);
  if (f.latestOp != null && f.prevOp != null && f.latestOp < 0) {
    rs.push(
      f.prevOp >= 0
        ? `${f.latestYearLabel} 영업이익 적자전환`
        : `${f.latestYearLabel} 영업이익 적자 지속(${f.latestOp > f.prevOp ? '적자폭 축소' : '적자폭 확대'})`
    );
  } else if (f.latestOp != null && f.prevOp != null && f.prevOp < 0 && f.latestOp >= 0) {
    rs.push(`${f.latestYearLabel} 영업이익 흑자전환`);
  } else if (f.opYoY != null) {
    rs.push(`${f.latestYearLabel} 영업이익 전년 대비 ${fmtGrowth(f.opYoY)}`);
  } else if (f.revYoY != null) {
    rs.push(`${f.latestYearLabel} 매출액 전년 대비 ${fmtGrowth(f.revYoY)}`);
  }
  if (f.isFinancial) {
    rs.push('금융업 특성상 부채비율 평가 제외');
  } else if (f.debtRatio != null) {
    if (f.debtRatio < 100) rs.push(`부채비율 ${round1(f.debtRatio)}%로 재무구조 안정적`);
    else if (f.debtRatio < 200) rs.push(`부채비율 ${round1(f.debtRatio)}%로 보통 수준`);
    else if (f.debtRatio < 400) rs.push(`부채비율 ${round1(f.debtRatio)}%로 다소 높음`);
    else rs.push(`부채비율 ${round1(f.debtRatio)}%로 높음`);
  }
  if (f.deficit) rs.push(`최근 확정연도(${f.latestYearLabel}) 당기순이익 적자`);
  if (fin.dataMissing) rs.push('재무 데이터 부족으로 중립(50점) 처리');
  return rs.slice(0, 4);
}

function outReasons(f, out, X) {
  const rs = [];
  if (f.hasConsensus) {
    if (f.consOp != null && f.latestOp != null && f.consOp < 0) {
      if (f.latestOp < 0)
        rs.push(`${f.consYearLabel} 컨센서스 영업이익 적자 지속(${f.consOp > f.latestOp ? '적자폭 축소' : '적자폭 확대'} 전망)`);
      else rs.push(`${f.consYearLabel} 컨센서스 영업이익 적자전환 전망`);
    } else if (f.consOpG != null) {
      if (f.latestOp != null && f.latestOp < 0 && f.consOp > 0)
        rs.push(`${f.consYearLabel} 컨센서스 영업이익 흑자전환 전망`);
      else rs.push(`${f.consYearLabel} 컨센서스 영업이익 ${fmtGrowth(f.consOpG)} 전망`);
    }
    if (out.upside != null) {
      rs.push(
        out.upside >= 0
          ? `평균 목표주가 대비 상승여력 ${round1(out.upside)}%`
          : `현재가가 평균 목표주가를 ${round1(-out.upside)}% 상회`
      );
    }
    if (f.consRevG != null && rs.length < 3)
      rs.push(`${f.consYearLabel} 컨센서스 매출액 ${fmtGrowth(f.consRevG)} 전망`);
  } else {
    rs.push('애널리스트 컨센서스 부재 — 최근 실적 추세 기반 추정(신뢰도 낮음, 중립 수축 적용)');
    if (f.latestOp != null && f.prevOp != null && f.latestOp < 0) {
      rs.push(
        f.prevOp >= 0
          ? '최근 확정연도 영업이익 적자전환 추세 반영'
          : `최근 확정연도 영업이익 적자 지속(${f.latestOp > f.prevOp ? '적자폭 축소' : '적자폭 확대'}) 추세 반영`
      );
    } else if (f.opYoY != null) {
      rs.push(`최근 확정연도 영업이익 ${fmtGrowth(f.opYoY)} 추세 반영`);
    }
  }
  const pp = f.perUsed != null ? X.P.perUsed(f.perUsed) : null;
  if (pp != null) {
    if (pp <= 0.35) rs.push(`${f.cnsPer != null ? '추정PER' : 'PER'} ${round1(f.perUsed)}배로 지수 하위 ${Math.max(1, Math.round(pp * 100))}% 저평가`);
    else if (pp >= 0.7) rs.push(`${f.cnsPer != null ? '추정PER' : 'PER'} ${round1(f.perUsed)}배로 지수 상위 ${Math.max(1, Math.round((1 - pp) * 100))}% 고평가 부담`);
  } else if (f.deficit) {
    rs.push('적자로 PER 산출 불가 — 밸류에이션 평가에서 PER 제외');
  }
  return rs.slice(0, 4);
}

function techReasons(t, tc) {
  const rs = [];
  if (t.crossUp) rs.push('MACD 시그널 상향 돌파(골든크로스)');
  else if (t.crossDown) rs.push('MACD 시그널 하향 이탈(데드크로스)');
  else if (t.macd != null && t.signal != null)
    rs.push(t.macd > t.signal ? 'MACD가 시그널 상회 중' : 'MACD가 시그널 하회 중');
  if (t.rsi != null) {
    if (t.rsi >= 70) rs.push(`RSI ${round1(t.rsi)}로 과매수권`);
    else if (t.rsi <= 30)
      rs.push(
        t.trendState === 'down'
          ? `RSI ${round1(t.rsi)} 과매도권(하락추세라 가점 없음)`
          : `RSI ${round1(t.rsi)}로 과매도권`
      );
    else rs.push(`RSI ${round1(t.rsi)} 중립권`);
  }
  if (t.ma20 != null && t.ma60 != null) {
    if (t.close > t.ma20 && t.close > t.ma60) rs.push('종가가 MA20/MA60 모두 상회(상승 배열)');
    else if (t.close < t.ma20 && t.close < t.ma60) rs.push('종가가 MA20/MA60 모두 하회(하락 배열)');
  }
  if (t.bollingerB != null && t.bollingerB >= 1) rs.push(`볼린저 상단 밴드 돌파(%b ${round2(t.bollingerB)})`);
  if (t.volumeZ != null && t.volumeZ >= 2) rs.push(`거래대금 20일 평균 대비 Z ${round1(t.volumeZ)} 급증`);
  if (t.momentum20 != null && Math.abs(t.momentum20) >= 3 && rs.length < 4)
    rs.push(`20일 모멘텀 ${t.momentum20 >= 0 ? '+' : ''}${round1(t.momentum20)}%`);
  return rs.slice(0, 4);
}

// ---------------------------------------------------------------------------
// 8. 등급 / 목표주가 / 총평
// ---------------------------------------------------------------------------
/**
 * P2-4: 등급 캘리브레이션 — 코스피200 내 BUY 백분위 상대평가.
 * 상위 5% 다이아 / ~20% 골드 / ~50% 실버 / ~80% 브론즈 / 나머지 아이언.
 */
function assignGrades(items) {
  const n = items.length;
  const ranked = items
    .map((it, i) => ({ i, buy: it.buy, mc: it.marketCap == null ? -1 : it.marketCap }))
    .sort((a, b) => b.buy - a.buy || b.mc - a.mc);
  const cut = (q) => Math.round(n * q);
  const grades = new Array(n);
  ranked.forEach((r, rank) => {
    grades[r.i] =
      rank < cut(0.05) ? 'diamond'
      : rank < cut(0.2) ? 'gold'
      : rank < cut(0.5) ? 'silver'
      : rank < cut(0.8) ? 'bronze'
      : 'iron';
  });
  return grades;
}

/** KRX 호가단위 반올림 (V2_CONTRACT §2.3) */
function roundToTick(p) {
  const tick =
    p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
  return Math.round(p / tick) * tick;
}

/**
 * 목표주가 (V2_CONTRACT §2.2/2.3) — grade ∈ {diamond, gold}에만 산출.
 */
function computeTargetPrice(f, tech, price, X) {
  if (price == null || price <= 0) return null;
  // E: forward EPS 우선
  const E =
    f.cnsEps != null && f.cnsEps > 0 ? f.cnsEps
    : f.consEps != null && f.consEps > 0 ? f.consEps
    : f.latestEps != null && f.latestEps > 0 ? f.latestEps
    : null;

  const explain = [];
  // 밸류에이션 성분
  let valuation = null;
  if (E != null && X.perMkt != null && X.perMkt > 0) {
    const perNow = price / E;
    const perTarget = clamp(Math.sqrt(perNow * X.perMkt), perNow * 0.85, perNow * 1.35);
    const gW = X.w('consOpG', f.consOpG);
    const g = gW == null ? 0 : clamp(gW, -10, 30);
    const growthAdj = 1 + (g / 100) * 0.5;
    const value = E * perTarget * growthAdj;
    valuation = {
      epsFwd: Math.round(E),
      perNow: round2(perNow),
      perMkt: round2(X.perMkt),
      perTarget: round2(perTarget),
      growthAdj: round2(growthAdj),
      value: Math.round(value),
    };
    explain.push(
      `추정 EPS ${fmtWon(E)} × 목표 PER ${round2(perTarget)}배(현재 PER ${round2(perNow)}배와 시장 중앙값 ${round2(X.perMkt)}배의 기하평균, −15%~+35% 밴드 제한) × 성장 조정 ${round2(growthAdj)}` +
        (gW == null ? '(컨센서스 성장률 결측 — 중립 1.0 적용)' : `(컨센서스 영업이익 성장 ${fmtGrowth(g)}의 50% 반영)`) +
        ` = ${fmtWon(value)}.`
    );
  }
  // 애널리스트 성분
  let analyst = null;
  if (f.priceTargetMean != null && f.priceTargetMean > 0) {
    const discounted = f.priceTargetMean * 0.95;
    analyst = { raw: Math.round(f.priceTargetMean), discounted: Math.round(discounted) };
    explain.push(
      `애널리스트 평균 목표주가 ${fmtWon(f.priceTargetMean)}에 국내 상방 편향 할인 5%를 적용해 ${fmtWon(discounted)}으로 반영했습니다.`
    );
  }

  let raw = null;
  let method = null;
  if (analyst && valuation) {
    raw = 0.45 * analyst.discounted + 0.55 * valuation.value;
    method = 'blend';
    explain.push('두 성분을 애널리스트 45% : 밸류에이션 55%로 가중 평균했습니다.');
  } else if (analyst) {
    raw = analyst.discounted;
    method = 'analyst';
    explain.push('밸류에이션 성분 산출이 불가해 애널리스트 성분만 사용했습니다.');
  } else if (valuation) {
    raw = valuation.value;
    method = 'valuation';
    explain.push('목표주가 컨센서스가 없어 밸류에이션 성분만 사용했습니다.');
  } else {
    return null;
  }

  const floor = price * 1.05;
  const ceil = tech.high52 != null && !tech.pos52Approx
    ? Math.min(price * 1.5, tech.high52 * 1.2)
    : price * 1.5;
  let capped = false;
  let capNote = null;
  let T = raw;
  if (T < floor) {
    T = floor;
    capped = true;
    capNote = '산출값이 현재가 대비 +5% 미만이라 하한(+5%)을 적용했습니다.';
  } else if (T > ceil) {
    T = ceil;
    capped = true;
    capNote = '과열 방지 상한(현재가 +50% 또는 52주 고가 ×1.2)을 적용했습니다.';
  }
  if (capNote) explain.push(capNote);

  const value = roundToTick(T);
  const upside = round1((value / price - 1) * 100);
  explain.push(`KRX 호가단위 반올림 후 목표주가 ${fmtWon(value)} — 현재가 대비 상승여력 ${upside >= 0 ? '+' : ''}${upside}%입니다.`);

  return { value, upside, method, components: { analyst, valuation }, capped, capNote, explain };
}

const GRADE_KO = { diamond: '다이아', gold: '골드', silver: '실버', bronze: '브론즈', iron: '아이언' };

/** 총평 verdict (V2_CONTRACT §2.4) — 전 종목 */
function buildVerdict({ buy, sell, grade, fin, out, tc, tech, finParts, outParts, techParts, targetPrice, confidenceLow }) {
  const stance =
    buy >= 70 ? '매수 우위' : buy >= 55 ? '중립' : sell >= 65 ? '매도 신호 우세' : '관망';

  // ① 등급 + 점수 요약
  let s1 = `코스피200 상대평가 ${GRADE_KO[grade]} 등급으로 매수 매력도(BUY) ${buy}점, 매도 신호(SELL) ${sell}점입니다`;
  if (confidenceLow) s1 += ' (데이터 결측이 많아 신뢰도는 낮은 편입니다)';
  s1 += '.';

  // ② 최강 축 + ③ 최대 리스크 → 한 문장
  const cands = [];
  const push = (label, score) => { if (score != null) cands.push({ label, score }); };
  push('수익성', fin.profitability);
  push('성장성', fin.growth);
  push('안정성', fin.stability);
  push('매출 성장 전망', out.revenueGrowth);
  push('영업이익 성장 전망', out.opGrowth);
  push('EPS 성장 전망', out.epsGrowth);
  push('목표주가 괴리율', out.targetUpside);
  push('밸류에이션', out.valuation);
  push('RSI', tc.rsiBuy);
  push('MACD', tc.macdBuy);
  push('추세', tc.trendBuy);
  push('볼린저밴드', tc.band);
  let s2 = null;
  if (cands.length > 0) {
    const best = cands.reduce((a, b) => (b.score > a.score ? b : a));
    const worst = cands.reduce((a, b) => (b.score < a.score ? b : a));
    const riskSig = (fin.riskSignals || []).concat(out.riskSignals || []);
    const riskTxt =
      riskSig.length > 0
        ? `최대 리스크는 ${riskSig.sort((a, b) => b.pts - a.pts)[0].label} 등 위험 신호 ${riskSig.length}건입니다`
        : `상대적 약점은 ${worst.label}(${roundScore(worst.score)}점)입니다`;
    s2 = `가장 강한 항목은 ${best.label}(${roundScore(best.score)}점)이고, ${riskTxt}.`;
  }

  // ④ 기술적 타이밍
  const stKo = tech.trendState === 'up' ? '상승추세' : tech.trendState === 'down' ? '하락추세' : '추세 중립';
  const rsiKo =
    tech.rsi == null ? '' : tech.rsi >= 70 ? '과매수권' : tech.rsi <= 30 ? '과매도권' : '중립권';
  const s3 =
    tech.rsi != null
      ? `기술적으로는 ${stKo} 국면에 RSI ${round1(tech.rsi)}(${rsiKo})입니다.`
      : `기술적으로는 ${stKo} 국면입니다.`;

  // ⑤ 목표주가
  const s4 = targetPrice
    ? `목표주가 ${fmtWon(targetPrice.value)} 기준 상승여력은 ${targetPrice.upside >= 0 ? '+' : ''}${targetPrice.upside}%입니다.`
    : null;

  return { stance, text: [s1, s2, s3, s4].filter(Boolean).join(' ') };
}

// ---------------------------------------------------------------------------
// 9. alerts.json (V2_CONTRACT §1)
// ---------------------------------------------------------------------------
function buildAlerts(scored, updatedAt) {
  const alertsPath = path.join(OUT_DIR, 'alerts.json');
  let prev = [];
  try {
    const j = JSON.parse(fs.readFileSync(alertsPath, 'utf8'));
    if (Array.isArray(j.signals)) prev = j.signals;
  } catch (_) { /* 최초 실행 또는 파손 — 빈 이력에서 시작 */ }

  // 기존 신호의 isNew 제거 + 30일 이력만 유지
  const cutoff = new Date(Date.now() + 9 * 3600 * 1000);
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const cutStr = cutoff.toISOString().slice(0, 10);
  prev = prev
    .filter((s) => s && s.date && s.date >= cutStr)
    .map((s) => { const { isNew, ...rest } = s; return rest; });

  const seen = new Set(prev.map((s) => `${s.code}|${s.date}|${s.type}`));
  const fresh = [];
  for (const s of scored) {
    const t = s.r.tech;
    if (!t.gcBelowZero) continue;
    const key = `${s.r.meta.code}|${t.lastDate}|gc_below_zero`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({
      type: 'gc_below_zero',
      code: s.r.meta.code,
      name: s.r.meta.name,
      detectedAt: updatedAt,
      date: t.lastDate,
      macd: round2(t.macd),
      signal: round2(t.signal),
      price: s.r.meta.price,
      desc: 'MACD가 0선 아래에서 시그널을 상향 돌파 (저점 반등 신호)',
      isNew: true,
    });
  }
  const signals = [...fresh, ...prev].sort(
    (a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0) || String(b.detectedAt).localeCompare(String(a.detectedAt))
  );
  fs.writeFileSync(alertsPath, JSON.stringify({ updatedAt, signals }));
  return { fresh: fresh.length, total: signals.length };
}

// ---------------------------------------------------------------------------
// 10. 출력 조립
// ---------------------------------------------------------------------------
function buildFinancials(finance) {
  if (!finance) return null;
  const years = finance.years.map((y) => (y.isConsensus ? `${y.title}(E)` : y.title));
  const pick = (title) =>
    finance.years.map((y) => (finance.rows[title] ? finance.rows[title][y.key] : null));
  return {
    years,
    revenue: pick('매출액'),
    op: pick('영업이익'),
    netIncome: pick('당기순이익'),
    roe: pick('ROE'),
    debtRatio: pick('부채비율'),
    per: pick('PER'),
    pbr: pick('PBR'),
    eps: pick('EPS'),
  };
}

function buildChart(candles, t) {
  const N = 120;
  const start = Math.max(0, candles.length - N);
  const slice = (arr) => arr.slice(start);
  return {
    dates: slice(candles.map((c) => c.date)),
    close: slice(candles.map((c) => c.close)),
    volume: slice(candles.map((c) => c.volume)),
    rsi14: slice(t.rsiSeries).map(round1),
    macd: slice(t.macdSeries).map(round2),
    signal: slice(t.signalSeries).map(round2),
  };
}

/** Pearson 상관계수 */
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return null;
  return cov / Math.sqrt(vx * vy);
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  const updatedAt = nowKstIso();
  console.log(`K-Rating V2 파이프라인 시작 (${updatedAt})`);

  // --- 구성종목 ---
  const universe = await fetchKospi200();
  console.log(`코스피200 구성종목 ${universe.length}개 확보`);
  if (universe.length !== 200) {
    console.warn(`경고: 구성종목이 200개가 아님 (${universe.length}개)`);
  }

  // --- 1차 패스: 원천 데이터 수집 (동시성 6) ---
  const results = [];
  const failed = [];
  let cursor = 0;
  async function worker() {
    while (cursor < universe.length) {
      const idx = cursor++;
      const meta = universe[idx];
      try {
        const raw = await fetchStockRaw(meta, idx + 1, universe.length);
        results.push(raw);
      } catch (e) {
        console.error(`  [${idx + 1}/${universe.length}] ${meta.code} ${meta.name} 실패: ${e.message}`);
        failed.push({ code: meta.code, name: meta.name, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const order = new Map(universe.map((s, i) => [s.code, i]));
  results.sort((a, b) => order.get(a.meta.code) - order.get(b.meta.code));
  console.log(`수집 완료: 성공 ${results.length} / 실패 ${failed.length}`);

  // --- 지표/펀더멘털 계산 ---
  for (const r of results) {
    r.tech = computeTechnicals(r.candles, r.integration);
    r.fund = extractFundamentals(r.finance, r.integration, r.meta.name);
    const ext = [
      ['매출액', r.fund.consRevG],
      ['영업이익', r.fund.consOpG],
      ['EPS', r.fund.consEpsG],
    ].filter(([, g]) => g != null && Math.abs(g) > 300);
    if (ext.length > 0) {
      console.warn(
        `  [경고] ${r.meta.code} ${r.meta.name} 극단 컨센서스(winsorize 처리됨): ` +
          ext.map(([k, g]) => `${k} ${g >= 0 ? '+' : ''}${Math.round(g)}%`).join(', ')
      );
    }
  }
  const finCount = results.filter((r) => r.fund.isFinancial).length;
  console.log(`금융업종 판별: ${finCount}개 종목 (부채비율 평가 제외)`);

  // --- 2차 패스: winsorize 경계 + percentile 상대평가 (§5.5) ---
  const X = buildUniverseStats(results);
  console.log(`시장 PER 중앙값(cnsPer, winsorize[p10,p90]): ${round2(X.perMkt)}배`);

  // --- 스코어링 V2 ---
  const scored = [];
  for (const r of results) {
    const fin = scoreFin(r.fund, X);
    const out = scoreOut(r.fund, X, r.meta.price);
    const tc = scoreTech(r.tech, X);
    const buy = Math.round(clamp(0.35 * fin.total + 0.3 * out.total + 0.35 * tc.buy, 0, 100));
    // SELL = 0.25×FINRISK + 0.20×OUTRISK + 0.55×TECH_sell (FINRISK 결측 시 재정규화)
    const sellRaw = weightedAvg([[fin.risk, 0.25], [out.risk, 0.2], [tc.sell, 0.55]]);
    const sell = Math.round(clamp(sellRaw == null ? 50 : sellRaw, 0, 100));
    scored.push({ r, fin, out, tc, buy, sell });
  }
  const grades = assignGrades(scored.map((s) => ({ buy: s.buy, marketCap: s.r.meta.marketCap })));

  // --- 파일 생성 ---
  fs.mkdirSync(STOCK_DIR, { recursive: true });
  const summaryStocks = [];
  let targetCount = 0;
  const targetSamples = [];
  for (let i = 0; i < scored.length; i++) {
    const { r, fin, out, tc, buy, sell } = scored[i];
    const { meta, fund, tech } = r;
    const grade = grades[i];

    summaryStocks.push({
      code: meta.code, name: meta.name,
      price: meta.price, change: meta.change, changeRate: meta.changeRate,
      marketCap: meta.marketCap,
      buy, sell, fin: fin.total, out: out.total, techBuy: tc.buy, techSell: tc.sell,
      grade,
    });

    // confidence 플래그 (§5.5): 어느 축이든 결측 재정규화 가중치 ≥ 50%
    const confidenceLow =
      fin.dataMissing || out.dataMissing || tc.buyMissing ||
      fin.missFrac >= 0.5 || out.missFrac >= 0.5 || tc.missFrac >= 0.5;

    // 목표주가 (diamond/gold 한정 — V2_CONTRACT §2.2)
    let targetPrice = null;
    if (grade === 'diamond' || grade === 'gold') {
      targetPrice = computeTargetPrice(fund, tech, meta.price, X);
      if (targetPrice) {
        targetCount++;
        if (targetSamples.length < 5) targetSamples.push({ code: meta.code, name: meta.name, grade, price: meta.price, ...targetPrice });
      }
    }

    const finParts = buildFinParts(fund, fin, X);
    const outParts = buildOutParts(fund, out, X, meta.price);
    const techParts = buildTechParts(tech, tc);
    const verdict = buildVerdict({
      buy, sell, grade, fin, out, tc, tech,
      finParts, outParts, techParts, targetPrice, confidenceLow,
    });

    const detail = {
      code: meta.code,
      name: meta.name,
      updatedAt,
      price: meta.price,
      change: meta.change,
      changeRate: meta.changeRate,
      buy, sell, grade,
      ...(confidenceLow ? { confidence: 'low' } : {}),
      scores: {
        fin: {
          total: fin.total,
          parts: finParts,
          reasons: finReasons(fund, fin, X),
          ...(fin.dataMissing ? { dataMissing: true } : {}),
        },
        out: {
          total: out.total,
          parts: outParts,
          reasons: outReasons(fund, out, X),
          hasConsensus: out.hasConsensus,
          ...(out.dataMissing ? { dataMissing: true } : {}),
        },
        tech: {
          buy: tc.buy,
          sell: tc.sell,
          parts: techParts,
          reasons: techReasons(tech, tc),
        },
      },
      indicators: {
        rsi: round1(tech.rsi),
        macd: round2(tech.macd),
        signal: round2(tech.signal),
        hist: round2(tech.hist),
        ma20: round1(tech.ma20),
        ma60: round1(tech.ma60),
        momentum20d: round1(tech.momentum20),
        bollingerB: round2(tech.bollingerB),
        pos52w: round1(tech.pos52),
        volumeZ: round1(tech.volumeZ),
        disparity20: round1(tech.disparity20),
        atrPct: round1(tech.atrPct),
        flowRatio: tech.flowRatio == null ? null : Math.round(tech.flowRatio * 10000) / 10000,
        flow: tech.flow ? {
          foreign5: tech.flow.foreign5,
          organ5: tech.flow.organ5,
          indiv5: tech.flow.indiv5,
          foreignRatio: Math.round(tech.flow.foreignRatio * 10000) / 10000,
          organRatio: Math.round(tech.flow.organRatio * 10000) / 10000,
          indivRatio: tech.flow.indivRatio == null ? null : Math.round(tech.flow.indivRatio * 10000) / 10000,
        } : null,
        foreignRate: round2(fund.foreignRate),
        trendState: tech.trendState,
      },
      targetPrice,
      verdict,
      financials: buildFinancials(r.finance),
      chart: buildChart(r.candles, tech),
    };
    fs.writeFileSync(path.join(STOCK_DIR, `${meta.code}.json`), JSON.stringify(detail));
  }

  const summary = { updatedAt, count: summaryStocks.length, stocks: summaryStocks };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary));

  // --- alerts.json ---
  const alertStat = buildAlerts(scored, updatedAt);
  console.log(`alerts.json: 신규 ${alertStat.fresh}건 / 30일 이력 총 ${alertStat.total}건`);

  // --- 리포트 + 수용 기준 (§5.4.4) ---
  const stat = (arr) => ({
    min: Math.min(...arr),
    max: Math.max(...arr),
    avg: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10,
  });
  const buys = summaryStocks.map((s) => s.buy);
  const sells = summaryStocks.map((s) => s.sell);
  const buyStat = stat(buys);
  const sellStat = stat(sells);
  const corrBuySell = pearson(buys, sells);
  const corrTech = pearson(summaryStocks.map((s) => s.techBuy), summaryStocks.map((s) => s.techSell));
  const sellHigh = sells.filter((v) => v >= 70).length;

  console.log('--------------------------------------------------');
  console.log(`완료 (${Math.round((Date.now() - t0) / 1000)}초)`);
  console.log(`성공 종목: ${summaryStocks.length}개 / 실패: ${failed.length}개`);
  console.log(`BUY  분포: min ${buyStat.min} / max ${buyStat.max} / avg ${buyStat.avg}`);
  console.log(`SELL 분포: min ${sellStat.min} / max ${sellStat.max} / avg ${sellStat.avg} / SELL≥70: ${sellHigh}개`);
  const okCorr1 = corrBuySell != null && corrBuySell >= -0.85 && corrBuySell <= -0.3;
  const okCorr2 = corrTech != null && Math.abs(corrTech) < 0.9;
  console.log(`[수용 기준] corr(BUY, SELL) = ${round2(corrBuySell)} (기준 [-0.85, -0.30]) → ${okCorr1 ? 'PASS' : 'FAIL'}`);
  console.log(`[수용 기준] corr(TECH_buy, TECH_sell) = ${round2(corrTech)} (기준 |r| < 0.90) → ${okCorr2 ? 'PASS' : 'FAIL'}`);
  const sellTop5 = [...summaryStocks].sort((a, b) => b.sell - a.sell).slice(0, 5);
  console.log('SELL TOP5 (과열형/펀더멘털 악화형 혼재 육안 확인용):');
  for (const s of sellTop5) {
    const sc = scored.find((x) => x.r.meta.code === s.code);
    const finSig = sc.fin.riskSignals.map((x) => x.label).join('|') || '-';
    const techSig = sc.tc.sellSignals.filter((x) => x.pts > 0).map((x) => x.label).join('|') || '-';
    console.log(`  ${s.code} ${s.name} SELL ${s.sell} (FINRISK: ${finSig} / TECH: ${techSig})`);
  }
  const gradeCounts = {};
  for (const s of summaryStocks) gradeCounts[s.grade] = (gradeCounts[s.grade] || 0) + 1;
  console.log('등급 분포:', JSON.stringify(gradeCounts));
  console.log(`목표주가 산출: ${targetCount}개 (diamond/gold 대상)`);
  for (const tp of targetSamples) {
    console.log(`  ${tp.code} ${tp.name} [${tp.grade}] 현재 ${fmtWon(tp.price)} → 목표 ${fmtWon(tp.value)} (+${tp.upside}%, ${tp.method}${tp.capped ? ', cap' : ''})`);
  }
  if (failed.length > 0) {
    console.log('실패 종목:', failed.map((f) => `${f.code}(${f.name})`).join(', '));
  }
  if (summaryStocks.length < 190) {
    console.warn(`경고: 성공 종목이 190개 미만입니다 (${summaryStocks.length}개)`);
  }
  console.log(`출력: ${path.join(OUT_DIR, 'summary.json')} + stocks/*.json ${summaryStocks.length}개 + alerts.json`);
}

main().catch((e) => {
  console.error('파이프라인 치명적 오류:', e);
  process.exit(1);
});
