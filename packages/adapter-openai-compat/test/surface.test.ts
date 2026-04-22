import type { StreamChunk } from 'flint';
import { AdapterError } from 'flint/errors';
import { describe, expect, it } from 'vitest';
import { openaiCompatAdapter } from '../src/index.ts';

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function mockFetch(response: { status: number; body: unknown } | string): typeof globalThis.fetch {
  return async (_url: URL | RequestInfo, _init?: RequestInit): Promise<Response> => {
    if (typeof response === 'string') {
      return new Response(response, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function mockResponse(
  overrides: Partial<{ finish_reason: string; content: string | null; tool_calls: unknown[]; usage: object }> = {},
) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: overrides.content !== undefined ? overrides.content : 'Hello',
        ...(overrides.tool_calls ? { tool_calls: overrides.tool_calls } : {}),
      },
      finish_reason: overrides.finish_reason ?? 'stop',
    }],
    usage: overrides.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe('openaiCompatAdapter -- shape', () => {
  it('name is "openai-compat"', () => {
    expect(openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1' }).name).toBe('openai-compat');
  });
  it('capabilities: promptCache=false, structuredOutput=true, parallelTools=true', () => {
    const a = openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1' });
    expect(a.capabilities.promptCache).toBe(false);
    expect(a.capabilities.structuredOutput).toBe(true);
    expect(a.capabilities.parallelTools).toBe(true);
  });
  it('count is undefined (flint falls back to approxCount)', () => {
    expect(openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1' }).count).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// call() -- HTTP basics
// ---------------------------------------------------------------------------

describe('openaiCompatAdapter -- call() HTTP', () => {
  it('POSTs to <baseUrl>/chat/completions', async () => {
    let capturedUrl = '';
    const fetch = async (url: URL | RequestInfo, _: RequestInit | undefined): Promise<Response> => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify(mockResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch })
      .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('strips trailing slash from baseUrl', async () => {
    let capturedUrl = '';
    const fetch = async (url: URL | RequestInfo, _: RequestInit | undefined): Promise<Response> => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify(mockResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1/', fetch })
      .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
    expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('sends Authorization: Bearer when apiKey provided', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch = async (_: URL | RequestInfo, init: RequestInit | undefined): Promise<Response> => {
      const h = new Headers(init?.headers);
      capturedHeaders = {}; h.forEach((v, k) => { capturedHeaders[k] = v; });
      return new Response(JSON.stringify(mockResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', fetch })
      .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
    expect(capturedHeaders['authorization']).toBe('Bearer sk-test');
  });

  it('omits Authorization when no apiKey', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch = async (_: URL | RequestInfo, init: RequestInit | undefined): Promise<Response> => {
      const h = new Headers(init?.headers);
      capturedHeaders = {}; h.forEach((v, k) => { capturedHeaders[k] = v; });
      return new Response(JSON.stringify(mockResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await openaiCompatAdapter({ baseUrl: 'http://localhost:11434/v1', fetch })
      .call({ model: 'llama3.2', messages: [{ role: 'user', content: 'Hi' }] });
    expect(capturedHeaders['authorization']).toBeUndefined();
  });

  it('merges defaultHeaders into every request', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch = async (_: URL | RequestInfo, init: RequestInit | undefined): Promise<Response> => {
      const h = new Headers(init?.headers);
      capturedHeaders = {}; h.forEach((v, k) => { capturedHeaders[k] = v; });
      return new Response(JSON.stringify(mockResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await openaiCompatAdapter({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_test', defaultHeaders: { 'x-custom': 'hello' }, fetch })
      .call({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'Hi' }] });
    expect(capturedHeaders['x-custom']).toBe('hello');
    expect(capturedHeaders['authorization']).toBe('Bearer gsk_test');
  });
});

// ---------------------------------------------------------------------------
// call() -- Message normalization
// ---------------------------------------------------------------------------

describe('openaiCompatAdapter -- call() message normalization', () => {
  function capturingFetch() {
    let capturedBody: Record<string, unknown> = {};
    const fetch = async (_: URL | RequestInfo, init: RequestInit | undefined): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockResponse()), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetch, getBody: () => capturedBody };
  }

  it('passes system message as role:system in messages array', async () => {
    const { fetch, getBody } = capturingFetch();
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch }).call({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Hello' }],
    });
    const messages = getBody().messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('serializes assistant toolCalls as tool_calls with JSON-stringified arguments', async () => {
    const { fetch, getBody } = capturingFetch();
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch }).call({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Do something' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'my_tool', arguments: { x: 1 } }] },
        { role: 'tool', content: 'done', toolCallId: 'call_1' },
      ],
    });
    const messages = getBody().messages as Array<Record<string, unknown>>;
    const toolCalls = (messages[1] as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.id).toBe('call_1');
    expect(toolCalls[0]?.type).toBe('function');
    expect(JSON.parse(((toolCalls[0]?.function) as Record<string, unknown>).arguments as string)).toEqual({ x: 1 });
  });

  it('serializes tool result message as role:tool with tool_call_id', async () => {
    const { fetch, getBody } = capturingFetch();
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch }).call({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 't', arguments: {} }] },
        { role: 'tool', content: 'result', toolCallId: 'call_1' },
      ],
    });
    const messages = getBody().messages as Array<Record<string, unknown>>;
    expect(messages[2]).toMatchObject({ role: 'tool', content: 'result', tool_call_id: 'call_1' });
  });

  it('serializes multipart user message: text + image URL', async () => {
    const { fetch, getBody } = capturingFetch();
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch }).call({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this' }, { type: 'image', url: 'https://example.com/img.png' }] }],
    });
    const parts = ((getBody().messages as Array<Record<string, unknown>>)[0]?.content) as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: 'Describe this' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/img.png' } });
  });

  it('serializes base64 image as data URI in image_url', async () => {
    const { fetch, getBody } = capturingFetch();
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch }).call({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'image_b64', data: 'abc123', mediaType: 'image/png' }] }],
    });
    const parts = ((getBody().messages as Array<Record<string, unknown>>)[0]?.content) as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } });
  });

  it('passes tool.jsonSchema as parameters in function definition', async () => {
    const { fetch, getBody } = capturingFetch();
    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    const mockTool = {
      name: 'get_weather', description: 'Gets weather',
      input: { '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v }) } } as never,
      handler: async () => 'sunny', jsonSchema: schema,
    };
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch }).call({
      model: 'gpt-4o', messages: [{ role: 'user', content: 'Weather?' }], tools: [mockTool],
    });
    const fn = ((getBody().tools as Array<Record<string, unknown>>)[0]?.function) as Record<string, unknown>;
    expect(fn.name).toBe('get_weather');
    expect(fn.parameters).toEqual(schema);
  });

  it('falls back to { type: "object" } when tool has no jsonSchema', async () => {
    const { fetch, getBody } = capturingFetch();
    const mockTool = {
      name: 'noop', description: 'Does nothing',
      input: { '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v }) } } as never,
      handler: async () => 'ok',
    };
    await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch }).call({
      model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], tools: [mockTool],
    });
    const fn = ((getBody().tools as Array<Record<string, unknown>>)[0]?.function) as Record<string, unknown>;
    expect(fn.parameters).toEqual({ type: 'object' });
  });
});

