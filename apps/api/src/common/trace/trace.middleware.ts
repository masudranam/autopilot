import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logging/logger';
import { TRACE_HEADER, newTraceId, runWithTrace } from './trace';

/**
 * Opens the trace context for every request, sets X-Trace-Id on the response, and
 * emits one structured access log line on completion (AC3, AC4).
 *
 * A PLAIN express handler, not a Nest middleware class, and registered with
 * `app.use()` before the body parsers — see app.setup.ts. Nest registers its parsers
 * during `NestFactory.create`, i.e. ahead of anything `AppModule.configure()` applies,
 * so a middleware class could never wrap a body-parse failure. pr-reviewer proved the
 * consequence on the wire: malformed JSON returned a body whose traceId appeared in no
 * log line, with no X-Trace-Id header and no access-log entry at all.
 */
export function traceRequest(req: Request, res: Response, next: NextFunction): void {
  // An inbound trace id is echoed so a caller can correlate across services, but only
  // when it looks like one — an attacker-supplied header must not be able to inject
  // newlines or unbounded junk into every log line for this request.
  const inbound = req.header(TRACE_HEADER);
  const traceId = inbound && /^[A-Za-z0-9._-]{8,128}$/.test(inbound) ? inbound : newTraceId();

  res.setHeader('X-Trace-Id', traceId);

  runWithTrace(traceId, () => {
    const startedAt = process.hrtime.bigint();

    const emitAccessLog = (): void => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger.info('request', {
        method: req.method,
        // originalUrl keeps the mount prefix and stays percent-encoded, so a hostile
        // path cannot break the log line.
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    };

    // 'finish' covers a completed response; 'close' catches a client that aborted
    // mid-flight, which would otherwise never be logged.
    let logged = false;
    const once = (): void => {
      if (logged) return;
      logged = true;
      emitAccessLog();
    };
    res.on('finish', once);
    res.on('close', once);

    next();
  });
}
