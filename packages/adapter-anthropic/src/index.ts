import type { NormalizedRequest, NormalizedResponse, ProviderAdapter } from 'flint';
import type { ContentPart, Message, StreamChunk, ToolCall } from 'flint';
import { AdapterError } from 'flint/errors';

export type AnthropicAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

// ---------------------------------------------------------------------------
// Anthropic API types (internal)
// ---------------------------------------------------------------------------

type CacheControl = { type: 'ephemeral' };

type AnthropicTextBlock = {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
};

type AnthropicImageBlock =
  | { type: 'image'; source: { type: 'url'; url: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
};

type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
};

type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  system?: AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stop_sequences?: string[];
  temperature?: number;
  stream?: boolean;
};

type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type AnthropicResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence?: string | null;
  usage: AnthropicUsage;
};

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(
  reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use',
): 'end' | 'tool_call' | 'max_tokens' | 'stop_sequence' {
  if (reason === 'end_turn' || reason === 'stop_sequence')
    return reason === 'stop_sequence' ? 'stop_sequence' : 'end';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'tool_use') return 'tool_call';
  return 'end';
}

// ---------------------------------------------------------------------------
// Message normalization: Flint → Anthropic
// ---------------------------------------------------------------------------

function normalizeMessages(
  messages: Message[],
  cache: 'auto' | 'off' | undefined,
): { system: AnthropicTextBlock[] | undefined; messages: AnthropicMessage[] } {
  const systemBlocks: AnthropicTextBlock[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (!msg) {
      i++;
      continue;
    }

    if (msg.role === 'system') {
      systemBlocks.push({ type: 'text', text: msg.content });
      i++;
      continue;
    }

    if (msg.role === 'tool') {
      // Coalesce consecutive tool messages into a single user message
      const toolResults: AnthropicToolResultBlock[] = [];
      while (i < messages.length) {
        const m = messages[i];
        if (!m || m.role !== 'tool') break;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content,
        });
        i++;
      }
      anthropicMessages.push({ role: 'user', content: toolResults });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        anthropicMessages.push({ role: 'user', content: msg.content });
      } else {
        const blocks: AnthropicContentBlock[] = msg.content.map((part: ContentPart) => {
          if (part.type === 'text') {
            return { type: 'text' as const, text: part.text };
          }
          if (part.type === 'image') {
            return { type: 'image' as const, source: { type: 'url' as const, url: part.url } };
          }
          // image_b64
          return {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: part.mediaType, data: part.data },
          };
        });
        anthropicMessages.push({ role: 'user', content: blocks });
      }
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) {
        blocks.push({ type: 'text', text: msg.content });
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
        }
      }
      if (blocks.length === 0) {
        anthropicMessages.push({ role: 'assistant', content: msg.content });
      } else if (blocks.length === 1 && blocks[0]?.type === 'text' && !msg.toolCalls?.length) {
        anthropicMessages.push({ role: 'assistant', content: msg.content });
      } else {
        anthropicMessages.push({ role: 'assistant', content: blocks });
      }
      i++;
      continue;
    }

    i++;
  }

  // Apply cache_control to last system block
  if (cache === 'auto' && systemBlocks.length > 0) {
    const last = systemBlocks[systemBlocks.length - 1];
    if (last) {
      last.cache_control = { type: 'ephemeral' };
    }
  }

  return {
    system: systemBlocks.length > 0 ? systemBlocks : undefined,
    messages: anthropicMessages,
  };
}

// ---------------------------------------------------------------------------
// Build request body
// ---------------------------------------------------------------------------

function buildBody(req: NormalizedRequest, streaming: boolean): AnthropicRequestBody {
  const { system, messages } = normalizeMessages(req.messages, req.cache);

  const body: AnthropicRequestBody = {
    model: req.model,
    max_tokens: req.maxTokens ?? 4096,
    messages,
  };

  if (system) {
    body.system = system;
  }

  if (req.tools && req.tools.length > 0) {
    const tools: AnthropicTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema ?? { type: 'object' },
    }));

    // Apply cache_control to last tool
    if (req.cache === 'auto' && tools.length > 0) {
      const last = tools[tools.length - 1];
      if (last) {
        last.cache_control = { type: 'ephemeral' };
      }
    }

    body.tools = tools;
  }

  if (req.stopSequences && req.stopSequences.length > 0) {
    body.stop_sequences = req.stopSequences;
  }

  if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }

  if (streaming) {
    body.stream = true;
  }

  return body;
}

