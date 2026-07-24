'use strict';
/* 네이버 금융 일봉 캔들 수집 (공용) — 백테스트/탐색 스크립트에서 재사용 */

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };
const RETRIES = 2;
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

/** 코스피200 전 종목 캔들 병렬 수집 → [{code,name,candles}] (candles.length>=minLen) */
async function fetchAllCandles({ concurrency = 6, minLen = 61 } = {}) {
  const codes = await fetchKospi200();
  const out = [];
  let cur = 0;
  async function worker() {
    while (cur < codes.length) {
      const it = codes[cur++];
      try {
        const candles = await fetchCandles(it.code);
        if (candles.length >= minLen) out.push({ code: it.code, name: it.name, candles });
      } catch (e) { /* skip */ }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { codes, universe: out };
}

module.exports = { fetchKospi200, fetchCandles, fetchAllCandles, parseFchart, num };
