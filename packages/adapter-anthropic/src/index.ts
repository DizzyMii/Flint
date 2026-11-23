import type {
  AssistantMessage,
  ContentPart,
  Message,
  ModelPricing,
  NormalizedRequest,
  NormalizedResponse,
  PriceTable,
  ProviderAdapter,
  StopReason,
  StreamChunk,
  ThinkingBlock,
  ToolCall,
  Usage,
} from 'flint';
import { AdapterError, httpError, networkError } from 'flint/errors';

export type AnthropicAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Override or extend the built-in price table (per million tokens). */
  pricing?: PriceTable | ((model: string) => ModelPricing | undefined);
  /** Fields merged into every request body, e.g. `{ thinking: { type: 'adaptive' } }`. */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** max_tokens sent when a request does not set one. Default 16000. */
  defaultMaxTokens?: number;
};

/**
 * First-party list prices, USD per million tokens. Cache writes are 1.25x input (5-minute TTL);
 * cache reads are 0.1x input unless listed.
 */
export const anthropicPricing: PriceTable = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    longContext: { threshold: 100_000, input: 0.5, output: 2.5 },
  },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// ---------------------------------------------------------------------------
// Anthropic wire types (internal)
// ---------------------------------------------------------------------------

type CacheControl = { type: 'ephemeral' };

type Block = { type: string; cache_control?: CacheControl; [k: string]: unknown };

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | Block[] };

type AnthropicTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
};

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal';

type AnthropicResponse = {
  content: Block[];
  stop_reason: AnthropicStopReason | null;
  usage: AnthropicUsage;
};

function lookup(table: PriceTable, model: string): ModelPricing | undefined {
  if (table[model]) return table[model];
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (model.includes(key) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : table[best];
}

function costOf(usage: Usage, p: ModelPricing): number {
  const prompt = usage.input + (usage.cached ?? 0) + (usage.cacheWrite ?? 0);
  const long = p.longContext !== undefined && prompt > p.longContext.threshold;
  const input = long && p.longContext ? p.longContext.input : p.input;
  const output = long && p.longContext ? p.longContext.output : p.output;
  const scale = input / p.input;
  const read = (p.cacheRead ?? p.input * 0.1) * scale;
  const write = (p.cacheWrite ?? p.input * 1.25) * scale;
  return (
    (usage.input * input +
      (usage.cached ?? 0) * read +
      (usage.cacheWrite ?? 0) * write +
      usage.output * output) /
    1_000_000
  );
}

function mapStopReason(reason: AnthropicStopReason | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_call';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return 'end';
  }
}

function mapUsage(u: AnthropicUsage): Usage {
  const cached = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    ...(cached > 0 ? { cached } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
}

// ---------------------------------------------------------------------------
// Flint → Anthropic
// ---------------------------------------------------------------------------

function userBlocks(content: ContentPart[]): Block[] {
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image', source: { type: 'url', url: part.url } };
    return {
      type: 'image',
      source: { type: 'base64', media_type: part.mediaType, data: part.data },
    };
  });
}

function assistantBlocks(msg: AssistantMessage): Block[] {
  if (msg.providerContent?.provider === 'anthropic') {
    // Replay verbatim: thinking signatures are only valid on the exact blocks the API produced.
    return structuredClone(msg.providerContent.blocks) as Block[];
  }
  const blocks: Block[] = [];
  for (const t of msg.thinking ?? []) blocks.push({ ...t });
  if (msg.content) blocks.push({ type: 'text', text: msg.content });
  for (const tc of msg.toolCalls ?? []) {
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments ?? {} });
  }
  return blocks;
}

function normalizeMessages(messages: Message[]): {
  system: Block[];
  messages: AnthropicMessage[];
} {
  const system: Block[] = [];
  const out: AnthropicMessage[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i] as Message;
    if (msg.role === 'system') {
      system.push({ type: 'text', text: msg.content });
      i++;
    } else if (msg.role === 'tool') {
      // All results for one assistant turn go back in a single user message.
      const results: Block[] = [];
      while (i < messages.length) {
        const m = messages[i] as Message;
        if (m.role !== 'tool') break;
        results.push({
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content,
          ...(m.isError ? { is_error: true } : {}),
        });
        i++;
      }
      out.push({ role: 'user', content: results });
    } else if (msg.role === 'user') {
      out.push({
        role: 'user',
        content: typeof msg.content === 'string' ? msg.content : userBlocks(msg.content),
      });
      i++;
    } else {
      const blocks = assistantBlocks(msg);
      const plainText =
        blocks.length === 1 && blocks[0]?.type === 'text' && msg.providerContent === undefined;
      out.push({
        role: 'assistant',
        content: blocks.length === 0 || plainText ? msg.content : blocks,
      });
      i++;
    }
  }
  return { system, messages: out };
}

