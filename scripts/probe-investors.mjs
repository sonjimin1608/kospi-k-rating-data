// 일회용 프로브 2: KRX에서 종목별 투자자 상세(사모/기타법인 포함) 취득 가능한지 검증
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const KRX = 'http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';
const H = {
  'User-Agent': UA,
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Referer: 'http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd',
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
};

async function post(bld, params) {
  const body = new URLSearchParams({ bld, ...params }).toString();
  try {
    const r = await fetch(KRX, { method: 'POST', headers: H, body });
    const t = await r.text();
    return { status: r.status, text: t };
  } catch (e) {
    return { status: 'ERR', text: String(e.message) };
  }
}

// 1) 단축코드 → ISIN 조회 (finder)
console.log('=== 1) ISIN finder (005930) ===');
const fin = await post('dbms/comm/finder/finder_stkisu', {
  mktsel: 'ALL',
  searchText: '005930',
  typeNo: '0',
});
console.log('status:', fin.status, 'head:', fin.text.slice(0, 500));
let isuCd = null;
try {
  const j = JSON.parse(fin.text);
  const row = (j.block1 || j.output || [])[0];
  console.log('finder row:', JSON.stringify(row));
  isuCd = row && (row.full_code || row.short_code || row.codeName ? row.full_code : null);
} catch (e) { console.log('finder parse fail:', e.message); }

// 2) 개별종목 투자자별 거래실적 일별추이 (MDCSTAT02302)
const isin = isuCd || 'KR7005930003';
console.log('\n=== 2) MDCSTAT02302 개별종목 투자자별 (isuCd=' + isin + ') ===');
const inv = await post('dbms/MDC/STAT/standard/MDCSTAT02302', {
  isuCd: isin,
  strtDd: '20260717',
  endDd: '20260723',
  askBid: '3',        // 1매도 2매수 3순매수
  trdVolVal: '2',     // 1거래량 2거래대금
  detailView: '1',    // 상세(투자자별 세분)
});
console.log('status:', inv.status, 'len:', inv.text.length);
try {
  const j = JSON.parse(inv.text);
  console.log('top keys:', Object.keys(j));
  const arr = j.output || j.block1 || [];
  console.log('rows:', arr.length);
  if (arr[0]) console.log('row[0] keys:', Object.keys(arr[0]));
  if (arr[0]) console.log('row[0]:', JSON.stringify(arr[0]));
} catch (e) { console.log('parse fail. head:', inv.text.slice(0, 400)); }

console.log('\n=== PROBE2 DONE ===');
