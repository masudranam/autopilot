import { currentTraceId } from '../trace/trace';

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured JSON logging (AC4).
 *
 * One line per event, machine-parseable, always carrying the current request's
 * traceId so logs, the response body and the X-Trace-Id header all agree (AC3).
 *
 * Deliberately dependency-free: a logging library is a large surface for something
 * that must never itself throw inside an exception filter.
 */
export type LogFields = Record<string, unknown>;

function emit(level: Level, message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    traceId: currentTraceId(),
    message,
    ...fields,
  });

  // stderr for warn/error so log shippers can split streams; stdout otherwise.
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
};