/** Put a cache breakpoint on the last cacheable block of a message, converting string content. */
function markMessage(msg: AnthropicMessage): boolean {
  if (typeof msg.content === 'string') {
    if (!msg.content) return false;
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
    return true;
  }
  for (let j = msg.content.length - 1; j >= 0; j--) {
    const b = msg.content[j] as Block;
    if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;
    b.cache_control = { type: 'ephemeral' };
    return true;
  }
  return false;
}

/**
 * Cache layout for agent loops (max 4 breakpoints): tools, system, the previous request's final
 * user turn (an exact hit on what the last request wrote, independent of the 20-block lookback),
 * and the current final message (written for the next request). Every step then reads the whole
 * history from cache and only pays full price for the newest turn.
 */
function applyCache(system: Block[], tools: AnthropicTool[], messages: AnthropicMessage[]): void {
  const lastTool = tools[tools.length - 1];
  if (lastTool) lastTool.cache_control = { type: 'ephemeral' };
  const lastSystem = system[system.length - 1];
  if (lastSystem) lastSystem.cache_control = { type: 'ephemeral' };

  const last = messages.length - 1;
  if (last < 0) return;
  markMessage(messages[last] as AnthropicMessage);
  let lastAssistant = -1;
  for (let j = last; j >= 0; j--) {
    if (messages[j]?.role === 'assistant') {
      lastAssistant = j;
      break;
    }
  }
  for (let j = lastAssistant - 1; j >= 0; j--) {
    if (messages[j]?.role === 'user') {
      markMessage(messages[j] as AnthropicMessage);
      break;
    }
  }
}

function buildBody(
  req: NormalizedRequest,
  streaming: boolean,
  opts: AnthropicAdapterOptions,
): Record<string, unknown> {
  const { system, messages } = normalizeMessages(req.messages);
  const tools: AnthropicTool[] = (req.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema ?? { type: 'object' },
  }));

  if ((req.cache ?? 'auto') === 'auto') applyCache(system, tools, messages);

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? opts.defaultMaxTokens ?? 16000,
    messages,
  };
  if (system.length > 0) body.system = system;
  if (tools.length > 0) body.tools = tools;
  if (req.stopSequences && req.stopSequences.length > 0) body.stop_sequences = req.stopSequences;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (streaming) body.stream = true;

  const extra = { ...opts.extraBody, ...req.extra };
  if (req.jsonSchema !== undefined) {
    const outputConfig = (extra.output_config ?? {}) as Record<string, unknown>;
    extra.output_config = {
      ...outputConfig,
      format: { type: 'json_schema', schema: req.jsonSchema },
    };
  }
  return { ...body, ...extra };
}

// ---------------------------------------------------------------------------
// Anthropic → Flint
// ---------------------------------------------------------------------------