// ---------------------------------------------------------------------------
// call() -- Response normalization
// ---------------------------------------------------------------------------

describe('openaiCompatAdapter -- call() response', () => {
  it('maps "stop" -> "end"', async () => {
    const res = await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch({ status: 200, body: mockResponse({ finish_reason: 'stop' }) }) })
      .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
    expect(res.stopReason).toBe('end');
  });

  it('maps "tool_calls" -> "tool_call"', async () => {
    const body = mockResponse({ finish_reason: 'tool_calls', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] });
    const res = await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch({ status: 200, body }) })
      .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
    expect(res.stopReason).toBe('tool_call');
  });

  it('maps "length" -> "max_tokens"', async () => {
    const res = await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch({ status: 200, body: mockResponse({ finish_reason: 'length' }) }) })
      .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
    expect(res.stopReason).toBe('max_tokens');
  });

  it('parses usage: prompt_tokens->input, completion_tokens->output', async () => {
    const res = await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch({ status: 200, body: mockResponse({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) }) })
      .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] });
    expect(res.usage.input).toBe(100);
    expect(res.usage.output).toBe(50);
    expect(res.usage.cached).toBeUndefined();
  });

  it('normalizes tool_calls into ToolCall[] with parsed arguments', async () => {
    const body = mockResponse({ finish_reason: 'tool_calls', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'add', arguments: '{"a":1,"b":2}' } }] });
    const res = await openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch({ status: 200, body }) })
      .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Add' }] });
    expect(res.message.toolCalls?.[0]).toMatchObject({ id: 'call_1', name: 'add', arguments: { a: 1, b: 2 } });
  });

  it('throws AdapterError adapter.http.401 on 401', async () => {
    await expect(
      openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'bad', fetch: mockFetch({ status: 401, body: { error: { message: 'Invalid API key', type: 'invalid_request_error' } } }) })
        .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({ name: 'AdapterError', code: 'adapter.http.401', message: 'Invalid API key' });
  });

  it('throws AdapterError adapter.http.429 on rate limit', async () => {
    await expect(
      openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch({ status: 429, body: { error: { message: 'Rate limit', type: 'rate_limit_error' } } }) })
        .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({ name: 'AdapterError', code: 'adapter.http.429' });
  });

  it('throws AdapterError adapter.network on fetch failure', async () => {
    await expect(
      openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: async () => { throw new TypeError('fetch failed'); } })
        .call({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({ name: 'AdapterError', code: 'adapter.network' });
  });
});

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

