import type { ProviderAdapter } from './adapter.ts';
import type { Budget } from './budget.ts';
import type { Transform } from './compress.ts';
import { NotImplementedError } from './errors.ts';
import type { Logger, Message, Result, Tool, ToolCall, Usage } from './types.ts';

export type Step = {
  messagesSent: Message[];
  assistant: Message & { role: 'assistant' };
  toolCalls: ToolCall[];
  toolResults: Array<Message & { role: 'tool' }>;
  usage: Usage;
  cost?: number;
};

export type AgentOutput = {
  message: Message & { role: 'assistant' };
  steps: Step[];
  usage: Usage;
  cost: number;
};

export type ToolsParam =
  | Tool[]
  | ((ctx: { messages: Message[]; step: number }) => Tool[] | Promise<Tool[]>);

export type AgentOptions = {
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];
  tools?: ToolsParam;
  budget: Budget;
  maxSteps?: number;
  onStep?: (step: Step) => void;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

export async function agent(_options: AgentOptions): Promise<Result<AgentOutput>> {
  throw new NotImplementedError('agent');
}
