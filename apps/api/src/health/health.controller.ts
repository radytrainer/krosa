import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators.js';
import { PrismaService } from '../infra/prisma.service.js';
import { RedisService } from '../infra/redis.service.js';
import { SkipThrottle } from '../common/throttle.js';

type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 2_000;

async function check(fn: () => Promise<void>): Promise<{ status: CheckStatus; latencyMs: number }> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { status: 'down', latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: the process is running and serving HTTP. No dependency checks. */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Process is alive' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and Redis are reachable. */
  @Get('ready')
  @ApiOkResponse({ description: 'All dependencies are reachable' })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is unreachable' })
  async ready() {
    const [database, redis] = await Promise.all([
      check(() => this.prisma.ping()),
      check(() => this.redis.ping()),
    ]);
    const body = {
      status: database.status === 'up' && redis.status === 'up' ? 'ok' : 'error',
      checks: { database, redis },
    };
    if (body.status !== 'ok') {
      throw new ServiceUnavailableException({ code: 'DEPENDENCY_UNAVAILABLE', ...body });
    }
    return body;
  }
}
