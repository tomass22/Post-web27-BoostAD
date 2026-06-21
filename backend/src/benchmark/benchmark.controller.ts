import { Controller, Get, Query, Logger } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { BenchmarkService, BenchmarkSummary } from './benchmark.service';

@Controller('benchmark')
export class BenchmarkController {
  private readonly logger = new Logger(BenchmarkController.name);

  constructor(private readonly benchmarkService: BenchmarkService) {}

  /**
   * GET /benchmark/run?iterations=5&tags=mysql,redis
   * 누적 단계 벤치마크 (baseline → +Redis → +임베딩캐싱)
   */
  @Public()
  @Get('run')
  async runBenchmark(
    @Query('iterations') iterations: string = '5',
    @Query('tags') tags?: string
  ): Promise<{
    success: boolean;
    data: BenchmarkSummary;
    message: string;
  }> {
    const iterCount = Math.max(1, Math.min(10, parseInt(iterations, 10) || 5));
    const requestTags = tags
      ? tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    this.logger.log(`📍 벤치마크 요청: ${iterCount}회 반복`);

    try {
      const result = await this.benchmarkService.runFullBenchmark(
        iterCount,
        requestTags
      );

      return {
        success: true,
        data: result,
        message: `✅ 벤치마크 완료 (${iterCount}회)`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error(`❌ 벤치마크 실패: ${errorMessage}`);

      return {
        success: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: null as any,
        message: `벤치마크 실패: ${errorMessage}`,
      };
    }
  }

  /**
   * GET /benchmark/health
   * 벤치마크 서비스 상태 확인
   */
  @Public()
  @Get('health')
  healthCheck(): {
    status: string;
    mlEngineReady: boolean;
    timestamp: string;
  } {
    return {
      status: 'benchmark-service-ok',
      mlEngineReady: true, // MLEngine이 준비됐다고 가정
      timestamp: new Date().toISOString(),
    };
  }
}
