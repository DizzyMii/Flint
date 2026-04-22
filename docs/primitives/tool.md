# tool()

Define a typed tool that an LLM can call.

`tool()` is an identity helper that infers types from your schema. It accepts a `Tool` spec and returns it unchanged — the value is in TypeScript inference.

## Signature

```ts
function tool<Input, Output>(spec: Tool<Input, Output>): Tool<Input, Output>
```

## Tool spec

```ts
type Tool<Input = unknown, Output = unknown> = {
  name: string;
  description: string;
  input: StandardSchemaV1<unknown, Input>;
  handler: (input: Input) => Promise<Output> | Output;
  permissions?: ToolPermissions;
  timeout?: number;
  jsonSchema?: Record<string, unknown>;
};

type ToolPermissions = {
  destructive?: boolean;
  scopes?: string[];
  network?: boolean;
  filesystem?: boolean;
  requireApproval?: boolean;
};
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Tool name (sent to the model) |
| `description` | `string` | Yes | What the tool does (sent to the model) |
| `input` | `StandardSchemaV1` | Yes | Validates and types the model's arguments |
| `handler` | `(input) => Output` | Yes | Executes the tool; may be async |
| `permissions` | `ToolPermissions` | No | Used by safety utilities |
| `timeout` | `number` | No | Milliseconds before handler is aborted |
| `jsonSchema` | `Record<string, unknown>` | No | Override JSON Schema sent to adapter (advanced) |

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
  handler: async ({ location, unit }) => {
    // fetch real weather here
    return { location, temperature: 22, unit };
  },
});
```

## ToolSpec reference

```ts
type ToolSpec<Input, Output> = {
  name: string;
  description: string;
  input: StandardSchemaV1<unknown, Input>;
  handler: (input: Input) => Promise<Output> | Output;
  permissions?: ToolPermissions;
  timeout?: number;
  jsonSchema?: Record<string, unknown>;
};
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Tool name sent to the LLM. Use snake_case. Must be unique within a call. |
| `description` | `string` | Explains to the LLM when and how to use the tool |
| `input` | `StandardSchemaV1` | Input schema — Zod, Valibot, ArkType, or any Standard Schema library |
| `handler` | `function` | The implementation. Receives typed, validated input. |
| `permissions` | `ToolPermissions` | Optional permission metadata for `requireApproval()` and `permissionedTools()` |
| `timeout` | `number` | Milliseconds before `TimeoutError`. Undefined = no timeout. |
| `jsonSchema` | `Record<string, unknown>` | Override the JSON Schema sent to the provider. Use when your schema library's output needs adjustment. |

## ToolPermissions

```ts
type ToolPermissions = {
  destructive?: boolean;   // true if the tool modifies state irreversibly
  scopes?: string[];       // custom permission scope strings
  network?: boolean;       // true if the tool makes network requests
  filesystem?: boolean;    // true if the tool accesses the filesystem
  requireApproval?: boolean; // always require human approval
};
```

Permissions are metadata only — they don't restrict execution unless you use `requireApproval()` or `permissionedTools()` from the safety module.

## Handler return types

The handler can return any serializable value. The agent loop serializes it to a tool result message:

```ts
// Returning a string — used as-is
handler: () => 'success'

// Returning an object — JSON.stringify'd
handler: () => ({ count: 42, items: ['a', 'b'] })

// Returning a number
handler: ({ a, b }) => a + b

// Async handler
handler: async ({ url }) => {
  const res = await fetch(url);
  return res.text();
}
```

## jsonSchema override

When your schema library generates JSON Schema that the LLM misinterprets, override with `jsonSchema`:

```ts
const myTool = tool({
  name: 'search',
  description: 'Search for items',
  input: v.object({ query: v.string(), limit: v.optional(v.number()) }),
  handler: search,
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      limit: { type: 'number', description: 'Max results (default 10)', default: 10 },
    },
    required: ['query'],
  },
});
```

## Common mistakes

::: warning Tool names must match across calls
The LLM sends back the tool name exactly as you defined it. If you change a tool name between steps in a multi-turn conversation, the agent won't find the tool.
:::

## See also

- [execute()](/primitives/execute) — run tool handlers directly
- [Safety](/features/safety) — requireApproval, permissionedTools
- [Error Types](/reference/errors) — ToolError, TimeoutError
