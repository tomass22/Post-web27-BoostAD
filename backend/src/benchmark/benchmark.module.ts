import { Module } from '@nestjs/common';
import { BenchmarkController } from './benchmark.controller';
import { BenchmarkService } from './benchmark.service';
import { CampaignModule } from '../campaign/campaign.module';
import { RTBModule } from '../rtb/rtb.module';

@Module({
  imports: [CampaignModule, RTBModule],
  controllers: [BenchmarkController],
  providers: [BenchmarkService],
})
export class BenchmarkModule {}
