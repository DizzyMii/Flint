import { call } from 'flint';
import type { StreamChunk } from 'flint';
import { budget } from 'flint/budget';
import { AdapterError } from 'flint/errors';
import { describe, expect, it } from 'vitest';
import { openaiCompatAdapter } from '../src/index.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Captured = { body: Record<string, unknown> };

function jsonFetch(
  body: unknown,
  captured?: Captured,
  status = 200,
  headers: Record<string, string> = {},
): typeof globalThis.fetch {
  return async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (captured) captured.body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  };
}

function sseFetch(payloads: unknown[], captured?: Captured): typeof globalThis.fetch {
  const text = payloads
    .map((d) => (d === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(d)}\n\n`))
    .join('');
  return async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    if (captured) captured.body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

function completion(message: Record<string, unknown>, finishReason = 'stop', usage?: unknown) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      { index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason },
    ],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-stream',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const BASE = 'https://api.example.com/v1';
const msgs = [{ role: 'user' as const, content: 'Hi' }];

// ---------------------------------------------------------------------------
// Usage normalization
// ---------------------------------------------------------------------------

describe('usage normalization', () => {
  it('call(): input excludes cached tokens, cached is reported separately', async () => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 20,
      total_tokens: 1020,
      prompt_tokens_details: { cached_tokens: 800 },
    };
    const res = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: 'ok' }, 'stop', usage)),
    }).call({ model: 'gpt-4o', messages: msgs });
    expect(res.usage).toEqual({ input: 200, output: 20, cached: 800 });
  });

  it('call(): omits cached when there were no cache hits', async () => {
    const res = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: 'ok' })),
    }).call({ model: 'gpt-4o', messages: msgs });
    expect(res.usage).toEqual({ input: 10, output: 5 });
  });

  it('call(): reads DeepSeek prompt_cache_hit_tokens', async () => {
    const usage = {
      prompt_tokens: 500,
      completion_tokens: 1,
      total_tokens: 501,
      prompt_cache_hit_tokens: 300,
    };
    const res = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: 'ok' }, 'stop', usage)),
    }).call({ model: 'deepseek-chat', messages: msgs });
    expect(res.usage).toEqual({ input: 200, output: 1, cached: 300 });
  });

  it('stream(): requests include_usage and normalizes the usage chunk', async () => {
    const captured: Captured = { body: {} };
    const chunks = await collect(
      openaiCompatAdapter({
        baseUrl: BASE,
        fetch: sseFetch(
          [
            chunk({ content: 'Hi' }, 'stop'),
            {
              ...chunk({}),
              choices: [],
              usage: {
                prompt_tokens: 64,
                completion_tokens: 3,
                total_tokens: 67,
                prompt_tokens_details: { cached_tokens: 48 },
              },
            },
            '[DONE]',
          ],
          captured,
        ),
      }).stream({ model: 'gpt-4o', messages: msgs }),
    );
    expect(captured.body.stream_options).toEqual({ include_usage: true });
    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage).toEqual({ type: 'usage', usage: { input: 16, output: 3, cached: 48 } });
  });
});

// ---------------------------------------------------------------------------
// Malformed tool arguments
// ---------------------------------------------------------------------------

describe('tool-call parseError', () => {
  it('call(): sets parseError and empty arguments on invalid JSON', async () => {
    const res = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(
        completion(
          {
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a": 1,' } },
            ],
          },
          'tool_calls',
        ),
      ),
    }).call({ model: 'gpt-4o', messages: msgs });
    const tc = res.message.toolCalls?.[0];
    expect(tc?.arguments).toEqual({});
    expect(typeof tc?.parseError).toBe('string');
    expect(tc?.parseError?.length).toBeGreaterThan(0);
  });

  it('call(): empty-string arguments are {} without parseError', async () => {
    const res = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(
        completion(
          {
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '' } }],
          },
          'tool_calls',
        ),
      ),
    }).call({ model: 'gpt-4o', messages: msgs });
    expect(res.message.toolCalls?.[0]).toEqual({ id: 'c1', name: 'f', arguments: {} });
  });

  it('stream(): sets parseError on invalid assembled JSON', async () => {
    const chunks = await collect(
      openaiCompatAdapter({
        baseUrl: BASE,
        fetch: sseFetch([
          chunk({
            tool_calls: [
              { index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x"' } },
            ],
          }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: ':' } }] }, 'tool_calls'),
          '[DONE]',
        ]),
      }).stream({ model: 'gpt-4o', messages: msgs }),
    );
    const tc = chunks.find((c) => c.type === 'tool_call');
    expect(tc?.type === 'tool_call' && tc.call.arguments).toEqual({});
    expect(tc?.type === 'tool_call' && typeof tc.call.parseError).toBe('string');
  });

  it('stream(): valid JSON carries no parseError', async () => {
    const chunks = await collect(
      openaiCompatAdapter({
        baseUrl: BASE,
        fetch: sseFetch([
          chunk(
            {
              tool_calls: [
                { index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
              ],
            },
            'tool_calls',
          ),
          '[DONE]',
        ]),
      }).stream({ model: 'gpt-4o', messages: msgs }),
    );
    const tc = chunks.find((c) => c.type === 'tool_call');
    expect(tc).toEqual({ type: 'tool_call', call: { id: 'c1', name: 'f', arguments: {} } });
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('refusal mapping', () => {
  it('call(): finish_reason content_filter -> refusal', async () => {
    const res = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: '' }, 'content_filter')),
    }).call({ model: 'gpt-4o', messages: msgs });
    expect(res.stopReason).toBe('refusal');
  });

  it('call(): message.refusal becomes content with stopReason refusal', async () => {
    const res = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: null, refusal: "I can't help with that." })),
    }).call({ model: 'gpt-4o', messages: msgs });
    expect(res.message.content).toBe("I can't help with that.");
    expect(res.stopReason).toBe('refusal');
  });

  it('call(): null refusal field does not change a normal answer', async () => {
    const res = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: 'Sure', refusal: null })),
    }).call({ model: 'gpt-4o', messages: msgs });
    expect(res.message.content).toBe('Sure');
    expect(res.stopReason).toBe('end');
  });

  it('stream(): refusal deltas become text and end reason refusal', async () => {
    const chunks = await collect(
      openaiCompatAdapter({
        baseUrl: BASE,
        fetch: sseFetch([chunk({ refusal: 'No.' }), chunk({}, 'stop'), '[DONE]']),
      }).stream({ model: 'gpt-4o', messages: msgs }),
    );
    expect(chunks).toContainEqual({ type: 'text', delta: 'No.' });
    expect(chunks.at(-1)).toEqual({ type: 'end', reason: 'refusal' });
  });

  it('stream(): finish_reason content_filter -> refusal', async () => {
    const chunks = await collect(
      openaiCompatAdapter({
        baseUrl: BASE,
        fetch: sseFetch([chunk({ content: 'x' }, 'content_filter'), '[DONE]']),
      }).stream({ model: 'gpt-4o', messages: msgs }),
    );
    expect(chunks.at(-1)).toEqual({ type: 'end', reason: 'refusal' });
  });
});

// ---------------------------------------------------------------------------
// Request body: structured output, extra, extraBody
// ---------------------------------------------------------------------------

describe('request body', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'number' } },
    required: ['a'],
    additionalProperties: false,
  };

  it('sends response_format json_schema when jsonSchema is set', async () => {
    const captured: Captured = { body: {} };
    await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: '{"a":1}' }), captured),
    }).call({ model: 'gpt-4o', messages: msgs, jsonSchema: schema });
    expect(captured.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema, strict: true },
    });
  });

  it('omits response_format without jsonSchema', async () => {
    const captured: Captured = { body: {} };
    await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: 'x' }), captured),
    }).call({ model: 'gpt-4o', messages: msgs });
    expect(captured.body).not.toHaveProperty('response_format');
    expect(captured.body).not.toHaveProperty('stream_options');
  });

  it('merges extraBody then per-request extra last', async () => {
    const captured: Captured = { body: {} };
    await openaiCompatAdapter({
      baseUrl: BASE,
      extraBody: { reasoning_effort: 'low', seed: 1, user: 'svc' },
      fetch: jsonFetch(completion({ content: 'x' }), captured),
    }).call({
      model: 'o3-mini',
      messages: msgs,
      temperature: 0.2,
      extra: { reasoning_effort: 'high', temperature: 0 },
    });
    expect(captured.body).toMatchObject({
      model: 'o3-mini',
      reasoning_effort: 'high',
      seed: 1,
      user: 'svc',
      temperature: 0,
    });
  });

  it('extraBody also applies to stream()', async () => {
    const captured: Captured = { body: {} };
    await collect(
      openaiCompatAdapter({
        baseUrl: BASE,
        extraBody: { seed: 7 },
        fetch: sseFetch([chunk({ content: 'x' }, 'stop'), '[DONE]'], captured),
      }).stream({ model: 'gpt-4o', messages: msgs, extra: { top_p: 0.5 } }),
    );
    expect(captured.body).toMatchObject({ seed: 7, top_p: 0.5, stream: true });
  });

  it('isError tool messages keep their content verbatim', async () => {
    const captured: Captured = { body: {} };
    await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: 'x' }), captured),
    }).call({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'f', arguments: {} }] },
        { role: 'tool', content: 'Error: boom', toolCallId: 'c1', isError: true },
      ],
    });
    const sent = captured.body.messages as Array<Record<string, unknown>>;
    expect(sent[2]).toEqual({ role: 'tool', content: 'Error: boom', tool_call_id: 'c1' });
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  it('429 with retry-after -> rate_limit, retryable, retryAfterMs', async () => {
    const err = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch({ error: { message: 'Rate limit reached' } }, undefined, 429, {
        'retry-after': '3',
      }),
    })
      .call({ model: 'gpt-4o', messages: msgs })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err).toMatchObject({
      code: 'adapter.http.429',
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: 3000,
      status: 429,
      message: 'Rate limit reached',
    });
  });

  it('400 maximum context length -> context_overflow, not retryable', async () => {
    const err = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(
        {
          error: {
            message: "This model's maximum context length is 128000 tokens.",
            code: 'context_length_exceeded',
          },
        },
        undefined,
        400,
      ),
    })
      .call({ model: 'gpt-4o', messages: msgs })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'context_overflow', retryable: false, status: 400 });
  });

  it('non-JSON error body is used as the message', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response('upstream overloaded', { status: 503 });
    const err = await openaiCompatAdapter({ baseUrl: BASE, fetch })
      .call({ model: 'gpt-4o', messages: msgs })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      kind: 'overloaded',
      retryable: true,
      message: 'upstream overloaded',
    });
  });

  it('stream(): HTTP errors are classified too', async () => {
    const fetch = jsonFetch({ error: { message: 'down' } }, undefined, 500);
    const err = await collect(
      openaiCompatAdapter({ baseUrl: BASE, fetch }).stream({ model: 'gpt-4o', messages: msgs }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'server', retryable: true });
  });

  it('network failure -> kind network, retryable', async () => {
    const err = await openaiCompatAdapter({
      baseUrl: BASE,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    })
      .call({ model: 'gpt-4o', messages: msgs })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'adapter.network', kind: 'network', retryable: true });
  });

  it('adapter does not retry by itself (one fetch per call)', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429 });
    };
    await openaiCompatAdapter({ baseUrl: BASE, fetch })
      .call({ model: 'gpt-4o', messages: msgs })
      .catch(() => undefined);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('pricing', () => {
  it('has no pricing() without the option (no built-in table)', () => {
    expect(openaiCompatAdapter({ baseUrl: BASE }).pricing).toBeUndefined();
  });

  it('looks up a PriceTable by exact and prefix match', () => {
    const a = openaiCompatAdapter({
      baseUrl: BASE,
      pricing: { 'llama-3.3-70b': { input: 0.59, output: 0.79 } },
    });
    expect(a.pricing?.('llama-3.3-70b')).toEqual({ input: 0.59, output: 0.79 });
    expect(a.pricing?.('llama-3.3-70b-versatile')).toEqual({ input: 0.59, output: 0.79 });
    expect(a.pricing?.('mixtral-8x7b')).toBeUndefined();
  });

  it('accepts a pricing function', () => {
    const a = openaiCompatAdapter({
      baseUrl: BASE,
      pricing: (m) => (m === 'x' ? { input: 1, output: 2 } : undefined),
    });
    expect(a.pricing?.('x')).toEqual({ input: 1, output: 2 });
    expect(a.pricing?.('y')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// End to end through flint's call()
// ---------------------------------------------------------------------------

describe('end to end with call()', () => {
  const usage = {
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
    total_tokens: 2_000_000,
    prompt_tokens_details: { cached_tokens: 500_000 },
  };

  it('computes cost from adapter pricing under a maxDollars budget', async () => {
    const adapter = openaiCompatAdapter({
      baseUrl: BASE,
      pricing: { 'gpt-4o': { input: 2, output: 8, cacheRead: 1 } },
      fetch: jsonFetch(completion({ content: 'ok' }, 'stop', usage)),
    });
    const b = budget({ maxDollars: 100 });
    const res = await call({ adapter, model: 'gpt-4o', messages: msgs, budget: b });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 0.5M uncached * $2 + 0.5M cached * $1 + 1M output * $8
    expect(res.value.cost).toBeCloseTo(9.5, 6);
    expect(res.value.usage).toEqual({ input: 500_000, output: 1_000_000, cached: 500_000 });
    expect(b.spent?.().dollars).toBeCloseTo(9.5, 6);
  });

  it('fails closed with budget.unpriced when maxDollars is set without pricing', async () => {
    const adapter = openaiCompatAdapter({
      baseUrl: BASE,
      fetch: jsonFetch(completion({ content: 'ok' })),
    });
    const res = await call({
      adapter,
      model: 'gpt-4o',
      messages: msgs,
      budget: budget({ maxDollars: 1 }),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as { code?: string }).code).toBe('budget.unpriced');
  });

  it('core call() retries a 429 using the adapter-provided retry-after', async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'retry-after-ms': '1' },
        });
      }
      return new Response(JSON.stringify(completion({ content: 'done' })), { status: 200 });
    };
    const res = await call({
      adapter: openaiCompatAdapter({ baseUrl: BASE, fetch }),
      model: 'gpt-4o',
      messages: msgs,
    });
    expect(calls).toBe(2);
    expect(res.ok && res.value.message.content).toBe('done');
  });
});
