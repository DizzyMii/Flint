import type { ProviderAdapter } from './adapter.ts';
import type { Budget } from './budget.ts';
import type { Transform } from './compress.ts';
import type { CompactionRecord, ContextStrategy } from './context.ts';
import { FlintError } from './errors.ts';
import { type CallOptions, type CallOutput, call, callStream } from './primitives/call.ts';
import { execute } from './primitives/execute.ts';
import type {
  AssistantMessage,
  Logger,
  Message,
  Result,
  StopReason,
  StreamChunk,
  Tool,
  ToolCall,
  ToolMessage,
  Usage,
} from './types.ts';

export type Step = {
  /** The messages actually sent for this step, after context management and compression. */
  messagesSent: Message[];
  assistant: AssistantMessage;
  toolCalls: ToolCall[];
  toolResults: ToolMessage[];
  usage: Usage;
  cost?: number;
};

export type AgentOutput = {
  message: AssistantMessage;
  steps: Step[];
  usage: Usage;
  cost: number;
  /** The full, uncompressed transcript including the initial messages. */
  messages: Message[];
};

/** What survived a failed run: everything up to the failure, so callers can inspect or resume. */
export type AgentPartial = {
  steps: Step[];
  messages: Message[];
  usage: Usage;
  cost: number;
};

export type ToolsCtx = { messages: Message[]; step: number };

export type ToolsParam = Tool[] | ((ctx: ToolsCtx) => Tool[] | Promise<Tool[]>);

/** JSON-safe error summary, so event logs can be serialized. */
export type ErrorInfo = { name: string; message: string; code?: string };

export type AgentEvent =
  | { type: 'start'; model: string; messages: Message[] }
  | { type: 'step_start'; step: number }
  | { type: 'compaction'; step: number; record: CompactionRecord }
  | { type: 'retry'; step: number; attempt: number; error: ErrorInfo; delayMs: number }
  | { type: 'chunk'; step: number; chunk: StreamChunk }
  | {
      type: 'response';
      step: number;
      message: AssistantMessage;
      usage: Usage;
      cost?: number;
      stopReason: StopReason;
    }
  | { type: 'message'; message: Message }
  | { type: 'tool_start'; step: number; call: ToolCall }
  | { type: 'tool_end'; step: number; result: ToolMessage; durationMs: number }
  | { type: 'step_end'; step: Step }
  | { type: 'done'; message: AssistantMessage; usage: Usage; cost: number }
  | { type: 'error'; error: ErrorInfo };

export type AgentOptions = {
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];
  tools?: ToolsParam;
  budget: Budget;
  maxSteps?: number;
  onStep?: (step: Step) => void;
  /** Receives every event; an append-only log of these is enough to rebuild the transcript. */
  onEvent?: (event: AgentEvent) => void;
  /** Stateless per-request transform. Prefer `context` for long runs: it keeps the cached prefix stable. */
  compress?: Transform;
  context?: ContextStrategy;
  /** Use the adapter's streaming endpoint and emit `chunk` events. */
  streaming?: boolean;
  maxTokens?: number;
  cache?: 'auto' | 'off';
  extra?: Record<string, unknown>;
  retry?: CallOptions['retry'];
  logger?: Logger;
  signal?: AbortSignal;
};

const partials = new WeakMap<Error, AgentPartial>();

/** The partial run attached to an error returned by `agent()` / `agentStream()`. */
export function partialRun(error: Error): AgentPartial | undefined {
  return partials.get(error);
}

function errorInfo(e: Error): ErrorInfo {
  const code = (e as { code?: unknown }).code;
  return { name: e.name, message: e.message, ...(typeof code === 'string' ? { code } : {}) };
}

