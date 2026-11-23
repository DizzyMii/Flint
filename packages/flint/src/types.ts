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
  /** Set when the provider emitted arguments that are not valid JSON. The call is not executed. */
  parseError?: string;
};

export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

/**
 * The provider's original content blocks for an assistant turn. Adapters replay these verbatim
 * when the message is sent back to the same provider, which keeps thinking signatures valid.
 */
export type ProviderContent = { provider: string; blocks: unknown[] };

export type AssistantMessage = {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  thinking?: ThinkingBlock[];
  providerContent?: ProviderContent;
};

export type ToolMessage = {
  role: 'tool';
  content: string;
  toolCallId: string;
  isError?: boolean;
};

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | AssistantMessage
  | ToolMessage;

export type ToolPermissions = {
  destructive?: boolean;
  scopes?: string[];
  network?: boolean;
  filesystem?: boolean;
  requireApproval?: boolean;
};

export type ToolContext = {
  /** Aborted when the tool times out or the surrounding run is cancelled. */
  signal: AbortSignal;
  toolCallId?: string;
  step?: number;
};

export type Tool<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  input: StandardSchemaV1<unknown, Input>;
  handler: (input: Input, ctx: ToolContext) => Promise<Output> | Output;
  permissions?: ToolPermissions;
  timeout?: number;
  jsonSchema?: Record<string, unknown>;
  /** Run this tool alone: when a turn contains a sequential tool, the whole batch runs in order. Defaults to `permissions.destructive`. */
  sequential?: boolean;
};

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Token usage for one request. `input` counts only uncached input tokens; `cached` counts tokens
 * read from the prompt cache and `cacheWrite` counts tokens written to it. The three are disjoint.
 */
export type Usage = {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
};

export type StopReason = 'end' | 'tool_call' | 'max_tokens' | 'stop_sequence' | 'refusal';

export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage; cost?: number }
  /** The fully assembled assistant message, emitted by adapters that can provide it before `end`. */
  | { type: 'message'; message: AssistantMessage }
  | { type: 'end'; reason: StopReason };

export type Logger = {
  debug?(msg: string, meta?: unknown): void;
  info?(msg: string, meta?: unknown): void;
  warn?(msg: string, meta?: unknown): void;
  error?(msg: string, meta?: unknown): void;
};

export type { StandardSchemaV1 };
