import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CampaignRepository } from '../campaign/repository/campaign.repository.interface';
import { CampaignCacheRepository } from '../campaign/repository/campaign.cache.repository.interface';
import { MLEngine } from '../rtb/ml/mlEngine.interface';
import { IOREDIS_CLIENT } from '../redis/redis.constant';
import type { AppIORedisClient } from '../redis/redis.type';
import type { CachedCampaign } from '../campaign/types/campaign.types';
import { CampaignEntity } from '../campaign/entities/campaign.entity';
import { REDIS_INCREMENT_SPENT_SCRIPT } from '../campaign/scripts/lua-script';
import { performance } from 'perf_hooks';

/**
 * 입찰 1회(=하나의 decision 요청)를 처리하는 데 걸린 단계별 소요 시간(ms).
 * - fetchMs    : 전체 캠페인 조회 (MySQL or Redis)
 * - embeddingMs: 태그 임베딩 확보 (매번 모델 추론 or Redis 캐시 읽기)
 * - scoreMs    : 유사도 계산 (3단계 공통 로직)
 * - totalMs    : 위 합계 (= 입찰 1회 엔드투엔드 지연)
 */
export interface StageTiming {
  fetchMs: number;
  embeddingMs: number;
  scoreMs: number;
  totalMs: number;
}

export type StageName = 'baseline' | 'withRedis' | 'withEmbeddingCache';

export interface StageResult extends StageTiming {
  stage: StageName;
  label: string;
  iteration: number;
}

export interface StageAverage extends StageTiming {
  stage: StageName;
  label: string;
}

export interface BenchmarkSummary {
  timestamp: string;
  campaignCount: number;
  eligibleCount: number;
  uniqueTagCount: number;
  iterations: number;
  requestTags: string[];

  /** 반복별 원시 측정값 */
  raw: {
    baseline: StageResult[];
    withRedis: StageResult[];
    withEmbeddingCache: StageResult[];
  };

  /** 단계별 평균 (누적 개선 흐름: baseline → withRedis → withEmbeddingCache) */
  averages: StageAverage[];

  /**
   * 각 최적화의 순수 기여도.
   * 주의: total 기준으로 비교하면 임베딩 추론 시간(호출마다 ±수백ms 출렁임)이
   *       조회 차이(~14ms)를 노이즈로 덮어버린다. 그래서 각 최적화는
   *       "그 최적화가 실제로 건드린 컴포넌트" 기준으로 비교한다.
   */
  gains: {
    /** MySQL → Redis 조회 전환 효과 (fetch 컴포넌트 기준) */
    redisGain: { ms: number; percent: string; basis: 'fetchMs' };
    /** 매번 추론 → Redis 임베딩 캐시 전환 효과 (embedding 컴포넌트 기준) */
    embeddingCacheGain: { ms: number; percent: string; basis: 'embeddingMs' };
    /** 베이스라인 대비 최종 총 개선 (엔드투엔드 total 기준) */
    total: { ms: number; percent: string; basis: 'totalMs' };
  };
}

/** 조회 전용 공정 비교의 반복별 측정값 */
export interface FetchRow {
  iteration: number;
  mysqlMs: number;
  redisRawMs: number;
  redisCachedMs: number;
  counts: { mysql: number; redisRaw: number; redisCached: number };
}

export interface FetchBenchmarkSummary {
  timestamp: string;
  iterations: number;
  campaignCount: number;
  averages: { mysqlMs: number; redisRawMs: number; redisCachedMs: number };
  comparison: {
    /** ①→②: 양수 ms = Redis가 더 빠름, 음수 = Redis가 더 느림 */
    redisVsMysql: { ms: number; percent: string; verdict: string };
    /** ②→③: 인메모리 캐싱이 추가로 줄인 시간 */
    cacheEffect: { ms: number; percent: string };
  };
  raw: FetchRow[];
}

/** spent 차감(원자적 예산 검증 + 증가)의 엔진별 비교 */
export type SpentEngine = 'mysql-atomic' | 'redis-lua' | 'mysql-naive';

/** 단건 호출 지연 통계 (성공 경로만, 동시성 없음) */
export interface SpentLatencyStats {
  engine: SpentEngine;
  calls: number;
  avgMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** 동시성 정합성 + 처리량 측정 결과 */
export interface SpentConcurrencyResult {
  engine: SpentEngine;
  /** 동시에 발사한 차감 요청 수 */
  concurrency: number;
  /** 예산상 성공해야 하는 정답 횟수 (= budgetAllows) */
  expectedSuccess: number;
  cpc: number;
  /** 실제 성공한 차감 수 */
  successCount: number;
  /** 거부(예산 초과)된 수 */
  rejectedCount: number;
  /** 전체 동시 요청이 끝나기까지 벽시계 시간 */
  wallClockMs: number;
  /** 초당 처리 차감 수 (concurrency / wallClock) */
  throughputOpsPerSec: number;
  /** 차감 종료 후 실제 dailySpent */
  finalDailySpent: number;
  /** 예산을 넘겨 차감됐는가 (정합성 깨짐) */
  overspent: boolean;
  /** 정확히 예산만큼만 성공했고 오버스펜드 없음 */
  correct: boolean;
}

export interface SpentBenchmarkSummary {
  timestamp: string;
  targetCampaignId: string;
  config: {
    latencyCalls: number;
    concurrency: number;
    cpc: number;
    budgetAllows: number;
  };
  /** 단건 지연 (원자 구현끼리만 비교: mysql-atomic vs redis-lua) */
  latency: SpentLatencyStats[];
  /** 동시성: 원자 2종 + 비원자(맹목 증가) 정합성 깨짐 시연 */
  concurrency: SpentConcurrencyResult[];
  verdict: {
    latencyWinner: SpentEngine;
    latencyNote: string;
    correctnessNote: string;
  };
}

/** 조회 비용 분해: 임베딩 payload 전수 파싱이 진짜 병목인지 가르는 측정 */
export interface ParseBenchmarkSummary {
  timestamp: string;
  iterations: number;
  campaignCount: number;
  /** JSON.GET이 반환한 문자열 바이트 합 (캠페인당 평균) */
  bytesPerCampaign: {
    full: number;
    lean: number;
    reductionPercent: string;
  };
  averages: {
    /** 전체 JSON.GET + JSON.parse (= 현재 getAllCampaigns 경로) */
    fullParseMs: number;
    /** 전체 JSON.GET, parse 생략 (전송+서버직렬화만) */
    fullNoParseMs: number;
    /** 필터 필드만 JSON.GET + parse (임베딩 제외) */
    leanParseMs: number;
  };
  breakdown: {
    /** 순수 파싱 비중 ≈ fullParse - fullNoParse */
    parseShareMs: number;
    /** 임베딩 payload 제거 효과 ≈ fullParse - leanParse */
    embeddingPayloadMs: number;
    verdict: string;
  };
  raw: Array<{
    iteration: number;
    fullParseMs: number;
    fullNoParseMs: number;
    leanParseMs: number;
    fullBytes: number;
    leanBytes: number;
  }>;
}

@Injectable()
export class BenchmarkService {
  private readonly logger = new Logger(BenchmarkService.name);

