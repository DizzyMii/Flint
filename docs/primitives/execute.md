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

## execute() signature

```ts
function execute<Input, Output>(
  tool: Tool<Input, Output>,
  rawInput: unknown
): Promise<Result<Output>>
```

`execute()` does two things in order:
1. **Validates** `rawInput` against `tool.input` using `validate()`
2. **Runs** `tool.handler(parsedInput)`, optionally with a timeout

## Error cases

| Error type | Code | When |
|------------|------|------|
| `ParseError` | `'parse.tool_input'` | Input fails schema validation |
| `ToolError` | `'tool.handler_threw'` | Handler throws an exception |
| `TimeoutError` | `'tool.timeout'` | Handler exceeds `tool.timeout` ms |

```ts
const res = await execute(myTool, rawInput);
if (!res.ok) {
  if (res.error.code === 'parse.tool_input') {
    // Input was wrong type — programming error
  } else if (res.error.code === 'tool.timeout') {
    // Handler ran too long
  } else {
    // Handler threw — res.error.cause has the original exception
    console.error(res.error.cause);
  }
}
```

## Using execute() for testing

`execute()` is the cleanest way to unit test tools — no LLM involved:

```ts
// test directly
const result = await execute(calculatorTool, { expression: '2 + 2' });
expect(result.ok).toBe(true);
expect(result.value).toBe(4);

// test validation
const invalid = await execute(calculatorTool, { expression: 123 });
expect(invalid.ok).toBe(false);
expect(invalid.error.code).toBe('parse.tool_input');
```

## Difference from calling the handler directly

`execute()` vs `tool.handler(input)`:
- `execute()` validates input first (catches type errors before they reach your handler)
- `execute()` wraps handler exceptions as `Result` (no uncaught promise rejections)
- `execute()` enforces the timeout (if set)
- `execute()` returns `Result<Output>` (never throws)

Use `execute()` in tests and anywhere you're calling tools outside the agent loop.

## See also

- [tool()](/primitives/tool) — defining tools
- [Testing](/guide/testing) — testing tools with execute()
- [Error Types](/reference/errors) — ParseError, ToolError, TimeoutError
