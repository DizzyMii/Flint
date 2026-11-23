import type { NormalizedRequest, NormalizedResponse, ProviderAdapter } from 'flint';
import type {
  ContentPart,
  Message,
  ModelPricing,
  PriceTable,
  StopReason,
  StreamChunk,
  ToolCall,
  Usage,
} from 'flint';
import { lookupPricing } from 'flint';
import { AdapterError, httpError, networkError } from 'flint/errors';

export type OpenAICompatAdapterOptions = {
  apiKey?: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  defaultHeaders?: Record<string, string>;
  /** Body fields merged into every request, before the per-request `extra`. */
  extraBody?: Record<string, unknown>;
  /**
   * Per-model prices (USD per million tokens). No built-in table is shipped because prices differ
   * per provider; without one, `maxDollars` budgets fail with `budget.unpriced`.
   */
  pricing?: PriceTable | ((model: string) => ModelPricing | undefined);
};

// ---------------------------------------------------------------------------
// OpenAI API types (internal)
// ---------------------------------------------------------------------------

type OpenAITextContentPart = { type: 'text'; text: string };
type OpenAIImageUrlContentPart = { type: 'image_url'; image_url: { url: string } };
type OpenAIContentPart = OpenAITextContentPart | OpenAIImageUrlContentPart;

type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAIContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

type OpenAITool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

type OpenAIRequestBody = {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; schema: Record<string, unknown>; strict: boolean };
  };
};

type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek reports cache hits here instead of `prompt_tokens_details`. */
  prompt_cache_hit_tokens?: number;
};

type OpenAIResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      refusal?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: OpenAIUsage;
};

type OpenAIDeltaToolCall = {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
};

type OpenAIStreamChunk = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      refusal?: string | null;
      tool_calls?: OpenAIDeltaToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: OpenAIUsage | null;
};

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(reason: string | null | undefined): StopReason {
  if (reason === 'tool_calls') return 'tool_call';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  // OpenAI reports both natural end and stop-sequence hits as 'stop' — cannot distinguish
  return 'end';
}

// ---------------------------------------------------------------------------
// Usage and tool-argument normalization: OpenAI -> Flint
// ---------------------------------------------------------------------------

/** OpenAI's `prompt_tokens` includes cached tokens; Flint's `input` counts uncached tokens only. */
function normalizeUsage(u: OpenAIUsage | null | undefined): Usage {
  if (!u) return { input: 0, output: 0 };
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  return {
    input: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    output: u.completion_tokens ?? 0,
    ...(cached > 0 ? { cached } : {}),
  };
}

function toToolCall(id: string, name: string, rawArgs: string): ToolCall {
  // Some servers send '' for tools that take no arguments.
  if (rawArgs.trim() === '') return { id, name, arguments: {} };
  try {
    return { id, name, arguments: JSON.parse(rawArgs) };
  } catch (e) {
    const parseError = e instanceof Error ? e.message : String(e);
    return { id, name, arguments: {}, parseError };
  }
}

// ---------------------------------------------------------------------------
// Message normalization: Flint -> OpenAI
// ---------------------------------------------------------------------------

