import { agent, call, tool } from 'flint';
import type { Message, StreamChunk } from 'flint';
import { budget } from 'flint/budget';
import type { AdapterError } from 'flint/errors';
import { describe, expect, it } from 'vitest';
import { anthropicAdapter, anthropicPricing } from '../src/index.ts';

type Captured = { body: Record<string, unknown> };

function jsonFetch(
  responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>,
  captured: Captured[] = [],
): typeof globalThis.fetch {
  let i = 0;
  return (async (_url: unknown, init?: RequestInit) => {
    captured.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const r = responses[Math.min(i++, responses.length - 1)] as (typeof responses)[number];
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  }) as typeof globalThis.fetch;
}

function msg(
  content: unknown[],
  usage: Record<string, number> = { input_tokens: 10, output_tokens: 5 },
  stop_reason = 'end_turn',
) {
  return { id: 'm', type: 'message', role: 'assistant', model: 'x', content, stop_reason, usage };
}

function sse(events: Array<[string, unknown]>): typeof globalThis.fetch {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return (async () =>
    new Response(text, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
}

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const user = (content: string): Message => ({ role: 'user', content });

describe('pricing and usage', () => {
  it('prices a response and reports cache writes', async () => {
    const a = anthropicAdapter({
      apiKey: 'k',
      fetch: jsonFetch([
        {
          body: msg([{ type: 'text', text: 'hi' }], {
            input_tokens: 1000,
            output_tokens: 1000,
            cache_read_input_tokens: 10_000,
            cache_creation_input_tokens: 2000,
          }),
        },
      ]),
    });
    const res = await a.call({ model: 'claude-opus-5-5', messages: [user('x')] });
    expect(res.usage).toEqual({ input: 1000, output: 1000, cached: 10_000, cacheWrite: 2000 });
    // 1000*4 + 10000*0.2 + 2000*5 + 1000*20 = 36000 micro-dollars-per-MTok
    expect(res.cost).toBeCloseTo(0.036, 6);
  });

  it('resolves dated and platform-prefixed model ids by longest key', () => {
    const a = anthropicAdapter({ apiKey: 'k' });
    expect(a.pricing?.('anthropic.claude-opus-5-5')).toBe(anthropicPricing['claude-opus-5-5']);
    expect(a.pricing?.('claude-opus-5-20260101')).toBe(anthropicPricing['claude-opus-5']);
    expect(a.pricing?.('unknown-model')).toBeUndefined();
  });

  it('applies long-context rates above the threshold', async () => {
    const a = anthropicAdapter({
      apiKey: 'k',
      fetch: jsonFetch([
        { body: msg([{ type: 'text', text: 'x' }], { input_tokens: 200_000, output_tokens: 0 }) },
      ]),
    });
    const res = await a.call({ model: 'claude-haiku-5-5', messages: [user('x')] });
    expect(res.cost).toBeCloseTo(0.1, 6);
  });

  it('custom pricing overrides the table', () => {
    const a = anthropicAdapter({
      apiKey: 'k',
      pricing: { 'claude-opus-5-5': { input: 1, output: 1 } },
    });
    expect(a.pricing?.('claude-opus-5-5')).toEqual({ input: 1, output: 1 });
  });
});

describe('maxDollars end to end', () => {
  it('stops an agent before it overspends instead of after', async () => {
    const captured: Captured[] = [];
    // Honors max_tokens and bills input by prompt size, like the real API.
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      captured.push({ body });
      const input = Math.ceil(JSON.stringify(body.messages).length / 3.5) + 50;
      const output = Math.min(400, body.max_tokens as number);
      return new Response(
        JSON.stringify(
          msg(
            [{ type: 'tool_use', id: `t${captured.length}`, name: 'noop', input: {} }],
            { input_tokens: input, output_tokens: output },
            'tool_use',
          ),
        ),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const a = anthropicAdapter({ apiKey: 'k', fetch: fetchFn });
    const noop = tool({
      name: 'noop',
      description: 'noop',
      input: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } },
      handler: () => 'ok',
    });
    const b = budget({ maxDollars: 0.05 });
    const out = await agent({
      adapter: a,
      model: 'claude-opus-5-5',
      messages: [user('loop forever')],
      tools: [noop],
      budget: b,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect((out.error as AdapterError).code).toBe('budget.dollars');
    const spent = b.spent?.().dollars ?? 0;
    // Bounded by the prompt-size estimate error, never by a whole runaway response.
    expect(spent).toBeLessThanOrEqual(0.0505);
    expect(spent).toBeGreaterThan(0);
    // Later calls were clamped to what the remaining dollars could buy.
    const last = captured[captured.length - 1]?.body.max_tokens as number;
    expect(last).toBeLessThan(16000);
  });
});

describe('cache layout', () => {
  it('places breakpoints on tools, system, previous user turn and the final message', async () => {
    const captured: Captured[] = [];
    const a = anthropicAdapter({ apiKey: 'k', fetch: jsonFetch([{ body: msg([]) }], captured) });
    await a.call({
      model: 'claude-opus-5-5',
      tools: [
        {
          name: 't',
          description: 'd',
          input: {
            '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) },
          },
          handler: () => null,
        },
      ],
      messages: [
        { role: 'system', content: 'sys' },
        user('task'),
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't', arguments: {} }] },
        { role: 'tool', content: 'r1', toolCallId: 'a' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 't', arguments: {} }] },
        { role: 'tool', content: 'r2', toolCallId: 'b' },
      ],
    });
    const body = captured[0]?.body as {
      tools: Array<{ cache_control?: unknown }>;
      system: Array<{ cache_control?: unknown }>;
      messages: Array<{ content: Array<{ cache_control?: unknown }> }>;
    };
    expect(body.tools[0]?.cache_control).toBeDefined();
    expect(body.system[0]?.cache_control).toBeDefined();
    const marked = body.messages.map((m) =>
      Array.isArray(m.content) && m.content.some((b) => b.cache_control) ? 1 : 0,
    );
    expect(marked).toEqual([0, 0, 1, 0, 1]);
    const count = JSON.stringify(body).split('cache_control').length - 1;
    expect(count).toBeLessThanOrEqual(4);
  });
});