// ---------------------------------------------------------------------------
// SSE parsing helpers
// ---------------------------------------------------------------------------

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      const parts = buffer.split('\n\n');
      // Last part may be incomplete — keep it in the buffer
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const lines = part.split('\n');
        let event = '';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            event = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            data = line.slice(6);
          }
        }
        if (event && data) {
          yield { event, data };
        }
      }
    }

    // Flush any remaining buffer content after the stream closes. A final event
    // (e.g. message_stop) may not be terminated by a trailing "\n\n".
    if (buffer.trim()) {
      let event = '';
      let data = '';
      for (const line of buffer.split('\n')) {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          data = line.slice(6);
        }
      }
      if (event && data) {
        yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function anthropicAdapter(opts: AnthropicAdapterOptions): ProviderAdapter {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';

  function buildHeaders(): Record<string, string> {
    return {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'content-type': 'application/json',
    };
  }

  return {
    name: 'anthropic',
    capabilities: {
      promptCache: true,
      structuredOutput: true,
      parallelTools: true,
    },

    async call(req: NormalizedRequest): Promise<NormalizedResponse> {
      const body = buildBody(req, false);
      let response: Response;

      try {
        response = await fetchFn(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(body),
          ...(req.signal != null ? { signal: req.signal } : {}),
        });
      } catch (e) {
        throw new AdapterError('Network error', { code: 'adapter.network', cause: e });
      }

      if (!response.ok) {
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = null;
        }
        const msg =
          errorBody != null &&
          typeof errorBody === 'object' &&
          'error' in errorBody &&
          errorBody.error != null &&
          typeof errorBody.error === 'object' &&
          'message' in errorBody.error
            ? String((errorBody.error as { message: unknown }).message)
            : `Anthropic ${response.status}`;
        throw new AdapterError(msg, {
          code: `adapter.http.${response.status}`,
          cause: { status: response.status, body: errorBody },
        });
      }

      const data = (await response.json()) as AnthropicResponse;

      let content = '';
      const toolCalls: ToolCall[] = [];

      for (const block of data.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
        }
      }

      const stopReason = mapStopReason(data.stop_reason);

      const usage = {
        input: data.usage.input_tokens,
        output: data.usage.output_tokens,
        ...(data.usage.cache_read_input_tokens !== undefined &&
        data.usage.cache_read_input_tokens > 0
          ? { cached: data.usage.cache_read_input_tokens }
          : {}),
      };

      const message: NormalizedResponse['message'] = {
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };

      return {
        message,
        usage,
        stopReason,
        raw: data,
      };
    },

    async *stream(req: NormalizedRequest): AsyncIterable<StreamChunk> {
      const body = buildBody(req, true);
      let response: Response;

      try {
        response = await fetchFn(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(body),
          ...(req.signal != null ? { signal: req.signal } : {}),
        });
      } catch (e) {
        throw new AdapterError('Network error', { code: 'adapter.network', cause: e });
      }

      if (!response.ok) {
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = null;
        }
        const msg =
          errorBody != null &&
          typeof errorBody === 'object' &&
          'error' in errorBody &&
          errorBody.error != null &&
          typeof errorBody.error === 'object' &&
          'message' in errorBody.error
            ? String((errorBody.error as { message: unknown }).message)
            : `Anthropic ${response.status}`;
        throw new AdapterError(msg, {
          code: `adapter.http.${response.status}`,
          cause: { status: response.status, body: errorBody },
        });
      }

      if (!response.body) {
        throw new AdapterError('No response body', { code: 'adapter.network' });
      }

      // Stash for accumulating tool calls
      type ToolStash = { index: number; id: string; name: string; args: string };
      const toolStash = new Map<number, ToolStash>();
      let messageDeltaUsage: { output_tokens: number } | undefined;
      let messageStartUsage: AnthropicUsage | undefined;
      let finalStopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' = 'end_turn';

      for await (const { event, data } of parseSSE(response.body)) {
        if (event === 'error') {
          const parsed = JSON.parse(data) as { error?: { message?: string } };
          throw new AdapterError(parsed.error?.message ?? 'Stream error', {
            code: 'adapter.stream',
            cause: parsed,
          });
        }

        if (event === 'message_start') {
          const parsed = JSON.parse(data) as { message: { usage: AnthropicUsage } };
          messageStartUsage = parsed.message.usage;
        }

        if (event === 'content_block_start') {
          const parsed = JSON.parse(data) as {
            index: number;
            content_block: { type: string; id?: string; name?: string };
          };
          if (parsed.content_block.type === 'tool_use') {
            toolStash.set(parsed.index, {
              index: parsed.index,
              id: parsed.content_block.id ?? '',
              name: parsed.content_block.name ?? '',
              args: '',
            });
          }
        }

        if (event === 'content_block_delta') {
          const parsed = JSON.parse(data) as {
            index: number;
            delta: { type: string; text?: string; partial_json?: string };
          };
          if (parsed.delta.type === 'text_delta' && parsed.delta.text !== undefined) {
            yield { type: 'text', delta: parsed.delta.text };
          } else if (
            parsed.delta.type === 'input_json_delta' &&
            parsed.delta.partial_json !== undefined
          ) {
            const stash = toolStash.get(parsed.index);
            if (stash) {
              stash.args += parsed.delta.partial_json;
            }
          }
        }

        if (event === 'content_block_stop') {
          const parsed = JSON.parse(data) as { index: number };
          const stash = toolStash.get(parsed.index);
          if (stash) {
            let parsedArgs: unknown = {};
            try {
              parsedArgs = JSON.parse(stash.args);
            } catch {
              parsedArgs = {};
            }
            yield {
              type: 'tool_call',
              call: { id: stash.id, name: stash.name, arguments: parsedArgs },
            };
            toolStash.delete(parsed.index);
          }
        }

        if (event === 'message_delta') {
          const parsed = JSON.parse(data) as {
            delta: { stop_reason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' };
            usage: { output_tokens: number };
          };
          messageDeltaUsage = parsed.usage;
          if (parsed.delta.stop_reason) {
            finalStopReason = parsed.delta.stop_reason;
          }
        }

        if (event === 'message_stop') {
          const inputTokens = messageStartUsage?.input_tokens ?? 0;
          const outputTokens = messageDeltaUsage?.output_tokens ?? 0;
          const cachedTokens = messageStartUsage?.cache_read_input_tokens;

          yield {
            type: 'usage',
            usage: {
              input: inputTokens,
              output: outputTokens,
              ...(cachedTokens !== undefined && cachedTokens > 0 ? { cached: cachedTokens } : {}),
            },
          };
          yield { type: 'end', reason: mapStopReason(finalStopReason) };
        }
      }
    },
  };
}
