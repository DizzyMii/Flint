# tool()

Define a typed tool that an LLM can call.

`tool()` infers types from your schema and returns a `Tool`. The value is in TypeScript inference — at runtime it copies the spec.

## Signature

```ts
function tool<Input, Output>(spec: ToolSpec<Input, Output>): Tool<Input, Output>
```

## ToolSpec

```ts
type ToolSpec<Input, Output> = {
  name: string;
  description: string;
  input: StandardSchemaV1<unknown, Input>;
  handler: (input: Input, ctx: ToolContext) => Promise<Output> | Output;
  permissions?: ToolPermissions;
  timeout?: number;
  jsonSchema?: Record<string, unknown>;
  sequential?: boolean;
};

type ToolContext = {
  /** Aborted when the tool times out or the surrounding run is cancelled. */
  signal: AbortSignal;
  toolCallId?: string;
  step?: number;
};
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Tool name sent to the model. Use snake_case. Must be unique among the tools of one `agent()` step — duplicates throw `TypeError`. |
| `description` | `string` | Yes | Tells the model when and how to use the tool |
| `input` | `StandardSchemaV1` | Yes | Validates and types the model's arguments — Zod, Valibot, ArkType, or any Standard Schema library |
| `handler` | `(input, ctx) => Output` | Yes | The implementation. Receives validated input and a `ToolContext`. May be async. |
| `jsonSchema` | `object` | Recommended | The JSON Schema the provider shows the model. See below. |
| `permissions` | `ToolPermissions` | No | Metadata for the safety utilities; `destructive` also makes the tool sequential |
| `timeout` | `number` | No | Milliseconds before the call fails with `TimeoutError` and `ctx.signal` aborts |
| `sequential` | `boolean` | No | Run alone: a turn containing this tool runs its whole batch in order. Defaults to `permissions.destructive`. |

::: warning Always provide jsonSchema
Flint validates arguments with `input`, but does not convert it to JSON Schema. The first-party adapters send `jsonSchema` to the provider and fall back to a bare `{ "type": "object" }` when it is missing, which leaves the model guessing the argument names.
:::

## Example

```ts
import { tool } from 'flint';
import * as v from 'valibot';

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  input: v.object({
    location: v.string(),
    unit: v.optional(v.picklist(['celsius', 'fahrenheit']), 'celsius'),
  }),
  jsonSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['location'],
  },
  handler: async ({ location, unit }, { signal }) => {
    const res = await fetch(`https://weather.example/api?q=${encodeURIComponent(location)}`, { signal });
    const { temperature } = (await res.json()) as { temperature: number };
    return { location, temperature, unit };
  },
  timeout: 10_000,
});
```

## The handler context

The second argument gives the handler what it needs to cooperate with the run:

- **`signal`** fires when the tool's `timeout` elapses or when the caller's signal (for example `agent({ signal })`) aborts. Pass it to `fetch`, child processes, database drivers — anything cancellable — so work actually stops instead of running on after its result was discarded.
- **`toolCallId`** is the provider's id for this call (set by `agent()`).
- **`step`** is the 0-based agent step (set by `agent()`).

When the signal fires, `execute()` stops waiting for the handler and returns `TimeoutError` (`tool.timeout`) or `ToolError` (`tool.aborted`) immediately; a handler that ignores the signal keeps running in the background.

## Parallel vs sequential execution

When the model asks for several tools in one turn, `agent()` runs them **concurrently** by default. If any tool in the batch is sequential — `sequential: true`, or `permissions.destructive: true` without an explicit `sequential` — the **whole batch** runs one at a time, in the order the model listed them.

```ts
const writeFile = tool({
  name: 'write_file',
  description: 'Write a file',
  input: v.object({ path: v.string(), content: v.string() }),
  jsonSchema: { /* … */ },
  permissions: { destructive: true, filesystem: true }, // implies sequential
  handler: async ({ path, content }) => { /* … */ },
});

const readOnlyButOrdered = tool({
  /* … */
  sequential: true, // order matters even though it is not destructive
});
```

## ToolPermissions

```ts
type ToolPermissions = {
  destructive?: boolean;     // modifies state irreversibly; also makes the tool sequential
  scopes?: string[];         // custom permission scope strings
  network?: boolean;         // makes network requests
  filesystem?: boolean;      // accesses the filesystem
  requireApproval?: boolean; // always require human approval
};
```

Apart from `destructive` implying `sequential`, permissions are metadata only — they don't restrict execution unless you use `requireApproval()` or `permissionedTools()` from the [safety module](/features/safety).

## Handler return types

The handler can return any serializable value. `agent()` turns it into a tool result message:

```ts
handler: () => 'success'                       // strings are used as-is
handler: () => ({ count: 42, items: ['a'] })   // anything else is JSON.stringify'd
handler: ({ a, b }) => a + b
```

If the handler throws, times out, or its input fails validation, `agent()` sends the model a tool result with `isError: true` and content `Error: …` (including schema issue paths for validation failures), and the loop continues.

## Common mistakes

::: warning Tool names must match across calls
The model sends back the tool name exactly as you defined it. If you rename a tool between steps in a multi-turn conversation, the agent won't find it and answers with an "unknown tool" error result.
:::

## See also

- [execute()](/primitives/execute) — run tool handlers directly
- [agent()](/primitives/agent) — how tool batches are scheduled
- [Safety](/features/safety) — requireApproval, permissionedTools
- [Error Types](/reference/errors) — ToolError, TimeoutError