  // 자격 필터에서 임계값으로 쓰는 유사도 (matcher와 동일 개념)
  private readonly SIMILARITY_THRESHOLD = 0.3;

  // 입찰 요청을 흉내내는 기본 태그 (요청 임베딩 대상)
  private readonly DEFAULT_REQUEST_TAGS = ['mysql', 'redis', 'database'];

  constructor(
    private readonly campaignRepository: CampaignRepository,
    private readonly campaignCacheRepository: CampaignCacheRepository,
    private readonly mlEngine: MLEngine,
    @Inject(IOREDIS_CLIENT) private readonly ioredisClient: AppIORedisClient,
    @InjectRepository(CampaignEntity)
    private readonly campaignEntityRepo: Repository<CampaignEntity>
  ) {}

  /**
   * 누적 단계 벤치마크: 동일한 입찰 1회 흐름을 3가지 구성으로 측정한다.
   *
   *   ① baseline           : MySQL 조회 + 태그마다 매번 모델 추론
   *   ② withRedis          : Redis 조회 + 태그마다 매번 모델 추론   (조회만 개선)
   *   ③ withEmbeddingCache : Redis 조회 + Redis 캐시 임베딩 읽기    (조회 + 임베딩 캐싱)
   *
   * baseline→②의 차이 = Redis 도입 효과,
   * ②→③의 차이      = 임베딩 캐싱 효과.
   */
  async runFullBenchmark(
    iterations: number = 5,
    requestTags?: string[]
  ): Promise<BenchmarkSummary> {
    const tags =
      requestTags && requestTags.length > 0
        ? requestTags
        : this.DEFAULT_REQUEST_TAGS;

    this.logger.log(
      `🚀 누적 단계 벤치마크 시작: ${iterations}회 반복, 요청태그=[${tags.join(', ')}]`
    );

    if (!this.mlEngine.isReady()) {
      throw new Error(
        'ML 엔진이 준비되지 않았습니다. 임베딩 추론을 측정할 수 없습니다.'
      );
    }

    // 캐시(Redis)에 캠페인 데이터가 있어야 ②③ 단계를 측정할 수 있다.
    const cachedCampaigns =
      await this.campaignCacheRepository.getAllCampaigns();
    if (cachedCampaigns.length === 0) {
      throw new Error(
        'Redis에 캠페인 데이터가 없습니다. 캠페인 캐시를 먼저 워밍업하세요.'
      );
    }

    const eligible = this.filterEligible(cachedCampaigns);
    const uniqueTags = this.collectUniqueTags(cachedCampaigns);

    this.logger.log(
      `📊 캠페인=${cachedCampaigns.length}개, 자격충족=${eligible.length}개, 유니크태그=${uniqueTags.size}개`
    );

    const raw = {
      baseline: [] as StageResult[],
      withRedis: [] as StageResult[],
      withEmbeddingCache: [] as StageResult[],
    };

    for (let i = 0; i < iterations; i++) {
      raw.baseline.push(await this.runBaseline(tags, i + 1));
      raw.withRedis.push(await this.runWithRedis(tags, i + 1));
      raw.withEmbeddingCache.push(
        await this.runWithEmbeddingCache(tags, i + 1)
      );
    }

    const averages: StageAverage[] = [
      this.average('baseline', 'MySQL 조회 + 매번 임베딩 추론', raw.baseline),
      this.average('withRedis', 'Redis 조회 + 매번 임베딩 추론', raw.withRedis),
      this.average(
        'withEmbeddingCache',
        'Redis 조회 + 임베딩 캐시 읽기',
        raw.withEmbeddingCache
      ),
    ];

    const gains = this.calculateGains(averages);

    this.logger.log(
      `✅ 벤치마크 완료 — baseline=${averages[0].totalMs}ms → withRedis=${averages[1].totalMs}ms → withEmbeddingCache=${averages[2].totalMs}ms`
    );
    this.logger.log(
      `   Redis 효과 ${gains.redisGain.ms}ms(${gains.redisGain.percent}), 임베딩캐싱 효과 ${gains.embeddingCacheGain.ms}ms(${gains.embeddingCacheGain.percent}), 총 ${gains.total.ms}ms(${gains.total.percent})`
    );

    return {
      timestamp: new Date().toISOString(),
      campaignCount: cachedCampaigns.length,
      eligibleCount: eligible.length,
      uniqueTagCount: uniqueTags.size,
      iterations,
      requestTags: tags,
      raw,
      averages,
      gains,
    };
  }