function normalizeMessages(messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      out.push({ role: 'system', content: msg.content });
      continue;
    }

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else {
        const parts: OpenAIContentPart[] = msg.content.map((part: ContentPart) => {
          if (part.type === 'text') return { type: 'text' as const, text: part.text };
          if (part.type === 'image')
            return { type: 'image_url' as const, image_url: { url: part.url } };
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${part.mediaType};base64,${part.data}` },
          };
        });
        out.push({ role: 'user', content: parts });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      out.push(
        msg.toolCalls && msg.toolCalls.length > 0
          ? {
              role: 'assistant',
              content: msg.content || null,
              tool_calls: msg.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
              })),
            }
          : { role: 'assistant', content: msg.content },
      );
      continue;
    }

    if (msg.role === 'tool') {
      out.push({ role: 'tool', content: msg.content, tool_call_id: msg.toolCallId });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Build request body
// ---------------------------------------------------------------------------

function buildBody(
  req: NormalizedRequest,
  streaming: boolean,
  extraBody: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const body: OpenAIRequestBody = { model: req.model, messages: normalizeMessages(req.messages) };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences && req.stopSequences.length > 0) body.stop = req.stopSequences;
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: (t.jsonSchema ?? { type: 'object' }) as Record<string, unknown>,
      },
    }));
  }
  if (req.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'response', schema: req.jsonSchema, strict: true },
    };
  }
  if (streaming) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return { ...body, ...extraBody, ...req.extra };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      // Normalize line endings, but hold back a trailing \r: its \n may arrive in the next chunk.
      const held = buffer.endsWith('\r') ? '\r' : '';
      buffer = (held ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, '\n');
      const parts = buffer.split('\n\n');
      buffer = (parts.pop() ?? '') + held;
      for (const part of parts) {
        let event: string | null = null;
        let data = '';
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6).trim();
        }
        if (data) yield { event, data };
      }
    }
    // Flush any remaining buffer content after stream closes
    buffer = buffer.replace(/\r\n?/g, '\n');
    if (buffer.trim()) {
      let event: string | null = null;
      let data = '';
      for (const line of buffer.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6).trim();
      }
      if (data) yield { event, data };
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// HTTP error helper
// ---------------------------------------------------------------------------

async function throwHttpError(response: Response, label: string): Promise<never> {
  let errorBody: unknown = null;
  try {
    const text = await response.text();
    try {
      errorBody = JSON.parse(text);
    } catch {
      errorBody = text || null;
    }
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
      : typeof errorBody === 'string'
        ? errorBody
        : `${label} ${response.status}`;
  throw httpError('openai-compat', response.status, msg, response.headers, errorBody);
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function openaiCompatAdapter(opts: OpenAICompatAdapterOptions): ProviderAdapter {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const priceTable = opts.pricing;
  const pricing =
    typeof priceTable === 'function'
      ? priceTable
      : priceTable !== undefined
        ? (model: string) => lookupPricing(priceTable, model)
        : undefined;

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(opts.defaultHeaders ?? {}),
    };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    return headers;
  }

  return {
    name: 'openai-compat',
    capabilities: { promptCache: false, structuredOutput: true, parallelTools: true },
    ...(pricing !== undefined ? { pricing } : {}),

    async call(req: NormalizedRequest): Promise<NormalizedResponse> {
      let response: Response;
      try {
        response = await fetchFn(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(buildBody(req, false, opts.extraBody)),
          ...(req.signal != null ? { signal: req.signal } : {}),
        });
      } catch (e) {
        throw networkError(e);
      }
      if (!response.ok) await throwHttpError(response, 'OpenAI-compat');

      const data = (await response.json()) as OpenAIResponse;
      const choice = data.choices[0];
      if (!choice) throw new AdapterError('Empty choices array', { code: 'adapter.parse' });

      const refusal = choice.message.refusal;
      const content = refusal != null ? refusal : (choice.message.content ?? '');
      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) =>
        toToolCall(tc.id, tc.function.name, tc.function.arguments ?? ''),
      );

      return {
        message: { role: 'assistant', content, ...(toolCalls.length > 0 ? { toolCalls } : {}) },
        usage: normalizeUsage(data.usage),
        stopReason: refusal != null ? 'refusal' : mapStopReason(choice.finish_reason),
        raw: data,
      };
    },

    async *stream(req: NormalizedRequest): AsyncIterable<StreamChunk> {
      let response: Response;
      try {
        response = await fetchFn(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(buildBody(req, true, opts.extraBody)),
          ...(req.signal != null ? { signal: req.signal } : {}),
        });
      } catch (e) {
        throw networkError(e);
      }
      if (!response.ok) await throwHttpError(response, 'OpenAI-compat');
      if (!response.body) throw new AdapterError('No response body', { code: 'adapter.network' });

      type ToolStash = { id: string; name: string; args: string };
      const toolStash = new Map<number, ToolStash>();
      let finalFinishReason: string | null = null;
      let usage: Usage = { input: 0, output: 0 };
      let refused = false;
      let sawDone = false;

      for await (const { event, data } of parseSSE(response.body)) {
        if (event === 'error') {
          let parsed: { error?: { message?: string } } = {};
          try {
            parsed = JSON.parse(data) as { error?: { message?: string } };
          } catch {
            /* use raw data */
          }
          throw new AdapterError(parsed.error?.message ?? data, {
            code: 'adapter.stream',
            cause: parsed,
          });
        }
        if (data === '[DONE]') {
          sawDone = true;
          break;
        }
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(data) as OpenAIStreamChunk;
        } catch {
          continue;
        }
        if (chunk.usage) usage = normalizeUsage(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finalFinishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (delta.content) yield { type: 'text', delta: delta.content };
        if (delta.refusal) {
          refused = true;
          yield { type: 'text', delta: delta.refusal };
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolStash.has(idx))
              toolStash.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
            const stash = toolStash.get(idx);
            if (stash) {
              if (tc.id) stash.id = tc.id;
              if (tc.function?.name) stash.name = tc.function.name;
              if (tc.function?.arguments) stash.args += tc.function.arguments;
            }
          }
        }
      }

      if (!sawDone && finalFinishReason === null) {
        // The connection closed mid-response: report it instead of passing off a partial answer.
        throw new AdapterError('Stream ended before the response completed', {
          code: 'adapter.stream_truncated',
          kind: 'network',
          retryable: true,
        });
      }

      for (const [, stash] of toolStash) {
        yield { type: 'tool_call', call: toToolCall(stash.id, stash.name, stash.args) };
      }

      yield { type: 'usage', usage };
      yield { type: 'end', reason: refused ? 'refusal' : mapStopReason(finalFinishReason) };
    },
  };
}
