# Event Log & Resume

Every state change in an `agent()` run is an `AgentEvent`. The same stream drives streaming UIs, tracing, cost accounting and crash recovery: an append-only log of events is enough to rebuild the transcript and resume.

```ts
import {
  agent,
  agentStream,
  eventLog,
  parseEventLog,
  transcriptFrom,
  usageFrom,
  partialRun,
} from 'flint';
import type { AgentEvent, EventLog } from 'flint';
```

## Getting events

Two ways, same events:

```ts
// 1. Callback — works with agent()
await agent({ ..., onEvent: (e) => console.log(e.type) });

// 2. Generator — agentStream() yields events and returns the Result
const run = agentStream({ ... });
for await (const e of run) console.log(e.type);
```

`onEvent` is called synchronously as each event happens. An exception thrown from it propagates out of the run, so keep sinks non-throwing.

## Event catalog

```ts
type AgentEvent =
  | { type: 'start'; model: string; messages: Message[] }
  | { type: 'step_start'; step: number }
  | { type: 'compaction'; step: number; record: CompactionRecord }
  | { type: 'retry'; step: number; attempt: number; error: ErrorInfo; delayMs: number }
  | { type: 'chunk'; step: number; chunk: StreamChunk }
  | { type: 'response'; step: number; message: AssistantMessage; usage: Usage; cost?: number; stopReason: StopReason }
  | { type: 'message'; message: Message }
  | { type: 'tool_start'; step: number; call: ToolCall }
  | { type: 'tool_end'; step: number; result: ToolMessage; durationMs: number }
  | { type: 'step_end'; step: Step }
  | { type: 'done'; message: AssistantMessage; usage: Usage; cost: number }
  | { type: 'error'; error: ErrorInfo };

/** JSON-safe error summary, so logs can be serialized. */
type ErrorInfo = { name: string; message: string; code?: string };
```

| Event | Emitted |
|---|---|
| `start` | Once, with the initial messages |
| `step_start` | At the start of every step |
| `compaction` | When the [context manager](/features/context) commits a compaction |
| `retry` | For each retried provider error (see note below) |
| `chunk` | For every stream chunk, only with `streaming: true` |
| `response` | When a model response is accepted, with its usage and cost |
| `message` | For every message appended to the transcript — the assistant reply, then each tool result |
| `tool_start` | For every tool call in the turn, before any runs |
| `tool_end` | For every tool call, with the result (`isError` set on failures) and duration |
| `step_end` | After a tool-using step completes |
| `done` | Successful finish, with total usage and cost |
| `error` | Failed finish, with the error summary |

Order within a tool-using step: `step_start` → `compaction`? → `chunk`* → `retry`* → `response` → `message` (assistant) → `tool_start`* → `tool_end`* → `message` (tool)* → `step_end`.

::: info retry timing
`onEvent` receives `retry` events the moment a retry is scheduled. The `agentStream()` generator yields them after the call settles, just before `response`.
:::

The transcript is exactly `start.messages` followed by every `message` event, in order.

## Recording: eventLog()

```ts
type EventLog = {
  readonly events: AgentEvent[];
  sink: (event: AgentEvent) => void;  // pass as onEvent
  transcript(): Message[];             // transcriptFrom(events)
  toJSONL(): string;                   // one JSON event per line
};

function eventLog(initial?: AgentEvent[]): EventLog;
function parseEventLog(jsonl: string): AgentEvent[];
```

```ts
const log = eventLog();
const res = await agent({ ..., onEvent: log.sink });

await writeFile('run.jsonl', log.toJSONL());
const events = parseEventLog(await readFile('run.jsonl', 'utf8'));
```

## JSONL persistence

For crash safety, append each event as it happens rather than writing at the end:

```ts
import { appendFileSync } from 'node:fs';
import type { AgentEvent } from 'flint';

function jsonlSink(path: string) {
  return (e: AgentEvent) => {
    if (e.type === 'chunk') return; // optional: chunks are large and not needed to resume
    appendFileSync(path, `${JSON.stringify(e)}\n`);
  };
}

await agent({ ..., onEvent: jsonlSink(`runs/${runId}.jsonl`) });
```

Every event is plain JSON — errors are reduced to `ErrorInfo` — so any append-only store works (a file, a database row per event, a queue).

