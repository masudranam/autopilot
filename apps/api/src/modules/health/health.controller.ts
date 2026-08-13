import { Controller, Get, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ProblemType } from '@repo/contracts';
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

  @Get()
  @ApiOperation({ summary: 'Liveness — 200 whenever the process is running' })
  @ApiOkResponse({ description: 'The process is up.' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness — 200 only when Postgres and Redis both answer' })
  @ApiOkResponse({ description: 'All dependencies reachable.' })
  @ApiServiceUnavailableResponse({
    description: 'One or more dependencies unreachable — RFC 9457 Problem Details body.',
  })
  async ready(@Res() res: Response): Promise<void> {
    const components = await this.health.checkReadiness();
    const failing = Object.entries(components).filter(([, ok]) => !ok);

    if (failing.length === 0) {
      res.status(200).json({ status: 'ready', components });
      return;
    }

    // Minimal RFC 9457 body (I3). The global exception filter with real trace
    // propagation is F5; this endpoint must not depend on it to report accurately.
    res
      .status(503)
      .type('application/problem+json')
      .json({
        type: ProblemType.INTERNAL,
        title: 'Not ready',
        status: 503,
        detail: `Unreachable: ${failing.map(([name]) => name).join(', ')}`,
        instance: '/health/ready',
        traceId: randomUUID(),
      });
  }
}
