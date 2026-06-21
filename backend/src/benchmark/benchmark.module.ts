import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BenchmarkController } from './benchmark.controller';
import { BenchmarkService } from './benchmark.service';
import { CampaignModule } from '../campaign/campaign.module';
import { RTBModule } from '../rtb/rtb.module';
import { RedisModule } from '../redis/redis.module';
import { CampaignEntity } from '../campaign/entities/campaign.entity';

@Module({
  imports: [
    CampaignModule,
    RTBModule,
    RedisModule,
    // spent 벤치마크에서 MySQL 원자 조건부 UPDATE를 직접 측정하기 위함 (측정 전용)
    TypeOrmModule.forFeature([CampaignEntity]),
  ],
  controllers: [BenchmarkController],
  providers: [BenchmarkService],
})
export class BenchmarkModule {}
