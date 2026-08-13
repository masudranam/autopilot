import { logger } from './logger';
import { runWithTrace } from '../trace/trace';

// The logger is silent under NODE_ENV=test so request logs do not bury CI output.
// These tests are about the logger itself, so they opt back in.
beforeAll(() => {
  process.env.LOG_LEVEL = 'debug';
});
afterAll(() => {
  delete process.env.LOG_LEVEL;
});

/** Captures whichever stream the logger writes to and returns parsed lines. */
function captureLines(fn: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('structured logging (AC4)', () => {
  it('emits one parseable JSON object per line', () => {
    const [line] = captureLines(() => logger.info('hello', { answer: 42 }));
    expect(line).toMatchObject({ level: 'info', message: 'hello', answer: 42 });
    expect(typeof line?.time).toBe('string');
  });

  it('carries the current request trace id (AC3)', () => {
    const [line] = captureLines(() => {
      runWithTrace('trace-log-1', () => logger.info('inside a request'));
    });
    expect(line?.traceId).toBe('trace-log-1');
  });

  it('still emits a trace id outside a request', () => {
    const [line] = captureLines(() => logger.info('background job'));
    expect(typeof line?.traceId).toBe('string');
  });

  it('is silent under NODE_ENV=test unless LOG_LEVEL is set', () => {
    const previous = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      logger.info('should not appear');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      if (previous !== undefined) process.env.LOG_LEVEL = previous;
    }
  });

  it('sends warn and error to stderr, info to stdout', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logger.info('to stdout');
      logger.warn('to stderr');
      logger.error('to stderr');
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledTimes(2);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it('is newline-delimited so a log shipper can split on lines', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      logger.info('one');
      const written = String(stdout.mock.calls[0]?.[0]);
      expect(written.endsWith('\n')).toBe(true);
      expect(written.trimEnd()).not.toContain('\n');
    } finally {
      stdout.mockRestore();
    }
  });
});
