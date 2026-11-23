import type { ModelPricing } from './pricing.ts';
import type {
  AssistantMessage,
  Message,
  StandardSchemaV1,
  StopReason,
  StreamChunk,
  Tool,
  Usage,
} from './types.ts';

export type { StreamChunk };

export type NormalizedRequest = {
  model: string;
  messages: Message[];
  tools?: Tool[];
  schema?: StandardSchemaV1;
  /** JSON Schema for the response. Adapters with native structured output constrain decoding with it. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  cache?: 'auto' | 'off';
  signal?: AbortSignal;
  /** Provider-specific body fields merged into the request (e.g. `{ thinking: {...}, output_config: {...} }`). */
  extra?: Record<string, unknown>;
};

export type NormalizedResponse = {
  message: AssistantMessage;
  usage: Usage;
  cost?: number;
  stopReason: StopReason;
  raw?: unknown;
};

export type AdapterCapabilities = {
  promptCache?: boolean;
  structuredOutput?: boolean;
  parallelTools?: boolean;
  /** max_tokens the adapter sends when the request does not set one. Used for budget pre-flight. */
  defaultMaxTokens?: number;
};

export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  call(req: NormalizedRequest): Promise<NormalizedResponse>;
  stream(req: NormalizedRequest): AsyncIterable<StreamChunk>;
  count?(messages: Message[], model: string): number;
  /** Per-model prices. When present, Flint computes `cost` and enforces `maxDollars` before each call. */
  pricing?(model: string): ModelPricing | undefined;
}
