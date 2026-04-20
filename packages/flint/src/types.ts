import type { StandardSchemaV1 } from '@standard-schema/spec';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'image_b64'; data: string; mediaType: string };

export type ToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

export type Tool<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  input: StandardSchemaV1<Input>;
  handler: (input: Input) => Promise<Output> | Output;
};

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type Usage = {
  input: number;
  output: number;
  cached?: number;
};

export type StopReason = 'end' | 'tool_call' | 'max_tokens' | 'stop_sequence';

export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage; cost?: number }
  | { type: 'end'; reason: StopReason };

export type Logger = {
  debug?(msg: string, meta?: unknown): void;
  info?(msg: string, meta?: unknown): void;
  warn?(msg: string, meta?: unknown): void;
  error?(msg: string, meta?: unknown): void;
};

export type { StandardSchemaV1 };