describe('protocol fidelity', () => {
  it('round-trips thinking blocks verbatim and keeps their order', async () => {
    const blocks = [
      { type: 'thinking', thinking: 'plan', signature: 'sig1' },
      { type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } },
      { type: 'redacted_thinking', data: 'opaque' },
    ];
    const captured: Captured[] = [];
    const a = anthropicAdapter({
      apiKey: 'k',
      fetch: jsonFetch([{ body: msg(blocks, undefined, 'tool_use') }, { body: msg([]) }], captured),
    });
    const first = await a.call({ model: 'claude-opus-5-5', messages: [user('go')] });
    expect(first.message.thinking).toHaveLength(2);
    await a.call({
      model: 'claude-opus-5-5',
      cache: 'off',
      messages: [user('go'), first.message, { role: 'tool', content: 'r', toolCallId: 't1' }],
    });
    const sent = (captured[1]?.body.messages as Array<{ content: unknown }>)[1]?.content;
    expect(sent).toEqual(blocks);
  });

  it('marks failed tool results with is_error', async () => {
    const captured: Captured[] = [];
    const a = anthropicAdapter({ apiKey: 'k', fetch: jsonFetch([{ body: msg([]) }], captured) });
    await a.call({
      model: 'm',
      cache: 'off',
      messages: [
        user('x'),
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 't', arguments: {} }] },
        { role: 'tool', content: 'Error: boom', toolCallId: 'a', isError: true },
      ],
    });
    const results = (captured[0]?.body.messages as Array<{ content: unknown[] }>)[2]?.content;
    expect(results?.[0]).toMatchObject({ type: 'tool_result', is_error: true });
  });

  it('maps refusal', async () => {
    const a = anthropicAdapter({
      apiKey: 'k',
      fetch: jsonFetch([{ body: msg([], undefined, 'refusal') }]),
    });
    expect((await a.call({ model: 'm', messages: [user('x')] })).stopReason).toBe('refusal');
  });

  it('sends structured output and extra body fields', async () => {
    const captured: Captured[] = [];
    const a = anthropicAdapter({
      apiKey: 'k',
      extraBody: { thinking: { type: 'adaptive' } },
      fetch: jsonFetch([{ body: msg([{ type: 'text', text: '{"a":1}' }]) }], captured),
    });
    await a.call({
      model: 'm',
      messages: [user('x')],
      jsonSchema: { type: 'object', additionalProperties: false },
      extra: { output_config: { effort: 'high' } },
    });
    expect(captured[0]?.body.thinking).toEqual({ type: 'adaptive' });
    expect(captured[0]?.body.output_config).toEqual({
      effort: 'high',
      format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false } },
    });
  });
});

