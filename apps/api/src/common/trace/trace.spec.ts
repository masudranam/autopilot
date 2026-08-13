import { currentTraceId, newTraceId, runWithTrace } from './trace';

describe('trace context (AC3)', () => {
  it('returns the id set for the current scope', () => {
    runWithTrace('trace-abc', () => {
      expect(currentTraceId()).toBe('trace-abc');
    });
  });

  it('survives async boundaries — the point of AsyncLocalStorage', async () => {
    await runWithTrace('trace-async', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentTraceId()).toBe('trace-async');
      await Promise.all([
        (async () => {
          await new Promise((resolve) => setImmediate(resolve));
          expect(currentTraceId()).toBe('trace-async');
        })(),
      ]);
    });
  });

  it('keeps concurrent requests separate', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithTrace(id, async () => {
          // Stagger so the contexts genuinely interleave.
          await new Promise((resolve) => setTimeout(resolve, id === 'b' ? 1 : 5));
          seen.push(`${id}:${currentTraceId()}`);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['a:a', 'b:b', 'c:c']);
  });

  // Never undefined: a log line or error body without a trace id is undebuggable.
  it('mints an id outside any request rather than returning undefined', () => {
    const id = currentTraceId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(8);
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newTraceId()));
    expect(ids.size).toBe(100);
  });
});
