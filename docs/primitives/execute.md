# execute()

Execute a tool directly with type-safe argument handling.

`execute()` validates arguments against the tool's input schema, calls the handler with a `ToolContext`, enforces the timeout, and wraps errors. It's what `agent()` calls internally for each tool call — but you can use it directly for testing or one-off tool invocations.

## Signature

```ts
function execute<Input, Output>(
  tool: Tool<Input, Output>,
  rawInput: unknown,
  opts?: ExecuteOptions,
): Promise<Result<Output>>

type ExecuteOptions = {
  signal?: AbortSignal;  // aborting it aborts ctx.signal and ends the call
  toolCallId?: string;   // forwarded to the handler as ctx.toolCallId
  step?: number;         // forwarded to the handler as ctx.step
};
```

| Parameter | Type | Description |
|---|---|---|
| `tool` | `Tool<Input, Output>` | The tool to execute |
| `rawInput` | `unknown` | Raw arguments (typically parsed from the model's response) |
| `opts` | `ExecuteOptions` | Optional cancellation signal and context forwarded to the handler |

## What it does

1. **Validates** `rawInput` against `tool.input`.
2. **Creates a per-call `AbortController`.** Its signal is passed to the handler as `ctx.signal` and fires when `tool.timeout` elapses or `opts.signal` aborts.
3. **Runs** `tool.handler(input, ctx)` and races it against that signal.
4. **Returns** a `Result` — it never throws.

## Return value

`Promise<Result<Output>>` — `{ ok: true, value }` on success, otherwise:

| Error type | Code | When |
|------------|------|------|
| `ParseError` | `'parse.tool_input'` | Input fails schema validation (`cause` holds the schema issues) |
| `ToolError` | `'tool.handler_threw'` | Handler throws (`cause` holds the original exception) |
| `TimeoutError` | `'tool.timeout'` | Handler exceeds `tool.timeout` ms |
| `ToolError` | `'tool.aborted'` | `opts.signal` aborted (if the abort reason is itself an `Error`, that error is returned instead) |

## Example

```ts
import { execute, tool } from 'flint';
import * as v from 'valibot';

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  input: v.object({ a: v.number(), b: v.number() }),
  jsonSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
  handler: ({ a, b }) => a + b,
});

const res = await execute(add, { a: 3, b: 4 });
if (res.ok) console.log(res.value); // 7
```

### Cancelling a running tool

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 1_000);

const res = await execute(slowTool, { url }, { signal: controller.signal });
if (!res.ok && (res.error as FlintError).code === 'tool.aborted') {
  console.log('cancelled');
}
```

`execute()` returns as soon as the signal fires. Whether the handler's own work stops depends on the handler passing `ctx.signal` to whatever it is waiting on.

## Handling errors

```ts
import type { FlintError } from 'flint/errors';

const res = await execute(myTool, rawInput);
if (!res.ok) {
  switch ((res.error as FlintError).code) {
    case 'parse.tool_input':   // wrong argument shape
      break;
    case 'tool.timeout':       // ran longer than tool.timeout
      break;
    case 'tool.aborted':       // caller cancelled
      break;
    default:                   // handler threw — res.error.cause has the original exception
      console.error(res.error.cause);
  }
}
```

## Testing tools

`execute()` is the cleanest way to unit test tools — no LLM involved:

```ts
import { describe, it, expect } from 'vitest';
import { execute } from 'flint';
import type { FlintError } from 'flint/errors';
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
    if (!res.ok) expect((res.error as FlintError).code).toBe('parse.tool_input');
  });
});
```

## Difference from calling the handler directly

- `execute()` validates input first
- `execute()` supplies the `ToolContext` (`signal`, `toolCallId`, `step`)
- `execute()` enforces the timeout and propagates cancellation
- `execute()` returns `Result<Output>` instead of throwing

## See also

- [tool()](/primitives/tool) — defining tools and the handler context
- [Testing](/guide/testing) — testing tools with execute()
- [Error Types](/reference/errors) — ParseError, ToolError, TimeoutError