  /**
   * ① baseline: MySQL에서 전체 캠페인을 읽고, 각 캠페인의 각 태그를 매번 모델로 임베딩한다.
   *    (Redis 도입 전, 임베딩 캐싱 전의 최초 구현을 재현)
   */
  private async runBaseline(
    requestTags: string[],
    iteration: number
  ): Promise<StageResult> {
    const start = performance.now();

    // 조회: MySQL (TypeORM + relations)
    const fetchStart = performance.now();
    const campaigns = await this.campaignRepository.getAll();
    const fetchMs = performance.now() - fetchStart;

    // 자격 필터 (Tag[] → name 추출)
    const eligible = campaigns.filter((c) =>
      this.isEligibleSql(c.status, c.startDate, c.endDate, c.deletedAt)
    );

    // 임베딩: 요청 1회 + 각 캠페인 태그마다 매번 추론
    const embeddingStart = performance.now();
    const requestEmbedding = await this.mlEngine.getEmbedding(
      requestTags.join(' ')
    );
    const campaignTagEmbeddings: number[][][] = [];
    for (const c of eligible) {
      const tagNames = (c.tags ?? []).map((t) => t.name).filter(Boolean);
      const embeds: number[][] = [];
      for (const name of tagNames) {
        try {
          embeds.push(await this.mlEngine.getEmbedding(name));
        } catch {
          // 추론 실패 태그는 스킵 (벤치마크 목적)
        }
      }
      campaignTagEmbeddings.push(embeds);
    }
    const embeddingMs = performance.now() - embeddingStart;

    // 스코어: 유사도 계산 (공통)
    const scoreMs = this.scoreAll(requestEmbedding, campaignTagEmbeddings);

    const totalMs = performance.now() - start;
    return this.toResult(
      'baseline',
      'MySQL 조회 + 매번 임베딩 추론',
      iteration,
      {
        fetchMs,
        embeddingMs,
        scoreMs,
        totalMs,
      }
    );
  }

  /**
   * ② withRedis: Redis에서 전체 캠페인을 읽되, 임베딩은 여전히 매번 추론한다.
   *    (조회만 Redis로 개선한 중간 단계 — Redis 도입 효과를 분리하기 위함)
   */
  private async runWithRedis(
    requestTags: string[],
    iteration: number
  ): Promise<StageResult> {
    const start = performance.now();

    // 조회: Redis
    const fetchStart = performance.now();
    const campaigns = await this.campaignCacheRepository.getAllCampaigns();
    const fetchMs = performance.now() - fetchStart;

    const eligible = this.filterEligible(campaigns);

    // 임베딩: 요청 1회 + 각 태그마다 매번 추론 (캐시 무시)
    const embeddingStart = performance.now();
    const requestEmbedding = await this.mlEngine.getEmbedding(
      requestTags.join(' ')
    );
    const campaignTagEmbeddings: number[][][] = [];
    for (const c of eligible) {
      const tagNames = (c.tags ?? []).filter(Boolean);
      const embeds: number[][] = [];
      for (const name of tagNames) {
        try {
          embeds.push(await this.mlEngine.getEmbedding(name));
        } catch {
          // 스킵
        }
      }
      campaignTagEmbeddings.push(embeds);
    }
    const embeddingMs = performance.now() - embeddingStart;

    const scoreMs = this.scoreAll(requestEmbedding, campaignTagEmbeddings);

    const totalMs = performance.now() - start;
    return this.toResult(
      'withRedis',
      'Redis 조회 + 매번 임베딩 추론',
      iteration,
      { fetchMs, embeddingMs, scoreMs, totalMs }
    );
  }

  /**
   * ③ withEmbeddingCache: Redis에서 캠페인을 읽고, 태그 임베딩도 Redis 캐시에서 읽는다.
   *    (현재 실 서비스 구현 — 캐시 미스 시에만 fallback 추론)
   */
  private async runWithEmbeddingCache(
    requestTags: string[],
    iteration: number
  ): Promise<StageResult> {
    const start = performance.now();

    // 조회: Redis
    const fetchStart = performance.now();
    const campaigns = await this.campaignCacheRepository.getAllCampaigns();
    const fetchMs = performance.now() - fetchStart;

    const eligible = this.filterEligible(campaigns);

    // 임베딩: 요청 1회는 추론(공통), 태그는 Redis 캐시(embeddingTags)에서 읽기
    const embeddingStart = performance.now();
    const requestEmbedding = await this.mlEngine.getEmbedding(
      requestTags.join(' ')
    );
    const campaignTagEmbeddings: number[][][] = [];
    for (const c of eligible) {
      const tagNames = (c.tags ?? []).filter(Boolean);
      const embeds: number[][] = [];
      for (const name of tagNames) {
        const cached = c.embeddingTags?.[name];
        if (cached) {
          embeds.push(cached);
        } else {
          // 캐시 미스 fallback (실 서비스와 동일)
          try {
            embeds.push(await this.mlEngine.getEmbedding(name));
          } catch {
            // 스킵
          }
        }
      }
      campaignTagEmbeddings.push(embeds);
    }
    const embeddingMs = performance.now() - embeddingStart;

    const scoreMs = this.scoreAll(requestEmbedding, campaignTagEmbeddings);

    const totalMs = performance.now() - start;
    return this.toResult(
      'withEmbeddingCache',
      'Redis 조회 + 임베딩 캐시 읽기',
      iteration,
      { fetchMs, embeddingMs, scoreMs, totalMs }
    );
  }

