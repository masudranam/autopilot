import { traceRequest } from './trace.middleware';
import { TRACE_HEADER } from './trace';

/**
 * Unit tests for inbound trace-id acceptance.
 *
 * The e2e suite covers what a real HTTP client can send; these cover what it cannot.
 * Node's http client refuses to transmit a header containing a newline, so the
 * log-injection case — the one that actually matters — is only reachable here.
 */
/**
 * @param emitFinish how many times to fire the response 'finish' event. Fired from
 *   INSIDE the trace scope, which is where it happens in production: res.end() runs
 *   downstream of next(), so the emit descends from the AsyncLocalStorage context the
 *   middleware opened. Firing it from outside would lose the context and the test
 *   would assert against a fresh id rather than the request's.
 */
function runMiddleware(
  inbound?: string,
  { method = 'GET', url = '/api/v1/thing', status = 200, emitFinish = 0 } = {},
): { traceId: string } {
  const headers: Record<string, string> = {};
  const listeners: Record<string, (() => void)[]> = {};

  const req = {
    method,
    originalUrl: url,
    header: (name: string) => (name.toLowerCase() === TRACE_HEADER ? inbound : undefined),
  };
  const res = {
    statusCode: status,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    // Records the callback instead of discarding it. The previous `() => undefined`
    // stub meant the finish handler never ran, so deleting the entire access-log
    // emission left the suite green — AC4 was untested (found by pr-reviewer).
    on: (event: string, callback: () => void) => {
      (listeners[event] ??= []).push(callback);
    },
  };

  let captured = '';

  traceRequest(req as never, res as never, () => {
    captured = headers['X-Trace-Id'] ?? '';
    for (let i = 0; i < emitFinish; i += 1) {
      listeners.finish?.forEach((callback) => callback());
    }
  });

  return { traceId: captured };
}

/** Captures the JSON log lines emitted while fn runs. */
function captureLogs(fn: () => void): Record<string, unknown>[] {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'debug';
  const lines: string[] = [];
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    stdout.mockRestore();
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('inbound trace id acceptance', () => {
  it('accepts a well-formed id and echoes it', () => {
    expect(runMiddleware('caller-supplied-0001').traceId).toBe('caller-supplied-0001');
  });

  it('accepts a UUID', () => {
    const uuid = '018f3a9c-1b2d-7e4f-9a8b-0c1d2e3f4a5b';
    expect(runMiddleware(uuid).traceId).toBe(uuid);
  });

  it('mints a fresh id when none is supplied', () => {
    const { traceId } = runMiddleware(undefined);
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  // These would otherwise be written verbatim into every log line for the request.
  it.each([
    ['newline', 'abcdefgh\ninjected'],
    ['carriage return', 'abcdefgh\rinjected'],
    ['JSON break-out', 'abcdefgh","level":"error'],
    ['too short', 'abc'],
    ['too long', 'x'.repeat(129)],
    ['empty', ''],
    ['spaces', 'has spaces here'],
  ])('rejects %s and mints a fresh id instead', (_label, bad) => {
    const { traceId } = runMiddleware(bad);
    expect(traceId).not.toBe(bad);
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts the boundary lengths', () => {
    expect(runMiddleware('a'.repeat(8)).traceId).toBe('a'.repeat(8));
    expect(runMiddleware('a'.repeat(128)).traceId).toBe('a'.repeat(128));
  });
});

describe('access log line (AC4)', () => {
  // Deleting the whole res.on('finish') block previously left the suite green: the
  // unit stub discarded the callback and the e2e suite silenced the logger, so the
  // entire acceptance criterion was unenforced.
  it('emits exactly one line carrying method, path, status, duration and traceId', () => {
    const lines = captureLogs(() => {
      runMiddleware('access-log-0001', {
        method: 'POST',
        url: '/api/v1/orders?dry=1',
        status: 201,
        emitFinish: 1,
      });
    });

    const access = lines.filter((line) => line.message === 'request');
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      level: 'info',
      method: 'POST',
      path: '/api/v1/orders?dry=1',
      status: 201,
      traceId: 'access-log-0001',
    });
    expect(typeof access[0]?.durationMs).toBe('number');
  });

  it('records the status the response actually finished with', () => {
    const lines = captureLogs(() => runMiddleware(undefined, { status: 503, emitFinish: 1 }));
    expect(lines.find((line) => line.message === 'request')?.status).toBe(503);
  });

  it('emits nothing until the response finishes', () => {
    const lines = captureLogs(() => runMiddleware(undefined, { emitFinish: 0 }));
    expect(lines.filter((line) => line.message === 'request')).toEqual([]);
  });

  // Both 'finish' and 'close' are registered so an aborted request is still logged;
  // the guard stops a completed response producing two lines.
  it('logs once even if the lifecycle event fires twice', () => {
    const lines = captureLogs(() => runMiddleware(undefined, { emitFinish: 2 }));
    expect(lines.filter((line) => line.message === 'request')).toHaveLength(1);
  });
});
