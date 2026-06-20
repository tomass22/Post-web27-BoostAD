import { Injectable, Logger } from '@nestjs/common';
import { CampaignRepository } from '../campaign/repository/campaign.repository.interface';
import { CampaignCacheRepository } from '../campaign/repository/campaign.cache.repository.interface';
import { MLEngine } from '../rtb/ml/mlEngine.interface';
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
    private readonly mlEngine: MLEngine
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
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
