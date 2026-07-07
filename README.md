# kospi-k-rating-data

[K-Rating](https://kospi-k-rating.web.app) (코스피200 FIFA 스타일 종목 평가)의 **공개 데이터 저장소**.
앱이 `raw.githubusercontent.com/sonjimin1608/kospi-k-rating-data/main/data/...` 에서 직접 읽는다
(raw는 CORS 허용 — 네이버 금융 API는 브라우저에서 직접 호출 불가하므로 이 저장소가 중간 캐시 역할).

## 갱신 주기

`.github/workflows/hourly.yml` — 평일 09:05~15:05 KST 매시 + 15:35 장 마감 직후,
`scripts/build-data.js`를 전체 재실행해 시세·점수·등급·알림을 재생성하고 변경 시에만 커밋한다.
MACD 0선 아래 골든크로스가 새로 발생하면 ntfy.sh 토픽 `krating-gxsignal-7k2m4x`로 푸시 알림을 보낸다.

## 구성

```
scripts/build-data.js   # 수집·스코어링 파이프라인 (Node 22, 의존성 0)
data/summary.json       # 200종목 요약 (BUY/SELL/등급/시세)
data/stocks/{code}.json # 종목별 상세 (파트별 점수 산정 이유, 목표주가, 총평, 차트)
data/alerts.json        # 골든크로스 신호 (30일 이력)
```

## 주의

- `scripts/build-data.js`는 **비공개 메인 저장소 `sonjimin1608/kospi-k-rating`의
  `scripts/build-data.js` 사본**이다. 원본을 수정하면 이 저장소에도 복사해 동기화할 것.
- 스코어링 모델 명세: 메인 저장소 `docs/SCORING_V2.md` · `docs/V2_CONTRACT.md`.
- 데이터 출처: 네이버 금융 비공식 API (지연·오류 가능). 본 데이터는 투자 참고용이며 투자 권유가 아님.
