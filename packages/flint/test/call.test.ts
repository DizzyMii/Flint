import { describe, expect, expectTypeOf, it } from 'vitest';
import type { NormalizedResponse } from '../src/adapter.ts';
import { budget } from '../src/budget.ts';
import { AdapterError, BudgetExhausted, ParseError, ValidationError } from '../src/errors.ts';
import { call } from '../src/primitives/call.ts';
import { mockAdapter } from '../src/testing/mock-adapter.ts';
import type { Message, StandardSchemaV1 } from '../src/types.ts';

const textResponse = (content: string, stop: 'end' | 'tool_call' = 'end'): NormalizedResponse => ({
  message: { role: 'assistant', content },
  usage: { input: 10, output: 5 },
  stopReason: stop,
});

function jsonSchema<T>(check: (v: unknown) => v is T): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (raw) => (check(raw) ? { value: raw } : { issues: [{ message: 'bad shape' }] }),
    },
  };
}

const msg: Message[] = [{ role: 'user', content: 'hi' }];

describe('call', () => {
  it('returns Result.ok on adapter success', async () => {
    const adapter = mockAdapter({ onCall: () => textResponse('hello') });
    const res = await call({ adapter, model: 'm', messages: msg });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.message.content).toBe('hello');
      expect(res.value.usage).toEqual({ input: 10, output: 5 });
      expect(res.value.stopReason).toBe('end');
      expect(res.value.value).toBeUndefined();
    }
  });

  it('returns Result.error(AdapterError) when adapter throws', async () => {
    const adapter = mockAdapter({
      onCall: () => {
        throw new Error('http 500');
      },
    });
    const res = await call({ adapter, model: 'm', messages: msg });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(AdapterError);
      if (res.error instanceof AdapterError) {
        expect(res.error.code).toBe('adapter.call_failed');
        expect(res.error.cause).toBeInstanceOf(Error);
      }
    }
  });

  it('validates JSON content against schema when stopReason is end', async () => {
    type Shape = { n: number };
    const schema = jsonSchema<Shape>(
      (v): v is Shape =>
        typeof v === 'object' &&
        v !== null &&
        'n' in v &&
        typeof (v as { n: unknown }).n === 'number',
    );
    const adapter = mockAdapter({ onCall: () => textResponse('{"n":7}') });
    const res = await call({ adapter, model: 'm', messages: msg, schema });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.value).toEqual({ n: 7 });
    }
  });

  it('returns ValidationError when JSON content fails schema', async () => {
    const schema = jsonSchema<{ n: number }>(
      (v): v is { n: number } => typeof v === 'object' && v !== null && 'n' in v,
    );
    const adapter = mockAdapter({ onCall: () => textResponse('{"wrong":true}') });
    const res = await call({ adapter, model: 'm', messages: msg, schema });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ValidationError);
    }
  });

  it('returns ParseError when content is not JSON', async () => {
    const schema = jsonSchema<{ n: number }>((v): v is { n: number } => true);
    const adapter = mockAdapter({ onCall: () => textResponse('not json') });
    const res = await call({ adapter, model: 'm', messages: msg, schema });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ParseError);
      if (res.error instanceof ParseError) {
        expect(res.error.code).toBe('parse.response_json');
      }
    }
  });

  it('skips schema validation when stopReason is tool_call', async () => {
    const schema = jsonSchema<unknown>((v): v is unknown => false); // would fail if called
    const adapter = mockAdapter({
      onCall: () => ({
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'x' } }],
        },
        usage: { input: 1, output: 1 },
        stopReason: 'tool_call',
      }),
    });
    const res = await call({ adapter, model: 'm', messages: msg, schema });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.value).toBeUndefined();
      expect(res.value.message.toolCalls).toHaveLength(1);
    }
  });

  it('runs compress pipeline before calling adapter', async () => {
    const adapter = mockAdapter({ onCall: () => textResponse('ok') });
    const compress = async () => [{ role: 'user', content: 'compressed' } as const];
    await call({ adapter, model: 'm', messages: msg, compress });
    expect(adapter.calls[0]?.messages).toEqual([{ role: 'user', content: 'compressed' }]);
  });

  it('forwards signal to adapter request', async () => {
    const adapter = mockAdapter({ onCall: () => textResponse('x') });
    const controller = new AbortController();
    await call({ adapter, model: 'm', messages: msg, signal: controller.signal });
    expect(adapter.calls[0]?.signal).toBe(controller.signal);
  });

  it('throws TypeError when adapter is missing', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional bad input for test
    await expect(call({ model: 'm', messages: msg } as any)).rejects.toThrow(TypeError);
  });

  it('returns Result.error(BudgetExhausted) when budget is exhausted post-consume', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'ok' },
        usage: { input: 50, output: 50 },
        stopReason: 'end',
      }),
    });
    // maxTokens 99, so the first consume (100 tokens) exhausts
    const b = budget({ maxTokens: 99 });
    const res = await call({ adapter, model: 'm', messages: msg, budget: b });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(BudgetExhausted);
      if (res.error instanceof BudgetExhausted) {
        expect(res.error.code).toBe('budget.tokens');
      }
    }
  });

  it('returns Result.error(BudgetExhausted) when budget is already exhausted before call', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'unused' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
    });
    const b = budget({ maxSteps: 1 });
    b.consume({}); // now at limit
    const res = await call({ adapter, model: 'm', messages: msg, budget: b });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(BudgetExhausted);
      if (res.error instanceof BudgetExhausted) {
        expect(res.error.code).toBe('budget.steps');
      }
    }
    // Adapter should NOT have been called because pre-check failed
    expect(adapter.calls).toHaveLength(0);
  });

  it('call<T> type requires schema output to match T', () => {
    // Compile-time test only; expectTypeOf is a no-op at runtime
    type MyShape = { n: number };
    const goodSchema = jsonSchema<MyShape>(
      (v): v is MyShape =>
        typeof v === 'object' &&
        v !== null &&
        'n' in v &&
        typeof (v as { n: unknown }).n === 'number',
    );
    // Valid: schema returns MyShape, call<MyShape> accepts it
    expectTypeOf(call<MyShape>)
      .parameter(0)
      .toMatchTypeOf<{ schema?: typeof goodSchema }>();
  });
});