  /** 3단계 공통: 요청 임베딩과 캠페인 태그 임베딩들 간 유사도 계산 시간 측정 */
  private scoreAll(
    requestEmbedding: number[],
    campaignTagEmbeddings: number[][][]
  ): number {
    const scoreStart = performance.now();
    for (const tagEmbeds of campaignTagEmbeddings) {
      let best = 0;
      for (const tagEmbed of tagEmbeds) {
        const sim = this.mlEngine.calculateSimilarity(
          requestEmbedding,
          tagEmbed
        );
        if (sim > best) best = sim;
      }
      // 임계값 비교까지 포함 (matcher 동작 흉내)
      void (best >= this.SIMILARITY_THRESHOLD);
    }
    return performance.now() - scoreStart;
  }

  /** CachedCampaign 자격 필터 (matcher의 filterEligibleCampaigns 간략판) */
  private filterEligible<
    T extends {
      status: string;
      startDate: string;
      endDate: string;
      deletedAt: string | null;
      embeddingTags?: { [k: string]: number[] };
    },
  >(campaigns: T[]): T[] {
    const now = Date.now();
    return campaigns.filter((c) => {
      if (c.deletedAt) return false;
      if (c.status !== 'ACTIVE') return false;
      const start = new Date(c.startDate).getTime();
      const end = new Date(c.endDate).getTime();
      if (now < start || now >= end) return false;
      return true;
    });
  }

  /** CampaignWithTags(MySQL) 자격 필터 — Date 타입 기준 */
  private isEligibleSql(
    status: string,
    startDate: Date,
    endDate: Date,
    deletedAt: Date | null
  ): boolean {
    if (deletedAt) return false;
    if (status !== 'ACTIVE') return false;
    const now = Date.now();
    if (now < new Date(startDate).getTime()) return false;
    if (now >= new Date(endDate).getTime()) return false;
    return true;
  }

  private collectUniqueTags(campaigns: { tags?: string[] }[]): Set<string> {
    const set = new Set<string>();
    for (const c of campaigns) {
      for (const t of c.tags ?? []) {
        if (t) set.add(t);
      }
    }
    return set;
  }

  private toResult(
    stage: StageName,
    label: string,
    iteration: number,
    timing: StageTiming
  ): StageResult {
    return {
      stage,
      label,
      iteration,
      fetchMs: round(timing.fetchMs),
      embeddingMs: round(timing.embeddingMs),
      scoreMs: round(timing.scoreMs),
      totalMs: round(timing.totalMs),
    };
  }

  private average(
    stage: StageName,
    label: string,
    results: StageResult[]
  ): StageAverage {
    const n = results.length || 1;
    const sum = (key: keyof StageTiming) =>
      results.reduce((acc, r) => acc + r[key], 0) / n;
    return {
      stage,
      label,
      fetchMs: round(sum('fetchMs')),
      embeddingMs: round(sum('embeddingMs')),
      scoreMs: round(sum('scoreMs')),
      totalMs: round(sum('totalMs')),
    };
  }

  private calculateGains(averages: StageAverage[]) {
    const [baseline, withRedis, withEmbeddingCache] = averages;

    const pct = (gain: number, base: number) =>
      base > 0 ? `${((gain / base) * 100).toFixed(1)}%` : '0%';

    // Redis 조회 효과: 조회(fetch) 컴포넌트만 비교 (임베딩 노이즈 배제)
    const redisMs = round(baseline.fetchMs - withRedis.fetchMs);
    // 임베딩 캐싱 효과: 임베딩(embedding) 컴포넌트만 비교
    const embedMs = round(
      withRedis.embeddingMs - withEmbeddingCache.embeddingMs
    );
    // 총 효과: 엔드투엔드 total 비교
    const totalMs = round(baseline.totalMs - withEmbeddingCache.totalMs);

    return {
      redisGain: {
        ms: redisMs,
        percent: pct(redisMs, baseline.fetchMs),
        basis: 'fetchMs' as const,
      },
      embeddingCacheGain: {
        ms: embedMs,
        percent: pct(embedMs, withRedis.embeddingMs),
        basis: 'embeddingMs' as const,
      },
      total: {
        ms: totalMs,
        percent: pct(totalMs, baseline.totalMs),
        basis: 'totalMs' as const,
      },
    };
  }

