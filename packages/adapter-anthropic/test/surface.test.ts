import type { StreamChunk } from 'flint';
import { AdapterError } from 'flint/errors';
import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../src/index.ts';

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function mockFetch(response: { status: number; body: unknown } | string): typeof globalThis.fetch {
  return async (_url: URL | RequestInfo, _init?: RequestInit): Promise<Response> => {
    if (typeof response === 'string') {
      // SSE stream
      return new Response(response, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function mockResponse(
  overrides: Partial<{
    stop_reason: string;
    content: unknown[];
    usage: object;
  }> = {},
) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: overrides.content ?? [{ type: 'text', text: 'Hello' }],
    model: 'claude-3-5-haiku-20241022',
    stop_reason: overrides.stop_reason ?? 'end_turn',
    usage: overrides.usage ?? { input_tokens: 10, output_tokens: 5 },
  };
}

// ---------------------------------------------------------------------------
// Adapter shape tests
// ---------------------------------------------------------------------------

describe('anthropicAdapter — shape', () => {
  it('name is "anthropic"', () => {
    const a = anthropicAdapter({ apiKey: 'test' });
    expect(a.name).toBe('anthropic');
  });

  it('capabilities has promptCache, structuredOutput, parallelTools', () => {
    const a = anthropicAdapter({ apiKey: 'test' });
    expect(a.capabilities.promptCache).toBe(true);
    expect(a.capabilities.structuredOutput).toBe(true);
    expect(a.capabilities.parallelTools).toBe(true);
  });

  it('count is not defined (falls back to approxCount)', () => {
    const a = anthropicAdapter({ apiKey: 'test' });
    expect(a.count).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// call() — HTTP basics
// ---------------------------------------------------------------------------

describe('anthropicAdapter — call() HTTP', () => {
  it('POSTs to /v1/messages with correct URL', async () => {
    let capturedUrl = '';
    const fetch = async (url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const a = anthropicAdapter({ apiKey: 'sk-test', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
  });

  it('sends x-api-key and anthropic-version headers', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers as Record<string, string>) ?? {}),
      );
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const a = anthropicAdapter({ apiKey: 'sk-mykey', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedHeaders['x-api-key']).toBe('sk-mykey');
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(capturedHeaders['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });

  it('respects custom baseUrl', async () => {
    let capturedUrl = '';
    const fetch = async (url: URL | RequestInfo, _init?: RequestInit): Promise<Response> => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const a = anthropicAdapter({ apiKey: 'test', baseUrl: 'https://proxy.example.com', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedUrl).toBe('https://proxy.example.com/v1/messages');
  });
});

// ---------------------------------------------------------------------------
// call() — Message normalization
// ---------------------------------------------------------------------------

describe('anthropicAdapter — call() message normalization', () => {
  it('extracts system messages to top-level system field', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const a = anthropicAdapter({ apiKey: 'test', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    expect(capturedBody.system).toEqual([{ type: 'text', text: 'You are helpful.' }]);
    const messages = capturedBody.messages as unknown[];
    expect(messages).toHaveLength(1);
    expect((messages[0] as Record<string, unknown>).role).toBe('user');
  });

  it('cache: auto adds cache_control to last system block', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const a = anthropicAdapter({ apiKey: 'test', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      cache: 'auto',
      messages: [
        { role: 'system', content: 'First system.' },
        { role: 'system', content: 'Second system.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const system = capturedBody.system as Array<Record<string, unknown>>;
    expect(system).toHaveLength(2);
    expect(system[0]?.cache_control).toBeUndefined();
    expect(system[1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('cache: auto adds cache_control to last tool', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const mockTool = {
      name: 'get_weather',
      description: 'Gets weather',
      input: {
        '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v }) },
      } as never,
      handler: async () => 'sunny',
    };

    const a = anthropicAdapter({ apiKey: 'test', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      cache: 'auto',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [mockTool],
    });

    const tools = capturedBody.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('cache: off does NOT add cache_control', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const a = anthropicAdapter({ apiKey: 'test', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      cache: 'off',
      messages: [
        { role: 'system', content: 'System message.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const system = capturedBody.system as Array<Record<string, unknown>>;
    expect(system[0]?.cache_control).toBeUndefined();
  });

  it('coalesces consecutive tool messages into a user message', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const a = anthropicAdapter({ apiKey: 'test', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [
        { role: 'user', content: 'Use tools' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'foo', arguments: {} }],
        },
        { role: 'tool', content: 'result1', toolCallId: 'call_1' },
        { role: 'tool', content: 'result2', toolCallId: 'call_2' },
      ],
    });

    const messages = capturedBody.messages as Array<Record<string, unknown>>;
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.role).toBe('user');
    const content = lastMsg?.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe('tool_result');
    expect(content[0]?.tool_use_id).toBe('call_1');
    expect(content[1]?.tool_use_id).toBe('call_2');
  });

  it('serializes assistant message with toolCalls correctly', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const a = anthropicAdapter({ apiKey: 'test', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: 'Calling tool',
          toolCalls: [{ id: 'tc_1', name: 'my_tool', arguments: { x: 1 } }],
        },
        { role: 'tool', content: 'done', toolCallId: 'tc_1' },
      ],
    });

    const messages = capturedBody.messages as Array<Record<string, unknown>>;
    const assistantMsg = messages[1] as Record<string, unknown>;
    expect(assistantMsg.role).toBe('assistant');
    const content = assistantMsg.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe('Calling tool');
    expect(content[1]?.type).toBe('tool_use');
    expect(content[1]?.id).toBe('tc_1');
    expect(content[1]?.name).toBe('my_tool');
  });

  it('passes tool.jsonSchema as input_schema', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    const mockTool = {
      name: 'get_weather',
      description: 'Gets weather',
      input: {
        '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v }) },
      } as never,
      handler: async () => 'sunny',
      jsonSchema: schema,
    };

    const a = anthropicAdapter({ apiKey: 'test', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [mockTool],
    });

    const tools = capturedBody.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.input_schema).toEqual(schema);
  });

  it('falls back to { type: "object" } when tool has no jsonSchema', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetch = async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(mockResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const mockTool = {
      name: 'simple_tool',
      description: 'Simple tool',
      input: {
        '~standard': { version: 1, vendor: 'test', validate: (v: unknown) => ({ value: v }) },
      } as never,
      handler: async () => 'result',
    };

    const a = anthropicAdapter({ apiKey: 'test', fetch });
    await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Do it' }],
      tools: [mockTool],
    });

    const tools = capturedBody.tools as Array<Record<string, unknown>>;
    expect(tools[0]?.input_schema).toEqual({ type: 'object' });
  });
});

// ---------------------------------------------------------------------------
// call() — Response normalization
// ---------------------------------------------------------------------------

describe('anthropicAdapter — call() response', () => {
  it('maps stop_reason end_turn → "end"', async () => {
    const a = anthropicAdapter({
      apiKey: 'test',
      fetch: mockFetch({ status: 200, body: mockResponse({ stop_reason: 'end_turn' }) }),
    });
    const res = await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(res.stopReason).toBe('end');
  });

  it('maps stop_reason tool_use → "tool_call"', async () => {
    const a = anthropicAdapter({
      apiKey: 'test',
      fetch: mockFetch({
        status: 200,
        body: mockResponse({
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'tc1', name: 'foo', input: {} }],
        }),
      }),
    });
    const res = await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(res.stopReason).toBe('tool_call');
  });

  it('maps stop_reason max_tokens → "max_tokens"', async () => {
    const a = anthropicAdapter({
      apiKey: 'test',
      fetch: mockFetch({ status: 200, body: mockResponse({ stop_reason: 'max_tokens' }) }),
    });
    const res = await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(res.stopReason).toBe('max_tokens');
  });

  it('parses usage including cache_read_input_tokens', async () => {
    const a = anthropicAdapter({
      apiKey: 'test',
      fetch: mockFetch({
        status: 200,
        body: mockResponse({
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 },
        }),
      }),
    });
    const res = await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(res.usage.input).toBe(100);
    expect(res.usage.output).toBe(50);
    expect(res.usage.cached).toBe(80);
  });

  it('does not set cached when cache_read_input_tokens is 0 or absent', async () => {
    const a = anthropicAdapter({
      apiKey: 'test',
      fetch: mockFetch({
        status: 200,
        body: mockResponse({ usage: { input_tokens: 10, output_tokens: 5 } }),
      }),
    });
    const res = await a.call({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(res.usage.cached).toBeUndefined();
  });

  it('throws AdapterError with correct code on HTTP 400', async () => {
    const a = anthropicAdapter({
      apiKey: 'test',
      fetch: mockFetch({
        status: 400,
        body: { error: { type: 'invalid_request_error', message: 'Bad request' } },
      }),
    });
    await expect(
      a.call({ model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'adapter.http.400',
      message: 'Bad request',
    });
  });

  it('throws AdapterError with correct code on HTTP 401', async () => {
    const a = anthropicAdapter({
      apiKey: 'test',
      fetch: mockFetch({
        status: 401,
        body: { error: { type: 'authentication_error', message: 'Invalid API key' } },
      }),
    });
    await expect(
      a.call({ model: 'claude-3-5-haiku-20241022', messages: [{ role: 'user', content: 'Hi' }] }),
    ).rejects.toMatchObject({ name: 'AdapterError', code: 'adapter.http.401' });
  });
});

// ---------------------------------------------------------------------------
// stream() tests
// ---------------------------------------------------------------------------

function sseBody(...events: Array<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}

describe('anthropicAdapter — stream()', () => {
  it('parses text_delta events into text chunks', async () => {
    const sse = sseBody(
      {
        event: 'message_start',
        data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text' } } },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'text_delta', text: ' world' } },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      {
        event: 'message_delta',
        data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      },
      { event: 'message_stop', data: {} },
    );

    const a = anthropicAdapter({ apiKey: 'test', fetch: mockFetch(sse) });
    const chunks: StreamChunk[] = [];
    for await (const chunk of a.stream({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => c.type === 'text');
    expect(textChunks).toHaveLength(2);
    expect((textChunks[0] as { type: 'text'; delta: string }).delta).toBe('Hello');
    expect((textChunks[1] as { type: 'text'; delta: string }).delta).toBe(' world');
  });

  it('parses tool_use events into tool_call chunk', async () => {
    const sse = sseBody(
      {
        event: 'message_start',
        data: { message: { usage: { input_tokens: 20, output_tokens: 0 } } },
      },
      {
        event: 'content_block_start',
        data: { index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{"city"' } },
      },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'input_json_delta', partial_json: ':"Paris"}' } },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      {
        event: 'message_delta',
        data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      },
      { event: 'message_stop', data: {} },
    );

    const a = anthropicAdapter({ apiKey: 'test', fetch: mockFetch(sse) });
    const chunks: StreamChunk[] = [];
    for await (const chunk of a.stream({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
    })) {
      chunks.push(chunk);
    }

    const toolChunks = chunks.filter((c) => c.type === 'tool_call');
    expect(toolChunks).toHaveLength(1);
    const toolChunk = toolChunks[0] as {
      type: 'tool_call';
      call: { id: string; name: string; arguments: unknown };
    };
    expect(toolChunk.call.id).toBe('tu_1');
    expect(toolChunk.call.name).toBe('get_weather');
    expect(toolChunk.call.arguments).toEqual({ city: 'Paris' });
  });

  it('emits usage and end at message_stop', async () => {
    const sse = sseBody(
      {
        event: 'message_start',
        data: { message: { usage: { input_tokens: 15, output_tokens: 0 } } },
      },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text' } } },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      {
        event: 'message_delta',
        data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      },
      { event: 'message_stop', data: {} },
    );

    const a = anthropicAdapter({ apiKey: 'test', fetch: mockFetch(sse) });
    const chunks: StreamChunk[] = [];
    for await (const chunk of a.stream({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }

    const usageChunk = chunks.find((c) => c.type === 'usage') as
      | { type: 'usage'; usage: { input: number; output: number } }
      | undefined;
    const endChunk = chunks.find((c) => c.type === 'end') as
      | { type: 'end'; reason: string }
      | undefined;

    expect(usageChunk).toBeDefined();
    expect(usageChunk?.usage.input).toBe(15);
    expect(usageChunk?.usage.output).toBe(3);
    expect(endChunk).toBeDefined();
    expect(endChunk?.reason).toBe('end');
  });

  it('emits the final event when the stream is not terminated by a blank line', async () => {
    // Drop the trailing "\n\n" so message_stop sits in the buffer at stream close.
    const sse = sseBody(
      {
        event: 'message_start',
        data: { message: { usage: { input_tokens: 15, output_tokens: 0 } } },
      },
      { event: 'content_block_start', data: { index: 0, content_block: { type: 'text' } } },
      {
        event: 'content_block_delta',
        data: { index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      },
      { event: 'content_block_stop', data: { index: 0 } },
      {
        event: 'message_delta',
        data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      },
      { event: 'message_stop', data: {} },
    ).replace(/\n\n$/, '');

    const a = anthropicAdapter({ apiKey: 'test', fetch: mockFetch(sse) });
    const chunks: StreamChunk[] = [];
    for await (const chunk of a.stream({
      model: 'claude-3-5-haiku-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }

    const endChunk = chunks.find((c) => c.type === 'end') as
      | { type: 'end'; reason: string }
      | undefined;
    expect(endChunk).toBeDefined();
    expect(endChunk?.reason).toBe('end');
  });

  it('throws AdapterError on HTTP error response (stream)', async () => {
    const a = anthropicAdapter({
      apiKey: 'test',
      fetch: mockFetch({
        status: 529,
        body: { error: { type: 'overloaded_error', message: 'Service overloaded' } },
      }),
    });

    await expect(async () => {
      for await (const _ of a.stream({
        model: 'claude-3-5-haiku-20241022',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        // unreachable
      }
    }).rejects.toMatchObject({ name: 'AdapterError', code: 'adapter.http.529' });
  });
});
