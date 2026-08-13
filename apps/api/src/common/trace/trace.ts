import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Per-request trace context.
 *
 * AsyncLocalStorage rather than passing a trace id through every signature: a log
 * line emitted five layers down must carry the same id as the response, and threading
 * it manually means the one place someone forgets is the place you need it (AC3).
 */
interface TraceContext {
  traceId: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return storage.run({ traceId }, fn);
}

/**
 * The current request's trace id, or a fresh one outside a request.
 *
 * Never returns undefined: a log line or error body without a trace id is
 * undebuggable, and callers should not have to branch on it.
 */
export function currentTraceId(): string {
  return storage.getStore()?.traceId ?? randomUUID();
}

export function newTraceId(): string {
  return randomUUID();
}

export const TRACE_HEADER = 'x-trace-id';
