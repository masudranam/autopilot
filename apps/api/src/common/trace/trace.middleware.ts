import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logging/logger';
import { TRACE_HEADER, newTraceId, runWithTrace } from './trace';

/**
 * Opens the trace context for every request, sets X-Trace-Id on the response, and
 * emits one structured access log line on completion (AC3, AC4).
 *
 * Runs as middleware rather than an interceptor so the context also covers requests
 * that never reach a controller — 404s and body-parse failures still get a trace id
 * and a log line, which is exactly when you most want one.
 */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // An inbound trace id is echoed so a caller can correlate across services, but
    // only when it looks like one — an attacker-supplied header must not be able to
    // inject newlines or unbounded junk into every log line for this request.
    const inbound = req.header(TRACE_HEADER);
    const traceId = inbound && /^[A-Za-z0-9._-]{8,128}$/.test(inbound) ? inbound : newTraceId();

    res.setHeader('X-Trace-Id', traceId);

    runWithTrace(traceId, () => {
      const startedAt = process.hrtime.bigint();

      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        logger.info('request', {
          method: req.method,
          // originalUrl keeps the mount prefix; route params are not expanded here,
          // so this is the real path that was requested.
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
        });
      });

      next();
    });
  }
}
