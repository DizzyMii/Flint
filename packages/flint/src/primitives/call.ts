import type { NormalizedRequest, NormalizedResponse, ProviderAdapter } from '../adapter.ts';
import type { Budget, Reservation } from '../budget.ts';
import type { Transform } from '../compress.ts';
import { AdapterError, BudgetExhausted, FlintError, ParseError } from '../errors.ts';
import { type ModelPricing, affordableOutputTokens, costOf, worstCaseCost } from '../pricing.ts';
import { checkTranscript } from '../transcript.ts';
import type {
  AssistantMessage,
  Logger,
  Message,
  Result,
  StandardSchemaV1,
  StopReason,
  StreamChunk,
  ToolCall,
  Usage,
} from '../types.ts';
import { approxCount } from './approx-count.ts';
import { validate } from './validate.ts';

export type RetryPolicy = {
  /** Retries after the first attempt. Default 2. */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type RetryInfo = { attempt: number; error: AdapterError; delayMs: number };

export type CallOptions<T = unknown> = Omit<NormalizedRequest, 'signal' | 'messages' | 'schema'> & {
  adapter: ProviderAdapter;
  messages: Message[];
  schema?: StandardSchemaV1<unknown, T>;
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
  /** Retry transient provider failures (rate limits, overload, 5xx, network). `false` disables. */
  retry?: RetryPolicy | false;
  onRetry?: (info: RetryInfo) => void;
  /** Steps charged to the budget for this call. Default 1; 0 for auxiliary calls such as summarization. */
  budgetSteps?: number;
};

export type CallOutput<T = unknown> = {
  message: AssistantMessage;
  value?: T;
  usage: Usage;
  cost?: number;
  stopReason: StopReason;
  /** The messages actually sent, after compression. */
  sent?: Message[];
};

type Prepared = {
  req: NormalizedRequest;
  pricing: ModelPricing | undefined;
  hold: Reservation | undefined;
  /** Raw (uncalibrated) prompt estimate, used to learn the estimator's error. */
  estimate: number | undefined;
};

// Observed (actual prompt tokens / estimated prompt tokens) per adapter and model. Local
// estimates miss provider-side framing, so pre-flight scales by what it has actually seen.
const calibration = new WeakMap<ProviderAdapter, Map<string, number>>();

function calibrated(adapter: ProviderAdapter, model: string, estimate: number): number {
  const ratio = calibration.get(adapter)?.get(model) ?? 1;
  return Math.ceil(estimate * Math.max(1, ratio));
}

function learn(adapter: ProviderAdapter, model: string, estimate: number, usage: Usage): void {
  const actual = usage.input + (usage.cached ?? 0) + (usage.cacheWrite ?? 0);
  if (estimate <= 0 || actual <= 0) return;
  let perModel = calibration.get(adapter);
  if (!perModel) {
    perModel = new Map();
    calibration.set(adapter, perModel);
  }
  const observed = actual / estimate;
  const prev = perModel.get(model);
  // Track upward errors quickly and relax slowly: overspend is worse than a slightly small cap.
  perModel.set(
    model,
    prev === undefined ? observed : Math.max(observed, prev * 0.8 + observed * 0.2),
  );
}

function fail<T>(error: Error): Result<T> {
  return { ok: false, error };
}

function estimatePromptTokens(req: NormalizedRequest, adapter: ProviderAdapter): number {
  const msgs = adapter.count ? adapter.count(req.messages, req.model) : approxCount(req.messages);
  let tools = 0;
  for (const t of req.tools ?? []) {
    tools += Math.ceil(
      (t.name.length + t.description.length + JSON.stringify(t.jsonSchema ?? {}).length) / 3.5,
    );
  }
  return msgs + tools;
}

export async function prepareCall<T>(options: CallOptions<T>): Promise<Result<Prepared>> {
  if (!options || !options.adapter || !options.model || !options.messages) {
    throw new TypeError('call: options.adapter, options.model, and options.messages are required');
  }
  const { adapter, budget } = options;

  const ctx = {
    ...(budget !== undefined ? { budget } : {}),
    model: options.model,
  };
  let messages = options.messages;
  if (options.compress) {
    messages = await options.compress(options.messages, ctx);
    if (messages !== options.messages && checkTranscript(options.messages).length === 0) {
      const issues = checkTranscript(messages);
      if (issues.length > 0) {
        return fail(
          new FlintError(
            `compress produced a malformed transcript: ${issues.map((i) => `[${i.index}] ${i.problem}`).join('; ')}`,
            { code: 'compress.malformed', cause: issues },
          ),
        );
      }
    }
  }

  if (budget) {
    try {
      budget.assertNotExhausted();
    } catch (e) {
      if (e instanceof Error && e.name === 'BudgetExhausted') return fail(e);
      throw e;
    }
  }

  const req: NormalizedRequest = {
    model: options.model,
    messages,
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.jsonSchema !== undefined ? { jsonSchema: options.jsonSchema } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stopSequences !== undefined ? { stopSequences: options.stopSequences } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.extra !== undefined ? { extra: options.extra } : {}),
  };

  const pricing = adapter.pricing?.(options.model);
  let hold: Reservation | undefined;
  let estimate: number | undefined;

  if (budget) {
    // Pre-flight: cap max_tokens at what the remaining budget can pay for, so a single call can
    // never overshoot maxTokens/maxDollars by more than the prompt-size estimate error.
    estimate = estimatePromptTokens(req, adapter);
    const prompt = calibrated(adapter, options.model, estimate);
    const requested = options.maxTokens ?? adapter.capabilities.defaultMaxTokens;
    const remaining = budget.remaining();
    let limit = requested ?? Number.POSITIVE_INFINITY;
    let limitedBy: 'tokens' | 'dollars' | undefined;
    if (remaining.tokens !== undefined && remaining.tokens - prompt < limit) {
      limit = remaining.tokens - prompt;
      limitedBy = 'tokens';
    }
    if (remaining.dollars !== undefined && pricing) {
      const affordable = affordableOutputTokens(remaining.dollars, prompt, pricing);
      if (affordable < limit) {
        limit = affordable;
        limitedBy = 'dollars';
      }
    }
    if (limitedBy !== undefined) {
      if (limit < 1) {
        return fail(
          new BudgetExhausted(
            `Budget insufficient for next call: estimated ${prompt} prompt tokens leave no room for output within the remaining ${limitedBy}`,
            { code: `budget.${limitedBy}`, cause: { promptEstimate: prompt, remaining } },
          ),
        );
      }
      req.maxTokens = Math.floor(limit);
    }
    const outCap = req.maxTokens ?? requested ?? 0;
    hold = budget.reserve?.({
      tokens: prompt + outCap,
      ...(pricing ? { dollars: worstCaseCost(prompt, outCap, pricing) } : {}),
    });
  }

  return { ok: true, value: { req, pricing, hold, estimate } };
}