  /**
   * 조회 전용 공정 비교: 앱 인메모리 캐시를 우회해 "순수 조회 비용"을 단계별로 잰다.
   *   ① MySQL        : campaignRepository.getAll() (매번 DB, 앱캐시 없음)
   *   ② Redis(raw)   : SCAN + JSON.GET 직접 (앱캐시 우회) = 순수 Redis 도입 효과
   *   ③ Redis+앱캐시 : getAllCampaigns() (10초 인메모리 캐시 히트)
   *
   * ①→② = Redis 전환 자체의 조회 속도 변화 (RedisJSON이 빨라졌나/느려졌나)
   * ②→③ = 인메모리 캐싱 추가 효과
   */
  async runFetchBenchmark(
    iterations: number = 5
  ): Promise<FetchBenchmarkSummary> {
    // 워밍업: cold start 제거 + ③의 앱캐시 채우기
    await this.campaignRepository.getAll();
    await this.scanAllCampaignsRaw();
    await this.campaignCacheRepository.getAllCampaigns();

    const rows: FetchRow[] = [];
    for (let i = 0; i < iterations; i++) {
      const t1 = performance.now();
      const mysql = await this.campaignRepository.getAll();
      const mysqlMs = performance.now() - t1;

      const t2 = performance.now();
      const redisRaw = await this.scanAllCampaignsRaw();
      const redisRawMs = performance.now() - t2;

      const t3 = performance.now();
      const redisCached = await this.campaignCacheRepository.getAllCampaigns();
      const redisCachedMs = performance.now() - t3;

      rows.push({
        iteration: i + 1,
        mysqlMs: round(mysqlMs),
        redisRawMs: round(redisRawMs),
        redisCachedMs: round(redisCachedMs),
        counts: {
          mysql: mysql.length,
          redisRaw: redisRaw.length,
          redisCached: redisCached.length,
        },
      });
    }

    const n = rows.length || 1;
    const avg = (k: 'mysqlMs' | 'redisRawMs' | 'redisCachedMs') =>
      round(rows.reduce((s, r) => s + r[k], 0) / n);
    const avgMysql = avg('mysqlMs');
    const avgRedisRaw = avg('redisRawMs');
    const avgRedisCached = avg('redisCachedMs');

    const pct = (gain: number, base: number) =>
      base > 0 ? `${((gain / base) * 100).toFixed(1)}%` : '0%';

    const redisDeltaMs = round(avgMysql - avgRedisRaw);
    const cacheDeltaMs = round(avgRedisRaw - avgRedisCached);

    this.logger.log(
      `📊 조회 비교 — MySQL=${avgMysql}ms, Redis(raw)=${avgRedisRaw}ms, Redis+앱캐시=${avgRedisCached}ms`
    );

    return {
      timestamp: new Date().toISOString(),
      iterations,
      campaignCount: rows[0]?.counts.mysql ?? 0,
      averages: {
        mysqlMs: avgMysql,
        redisRawMs: avgRedisRaw,
        redisCachedMs: avgRedisCached,
      },
      comparison: {
        redisVsMysql: {
          ms: redisDeltaMs,
          percent: pct(redisDeltaMs, avgMysql),
          verdict:
            redisDeltaMs >= 0 ? 'Redis 조회가 더 빠름' : 'Redis 조회가 더 느림',
        },
        cacheEffect: {
          ms: cacheDeltaMs,
          percent: pct(cacheDeltaMs, avgRedisRaw),
        },
      },
      raw: rows,
    };
  }

  /** getAllCampaigns의 실제 Redis 조회 로직을 앱 캐시 없이 재현 (측정 전용) */
  private async scanAllCampaignsRaw(): Promise<CachedCampaign[]> {
    const pattern = `campaign:*`;
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await this.ioredisClient.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100
      );
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');

    if (keys.length === 0) return [];

