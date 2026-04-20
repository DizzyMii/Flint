import { NotImplementedError } from 'flint/errors';
import type {
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
} from 'flint';
import type { Message, StreamChunk } from 'flint';

export type AnthropicAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export function anthropicAdapter(_opts: AnthropicAdapterOptions): ProviderAdapter {
  return {
    name: 'anthropic',
    capabilities: {
      promptCache: true,
      structuredOutput: true,
      parallelTools: true,
    },
    async call(_req: NormalizedRequest): Promise<NormalizedResponse> {
      throw new NotImplementedError('adapter-anthropic.call');
    },
    async *stream(_req: NormalizedRequest): AsyncIterable<StreamChunk> {
      throw new NotImplementedError('adapter-anthropic.stream');
    },
    count(_messages: Message[], _model: string): number {
      throw new NotImplementedError('adapter-anthropic.count');
    },
  };
}