## Crash resume

`transcriptFrom(events)` rebuilds the full transcript from a log. If the process died between a tool-calling response and its results, the log ends with an assistant turn whose calls are unanswered; `transcriptFrom()` **drops that dangling turn** (and any partial results) so the resumed run re-asks the model instead of sending a transcript the provider would reject.

`usageFrom(events)` totals the usage and cost of every `response` in the log, so the resumed run can be given only what is left of the budget.

```ts
import { readFile } from 'node:fs/promises';
import { agent, parseEventLog, transcriptFrom, usageFrom } from 'flint';
import { budget } from 'flint/budget';
import { contextManager } from 'flint/context';

const events = parseEventLog(await readFile('runs/run-1.jsonl', 'utf8'));

const messages = transcriptFrom(events);
const { cost } = usageFrom(events);
const lastCompaction = events.filter((e) => e.type === 'compaction').at(-1);

const res = await agent({
  adapter,
  model: 'claude-opus-5-5',
  messages,
  tools,
  budget: budget({ maxDollars: 5 - cost }),
  context: contextManager({
    summarizer: { adapter, model: 'claude-opus-5-5' },
    contextWindow: 200_000,
    ...(lastCompaction?.type === 'compaction' ? { restore: lastCompaction.record } : {}),
  }),
  onEvent: jsonlSink('runs/run-1.resume-1.jsonl'), // a fresh log per attempt
});
```

Things to know:

- **Use a fresh log per attempt.** The resumed run emits its own `start` event containing the whole rebuilt transcript. `transcriptFrom()` concatenates every `start` it sees, so appending a second attempt to the first log would duplicate history. To total spend across attempts, sum `usageFrom()` over each attempt's log.
- **Dropped turns re-run tools.** When a dangling turn is dropped, tools from that turn that had already started may run again after the model re-asks. Make side-effecting tools idempotent, or check `tool_start` / `tool_end` pairs in the log before resuming.

## Partial runs

You don't need a log to inspect a failed run in-process. `partialRun(error)` returns what an `agent()` / `agentStream()` run achieved before it failed:

```ts
const res = await agent({ ... });
if (!res.ok) {
  const p = partialRun(res.error); // { steps, messages, usage, cost } | undefined
  if (p) {
    console.log(`stopped after ${p.steps.length} steps, $${p.cost.toFixed(4)}: ${res.error.message}`);
    // continue where it stopped, with more budget
    await agent({ ..., messages: p.messages, budget: bigger });
  }
}
```

`partialRun()` returns `undefined` for errors that did not come from an agent run. `p.messages` is the full transcript up to the failure; tool results are appended together with their turn, so it is well-formed and can be passed straight back to `agent()`.

## Tracing via onEvent

Events carry what a tracer needs: step boundaries, per-response usage and cost, tool durations, retries and compactions.

```ts
import type { AgentEvent } from 'flint';

// `metrics` and `log` stand in for your telemetry client.
function tracer(runId: string) {
  return (e: AgentEvent) => {
    switch (e.type) {
      case 'response':
        metrics.histogram('llm.cost', e.cost ?? 0, { runId, step: e.step });
        metrics.histogram('llm.tokens.cached', e.usage.cached ?? 0, { runId });
        break;
      case 'tool_start':
        log.debug('tool call', { runId, step: e.step, tool: e.call.name, id: e.call.id });
        break;
      case 'tool_end':
        metrics.histogram('tool.duration_ms', e.durationMs, { runId, error: !!e.result.isError });
        break;
      case 'retry':
        log.warn('provider retry', { runId, attempt: e.attempt, code: e.error.code, delayMs: e.delayMs });
        break;
      case 'compaction':
        log.info('context compacted', { runId, ...e.record, summary: undefined });
        break;
      case 'error':
        log.error('agent failed', { runId, ...e.error });
        break;
    }
  };
}

await agent({ ..., onEvent: tracer('run-1') });
```

Combine several sinks with a small fan-out: `onEvent: (e) => { log.sink(e); trace(e); }`.

## See also

- [agent()](/primitives/agent) — options and loop semantics
- [Context management](/features/context) — `compaction` events and `restore`
- [stream()](/primitives/stream) — the chunks inside `chunk` events
- [Landlord resume](/landlord/resume) — journaling for multi-agent workflows