    const campaigns: CachedCampaign[] = [];
    const BATCH_SIZE = 200;
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batchKeys = keys.slice(i, i + BATCH_SIZE);
      const pipeline = this.ioredisClient.pipeline();
      batchKeys.forEach((key) => pipeline.call('JSON.GET', key));
      const results = await pipeline.exec();
      if (!results) continue;
      results.forEach(([err, res]) => {
        if (!err && typeof res === 'string') {
          try {
            campaigns.push(JSON.parse(res) as CachedCampaign);
          } catch {
            // 파싱 실패 스킵
          }
        }
      });
    }
    return campaigns;
  }

  /** SCAN으로 campaign:* 키만 수집 (GET 없이) */
  private async scanKeys(): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const result = await this.ioredisClient.scan(
        cursor,
        'MATCH',
        'campaign:*',
        'COUNT',
        100
      );
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
    return keys;
  }

  /**
   * 조회 비용 분해: "임베딩 태그까지 전수 파싱한 게 병목인가?"를 가른다.
   * 같은 키 집합을 3가지로 측정한다.
   *   ① full+parse   : JSON.GET(전체) + JSON.parse  (= 현재 경로)
   *   ② full,noparse : JSON.GET(전체), parse 생략    (전송+서버 직렬화만)
   *   ③ lean+parse   : JSON.GET(필터 필드만) + parse (임베딩 제외)
   * + 반환 문자열 바이트(full vs lean)로 payload 크기를 직접 비교.
   */
  async runParseBenchmark(
    iterations: number = 8
  ): Promise<ParseBenchmarkSummary> {
    // 필터에 실제로 쓰는 필드만 (임베딩 제외)
    const LEAN_PATHS = [
      '$.status',
      '$.startDate',
      '$.endDate',
      '$.deletedAt',
      '$.isHighIntent',
    ];
    const BATCH_SIZE = 200;

    const getFull = async (keys: string[], parse: boolean): Promise<number> => {
      let bytes = 0;
      for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);
        const pipeline = this.ioredisClient.pipeline();
        batch.forEach((k) => pipeline.call('JSON.GET', k));
        const results = await pipeline.exec();
        if (!results) continue;
        results.forEach(([err, res]) => {
          if (!err && typeof res === 'string') {
            bytes += res.length;
            if (parse) {
              try {
                JSON.parse(res);
              } catch {
                // skip
              }
            }
          }
        });
      }
      return bytes;
    };

    const getLean = async (keys: string[]): Promise<number> => {
      let bytes = 0;
      for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);
        const pipeline = this.ioredisClient.pipeline();
        batch.forEach((k) => pipeline.call('JSON.GET', k, ...LEAN_PATHS));
        const results = await pipeline.exec();
        if (!results) continue;
        results.forEach(([err, res]) => {
          if (!err && typeof res === 'string') {
            bytes += res.length;
            try {
              JSON.parse(res);
            } catch {
              // skip
            }
          }
        });
      }
      return bytes;
    };

    // 워밍업
    const warmKeys = await this.scanKeys();
    await getFull(warmKeys, true);
    await getLean(warmKeys);

    const rows: ParseBenchmarkSummary['raw'] = [];
    for (let i = 0; i < iterations; i++) {
      const keys = await this.scanKeys();

      const t1 = performance.now();
      const fullBytes = await getFull(keys, true);
      const fullParseMs = performance.now() - t1;

      const t2 = performance.now();
      await getFull(keys, false);
      const fullNoParseMs = performance.now() - t2;

      const t3 = performance.now();
      const leanBytes = await getLean(keys);
      const leanParseMs = performance.now() - t3;

      rows.push({
        iteration: i + 1,
        fullParseMs: round(fullParseMs),
        fullNoParseMs: round(fullNoParseMs),
        leanParseMs: round(leanParseMs),
        fullBytes,
        leanBytes,
      });
    }

    const n = rows.length || 1;
    const avg = (k: 'fullParseMs' | 'fullNoParseMs' | 'leanParseMs') =>
      round(rows.reduce((s, r) => s + r[k], 0) / n);
    const count = (await this.scanKeys()).length;
    const fullBytesAvg = Math.round(
      rows.reduce((s, r) => s + r.fullBytes, 0) / n / (count || 1)
    );
    const leanBytesAvg = Math.round(
      rows.reduce((s, r) => s + r.leanBytes, 0) / n / (count || 1)
    );

    const fullParse = avg('fullParseMs');
    const fullNoParse = avg('fullNoParseMs');
    const leanParse = avg('leanParseMs');
    const parseShare = round(fullParse - fullNoParse);
    const embeddingPayload = round(fullParse - leanParse);
    const pct = (gain: number, base: number) =>
      base > 0 ? `${((gain / base) * 100).toFixed(1)}%` : '0%';

    this.logger.log(
      `📊 파싱 분해 — full+parse=${fullParse}ms, full(noparse)=${fullNoParse}ms, lean+parse=${leanParse}ms / ` +
        `bytes/캠페인 full=${fullBytesAvg} lean=${leanBytesAvg}`
    );

    return {
      timestamp: new Date().toISOString(),
      iterations,
      campaignCount: count,
      bytesPerCampaign: {
        full: fullBytesAvg,
        lean: leanBytesAvg,
        reductionPercent: pct(fullBytesAvg - leanBytesAvg, fullBytesAvg),
      },
      averages: {
        fullParseMs: fullParse,
        fullNoParseMs: fullNoParse,
        leanParseMs: leanParse,
      },
      breakdown: {
        parseShareMs: parseShare,
        embeddingPayloadMs: embeddingPayload,
        verdict:
          `임베딩 제외 시 ${pct(embeddingPayload, fullParse)} 감소(${embeddingPayload}ms). ` +
          `순수 파싱 비중 ${pct(parseShare, fullParse)}(${parseShare}ms). ` +
          `payload ${pct(fullBytesAvg - leanBytesAvg, fullBytesAvg)} 축소.`,
      },
      raw: rows,
    };
  }

  // ===========================================================================
  // spent 차감 벤치마크
  //   질문: "전체 조회만 보면 Redis가 느리지만, spent의 원자적 정합성까지
  //         포함하면 어느 쪽이 빠른가?"
  //
  //   공정 조건: 두 엔진 모두 "원자적 예산 검증 + 증가"를 수행한다.
  //     - redis-lua    : 기존 Lua 스크립트 (싱글스레드 원자성)
  //     - mysql-atomic : 조건부 단일 UPDATE (WHERE에 예산 검증 → InnoDB 행 잠금으로 원자)
  //   ⚠️ 프로덕션 MySQL incrementSpent는 검증 없는 맹목 증가라 비교에 부적합.
  //      그래서 측정 전용 원자 구현을 따로 둔다. (mysql-naive는 정합성 깨짐 시연용)
  //
  //   데이터 안전: 실 캠페인 1개를 골라 시작값을 스냅샷 → 측정 → finally에서 원복.
  // ===========================================================================
  async runSpentBenchmark(opts?: {
    latencyCalls?: number;
    concurrency?: number;
    cpc?: number;
    budgetAllows?: number;
  }): Promise<SpentBenchmarkSummary> {
    const latencyCalls = clampInt(opts?.latencyCalls ?? 200, 1, 1000);
    const concurrency = clampInt(opts?.concurrency ?? 200, 1, 1000);
    const cpc = clampInt(opts?.cpc ?? 1, 1, 100000);
    const budgetAllows = clampInt(opts?.budgetAllows ?? 50, 1, concurrency);
    const BIG = 1_000_000_000;

    // 1) Redis + MySQL 양쪽에 존재하는 대상 캠페인 선택
    const cached = await this.campaignCacheRepository.getAllCampaigns();
    if (cached.length === 0) {
      throw new Error('Redis 캠페인 캐시가 비어있습니다. 워밍업 먼저 하세요.');
    }
    let target: CampaignEntity | null = null;
    for (const c of cached) {
      const row = await this.campaignEntityRepo.findOne({
        where: { id: c.id },
      });
      if (row) {
        target = row;
        break;
      }
    }
    if (!target) {
      throw new Error(
        'MySQL과 Redis 양쪽에 존재하는 캠페인을 찾지 못했습니다.'
      );
    }
    const id = target.id;

    // 2) 스냅샷 (원복용)
    const snap = {
      dailySpent: target.dailySpent,
      totalSpent: target.totalSpent,
      dailyBudget: target.dailyBudget,
      totalBudget: target.totalBudget,
    };
    const redisSnap = await this.redisGetSpent(id);

    this.logger.log(
      `🎯 spent 벤치마크 대상=${id}, latencyCalls=${latencyCalls}, concurrency=${concurrency}, cpc=${cpc}, budgetAllows=${budgetAllows}`
    );

    try {
      // === Test 1: 단건 지연 (성공 경로만) ===
      // 예산을 크게 열어 두어 항상 성공 경로를 타게 한다.
      await this.campaignEntityRepo.update(
        { id },
        { dailySpent: 0, totalSpent: 0, dailyBudget: BIG, totalBudget: BIG }
      );
      for (let i = 0; i < 5; i++) await this.mysqlAtomicIncrement(id, cpc); // 워밍업
      const mysqlLat: number[] = [];
      for (let i = 0; i < latencyCalls; i++) {
        const t = performance.now();
        await this.mysqlAtomicIncrement(id, cpc);
        mysqlLat.push(performance.now() - t);
      }

      await this.redisSetSpent(id, 0, 0);
      for (let i = 0; i < 5; i++)
        await this.redisLuaIncrement(id, cpc, BIG, BIG); // 워밍업
      const redisLat: number[] = [];
      for (let i = 0; i < latencyCalls; i++) {
        const t = performance.now();
        await this.redisLuaIncrement(id, cpc, BIG, BIG);
        redisLat.push(performance.now() - t);
      }

      const latency: SpentLatencyStats[] = [
        this.latencyStats('mysql-atomic', mysqlLat),
        this.latencyStats('redis-lua', redisLat),
      ];

      // === Test 2: 동시성 정합성 + 처리량 ===
      // 예산을 정확히 budgetAllows*cpc로 두고 concurrency개를 동시 발사한다.
      // 원자 구현이면 정확히 budgetAllows개만 성공해야 한다(오버스펜드 0).
      const budgetCap = budgetAllows * cpc;
      const concResults: SpentConcurrencyResult[] = [];

      // redis-lua (원자)
      await this.redisSetSpent(id, 0, 0);
      {
        const t = performance.now();
        const outcomes = await Promise.all(
          Array.from({ length: concurrency }, () =>
            this.redisLuaIncrement(id, cpc, budgetCap, BIG)
          )
        );
        const wall = performance.now() - t;
        const success = outcomes.filter(Boolean).length;
        const finalSpent = (await this.redisGetSpent(id)).daily;
        concResults.push(
          this.concResult(
            'redis-lua',
            concurrency,
            budgetAllows,
            cpc,
            success,
            wall,
            finalSpent,
            budgetCap
          )
        );
      }

      // mysql-atomic (조건부 단일 UPDATE)
      await this.campaignEntityRepo.update(
        { id },
        {
          dailySpent: 0,
          totalSpent: 0,
          dailyBudget: budgetCap,
          totalBudget: BIG,
        }
      );
      {
        const t = performance.now();
        const outcomes = await Promise.all(
          Array.from({ length: concurrency }, () =>
            this.mysqlAtomicIncrement(id, cpc)
          )
        );
        const wall = performance.now() - t;
        const success = outcomes.filter(Boolean).length;
        const row = await this.campaignEntityRepo.findOne({ where: { id } });
        concResults.push(
          this.concResult(
            'mysql-atomic',
            concurrency,
            budgetAllows,
            cpc,
            success,
            wall,
            row?.dailySpent ?? 0,
            budgetCap
          )
        );
      }

      // mysql-naive (검증 없는 맹목 증가 — 정합성 깨짐 시연)
      await this.campaignEntityRepo.update(
        { id },
        {
          dailySpent: 0,
          totalSpent: 0,
          dailyBudget: budgetCap,
          totalBudget: BIG,
        }
      );
      {
        const t = performance.now();
        const outcomes = await Promise.all(
          Array.from({ length: concurrency }, () =>
            this.mysqlNaiveIncrement(id, cpc)
          )
        );
        const wall = performance.now() - t;
        const success = outcomes.filter(Boolean).length;
        const row = await this.campaignEntityRepo.findOne({ where: { id } });
        concResults.push(
          this.concResult(
            'mysql-naive',
            concurrency,
            budgetAllows,
            cpc,
            success,
            wall,
            row?.dailySpent ?? 0,
            budgetCap
          )
        );
      }

      const mysqlAtomicLat = latency.find((l) => l.engine === 'mysql-atomic')!;
      const redisLuaLat = latency.find((l) => l.engine === 'redis-lua')!;
      const latencyWinner: SpentEngine =
        redisLuaLat.p99Ms <= mysqlAtomicLat.p99Ms
          ? 'redis-lua'
          : 'mysql-atomic';

      const redisConc = concResults.find((c) => c.engine === 'redis-lua')!;
      const mysqlConc = concResults.find((c) => c.engine === 'mysql-atomic')!;
      const naiveConc = concResults.find((c) => c.engine === 'mysql-naive')!;

      this.logger.log(
        `✅ spent 벤치마크 완료 — 단건 p99: redis=${redisLuaLat.p99Ms}ms, mysql=${mysqlAtomicLat.p99Ms}ms / ` +
          `동시성 throughput: redis=${redisConc.throughputOpsPerSec}op/s, mysql=${mysqlConc.throughputOpsPerSec}op/s`
      );

      return {
        timestamp: new Date().toISOString(),
        targetCampaignId: id,
        config: { latencyCalls, concurrency, cpc, budgetAllows },
        latency,
        concurrency: concResults,
        verdict: {
          latencyWinner,
          latencyNote: `단건 지연 p99: redis-lua=${redisLuaLat.p99Ms}ms vs mysql-atomic=${mysqlAtomicLat.p99Ms}ms`,
          correctnessNote:
            `원자 구현(redis-lua, mysql-atomic)은 정확히 ${budgetAllows}건만 성공해야 정상. ` +
            `redis-lua 성공=${redisConc.successCount}(정합성 ${redisConc.correct ? 'OK' : '깨짐'}), ` +
            `mysql-atomic 성공=${mysqlConc.successCount}(정합성 ${mysqlConc.correct ? 'OK' : '깨짐'}), ` +
            `mysql-naive 성공=${naiveConc.successCount}/오버스펜드=${naiveConc.overspent}(원자성 없으면 예산 초과 차감).`,
        },
      };
    } finally {
      // 3) 데이터 원복 (성공/실패 무관하게 항상 실행)
      await this.campaignEntityRepo.update(
        { id },
        {
          dailySpent: snap.dailySpent,
          totalSpent: snap.totalSpent,
          dailyBudget: snap.dailyBudget,
          totalBudget: snap.totalBudget,
        }
      );
      await this.redisSetSpent(id, redisSnap.daily, redisSnap.total);
      this.logger.log(`🔄 spent 벤치마크 데이터 원복 완료 (대상=${id})`);
    }
  }

  /**
   * MySQL 원자 차감: 예산 검증을 WHERE에 넣은 단일 조건부 UPDATE.
   * InnoDB가 행 잠금으로 직렬화하므로 동시 요청에서도 오버스펜드가 없다.
   * affected > 0 → 성공, 0 → 예산 초과(또는 없음).
   */
  private async mysqlAtomicIncrement(
    id: string,
    cpc: number
  ): Promise<boolean> {
    const result = await this.campaignEntityRepo
      .createQueryBuilder()
      .update(CampaignEntity)
      .set({
        dailySpent: () => `daily_spent + ${cpc}`,
        totalSpent: () => `total_spent + ${cpc}`,
      })
      .where('id = :id', { id })
      .andWhere('deleted_at IS NULL')
      .andWhere('daily_spent + :c <= daily_budget', { c: cpc })
      .andWhere('(total_budget IS NULL OR total_spent + :c <= total_budget)', {
        c: cpc,
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /** MySQL 비원자 차감(맹목 증가): 예산 검증 없음 → 동시성에서 오버스펜드 발생(시연용) */
  private async mysqlNaiveIncrement(id: string, cpc: number): Promise<boolean> {
    await this.campaignEntityRepo.increment({ id }, 'dailySpent', cpc);
    await this.campaignEntityRepo.increment({ id }, 'totalSpent', cpc);
    return true;
  }

  /** Redis Lua 원자 차감 (실 서비스와 동일 스크립트) */
  private async redisLuaIncrement(
    id: string,
    cpc: number,
    dailyBudget: number,
    totalBudget: number | null
  ): Promise<boolean> {
    const key = `campaign:${id}`;
    const res = (await this.ioredisClient.eval(
      REDIS_INCREMENT_SPENT_SCRIPT,
      1,
      key,
      cpc.toString(),
      dailyBudget.toString(),
      totalBudget !== null ? totalBudget.toString() : 'null'
    )) as number;
    return res === 1;
  }

  /** Redis의 dailySpent/totalSpent를 절대값으로 설정 (리셋/원복 전용) */
  private async redisSetSpent(
    id: string,
    daily: number,
    total: number
  ): Promise<void> {
    const key = `campaign:${id}`;
    await this.ioredisClient.call(
      'JSON.SET',
      key,
      '$.dailySpent',
      daily.toString()
    );
    await this.ioredisClient.call(
      'JSON.SET',
      key,
      '$.totalSpent',
      total.toString()
    );
  }

  /** Redis의 현재 dailySpent/totalSpent 조회 */
  private async redisGetSpent(
    id: string
  ): Promise<{ daily: number; total: number }> {
    const key = `campaign:${id}`;
    const parse = (raw: unknown): number => {
      if (typeof raw !== 'string') return 0;
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? Number(v[0]) : Number(v);
      } catch {
        return 0;
      }
    };
    const d = await this.ioredisClient.call('JSON.GET', key, '$.dailySpent');
    const t = await this.ioredisClient.call('JSON.GET', key, '$.totalSpent');
    return { daily: parse(d), total: parse(t) };
  }

  private latencyStats(
    engine: SpentEngine,
    samples: number[]
  ): SpentLatencyStats {
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length || 1;
    const pct = (p: number) =>
      sorted.length === 0
        ? 0
        : sorted[
            Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
          ];
    return {
      engine,
      calls: samples.length,
      avgMs: round(samples.reduce((s, v) => s + v, 0) / n),
      p50Ms: round(pct(50)),
      p99Ms: round(pct(99)),
      maxMs: round(sorted[sorted.length - 1] ?? 0),
    };
  }

  private concResult(
    engine: SpentEngine,
    concurrency: number,
    expectedSuccess: number,
    cpc: number,
    successCount: number,
    wallClockMs: number,
    finalDailySpent: number,
    budgetCap: number
  ): SpentConcurrencyResult {
    const overspent = finalDailySpent > budgetCap;
    return {
      engine,
      concurrency,
      expectedSuccess,
      cpc,
      successCount,
      rejectedCount: concurrency - successCount,
      wallClockMs: round(wallClockMs),
      throughputOpsPerSec:
        wallClockMs > 0 ? round((concurrency / wallClockMs) * 1000) : 0,
      finalDailySpent,
      overspent,
      correct: successCount === expectedSuccess && !overspent,
    };
  }
}

function clampInt(n: number, min: number, max: number): number {
  const v = Math.floor(Number(n));
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
