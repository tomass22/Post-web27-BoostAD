/*
 * RTB decision 엔드포인트 부하테스트 (autocannon)
 *
 * 마이크로 벤치마크(/benchmark/run)가 "단일 연산이 얼마나 빠른가"를 본다면,
 * 이 스크립트는 "트래픽이 몰릴 때 실제로 버티는가"를 본다.
 * 측정값: throughput(RPS), 지연 분포(p50/p95/p99), 에러/타임아웃.
 *
 * 사용:
 *   BASE_URL=http://localhost:3000 \
 *   BLOG_KEY=<유효한 blogKey> \
 *   CONNECTIONS=50 DURATION=20 \
 *   node benchmark/load-test.js
 *
 * 주의: 대상 엔드포인트는 BlogKeyValidationGuard가 걸려 있어 유효한 BLOG_KEY가 필요하다.
 *       값이 틀리면 전부 4xx로 떨어져 부하 측정이 무의미해진다.
 */
const autocannon = require('autocannon');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const BLOG_KEY = process.env.BLOG_KEY;
const CONNECTIONS = parseInt(process.env.CONNECTIONS || '50', 10);
const DURATION = parseInt(process.env.DURATION || '20', 10);
const PIPELINING = parseInt(process.env.PIPELINING || '1', 10);

if (!BLOG_KEY) {
  console.error(
    '❌ BLOG_KEY 환경변수가 필요합니다. (Guard 통과용 유효한 blogKey)'
  );
  process.exit(1);
}

// 입찰 요청 페이로드 (RTBRequestDto 형태)
const payload = JSON.stringify({
  blogKey: BLOG_KEY,
  tags: (process.env.TAGS || 'mysql,redis,database').split(','),
  postUrl: process.env.POST_URL || 'https://example.com/post/1',
  behaviorScore: Number(process.env.BEHAVIOR_SCORE || 50),
  isHighIntent: process.env.IS_HIGH_INTENT === 'true',
});

console.log(`🚀 부하테스트 시작`);
console.log(`   대상   : POST ${BASE_URL}/sdk/decision`);
console.log(`   동시성 : ${CONNECTIONS} connections, pipelining=${PIPELINING}`);
console.log(`   기간   : ${DURATION}s\n`);

const instance = autocannon(
  {
    url: `${BASE_URL}/sdk/decision`,
    method: 'POST',
    connections: CONNECTIONS,
    duration: DURATION,
    pipelining: PIPELINING,
    headers: { 'content-type': 'application/json' },
    body: payload,
  },
  (err, result) => {
    if (err) {
      console.error('❌ 부하테스트 실패:', err);
      process.exit(1);
    }

    const non2xx = result.non2xx + (result['1xx'] || 0) + (result['3xx'] || 0);
    console.log('\n===== 요약 =====');
    console.log(`총 요청    : ${result.requests.total}`);
    console.log(`처리량(RPS): avg ${result.requests.average}`);
    console.log(
      `지연(ms)   : p50 ${result.latency.p50} / p97.5 ${result.latency.p97_5} / p99 ${result.latency.p99} / max ${result.latency.max}`
    );
    console.log(`2xx        : ${result['2xx']}`);
    console.log(`non-2xx    : ${non2xx}`);
    console.log(`에러/타임아웃: ${result.errors} / ${result.timeouts}`);

    if (non2xx > 0) {
      console.warn(
        '\n⚠️  non-2xx 응답이 있습니다. BLOG_KEY가 유효한지 확인하세요 (Guard 차단 시 측정 무의미).'
      );
    }
  }
);

// 실시간 진행률 표시
autocannon.track(instance, { renderProgressBar: true });
