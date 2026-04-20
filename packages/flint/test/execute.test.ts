import { describe, expect, it } from 'vitest';
import { ParseError, TimeoutError, ToolError } from '../src/errors.ts';
import { execute } from '../src/primitives/execute.ts';
import { tool } from '../src/primitives/tool.ts';
import type { StandardSchemaV1 } from '../src/types.ts';

function numberSchema(): StandardSchemaV1<unknown, { n: number }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (raw) => {
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'n' in raw &&
          typeof (raw as { n: unknown }).n === 'number'
        ) {
          return { value: { n: (raw as { n: number }).n } };
        }
        return { issues: [{ message: 'must be { n: number }' }] };
      },
    },
  };
}

describe('execute', () => {
  const adder = tool({
    name: 'adder',
    description: 'adds one',
    input: numberSchema(),
    handler: (x) => x.n + 1,
  });

  it('returns Result.ok with handler output on valid input', async () => {
    const res = await execute(adder, { n: 5 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe(6);
    }
  });

  it('returns Result.error(ParseError) on invalid input', async () => {
    const res = await execute(adder, { wrong: 'input' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ParseError);
      expect((res.error as ParseError).code).toBe('parse.tool_input');
    }
  });

  it('does not invoke handler when input is invalid', async () => {
    let called = false;
    const t = tool({
      name: 't',
      description: 't',
      input: numberSchema(),
      handler: () => {
        called = true;
        return 0;
      },
    });
    await execute(t, { wrong: 'input' });
    expect(called).toBe(false);
  });

  it('returns Result.error(ToolError) when handler throws', async () => {
    const boom = tool({
      name: 'boom',
      description: 'throws',
      input: numberSchema(),
      handler: () => {
        throw new Error('kaboom');
      },
    });
    const res = await execute(boom, { n: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ToolError);
      expect((res.error as ToolError).code).toBe('tool.handler_threw');
      expect((res.error as ToolError).cause).toBeInstanceOf(Error);
    }
  });

  it('awaits async handlers', async () => {
    const asyncAdder = tool({
      name: 'async',
      description: 'async',
      input: numberSchema(),
      handler: async (x) => x.n * 2,
    });
    const res = await execute(asyncAdder, { n: 3 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe(6);
    }
  });

  it('enforces timeout on slow handlers', async () => {
    const slow = tool({
      name: 'slow',
      description: 'takes too long',
      input: numberSchema(),
      timeout: 50,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 1;
      },
    });
    const res = await execute(slow, { n: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(TimeoutError);
      if (res.error instanceof TimeoutError) {
        expect(res.error.code).toBe('tool.timeout');
      }
    }
  });

  it('does not time out when handler is fast enough', async () => {
    const fast = tool({
      name: 'fast',
      description: 'quick',
      input: numberSchema(),
      timeout: 200,
      handler: async (x) => {
        await new Promise((r) => setTimeout(r, 20));
        return x.n + 1;
      },
    });
    const res = await execute(fast, { n: 5 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe(6);
    }
  });

  it('works without timeout (default behavior)', async () => {
    const noTimeout = tool({
      name: 'plain',
      description: 'no timeout',
      input: numberSchema(),
      handler: async (x) => x.n * 2,
    });
    const res = await execute(noTimeout, { n: 3 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe(6);
    }
  });
});
