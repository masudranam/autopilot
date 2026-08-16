import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/auth/public.decorator';
import { NotReadyError } from '../../common/errors/domain-error';
import { HealthService } from './health.service';

/**
 * Liveness and readiness (F4/AC3).
 *
 * `/health` answers 200 whenever the process is up — orchestrators use it to decide
 * whether to restart. `/health/ready` answers 200 only when Postgres and Redis both
 * respond — load balancers use it to decide whether to send traffic. Conflating the
 * two turns any database blip into a restart loop.
 *
 * These endpoints are deliberately unauthenticated: infrastructure probes cannot
 * carry credentials. They expose no data beyond component up/down state.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness — 200 whenever the process is running' })
  @ApiOkResponse({ description: 'The process is up.' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness — 200 only when Postgres and Redis both answer' })
  @ApiOkResponse({ description: 'All dependencies reachable.' })
  @ApiServiceUnavailableResponse({
    description: 'One or more dependencies unreachable — RFC 9457 Problem Details body.',
  })
  async ready(): Promise<{ status: 'ready'; components: Record<string, boolean> }> {
    const components = await this.health.checkReadiness();
    const failing = Object.entries(components)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);

    // Throw and let the one filter render it (I3). The previous version hand-built a
    // Problem Details body here and shipped a hardcoded `instance` that did not match
    // the request path — the exact drift a single filter exists to prevent.
    if (failing.length > 0) throw new NotReadyError(failing);

    return { status: 'ready', components };
  }
}