function sseLines(...payloads: unknown[]): string {
  return payloads.map((d) => (d === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(d)}\n\n`)).join('');
}

function streamChunk(delta: { content?: string; tool_calls?: unknown[] }, finishReason: string | null = null): unknown {
  return { id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1700000000, model: 'gpt-4o', choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

describe('openaiCompatAdapter -- stream()', () => {
  it('parses content deltas into text chunks', async () => {
    const sse = sseLines(streamChunk({ content: 'Hello' }), streamChunk({ content: ' world' }), streamChunk({}, 'stop'), '[DONE]');
    const a = openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch(sse) });
    const chunks: StreamChunk[] = [];
    for await (const c of a.stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })) chunks.push(c);
    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toHaveLength(2);
    expect((textChunks[0] as { type: 'text'; delta: string }).delta).toBe('Hello');
    expect((textChunks[1] as { type: 'text'; delta: string }).delta).toBe(' world');
  });

  it('always emits usage and end chunks', async () => {
    const sse = sseLines(streamChunk({ content: 'Hi' }), streamChunk({}, 'stop'), '[DONE]');
    const chunks: StreamChunk[] = [];
    for await (const c of openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch(sse) }).stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })) chunks.push(c);
    expect(chunks.some((c) => c.type === 'usage')).toBe(true);
    expect(chunks.some((c) => c.type === 'end')).toBe(true);
  });

  it('accumulates token usage from the usage chunk in the stream', async () => {
    const usageChunk = {
      id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1700000000, model: 'gpt-4o',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
    };
    const sse = sseLines(streamChunk({ content: 'Hi' }), usageChunk, '[DONE]');
    const chunks: StreamChunk[] = [];
    for await (const c of openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch(sse) }).stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })) chunks.push(c);
    const usageEvent = chunks.find((c) => c.type === 'usage') as { type: 'usage'; usage: { input: number; output: number } } | undefined;
    expect(usageEvent?.usage.input).toBe(42);
    expect(usageEvent?.usage.output).toBe(17);
  });

  it('maps "stop" in stream -> end reason "end"', async () => {
    const chunks: StreamChunk[] = [];
    for await (const c of openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch(sseLines(streamChunk({}, 'stop'), '[DONE]')) }).stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })) chunks.push(c);
    expect((chunks.find((c) => c.type === 'end') as { type: 'end'; reason: string } | undefined)?.reason).toBe('end');
  });

  it('maps "tool_calls" in stream -> end reason "tool_call"', async () => {
    const sse = sseLines(
      streamChunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }] }),
      streamChunk({}, 'tool_calls'), '[DONE]',
    );
    const chunks: StreamChunk[] = [];
    for await (const c of openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch(sse) }).stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })) chunks.push(c);
    expect((chunks.find((c) => c.type === 'end') as { type: 'end'; reason: string } | undefined)?.reason).toBe('tool_call');
  });

  it('assembles streamed tool call argument deltas into a single tool_call chunk', async () => {
    const sse = sseLines(
      streamChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
      streamChunk({ tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }),
      streamChunk({ tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }] }),
      streamChunk({}, 'tool_calls'), '[DONE]',
    );
    const chunks: StreamChunk[] = [];
    for await (const c of openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch(sse) }).stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Weather?' }] })) chunks.push(c);
    const tc = chunks.filter((c) => c.type === 'tool_call')[0] as { type: 'tool_call'; call: { id: string; name: string; arguments: unknown } };
    expect(tc.call).toMatchObject({ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } });
  });

  it('throws AdapterError on HTTP 401 before streaming begins', async () => {
    await expect(async () => {
      for await (const _ of openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'bad', fetch: mockFetch({ status: 401, body: { error: { message: 'Invalid API key', type: 'invalid_request_error' } } }) }).stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })) {
        // unreachable
      }
    }).rejects.toMatchObject({ name: 'AdapterError', code: 'adapter.http.401' });
  });

  it('throws AdapterError adapter.stream on mid-stream error event', async () => {
    const errorSse = 'event: error\ndata: {"error":{"message":"stream interrupted"}}\n\n';
    await expect(async () => {
      for await (const _ of openaiCompatAdapter({ baseUrl: 'https://api.openai.com/v1', fetch: mockFetch(errorSse) }).stream({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }] })) {
        // unreachable
      }
    }).rejects.toMatchObject({ name: 'AdapterError', code: 'adapter.stream', message: 'stream interrupted' });
  });
});
