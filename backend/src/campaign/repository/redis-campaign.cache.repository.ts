import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { IOREDIS_CLIENT } from 'src/redis/redis.constant';
import type { AppIORedisClient } from 'src/redis/redis.type';
import { CampaignCacheRepository } from './campaign.cache.repository.interface';
import {
  CachedCampaign,
  CachedCampaignWithoutSpent,
  CampaignMatchIndexEntry,
  CampaignMatchIndexRow,
} from '../types/campaign.types';
import {
  REDIS_INCREMENT_SPENT_SCRIPT,
  REDIS_DECREMENT_SPENT_SCRIPT,
} from '../scripts/lua-script';

@Injectable()
export class RedisCampaignCacheRepository
  implements CampaignCacheRepository, OnApplicationBootstrap
{
  private readonly logger = new Logger(RedisCampaignCacheRepository.name);
  private readonly KEY_PREFIX = 'campaign:';
  // 매칭 인덱스(Hash): field=캠페인 id, value=경량 JSON (ADR-rtb-cache-lookup.md 3.1)
  // ⚠️ 키를 'campaign:' 네임스페이스 밖에 둔다. getAllCampaigns의 SCAN 'campaign:*'에
  //    걸려 JSON.GET WRONGTYPE 에러를 유발하는 충돌을 피하기 위함.
  private readonly MATCH_INDEX_KEY = 'rtb:match-index';
  private readonly CAMPAIGN_CACHE_TTL = 60 * 60 * 24;
  private readonly ALL_CAMPAIGNS_CACHE_TTL_MS = 10_000; // RTB decision hot path (짧은 TTL로 Redis SCAN/JSON.GET 비용 완화)
  private allCampaignsCache: {
    value: CachedCampaign[];
    expiresAtMs: number;
  } | null = null;
  private allCampaignsInFlight: Promise<CachedCampaign[]> | null = null;

  constructor(
    @Inject(IOREDIS_CLIENT) private readonly ioredisClient: AppIORedisClient
  ) {}

  /**
   * 부팅 시 매칭 인덱스를 1회 전체 구축한다.
   * 기존 Redis에 본문(campaign:{id})은 있는데 인덱스가 없는 상태(배포 직후)를 방지.
   * (PRD-rtb-cache-lookup.md 6. 롤아웃 1단계)
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const count = await this.rebuildMatchIndex();
      this.logger.log(`부팅 시 매칭 인덱스 초기 구축: ${count}개`);
    } catch (error) {
      this.logger.warn(
        '부팅 시 매칭 인덱스 구축 실패 (hourly cron이 보정)',
        error
      );
    }
  }

  async saveCampaignCacheById(
    id: string,
    data: CachedCampaign,
    ttl = this.CAMPAIGN_CACHE_TTL
  ): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      await this.ioredisClient.call('JSON.SET', key, '$', JSON.stringify(data));
      await this.ioredisClient.expire(key, ttl);
      // 매칭 인덱스 동기화: 본문 전체가 들어왔으므로 인덱스 엔트리를 통째로 set
      await this.setMatchIndex(id, this.buildMatchIndexEntry(data));
    } catch (error) {
      this.logger.error(`캐시 저장 실패: ${id}`, error);
      throw error;
    }
  }

  async findCampaignCacheById(id: string): Promise<CachedCampaign | null> {
    const key = this.getCampaignCacheKey(id);

    try {
      const result = await this.ioredisClient.call('JSON.GET', key);

      if (!result || typeof result !== 'string') {
        this.logger.debug(`캐시 미스: ${id}`);
        return null;
      }

      return JSON.parse(result) as CachedCampaign;
    } catch (error) {
      this.logger.error(`캐시 조회 실패: ${id}`, error);
      return null;
    }
  }

  // 동시성 이슈가 있을 수 있는 Spent를 제외한 나머지 필드 업데이트
  async updateCampaignWithoutCachedById(
    id: string,
    data: CachedCampaignWithoutSpent
  ): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      const updatePromises = Object.entries(data).map(([field, value]) =>
        this.ioredisClient.call(
          'JSON.SET',
          key,
          `$.${field}`,
          JSON.stringify(value)
        )
      );

      await Promise.all(updatePromises);
      // 매칭 인덱스 동기화: 변경분 중 인덱스에 해당하는 경량 필드만 patch
      await this.patchMatchIndexFromPartial(id, data);
    } catch (error) {
      this.logger.error(`캐시 저장 실패: ${id}`, error);
      throw error;
    }
  }

  // 상태만 업데이트
  async updateCampaignStatus(id: string, status: string): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      await this.ioredisClient.call(
        'JSON.SET',
        key,
        '$.status',
        JSON.stringify(status)
      );
      // 매칭 인덱스 동기화: status 필드만 patch
      await this.patchMatchIndex(id, {
        status: status as CampaignMatchIndexEntry['status'],
      });
    } catch (error) {
      this.logger.error(`캠페인 상태 업데이트 실패: ${id}`, error);
      throw error;
    }
  }

  // 태그 변경 시 임베딩 비우기
  async deleteCampaignEmbeddingById(id: string): Promise<void> {
    const key = this.getCampaignCacheKey(id);
    try {
      await this.ioredisClient.call(
        'JSON.SET',
        key,
        '$.embeddingTags',
        JSON.stringify({})
      );
      // 매칭 인덱스 동기화: 임베딩 비웠으므로 hasEmbedding=false
      await this.patchMatchIndex(id, { hasEmbedding: false });
    } catch (error) {
      this.logger.error(`임베딩 삭제 실패: ${id}`, error);
      throw error;
    }
  }

  async updateDailySpentCacheById(id: string, amount: number): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      await this.ioredisClient.call(
        'JSON.NUMINCRBY', // Redis에게 ADD에 대한 명령을 통한 원자적 연산 수행
        key,
        '$.dailySpent',
        amount.toString()
      );
    } catch (error) {
      this.logger.error(`dailySpent 업데이트 실패: ${id}`, error);
      throw error;
    }
  }

  async resetDailySpentCache(id: string): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      // 개별 필드만 원자적으로 업데이트
      await Promise.all([
        this.ioredisClient.call('JSON.SET', key, '$.dailySpent', '0'),
        this.ioredisClient.call(
          'JSON.SET',
          key,
          '$.lastResetDate',
          JSON.stringify(new Date().toISOString())
        ),
      ]);
    } catch (error) {
      this.logger.error(`일일 예산 리셋 실패: ${id}`, error);
      throw error;
    }
  }

  async incrementSpent(
    campaignId: string,
    cpc: number,
    dailyBudget: number,
    totalBudget: number | null
  ): Promise<boolean> {
    const key = this.getCampaignCacheKey(campaignId);

    try {
      const result = (await this.ioredisClient.eval(
        REDIS_INCREMENT_SPENT_SCRIPT,
        1,
        key,
        cpc.toString(),
        dailyBudget.toString(),
        totalBudget !== null ? totalBudget.toString() : 'null'
      )) as number;

      if (result === 1) {
        this.logger.debug(
          `캠페인 ${campaignId} Spent 증가 성공: +${cpc} (일일/총)`
        );
        return true;
      }

      if (result === 0) {
        this.logger.debug(`캠페인 ${campaignId} 일일 예산 초과로 증가 실패`);
      } else if (result === -1) {
        this.logger.debug(`캠페인 ${campaignId} 총 예산 초과로 증가 실패`);
      } else {
        this.logger.warn(`캠페인 ${campaignId} 캐시 없음 (result: ${result})`);
      }

      return false;
    } catch (error) {
      this.logger.error(`캠페인 ${campaignId} Spent 증가 실패`, error);
      return false;
    }
  }

  async decrementSpent(campaignId: string, cpc: number): Promise<void> {
    const key = this.getCampaignCacheKey(campaignId);

    try {
      const result = (await this.ioredisClient.eval(
        REDIS_DECREMENT_SPENT_SCRIPT,
        1,
        key,
        cpc.toString() // 양수로 전달 (Lua에서 -cpc 처리)
      )) as number;

      if (result === 1) {
        this.logger.debug(
          `캠페인 ${campaignId} Spent 롤백 완료: -${cpc} (일일/총)`
        );
      } else if (result === 0) {
        this.logger.warn(
          `캠페인 ${campaignId} 일일 Spent 음수 방지 (현재값 < ${cpc})`
        );
      } else if (result === -1) {
        this.logger.warn(
          `캠페인 ${campaignId} 총 Spent 음수 방지 (현재값 < ${cpc})`
        );
      } else if (result === -99) {
        this.logger.error(`캠페인 ${campaignId} 캐시 없음 (롤백 실패)`);
      }
    } catch (error) {
      this.logger.error(`캠페인 ${campaignId} Spent 롤백 실패`, error);
      // 롤백 실패는 치명적이지 않음 (과다 차감 방향은 안전)
      // 일일 정산에서 보정됨
    }
  }

  async deleteCampaignCacheById(id: string): Promise<void> {
    const key = this.getCampaignCacheKey(id);
    await this.ioredisClient.del(key);
    // 매칭 인덱스 동기화: 인덱스 field 제거 → 매칭 후보에서 자연 제외
    await this.ioredisClient.hdel(this.MATCH_INDEX_KEY, id);
    this.logger.debug(`캐시 삭제: ${id}`);
  }

  async existsCampaignCacheById(id: string): Promise<boolean> {
    const key = this.getCampaignCacheKey(id);
    const result = await this.ioredisClient.exists(key);
    return result === 1;
  }

  async updateCampaignEmbeddingTags(
    id: string,
    embeddingTags: { [tagName: string]: number[] }
  ): Promise<void> {
    const key = this.getCampaignCacheKey(id);

    try {
      await this.ioredisClient.call(
        'JSON.SET',
        key,
        '$.embeddingTags',
        JSON.stringify(embeddingTags)
      );
      // 매칭 인덱스 동기화: 임베딩 생성됐으므로 hasEmbedding 갱신
      await this.patchMatchIndex(id, {
        hasEmbedding: Object.keys(embeddingTags ?? {}).length > 0,
      });
    } catch (error) {
      this.logger.error(`캠페인 임베딩 업데이트 실패: ${id}`, error);
      throw error;
    }
  }

  // RTB 비딩용: Redis에서 모든 캠페인 조회
  async getAllCampaigns(): Promise<CachedCampaign[]> {
    const nowMs = Date.now();

    const cached = this.allCampaignsCache;
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.value;
    }

    if (this.allCampaignsInFlight) {
      return this.allCampaignsInFlight;
    }

    const work = (async () => {
      try {
        const pattern = `${this.KEY_PREFIX}*`;
        const keys: string[] = [];

        // SCAN으로 모든 campaign:* 키 조회
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

        if (keys.length === 0) {
          return [];
        }

        // JSON.GET는 다건 호출 시 latency가 커져 in-flight 요청이 쌓이며 heap spike로 이어질 수 있음
        // → pipeline + batch로 라운드트립을 줄입니다.
        const campaigns: CachedCampaign[] = [];
        const BATCH_SIZE = 200;

        for (let i = 0; i < keys.length; i += BATCH_SIZE) {
          const batchKeys = keys.slice(i, i + BATCH_SIZE);
          const pipeline = this.ioredisClient.pipeline();

          batchKeys.forEach((key) => {
            pipeline.call('JSON.GET', key);
          });

          const results = await pipeline.exec();
          if (!results) continue;

          results.forEach(([error, result], idx) => {
            if (error) {
              this.logger.warn(`캠페인 조회 실패: ${batchKeys[idx]}`, error);
              return;
            }

            if (result && typeof result === 'string') {
              try {
                campaigns.push(JSON.parse(result) as CachedCampaign);
              } catch (parseError) {
                this.logger.warn(
                  `캠페인 JSON 파싱 실패: ${batchKeys[idx]}`,
                  parseError
                );
              }
            }
          });
        }

        return campaigns;
      } catch (error) {
        this.logger.error('모든 캠페인 조회 실패', error);
        return [];
      } finally {
        this.allCampaignsInFlight = null;
      }
    })();

    this.allCampaignsInFlight = work;

    const campaigns = await work;
    this.allCampaignsCache = {
      value: campaigns,
      expiresAtMs: Date.now() + this.ALL_CAMPAIGNS_CACHE_TTL_MS,
    };

    return campaigns;
  }

  // ===========================================================================
  // 매칭 인덱스 (campaign:match-index Hash)
  // ===========================================================================

  /**
   * RTB hot path: 매칭 인덱스를 HGETALL 1왕복으로 조회.
   * SCAN/개별 GET 없이 경량 데이터만 가져온다(본문/임베딩 벡터 미포함).
   */
  async getMatchIndex(): Promise<CampaignMatchIndexRow[]> {
    try {
      const all = await this.ioredisClient.hgetall(this.MATCH_INDEX_KEY);
      const rows: CampaignMatchIndexRow[] = [];
      for (const [id, raw] of Object.entries(all)) {
        try {
          rows.push({ id, ...(JSON.parse(raw) as CampaignMatchIndexEntry) });
        } catch (e) {
          this.logger.warn(`매칭 인덱스 엔트리 파싱 실패: ${id}`, e);
        }
      }
      return rows;
    } catch (error) {
      this.logger.error('매칭 인덱스 조회 실패', error);
      return [];
    }
  }

  /**
   * 자격 통과 후보들의 본문/임베딩만 pipeline GET으로 모아 조회.
   * 매 입찰에서 전수가 아니라 "생존자"에 대해서만 무거운 문서를 읽는다.
   */
  async findManyByIds(ids: string[]): Promise<CachedCampaign[]> {
    if (ids.length === 0) return [];

    const campaigns: CachedCampaign[] = [];
    const BATCH_SIZE = 200;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const pipeline = this.ioredisClient.pipeline();
      batch.forEach((id) =>
        pipeline.call('JSON.GET', this.getCampaignCacheKey(id))
      );
      const results = await pipeline.exec();
      if (!results) continue;
      results.forEach(([error, result], idx) => {
        if (error) {
          this.logger.warn(`캠페인 조회 실패: ${batch[idx]}`, error);
          return;
        }
        if (result && typeof result === 'string') {
          try {
            campaigns.push(JSON.parse(result) as CachedCampaign);
          } catch (parseError) {
            this.logger.warn(
              `캠페인 JSON 파싱 실패: ${batch[idx]}`,
              parseError
            );
          }
        }
      });
    }
    return campaigns;
  }

  /**
   * 본문(getAllCampaigns) 기준으로 매칭 인덱스를 전체 재구축.
   * 증분 갱신(HSET/HDEL)에서 누락이 생겨도 cron이 self-healing 한다.
   * 기존 키를 DEL 후 재구축하므로 orphan(삭제된 캠페인) field도 함께 제거된다.
   */
  async rebuildMatchIndex(): Promise<number> {
    const campaigns = await this.getAllCampaigns();
    const pipeline = this.ioredisClient.pipeline();
    pipeline.del(this.MATCH_INDEX_KEY);
    for (const c of campaigns) {
      pipeline.hset(
        this.MATCH_INDEX_KEY,
        c.id,
        JSON.stringify(this.buildMatchIndexEntry(c))
      );
    }
    await pipeline.exec();
    const withEmb = campaigns.filter(
      (c) => !!c.embeddingTags && Object.keys(c.embeddingTags).length > 0
    ).length;
    this.logger.log(
      `🔁 매칭 인덱스 재구축 완료: ${campaigns.length}개 (hasEmbedding=${withEmb})`
    );
    return campaigns.length;
  }

  /** 본문 CachedCampaign에서 인덱스 경량 엔트리를 도출 */
  private buildMatchIndexEntry(c: CachedCampaign): CampaignMatchIndexEntry {
    return {
      status: c.status,
      isHighIntent: c.isHighIntent,
      deletedAt: c.deletedAt,
      startDate: c.startDate,
      endDate: c.endDate,
      hasEmbedding:
        !!c.embeddingTags && Object.keys(c.embeddingTags).length > 0,
    };
  }

  /** 인덱스 엔트리를 통째로 set (본문 전체 저장 시) */
  private async setMatchIndex(
    id: string,
    entry: CampaignMatchIndexEntry
  ): Promise<void> {
    await this.ioredisClient.hset(
      this.MATCH_INDEX_KEY,
      id,
      JSON.stringify(entry)
    );
  }

  /**
   * 인덱스 엔트리의 일부 필드만 갱신 (read-modify-write).
   * 대상은 단일 캠페인 field 1개뿐 — 전체 인덱스를 읽거나 다시 쓰지 않는다.
   * field가 아직 없으면(인덱스 누락) 부분값만 기록하고, 빠진 필드는 rebuild cron이 보정.
   */
  private async patchMatchIndex(
    id: string,
    partial: Partial<CampaignMatchIndexEntry>
  ): Promise<void> {
    try {
      const raw = await this.ioredisClient.hget(this.MATCH_INDEX_KEY, id);
      let entry: Partial<CampaignMatchIndexEntry> = {};
      if (raw) {
        try {
          entry = JSON.parse(raw) as CampaignMatchIndexEntry;
        } catch {
          // 파싱 실패 시 부분값으로 재기록
        }
      }
      await this.ioredisClient.hset(
        this.MATCH_INDEX_KEY,
        id,
        JSON.stringify({ ...entry, ...partial })
      );
    } catch (error) {
      // 인덱스 갱신 실패는 비치명적: spent Lua 최종 검증 + rebuild cron이 방어
      this.logger.warn(`매칭 인덱스 patch 실패: ${id}`, error);
    }
  }

  /** 부분 본문 변경분 중 인덱스에 해당하는 경량 필드만 추려 patch */
  private async patchMatchIndexFromPartial(
    id: string,
    data: CachedCampaignWithoutSpent
  ): Promise<void> {
    const partial: Partial<CampaignMatchIndexEntry> = {};
    if (data.status !== undefined) partial.status = data.status;
    if (data.isHighIntent !== undefined)
      partial.isHighIntent = data.isHighIntent;
    if (data.deletedAt !== undefined) partial.deletedAt = data.deletedAt;
    if (data.startDate !== undefined) partial.startDate = data.startDate;
    if (data.endDate !== undefined) partial.endDate = data.endDate;
    if (data.embeddingTags !== undefined)
      partial.hasEmbedding = Object.keys(data.embeddingTags ?? {}).length > 0;

    if (Object.keys(partial).length > 0) {
      await this.patchMatchIndex(id, partial);
    }
  }

  private getCampaignCacheKey(id: string): string {
    return `${this.KEY_PREFIX}${id}`;
  }
}
