import type { NormalizedRequest, ProviderAdapter } from '../adapter.ts';
import type { Budget } from '../budget.ts';
import type { Transform } from '../compress.ts';
import { costOf } from '../pricing.ts';
import type { Logger, Message, StreamChunk } from '../types.ts';
import { prepareCall } from './call.ts';

export type StreamOptions = Omit<NormalizedRequest, 'signal' | 'messages'> & {
  adapter: ProviderAdapter;
  messages: Message[];
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

export async function* stream(options: StreamOptions): AsyncIterable<StreamChunk> {
  if (!options || !options.adapter || !options.model || !options.messages) {
    throw new TypeError(
      'stream: options.adapter, options.model, and options.messages are required',
    );
  }
  const prepared = await prepareCall(options);
  if (!prepared.ok) throw prepared.error;
  const { req, pricing, hold } = prepared.value;

  try {
    for await (const chunk of options.adapter.stream(req)) {
      if (chunk.type === 'usage') {
        const cost = chunk.cost ?? (pricing ? costOf(chunk.usage, pricing) : undefined);
        hold?.release();
        options.budget?.consume({ ...chunk.usage, ...(cost !== undefined ? { cost } : {}) });
        yield cost !== undefined ? { ...chunk, cost } : chunk;
        continue;
      }
      yield chunk;
    }
  } finally {
    hold?.release();
  }
}