describe('errors and retries', () => {
  it('classifies 429 with retry-after', async () => {
    const a = anthropicAdapter({
      apiKey: 'k',
      fetch: jsonFetch([
        { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '2' } },
      ]),
    });
    const err = (await a
      .call({ model: 'm', messages: [user('x')] })
      .catch((e) => e)) as AdapterError;
    expect(err.kind).toBe('rate_limit');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
  });

  it('classifies prompt-too-long as context_overflow', async () => {
    const a = anthropicAdapter({
      apiKey: 'k',
      fetch: jsonFetch([
        {
          status: 400,
          body: { error: { message: 'prompt is too long: 1200000 tokens > 1000000' } },
        },
      ]),
    });
    const err = (await a
      .call({ model: 'm', messages: [user('x')] })
      .catch((e) => e)) as AdapterError;
    expect(err.kind).toBe('context_overflow');
    expect(err.retryable).toBe(false);
  });

  it('call() retries an overloaded 529 and then succeeds', async () => {
    const a = anthropicAdapter({
      apiKey: 'k',
      fetch: jsonFetch([
        { status: 529, body: { error: { message: 'Overloaded' } } },
        { body: msg([{ type: 'text', text: 'ok' }]) },
      ]),
    });
    const retries: number[] = [];
    const res = await call({
      adapter: a,
      model: 'm',
      messages: [user('x')],
      retry: { baseDelayMs: 1 },
      onRetry: (r) => retries.push(r.attempt),
    });
    expect(res.ok).toBe(true);
    expect(retries).toEqual([1]);
  });
});

describe('streaming', () => {
  it('flags malformed tool arguments instead of running with {}', async () => {
    const a = anthropicAdapter({
      apiKey: 'k',
      fetch: sse([
        ['message_start', { message: { usage: { input_tokens: 1, output_tokens: 0 } } }],
        [
          'content_block_start',
          { index: 0, content_block: { type: 'tool_use', id: 't', name: 'rm' } },
        ],
        [
          'content_block_delta',
          { index: 0, delta: { type: 'input_json_delta', partial_json: '{"path": "/ho' } },
        ],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }],
        ['message_stop', {}],
      ]),
    });
    const chunks = await collect(a.stream({ model: 'm', messages: [user('x')] }));
    const tc = chunks.find((c) => c.type === 'tool_call');
    expect(tc?.type === 'tool_call' && tc.call.parseError).toBeTruthy();
    const m = chunks.find((c) => c.type === 'message');
    expect(m?.type === 'message' && m.message.toolCalls?.[0]?.parseError).toBeTruthy();
  });

  it('assembles thinking with its signature and reports cache usage', async () => {
    const a = anthropicAdapter({
      apiKey: 'k',
      fetch: sse([
        [
          'message_start',
          {
            message: {
              usage: {
                input_tokens: 5,
                output_tokens: 0,
                cache_read_input_tokens: 100,
                cache_creation_input_tokens: 50,
              },
            },
          },
        ],
        ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }],
        ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }],
        ['content_block_stop', { index: 0 }],
        ['content_block_start', { index: 1, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'answer' } }],
        ['content_block_stop', { index: 1 }],
        ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }],
        ['message_stop', {}],
      ]),
    });
    const chunks = await collect(a.stream({ model: 'claude-opus-5-5', messages: [user('x')] }));
    const m = chunks.find((c) => c.type === 'message');
    expect(m?.type === 'message' && m.message.providerContent?.blocks).toEqual([
      { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
      { type: 'text', text: 'answer' },
    ]);
    const u = chunks.find((c) => c.type === 'usage');
    expect(u?.type === 'usage' && u.usage).toEqual({
      input: 5,
      output: 9,
      cached: 100,
      cacheWrite: 50,
    });
    expect(u?.type === 'usage' && u.cost).toBeGreaterThan(0);
  });
});
