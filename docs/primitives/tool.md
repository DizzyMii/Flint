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

## See also

- [execute()](/primitives/execute) — run a tool directly (without an LLM)
- [agent()](/primitives/agent) — pass tools to the agent loop
- [Safety — permissioned tools](/features/safety) — enforce permissions at runtime
