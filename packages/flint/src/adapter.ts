import type { Message, StreamChunk, Tool, Usage, StopReason, StandardSchemaV1 } from './types.ts';

export type NormalizedRequest = {
  model: string;
  messages: Message[];
  tools?: Tool[];
  schema?: StandardSchemaV1;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: 'auto' | 'off';
  signal?: AbortSignal;
};

export type NormalizedResponse = {
  message: Message & { role: 'assistant' };
  usage: Usage;
  cost?: number;
  stopReason: StopReason;
  raw?: unknown;
};

export type AdapterCapabilities = {
  promptCache?: boolean;
  structuredOutput?: boolean;
  parallelTools?: boolean;
};

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  call(req: NormalizedRequest): Promise<NormalizedResponse>;
  stream(req: NormalizedRequest): AsyncIterable<StreamChunk>;
  count?(messages: Message[], model: string): number;
}
