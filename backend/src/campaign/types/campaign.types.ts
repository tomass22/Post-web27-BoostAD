export type CampaignStatus = 'PENDING' | 'ACTIVE' | 'PAUSED' | 'ENDED';

export type Campaign = {
  id: string;
  userId: number;
  title: string;
  content: string;
  image: string;
  url: string;
  maxCpc: number;
  dailyBudget: number;
  totalBudget: number | null;
  dailySpent: number;
  totalSpent: number;
  lastResetDate: Date;
  isHighIntent: boolean;
  status: CampaignStatus;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  deletedAt: Date | null;
};

export type Tag = {
  id: number;
  name: string;
};

export type CampaignWithTags = Campaign & {
  tags: Tag[];
};

export type CampaignWithStats = CampaignWithTags & {
  impressions: number;
  clicks: number;
  ctr: number;
  dailySpentPercent: number;
  totalSpentPercent: number;
};

export type CampaignTag = {
  campaignId: string;
  tagId: number;
};

export type CachedCampaign = {
  id: string;
  userId: number;
  title: string;
  content: string;
  image: string | null;
  url: string;
  maxCpc: number;
  dailyBudget: number;
  totalBudget: number | null;
  dailySpent: number;
  totalSpent: number;
  lastResetDate: string;
  isHighIntent: boolean;
  status: CampaignStatus;
  startDate: string;
  endDate: string;
  createdAt: string;
  deletedAt: string | null;

  // 태그 정보 (매칭용)
  tags?: string[];

  // 태그별 임베딩 (Worker가 추가)
  embeddingTags?: { [tagName: string]: number[] };
};

export type CachedCampaignWithoutSpent = Omit<
  CachedCampaign,
  'dailySpent' | 'totalSpent'
>;

/**
 * 매칭 인덱스(campaign:match-index Hash)의 field 값.
 * 1단계 자격 필터(filterEligibleCampaigns)에 필요한 경량 필드만 담는다.
 * 본문/예산/임베딩 벡터는 제외 — 임베딩은 존재 여부(hasEmbedding)만 평탄화해 보관.
 * (ADR-rtb-cache-lookup.md 3.1)
 */
export type CampaignMatchIndexEntry = {
  status: CampaignStatus;
  isHighIntent: boolean;
  deletedAt: string | null;
  startDate: string;
  endDate: string;
  hasEmbedding: boolean;
};

/** 매칭 인덱스 엔트리 + 캠페인 id */
export type CampaignMatchIndexRow = CampaignMatchIndexEntry & { id: string };
