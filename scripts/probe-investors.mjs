// 일회용 프로브: 네이버가 종목별 투자자 수급을 어떤 필드로 주는지 확인 (개인/외국인/기관/사모/기타법인)
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const H = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };

async function get(url) {
  try {
    const r = await fetch(url, { headers: H });
    const t = await r.text();
    return { status: r.status, len: t.length, text: t };
  } catch (e) {
    return { status: 'ERR', len: 0, text: String(e.message) };
  }
}

const code = '005930';
const candidates = [
  `https://m.stock.naver.com/api/stock/${code}/integration`,
  `https://m.stock.naver.com/api/stock/${code}/trend`,
  `https://m.stock.naver.com/api/stock/${code}/investors`,
  `https://m.stock.naver.com/api/stock/${code}/investor`,
  `https://api.stock.naver.com/chart/domestic/item/${code}/investorTrend`,
  `https://api.stock.naver.com/chart/domestic/item/${code}/investor`,
  `https://finance.naver.com/item/frgn.naver?code=${code}`,
];

for (const url of candidates) {
  const r = await get(url);
  console.log('\n===================================================');
  console.log('URL:', url);
  console.log('STATUS:', r.status, 'LEN:', r.len);
  if (r.status !== 200) { console.log('BODY(head):', r.text.slice(0, 200)); continue; }
  // integration: dealTrendInfos 전체 키 덤프
  try {
    const d = JSON.parse(r.text);
    if (d && Array.isArray(d.dealTrendInfos)) {
      console.log('TOP KEYS:', Object.keys(d));
      console.log('dealTrendInfos[0] FULL:', JSON.stringify(d.dealTrendInfos[0], null, 0));
      console.log('dealTrendInfos length:', d.dealTrendInfos.length);
    } else if (Array.isArray(d)) {
      console.log('ARRAY len', d.length, 'item[0] keys:', d[0] && Object.keys(d[0]));
      console.log('item[0]:', JSON.stringify(d[0]).slice(0, 800));
    } else if (d && typeof d === 'object') {
      console.log('OBJ keys:', Object.keys(d));
      // 투자자 관련 하위 배열 탐색
      for (const k of Object.keys(d)) {
        if (/deal|trend|invest|investor|수급/i.test(k)) {
          console.log(`  [${k}] sample:`, JSON.stringify(d[k]).slice(0, 600));
        }
      }
      console.log('RAW(head):', JSON.stringify(d).slice(0, 600));
    }
  } catch (e) {
    // HTML 등 — 투자자 관련 키워드 주변만
    const idx = r.text.search(/사모|기타법인|개인|투자자별/);
    console.log('NON-JSON. keyword idx:', idx, 'snippet:', idx >= 0 ? r.text.slice(idx - 40, idx + 200) : r.text.slice(0, 200));
  }
}
console.log('\n=== PROBE DONE ===');
