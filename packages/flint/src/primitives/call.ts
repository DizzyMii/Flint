import type { NormalizedRequest, NormalizedResponse, ProviderAdapter } from '../adapter.ts';
import type { Budget } from '../budget.ts';
import type { Transform } from '../compress.ts';
import { AdapterError, BudgetExhausted, ParseError } from '../errors.ts';
import type { Logger, Message, Result, StandardSchemaV1, StopReason, Usage } from '../types.ts';
import { validate } from './validate.ts';

export type CallOptions<T = unknown> = Omit<NormalizedRequest, 'signal' | 'messages' | 'schema'> & {
  adapter: ProviderAdapter;
  messages: Message[];
  schema?: StandardSchemaV1<unknown, T>;
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

export type CallOutput<T = unknown> = {
  message: Message & { role: 'assistant' };
  value?: T;
  usage: Usage;
  cost?: number;
  stopReason: StopReason;
};

export async function call<T = unknown>(options: CallOptions<T>): Promise<Result<CallOutput<T>>> {
  if (!options || !options.adapter || !options.model || !options.messages) {
    throw new TypeError('call: options.adapter, options.model, and options.messages are required');
  }

  const ctx = {
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    model: options.model,
  };
  const messages = options.compress
    ? await options.compress(options.messages, ctx)
    : options.messages;

  if (options.budget) {
    try {
      options.budget.assertNotExhausted();
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        return { ok: false, error: e };
      }
      throw e;
    }
  }

  const req: NormalizedRequest = {
    model: options.model,
    messages,
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stopSequences !== undefined ? { stopSequences: options.stopSequences } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };

  let resp: NormalizedResponse;
  try {
    resp = await options.adapter.call(req);
  } catch (e) {
    return {
      ok: false,
      error: new AdapterError(e instanceof Error ? e.message : 'Adapter call failed', {
        code: 'adapter.call_failed',
        cause: e,
      }),
    };
  }

  if (options.budget) {
    try {
      options.budget.consume({
        ...resp.usage,
        ...(resp.cost !== undefined ? { cost: resp.cost } : {}),
      });
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        return { ok: false, error: e };
      }
      throw e;
    }
  }

  const output: CallOutput<T> = {
    message: resp.message,
    usage: resp.usage,
    ...(resp.cost !== undefined ? { cost: resp.cost } : {}),
    stopReason: resp.stopReason,
  };

  if (options.schema && resp.stopReason !== 'tool_call') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(resp.message.content);
    } catch (e) {
      return {
        ok: false,
        error: new ParseError('Response content is not valid JSON', {
          code: 'parse.response_json',
          cause: e,
        }),
      };
    }
    const validated = await validate(parsed, options.schema);
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }
    output.value = validated.value;
  }

  return { ok: true, value: output };
}
