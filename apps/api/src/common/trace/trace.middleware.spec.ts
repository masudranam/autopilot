import { TraceMiddleware } from './trace.middleware';
import { TRACE_HEADER } from './trace';

/**
 * Unit tests for inbound trace-id acceptance.
 *
 * The e2e suite covers what a real HTTP client can send; these cover what it cannot.
 * Node's http client refuses to transmit a header containing a newline, so the
 * log-injection case — the one that actually matters — is only reachable here.
 */
function runMiddleware(inbound?: string): { traceId: string } {
  const headers: Record<string, string> = {};
  const req = {
    method: 'GET',
    originalUrl: '/api/v1/thing',
    header: (name: string) => (name.toLowerCase() === TRACE_HEADER ? inbound : undefined),
  };
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    on: () => undefined,
  };

  let captured = '';
  new TraceMiddleware().use(req as never, res as never, () => {
    captured = headers['X-Trace-Id'] ?? '';
  });
  return { traceId: captured };
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