function parseArgs(raw: string): { args: unknown; error?: string } {
  if (raw.trim() === '') return { args: {} };
  try {
    return { args: JSON.parse(raw) };
  } catch (e) {
    return { args: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

function toMessage(blocks: Block[]): AssistantMessage {
  let content = '';
  const toolCalls: ToolCall[] = [];
  const thinking: ThinkingBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'text') content += String(b.text ?? '');
    else if (b.type === 'tool_use') {
      toolCalls.push({ id: String(b.id), name: String(b.name), arguments: b.input });
    } else if (b.type === 'thinking') {
      thinking.push({
        type: 'thinking',
        thinking: String(b.thinking ?? ''),
        signature: String(b.signature ?? ''),
      });
    } else if (b.type === 'redacted_thinking') {
      thinking.push({ type: 'redacted_thinking', data: String(b.data ?? '') });
    }
  }
  return {
    role: 'assistant',
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(thinking.length > 0
      ? { thinking, providerContent: { provider: 'anthropic', blocks } }
      : {}),
  };
}

async function readError(response: Response): Promise<AdapterError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const message =
    body !== null &&
    typeof body === 'object' &&
    'error' in body &&
    body.error !== null &&
    typeof body.error === 'object' &&
    'message' in body.error
      ? String((body.error as { message: unknown }).message)
      : undefined;
  return httpError('anthropic', response.status, message, response.headers, body);
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

function parseEvent(part: string): { event: string; data: string } | undefined {
  let event = '';
  const data: string[] = [];
  for (const line of part.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return event && data.length > 0 ? { event, data: data.join('\n') } : undefined;
}

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
      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const ev = parseEvent(part);
        if (ev) yield ev;
      }
    }
    // A final event may not be terminated by a blank line.
    if (buffer.trim()) {
      const ev = parseEvent(buffer);
      if (ev) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function anthropicAdapter(opts: AnthropicAdapterOptions): ProviderAdapter {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';

  const pricing = (model: string): ModelPricing | undefined => {
    if (typeof opts.pricing === 'function') return opts.pricing(model);
    if (opts.pricing) {
      const custom = lookup(opts.pricing, model);
      if (custom) return custom;
    }
    return lookup(anthropicPricing, model);
  };

  async function post(req: NormalizedRequest, streaming: boolean): Promise<Response> {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          ...opts.headers,
        },
        body: JSON.stringify(buildBody(req, streaming, opts)),
        ...(req.signal != null ? { signal: req.signal } : {}),
      });
    } catch (e) {
      throw networkError(e);
    }
    if (!response.ok) throw await readError(response);
    return response;
  }

  function priced(usage: Usage, model: string): { cost?: number } {
    const p = pricing(model);
    return p ? { cost: costOf(usage, p) } : {};
  }

  return {
    name: 'anthropic',
    capabilities: {
      promptCache: true,
      structuredOutput: true,
      parallelTools: true,
      defaultMaxTokens: opts.defaultMaxTokens ?? 16000,
    },
    pricing,

    async call(req: NormalizedRequest): Promise<NormalizedResponse> {
      const response = await post(req, false);
      const data = (await response.json()) as AnthropicResponse;
      const usage = mapUsage(data.usage);
      return {
        message: toMessage(data.content),
        usage,
        ...priced(usage, req.model),
        stopReason: mapStopReason(data.stop_reason),
        raw: data,
      };
    },

    async *stream(req: NormalizedRequest): AsyncIterable<StreamChunk> {
      const response = await post(req, true);
      if (!response.body) {
        throw new AdapterError('No response body', { code: 'adapter.network', kind: 'network' });
      }

      type Pending = Block & { json?: string; parseError?: string };
      const blocks = new Map<number, Pending>();
      let startUsage: AnthropicUsage = {};
      let deltaUsage: AnthropicUsage = {};
      let stopReason: AnthropicStopReason | null = null;

      for await (const { event, data } of parseSSE(response.body)) {
        if (event === 'ping') continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;

        if (event === 'error') {
          const err = (parsed.error ?? {}) as { type?: string; message?: string };
          const overloaded = err.type === 'overloaded_error';
          throw new AdapterError(err.message ?? 'Stream error', {
            code: 'adapter.stream',
            cause: parsed,
            kind: overloaded
              ? 'overloaded'
              : err.type === 'rate_limit_error'
                ? 'rate_limit'
                : 'server',
            retryable: overloaded || err.type === 'rate_limit_error' || err.type === 'api_error',
          });
        }

        if (event === 'message_start') {
          startUsage = (parsed.message as { usage?: AnthropicUsage }).usage ?? {};
        } else if (event === 'content_block_start') {
          const index = parsed.index as number;
          const block = { ...(parsed.content_block as Block) } as Pending;
          if (block.type === 'tool_use') block.json = '';
          blocks.set(index, block);
        } else if (event === 'content_block_delta') {
          const block = blocks.get(parsed.index as number);
          const delta = parsed.delta as Record<string, string | undefined>;
          if (!block) continue;
          if (delta.type === 'text_delta' && delta.text !== undefined) {
            block.text = String(block.text ?? '') + delta.text;
            yield { type: 'text', delta: delta.text };
          } else if (delta.type === 'thinking_delta' && delta.thinking !== undefined) {
            block.thinking = String(block.thinking ?? '') + delta.thinking;
            yield { type: 'thinking', delta: delta.thinking };
          } else if (delta.type === 'signature_delta' && delta.signature !== undefined) {
            block.signature = String(block.signature ?? '') + delta.signature;
          } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
            block.json = (block.json ?? '') + delta.partial_json;
          }
        } else if (event === 'content_block_stop') {
          const block = blocks.get(parsed.index as number);
          if (block?.type === 'tool_use') {
            const { args, error } = parseArgs(block.json ?? '');
            block.input = args;
            if (error !== undefined) block.parseError = error;
            const call: ToolCall = {
              id: String(block.id),
              name: String(block.name),
              arguments: args,
              ...(error !== undefined ? { parseError: error } : {}),
            };
            yield { type: 'tool_call', call };
          }
        } else if (event === 'message_delta') {
          const delta = parsed.delta as { stop_reason?: AnthropicStopReason };
          if (delta.stop_reason) stopReason = delta.stop_reason;
          deltaUsage = { ...deltaUsage, ...((parsed.usage as AnthropicUsage) ?? {}) };
        } else if (event === 'message_stop') {
          const usage = mapUsage({ ...startUsage, ...deltaUsage });
          yield { type: 'usage', usage, ...priced(usage, req.model) };
          const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
          const failures = new Map<string, string>();
          const wire = ordered.map((b) => {
            const { json: _json, parseError, ...rest } = b;
            if (typeof parseError === 'string') failures.set(String(b.id), parseError);
            return rest as Block;
          });
          const message = toMessage(wire);
          for (const tc of message.toolCalls ?? []) {
            const err = failures.get(tc.id);
            if (err !== undefined) tc.parseError = err;
          }
          yield { type: 'message', message };
          yield { type: 'end', reason: mapStopReason(stopReason) };
        }
      }
    },
  };
}