function addUsage(a: Usage, b: Usage): Usage {
  const cached = (a.cached ?? 0) + (b.cached ?? 0);
  const cacheWrite = (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    ...(cached > 0 ? { cached } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
}

function toolError(tc: ToolCall, content: string): ToolMessage {
  return { role: 'tool', content: `Error: ${content}`, toolCallId: tc.id, isError: true };
}

async function runToolCall(
  tc: ToolCall,
  tools: Tool[],
  step: number,
  signal: AbortSignal | undefined,
): Promise<ToolMessage> {
  if (tc.parseError !== undefined) {
    return toolError(
      tc,
      `arguments for "${tc.name}" were not valid JSON (${tc.parseError}). Call the tool again with complete, valid arguments.`,
    );
  }
  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) {
    return toolError(
      tc,
      `unknown tool "${tc.name}". Available: ${tools.map((t) => t.name).join(', ')}`,
    );
  }
  const result = await execute(tool, tc.arguments, {
    toolCallId: tc.id,
    step,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (result.ok) {
    const content =
      typeof result.value === 'string' ? result.value : (JSON.stringify(result.value) ?? '');
    return { role: 'tool', content, toolCallId: tc.id };
  }
  let msg = result.error.message;
  const cause = result.error.cause;
  if (cause instanceof Error) msg += `: ${cause.message}`;
  else if (Array.isArray(cause)) {
    // Standard Schema issues: give the model enough to fix its arguments.
    const issues = cause
      .map((i: { message?: string; path?: unknown[] }) => {
        const path = (i.path ?? [])
          .map((p) => (typeof p === 'object' && p !== null && 'key' in p ? p.key : p))
          .join('.');
        return path ? `${path}: ${i.message}` : i.message;
      })
      .join('; ');
    if (issues) msg += `: ${issues}`;
  }
  return toolError(tc, msg);
}

function isSequential(t: Tool | undefined): boolean {
  return t !== undefined && (t.sequential ?? t.permissions?.destructive ?? false);
}

function assertUniqueToolNames(tools: Tool[]): void {
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new TypeError(`agent: duplicate tool name "${t.name}"`);
    seen.add(t.name);
  }
}

/**
 * The agent loop as an event stream. Every state change is an event, so the same generator
 * drives streaming UIs, tracing, budget accounting and crash recovery (`transcriptFrom(events)`).
 */
export async function* agentStream(
  options: AgentOptions,
): AsyncGenerator<AgentEvent, Result<AgentOutput>> {
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
  const messages: Message[] = [...options.messages];
  const steps: Step[] = [];
  let usage: Usage = { input: 0, output: 0 };
  let cost = 0;

  const emit = (e: AgentEvent): AgentEvent => {
    options.onEvent?.(e);
    return e;
  };
  const fail = (error: Error): Result<AgentOutput> => {
    partials.set(error, { steps, messages, usage, cost });
    return { ok: false, error };
  };

  yield emit({ type: 'start', model: options.model, messages: [...options.messages] });

  while (steps.length < maxSteps) {
    const step = steps.length;
    if (options.signal?.aborted) {
      const err = new FlintError('Agent aborted', {
        code: 'agent.aborted',
        cause: options.signal.reason,
      });
      yield emit({ type: 'error', error: errorInfo(err) });
      return fail(err);
    }
    yield emit({ type: 'step_start', step });

    const tools: Tool[] =
      options.tools === undefined
        ? []
        : typeof options.tools === 'function'
          ? await options.tools({ messages, step })
          : options.tools;
    assertUniqueToolNames(tools);

    let result: Result<CallOutput> | undefined;
    for (let overflowRetry = 0; overflowRetry < 2; overflowRetry++) {
      let view = messages;
      if (options.context) {
        const prepared = await options.context.prepare(messages, {
          model: options.model,
          step,
          budget: options.budget,
          force: overflowRetry > 0,
        });
        view = prepared.messages;
        if (prepared.compaction) {
          yield emit({ type: 'compaction', step, record: prepared.compaction });
        }
      }

      const pendingRetries: AgentEvent[] = [];
      const callOpts: CallOptions = {
        adapter: options.adapter,
        model: options.model,
        messages: view,
        ...(tools.length > 0 ? { tools } : {}),
        budget: options.budget,
        ...(options.compress !== undefined ? { compress: options.compress } : {}),
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.cache !== undefined ? { cache: options.cache } : {}),
        ...(options.extra !== undefined ? { extra: options.extra } : {}),
        ...(options.retry !== undefined ? { retry: options.retry } : {}),
        onRetry: (info) =>
          pendingRetries.push(
            emit({
              type: 'retry',
              step,
              attempt: info.attempt,
              error: errorInfo(info.error),
              delayMs: info.delayMs,
            }),
          ),
      };

      if (options.streaming) {
        const it = callStream(callOpts);
        for (;;) {
          const n = await it.next();
          if (n.done) {
            result = n.value;
            break;
          }
          yield emit({ type: 'chunk', step, chunk: n.value });
        }
      } else {
        result = await call(callOpts);
      }
      yield* pendingRetries;

      const overflow =
        !result.ok &&
        (result.error as { kind?: unknown }).kind === 'context_overflow' &&
        options.context !== undefined;
      if (!overflow) break;
    }

    if (result === undefined || !result.ok) {
      const err =
        result?.error ??
        new FlintError('Agent call produced no result', { code: 'agent.internal' });
      yield emit({ type: 'error', error: errorInfo(err) });
      return fail(err);
    }

    const { message, stopReason } = result.value;
    // Snapshot now: when nothing transforms the prompt, `sent` is the live transcript array.
    const messagesSent = [...(result.value.sent ?? [])];
    usage = addUsage(usage, result.value.usage);
    cost += result.value.cost ?? 0;
    yield emit({
      type: 'response',
      step,
      message,
      usage: result.value.usage,
      ...(result.value.cost !== undefined ? { cost: result.value.cost } : {}),
      stopReason,
    });
    messages.push(message);
    yield emit({ type: 'message', message });

    const toolCalls = message.toolCalls ?? [];
    if (stopReason !== 'tool_call' || toolCalls.length === 0) {
      yield emit({ type: 'done', message, usage, cost });
      return { ok: true, value: { message, steps, usage, cost, messages } };
    }

    const runOne = async (tc: ToolCall) => {
      const started = Date.now();
      const res = await runToolCall(tc, tools, step, options.signal);
      return { res, durationMs: Date.now() - started };
    };
    for (const tc of toolCalls) yield emit({ type: 'tool_start', step, call: tc });
    let outcomes: Array<{ res: ToolMessage; durationMs: number }>;
    if (toolCalls.some((tc) => isSequential(tools.find((t) => t.name === tc.name)))) {
      outcomes = [];
      for (const tc of toolCalls) outcomes.push(await runOne(tc));
    } else {
      outcomes = await Promise.all(toolCalls.map(runOne));
    }
    const toolResults = outcomes.map((o) => o.res);
    for (const o of outcomes) {
      yield emit({ type: 'tool_end', step, result: o.res, durationMs: o.durationMs });
    }
    for (const r of toolResults) {
      messages.push(r);
      yield emit({ type: 'message', message: r });
    }

    const s: Step = {
      messagesSent,
      assistant: message,
      toolCalls,
      toolResults,
      usage: result.value.usage,
      ...(result.value.cost !== undefined ? { cost: result.value.cost } : {}),
    };
    steps.push(s);
    options.onStep?.(s);
    yield emit({ type: 'step_end', step: s });
  }

  const err = new FlintError('Agent exceeded maxSteps without reaching a terminal response', {
    code: 'agent.max_steps_exceeded',
    cause: messages[messages.length - 1],
  });
  yield emit({ type: 'error', error: errorInfo(err) });
  return fail(err);
}

export async function agent(options: AgentOptions): Promise<Result<AgentOutput>> {
  const it = agentStream(options);
  for (;;) {
    const n = await it.next();
    if (n.done) return n.value;
  }
}

/** Rebuild the full transcript from an event log (e.g. after a crash) to resume with `agent()`. */
export function transcriptFrom(events: AgentEvent[]): Message[] {
  const out: Message[] = [];
  for (const e of events) {
    if (e.type === 'start') out.push(...e.messages);
    else if (e.type === 'message') out.push(e.message);
  }
  // A crash between a tool-calling response and its results leaves calls unanswered; drop that
  // turn so the resumed run re-asks the model instead of sending a malformed transcript.
  const last = out[out.length - 1];
  if (last?.role === 'assistant' && last.toolCalls?.length) out.pop();
  else if (last?.role === 'tool') {
    let i = out.length - 1;
    while (i >= 0 && out[i]?.role === 'tool') i--;
    const turn = out[i];
    const answered = out.length - 1 - i;
    if (turn?.role === 'assistant' && (turn.toolCalls?.length ?? 0) > answered) out.length = i;
  }
  return out;
}

/** Total usage and cost recorded in an event log. */
export function usageFrom(events: AgentEvent[]): { usage: Usage; cost: number } {
  let usage: Usage = { input: 0, output: 0 };
  let cost = 0;
  for (const e of events) {
    if (e.type === 'response') {
      usage = addUsage(usage, e.usage);
      cost += e.cost ?? 0;
    }
  }
  return { usage, cost };
}

export type EventLog = {
  readonly events: AgentEvent[];
  sink: (event: AgentEvent) => void;
  transcript(): Message[];
  toJSONL(): string;
};

/** In-memory event recorder. Pass `log.sink` as `onEvent`; persist `log.toJSONL()` anywhere. */
export function eventLog(initial: AgentEvent[] = []): EventLog {
  const events = [...initial];
  return {
    events,
    sink: (e) => {
      events.push(e);
    },
    transcript: () => transcriptFrom(events),
    toJSONL: () => events.map((e) => JSON.stringify(e)).join('\n'),
  };
}

export function parseEventLog(jsonl: string): AgentEvent[] {
  return jsonl
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AgentEvent);
}
