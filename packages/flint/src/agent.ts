import type { ProviderAdapter } from './adapter.ts';
import type { Budget } from './budget.ts';
import type { Transform } from './compress.ts';
import { FlintError } from './errors.ts';
import { call } from './primitives/call.ts';
import { execute } from './primitives/execute.ts';
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

export type ToolsCtx = { messages: Message[]; step: number };

export type ToolsParam = Tool[] | ((ctx: ToolsCtx) => Tool[] | Promise<Tool[]>);

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

async function runToolCall(tc: ToolCall, tools: Tool[]): Promise<Message & { role: 'tool' }> {
  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) {
    return {
      role: 'tool',
      content: `Error: unknown tool "${tc.name}"`,
      toolCallId: tc.id,
    };
  }
  const execResult = await execute(tool, tc.arguments);
  if (execResult.ok) {
    const content =
      typeof execResult.value === 'string' ? execResult.value : JSON.stringify(execResult.value);
    return { role: 'tool', content, toolCallId: tc.id };
  }
  // Include both the wrapper message and the underlying cause
  let errorMsg = execResult.error.message;
  if (execResult.error.cause instanceof Error) {
    errorMsg += `: ${execResult.error.cause.message}`;
  }
  return {
    role: 'tool',
    content: `Error: ${errorMsg}`,
    toolCallId: tc.id,
  };
}

function aggregateUsage(steps: Step[], terminal: Usage): Usage {
  let input = terminal.input;
  let output = terminal.output;
  let cached = terminal.cached ?? 0;
  for (const s of steps) {
    input += s.usage.input;
    output += s.usage.output;
    cached += s.usage.cached ?? 0;
  }
  return cached > 0 ? { input, output, cached } : { input, output };
}

function aggregateCost(steps: Step[], terminal: number | undefined): number {
  let total = terminal ?? 0;
  for (const s of steps) {
    total += s.cost ?? 0;
  }
  return total;
}

export async function agent(options: AgentOptions): Promise<Result<AgentOutput>> {
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
  const messages: Message[] = [...options.messages];
  const steps: Step[] = [];

  while (steps.length < maxSteps) {
    // Resolve tools (lazy support)
    const tools: Tool[] =
      options.tools === undefined
        ? []
        : typeof options.tools === 'function'
          ? await options.tools({ messages, step: steps.length })
          : options.tools;

    const result = await call({
      adapter: options.adapter,
      model: options.model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      budget: options.budget,
      ...(options.compress !== undefined ? { compress: options.compress } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const { message, usage, cost, stopReason } = result.value;

    messages.push(message);

    // Terminal: no tool calls in response
    const hasToolCalls =
      stopReason === 'tool_call' && message.toolCalls && message.toolCalls.length > 0;

    if (!hasToolCalls) {
      return {
        ok: true,
        value: {
          message,
          steps,
          usage: aggregateUsage(steps, usage),
          cost: aggregateCost(steps, cost),
        },
      };
    }

    // Execute tool calls in parallel
    const toolCalls = message.toolCalls ?? [];
    const toolResults = await Promise.all(toolCalls.map((tc) => runToolCall(tc, tools)));

    messages.push(...toolResults);

    const step: Step = {
      messagesSent: [...messages],
      assistant: message,
      toolCalls,
      toolResults,
      usage,
      ...(cost !== undefined ? { cost } : {}),
    };
    steps.push(step);

    options.onStep?.(step);
  }

  const lastMessage = messages[messages.length - 1];
  return {
    ok: false,
    error: new FlintError('Agent exceeded maxSteps without reaching a terminal response', {
      code: 'agent.max_steps_exceeded',
      cause: lastMessage,
    }),
  };
}
