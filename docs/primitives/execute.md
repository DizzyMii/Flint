# execute()

Execute a tool directly with type-safe argument handling.

`execute()` validates arguments against the tool's input schema, calls the handler, and wraps errors. It's what `agent()` calls internally for each tool call — but you can use it directly for testing or one-off tool invocations.

## Signature

```ts
function execute<Input, Output>(
  tool: Tool<Input, Output>,
  args: unknown
): Promise<Result<Output>>
```

## Parameters

| Parameter | Type | Description |
|---|---|---|
| `tool` | `Tool<Input, Output>` | The tool to execute |
| `args` | `unknown` | Raw arguments (typically parsed from the model's response) |

## Return value

`Promise<Result<Output>>` — `{ ok: true, value: Output }` on success. On failure: `{ ok: false, error: ToolError }` for handler exceptions, `{ ok: false, error: ValidationError }` for invalid arguments.

## Example

```ts
import { execute, tool } from 'flint';
import * as v from 'valibot';

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  input: v.object({ a: v.number(), b: v.number() }),
  handler: ({ a, b }) => a + b,
});

const res = await execute(add, { a: 3, b: 4 });

if (res.ok) {
  console.log(res.value); // 7
}
```

## Testing tools

`execute()` makes it easy to unit test tools in isolation without an LLM:

```ts
import { describe, it, expect } from 'vitest';
import { execute } from 'flint';
import { myTool } from '../src/tools.ts';

describe('myTool', () => {
  it('handles valid input', async () => {
    const res = await execute(myTool, { value: 42 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(42);
  });

  it('rejects invalid input', async () => {
    const res = await execute(myTool, { value: 'not a number' });
    expect(res.ok).toBe(false);
  });
});
```

## See also

- [tool()](/primitives/tool) — define a tool
- [agent()](/primitives/agent) — agent loop calls `execute()` for each tool call