function toAdapterError(e: unknown): AdapterError {
  if (e instanceof Error && e.name === 'AdapterError') return e as AdapterError;
  return new AdapterError(e instanceof Error ? e.message : 'Adapter call failed', {
    code: 'adapter.call_failed',
    cause: e,
  });
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryDelay(err: AdapterError, attempt: number, policy: RetryPolicy): number {
  const base = policy.baseDelayMs ?? 500;
  const max = policy.maxDelayMs ?? 30_000;
  if (err.retryAfterMs !== undefined) return Math.min(err.retryAfterMs, 60_000);
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

/** Decide whether to retry `e`; returns the delay, or undefined to give up. */
function nextRetry<T>(
  e: AdapterError,
  attempt: number,
  options: CallOptions<T>,
): number | undefined {
  if (options.retry === false || !e.retryable) return undefined;
  const policy = options.retry ?? {};
  if (attempt >= (policy.retries ?? 2)) return undefined;
  if (options.signal?.aborted) return undefined;
  return retryDelay(e, attempt, policy);
}

function settle<T>(
  options: CallOptions<T>,
  prepared: Prepared,
  resp: NormalizedResponse,
): Result<{ cost: number | undefined }> {
  prepared.hold?.release();
  if (prepared.estimate !== undefined) {
    learn(options.adapter, options.model, prepared.estimate, resp.usage);
  }
  const cost = resp.cost ?? (prepared.pricing ? costOf(resp.usage, prepared.pricing) : undefined);
  const { budget } = options;
  if (!budget) return { ok: true, value: { cost } };
  try {
    budget.consume({
      ...resp.usage,
      ...(cost !== undefined ? { cost } : {}),
      ...(options.budgetSteps !== undefined ? { steps: options.budgetSteps } : {}),
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'BudgetExhausted') return fail(e);
    throw e;
  }
  if (budget.limits.maxDollars !== undefined && cost === undefined) {
    return fail(
      new FlintError(
        `maxDollars is set but adapter "${options.adapter.name}" reported no cost and has no pricing for model "${options.model}". Pass pricing to the adapter or drop maxDollars.`,
        { code: 'budget.unpriced' },
      ),
    );
  }
  return { ok: true, value: { cost } };
}

function extractJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (first) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
    if (fenced?.[1] !== undefined) return JSON.parse(fenced[1]);
    const start = content.search(/[[{]/);
    const end = Math.max(content.lastIndexOf('}'), content.lastIndexOf(']'));
    if (start !== -1 && end > start) return JSON.parse(content.slice(start, end + 1));
    throw first;
  }
}

async function finish<T>(
  options: CallOptions<T>,
  prepared: Prepared,
  resp: NormalizedResponse,
): Promise<Result<CallOutput<T>>> {
  const settled = settle(options, prepared, resp);
  if (!settled.ok) return settled;
  const { cost } = settled.value;

  const output: CallOutput<T> = {
    message: resp.message,
    usage: resp.usage,
    ...(cost !== undefined ? { cost } : {}),
    stopReason: resp.stopReason,
    sent: prepared.req.messages,
  };

  if (options.schema && resp.stopReason !== 'tool_call') {
    if (resp.stopReason === 'refusal') {
      return fail(
        new FlintError('Model refused to produce structured output', {
          code: 'call.refusal',
          cause: resp.message,
        }),
      );
    }
    let parsed: unknown;
    try {
      parsed = extractJson(resp.message.content);
    } catch (e) {
      return fail(
        new ParseError('Response content is not valid JSON', {
          code: 'parse.response_json',
          cause: e,
        }),
      );
    }
    const validated = await validate(parsed, options.schema);
    if (!validated.ok) return validated;
    output.value = validated.value;
  }

  return { ok: true, value: output };
}

export async function call<T = unknown>(options: CallOptions<T>): Promise<Result<CallOutput<T>>> {
  const prepared = await prepareCall(options);
  if (!prepared.ok) return prepared;

  let resp: NormalizedResponse;
  for (let attempt = 0; ; attempt++) {
    try {
      resp = await options.adapter.call(prepared.value.req);
      break;
    } catch (e) {
      const err = toAdapterError(e);
      const delay = nextRetry(err, attempt, options);
      if (delay === undefined) {
        prepared.value.hold?.release();
        return fail(err);
      }
      options.logger?.warn?.('call: retrying after transient adapter error', {
        attempt: attempt + 1,
        delayMs: delay,
        kind: err.kind,
      });
      options.onRetry?.({ attempt: attempt + 1, error: err, delayMs: delay });
      try {
        await sleep(delay, options.signal);
      } catch {
        prepared.value.hold?.release();
        return fail(err);
      }
    }
  }

  return finish(options, prepared.value, resp);
}

/** Folds stream chunks into a response. Adapters that emit a `message` chunk supply the exact message. */
export function assembleStream(): {
  push(chunk: StreamChunk): void;
  response(): NormalizedResponse;
} {
  let text = '';
  const toolCalls: ToolCall[] = [];
  let usage: Usage = { input: 0, output: 0 };
  let cost: number | undefined;
  let stopReason: StopReason = 'end';
  let message: AssistantMessage | undefined;
  return {
    push(chunk) {
      if (chunk.type === 'text') text += chunk.delta;
      else if (chunk.type === 'tool_call') toolCalls.push(chunk.call);
      else if (chunk.type === 'usage') {
        usage = chunk.usage;
        cost = chunk.cost;
      } else if (chunk.type === 'message') message = chunk.message;
      else if (chunk.type === 'end') stopReason = chunk.reason;
    },
    response() {
      return {
        message: message ?? {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        },
        usage,
        ...(cost !== undefined ? { cost } : {}),
        stopReason,
      };
    },
  };
}

/**
 * Streaming counterpart of `call()`: yields chunks as they arrive and returns the same Result.
 * Retries only happen before the first chunk is yielded, so consumers never see duplicated output.
 */
export async function* callStream<T = unknown>(
  options: CallOptions<T>,
): AsyncGenerator<StreamChunk, Result<CallOutput<T>>> {
  const prepared = await prepareCall(options);
  if (!prepared.ok) return prepared;

  try {
    for (let attempt = 0; ; attempt++) {
      const acc = assembleStream();
      let emitted = false;
      try {
        for await (const chunk of options.adapter.stream(prepared.value.req)) {
          acc.push(chunk);
          emitted = true;
          yield chunk;
        }
        return await finish(options, prepared.value, acc.response());
      } catch (e) {
        const err = toAdapterError(e);
        const delay = emitted ? undefined : nextRetry(err, attempt, options);
        if (delay === undefined) {
          prepared.value.hold?.release();
          return fail(err);
        }
        options.onRetry?.({ attempt: attempt + 1, error: err, delayMs: delay });
        try {
          await sleep(delay, options.signal);
        } catch {
          prepared.value.hold?.release();
          return fail(err);
        }
      }
    }
  } finally {
    // Releases the hold if the consumer stops iterating early; release() is idempotent.
    prepared.value.hold?.release();
  }
}
