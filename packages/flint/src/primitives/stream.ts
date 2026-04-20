import type { NormalizedRequest, ProviderAdapter } from '../adapter.ts';
import type { Budget } from '../budget.ts';
import type { Transform } from '../compress.ts';
import type { Logger, Message, StreamChunk } from '../types.ts';

export type StreamOptions = Omit<NormalizedRequest, 'signal' | 'messages'> & {
  adapter: ProviderAdapter;
  messages: Message[];
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

export async function* stream(
  options: StreamOptions,
): AsyncIterable<StreamChunk> {
  if (!options || !options.adapter || !options.model || !options.messages) {
    throw new TypeError(
      'stream: options.adapter, options.model, and options.messages are required',
    );
  }

  const ctx = {
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    model: options.model,
  };
  const messages = options.compress
    ? await options.compress(options.messages, ctx)
    : options.messages;

  if (options.budget) {
    options.budget.assertNotExhausted();
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

  for await (const chunk of options.adapter.stream(req)) {
    if (chunk.type === 'usage' && options.budget) {
      options.budget.consume({
        ...chunk.usage,
        ...(chunk.cost !== undefined ? { cost: chunk.cost } : {}),
      });
    }
    yield chunk;
  }
}
