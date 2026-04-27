# 06 — Primitives

**Source:** `packages/flint/src/primitives/`
**See also:** Doc 01 (types), Doc 02 (errors), Doc 03 (adapter contract), Doc 07 (budget)

---

## validate

`validate.ts` is the single entry point for Standard Schema validation across the entire library. Every schema-shaped input — tool inputs, structured response parsing — goes through here.

### Standard Schema protocol call

The call is `schema['~standard'].validate(value)`. The bracketed key is intentional: `~standard` is not a valid JS identifier in dot-notation, so the Standard Schema spec uses this bracket access as the protocol's wire interface. The `schema` parameter is typed as `StandardSchemaV1<unknown, T>`, meaning the library accepts any conforming schema (Zod, Valibot, ArkType, etc.) without importing their runtime.

### Promise unwrapping

The return type of `.validate()` is `StandardSchemaV1.Result<T> | Promise<StandardSchemaV1.Result<T>>`. The primitive captures the call synchronously and then checks `instanceof Promise`:

```ts
let result = schema['~standard'].validate(value);
if (result instanceof Promise) result = await result;
```

This avoids unconditionally awaiting a sync value (which would be a microtask round-trip overhead multiplied across every tool call), while still being correct when a schema library performs async coercions or remote lookups. The function itself is `async` so both paths are safe to `await` at the call site.

### `issues` check

After resolution, the result is a discriminated union: success has `value`, failure has `issues`. The check is `'issues' in result && result.issues !== undefined` — both conditions are required because some schemas leave an empty `issues` array on success rather than omitting the key entirely. Only a defined, non-empty issues array constitutes a failure.

### `ValidationError` contents

On failure the primitive constructs a `ValidationError` with a fixed message `'Schema validation failed'`, code `'validation.failed'`, and `cause: result.issues`. The raw issues array from the schema library becomes the `cause`, preserving every individual issue (path, message, schema internals) for downstream inspection. Callers who want the first human-readable message can read `error.cause[0].message`; callers who want structured detail get the full array. The error code is stable and machine-matchable.

---

## tool

`tool.ts` provides a single constructor function that doubles as a TypeScript inference anchor.

### Identity-ish constructor

`tool(spec)` returns an object with the same fields as `spec`. It is not a class, not a prototype chain, not a wrapper — the returned value is a plain object with the same keys. The structural output is identical to what you'd get writing the object literal directly.

### Why it exists: generic inference anchor

Without the `tool()` call, a caller writing a tool definition inline must manually annotate the generic parameters `Input` and `Output`:

```ts
// Without tool(): must annotate manually
const t: Tool<{ q: string }, SearchResult[]> = { name: ..., handler: async (input) => ... };
```

With `tool()`, TypeScript infers `Input` and `Output` from the `handler` signature:

```ts
// With tool(): inferred from handler
const t = tool({ name: ..., handler: async (input: { q: string }): Promise<SearchResult[]> => ... });
```

The function call site is the inference trigger. TypeScript resolves generics at function call boundaries, not at object literal boundaries, so the constructor function is the minimal surface needed to capture the handler's type parameters and propagate them to the returned `Tool<Input, Output>` type. This is a well-known TypeScript pattern for library-defined types that need to carry user-defined generics without requiring explicit annotation.

### Optional field spread pattern

`permissions`, `timeout`, and `jsonSchema` are forwarded only when present:

```ts
...(spec.permissions !== undefined ? { permissions: spec.permissions } : {})
```

This three-field spread pattern ensures the returned object doesn't carry `undefined`-valued keys. Callers checking `'timeout' in tool` (as `execute` does) get `false` when the field was never set, rather than `true` with an `undefined` value. The absence of the key is semantically meaningful throughout the rest of the runtime.

---

## execute

`execute.ts` is the safe harness for calling a tool handler: validate input, run handler, enforce timeout, normalize errors into `Result`.

### `validate` first

`execute` calls the `validate` primitive on `rawInput` using `t.input` as the schema. On failure, the `ValidationError` from `validate` is re-wrapped in a `ParseError` with code `'parse.tool_input'`. The re-wrapping is deliberate: at the call site (`execute`), the failure semantics are "the tool's input could not be parsed", not "generic schema validation failed". The original `ValidationError` is preserved as `cause`, so the full issue chain is still accessible.

### `runHandler` closure

```ts
const runHandler = async (): Promise<Output> => t.handler(parsed.value);
```

The handler invocation is extracted into a zero-argument async closure so that the same call expression can be used in both the no-timeout path (`await runHandler()`) and the timeout path (`Promise.race([runHandler(), timeoutPromise])`). Without this extraction, the timeout branch would need to duplicate the handler call, or use a differently-shaped expression that complicates the type on the race.

### No-timeout path vs `Promise.race` timeout path

When `t.timeout === undefined`, `execute` runs `runHandler()` directly inside a `try/catch`. This is the zero-overhead path — no timer allocation, no race setup.

When `t.timeout` is defined, a second promise is created that rejects after `t.timeout` milliseconds with a pre-constructed `TimeoutError`. Both promises are passed to `Promise.race`:

```ts
const output = await Promise.race<Output>([
  runHandler(),
  new Promise<Output>((_, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(...)), t.timeout);
  }),
]);
```

`Promise.race` resolves or rejects with whichever promise settles first. If the handler is fast, the timeout promise never fires. If the timeout fires first, the race rejects with `TimeoutError` and the handler's eventual resolution or rejection is silently dropped (no memory leak because the handler promise itself has no other references after the race resolves).

### `TimeoutError` vs `ToolError` discrimination in catch

The single `catch` block handles both timeout rejections and handler-thrown errors. The discriminant is `instanceof TimeoutError`:

```ts
} catch (e) {
  if (e instanceof TimeoutError) {
    return { ok: false, error: e };
  }
  return { ok: false, error: new ToolError(..., { cause: e }) };
}
```

`TimeoutError` is returned as-is; it was already constructed with the right code and message. Anything else is wrapped in `ToolError` with code `'tool.handler_threw'`. This distinction matters at the agent loop level, where a timeout may trigger retry logic or tool removal, while a handler throw signals a bug in the tool implementation.

### `clearTimeout` in finally

```ts
} finally {
  if (timeoutId !== undefined) clearTimeout(timeoutId);
}
```

The `finally` block runs whether the race resolved, rejected with `TimeoutError`, or rejected with a handler error. Without it, if the handler resolves first, the timeout timer remains queued in the event loop for up to `t.timeout` milliseconds. In high-throughput agent loops running many tool calls, accumulating stale timers adds memory pressure and can cause spurious `TimeoutError` objects to be constructed (then dropped) after the race has already settled. The `finally` cancels the timer unconditionally.

---

## count

`count.ts` is the two-line routing layer between the adapter's exact token counter and the library's built-in approximation.

### Adapter delegation

```ts
if (adapter?.count) return adapter.count(messages, model);
```

When the adapter exposes a `count` method (optional on `ProviderAdapter`), `count` delegates immediately. The adapter's implementation may call the provider's token-counting API (e.g., Anthropic's `/v1/messages/count_tokens`), which is exact but incurs a network round-trip. Adapter is optional (`adapter?`) so `count` can be called without any adapter at all.

### Fallback to `approxCount`

`approxCount` estimates token count from character length without any network call. The algorithm:

- **Per message:** adds `ROLE_OVERHEAD = 4` tokens (accounts for the role prefix and message delimiter in the serialized prompt format).
- **String content:** `Math.ceil(length / 3.5)` — the constant `3.5` chars/token is a reasonable average for English prose and JSON; it underestimates for dense symbol-heavy content and overestimates for whitespace-heavy content.
- **Multipart content:** iterates parts; text parts use the same character division; image parts use a flat `IMAGE_TOKENS = 512` (a rough mid-range for Anthropic's vision pricing tier).
- **Tool calls on assistant messages:** each tool call gets `ROLE_OVERHEAD` plus the character-divided estimate of its serialized arguments.

### Why approximate is acceptable

Token counting feeds two consumers: budget estimation (is the agent approaching its token limit?) and context window pre-checks (will this request exceed the model's max input?). Both use the count as a soft signal, not a hard gate. A 5–10% error in either direction doesn't cause correctness failures — the hard enforcement happens at the provider's API layer when the actual request is made. The fallback also runs synchronously and at zero cost, making it safe to call frequently inside planning loops without worrying about rate limits or latency.

---

## call

`call.ts` is the non-streaming primitive: takes normalized options, runs one adapter round-trip, returns `Result<CallOutput<T>>`.

### Option validation

A guard at the top throws `TypeError` synchronously (not as a `Result`) if `options`, `options.adapter`, `options.model`, or `options.messages` is falsy. These are programmer errors, not runtime failures — throwing rather than returning `{ ok: false }` makes incorrect call sites fail loudly at development time rather than producing silent error results that might be silently swallowed upstream.

### Compress application

If `options.compress` is defined, it is called as `await options.compress(options.messages, ctx)` before the budget check. The `ctx` object carries `model` and, if present, `budget` (so transforms like `summarize` can inspect remaining budget). Compression runs before the budget check because it may reduce message count enough to change whether the budget is considered exhausted — compressing first gives the most accurate pre-check.

### `assertNotExhausted` before the adapter call

`options.budget.assertNotExhausted()` is called after compression but before constructing the request. `assertNotExhausted` uses `>=` semantics: it throws `BudgetExhausted` if the used count is already at or beyond the limit. This prevents sending a request when the budget has zero headroom remaining, avoiding a round-trip that would immediately result in a `consume`-time exhaustion anyway. The throw is caught and returned as `{ ok: false, error }` — it is converted from an exception (budget's interface) to a `Result` error (call's interface).

### `NormalizedRequest` assembly

The request object is built with the same conditional spread pattern as `tool`:

```ts
const req: NormalizedRequest = {
  model: options.model,
  messages,
  ...(options.tools !== undefined ? { tools: options.tools } : {}),
  ...(options.schema !== undefined ? { schema: options.schema } : {}),
  ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  ...(options.stopSequences !== undefined ? { stopSequences: options.stopSequences } : {}),
  ...(options.cache !== undefined ? { cache: options.cache } : {}),
  ...(options.signal !== undefined ? { signal: options.signal } : {}),
};
```

Only `model` and `messages` are unconditionally present. Every other field is omitted rather than set to `undefined`, because adapter implementations inspect key presence (`'tools' in req`) to decide whether to include tool definitions in the serialized request body. Passing `tools: undefined` would cause an adapter to serialize an empty tools block or behave incorrectly.

### `adapter.call` in try/catch → `AdapterError`

The adapter call is wrapped in `try/catch`. Any thrown value — provider SDK error, network error, JSON parse error, anything — is caught and returned as `{ ok: false, error: new AdapterError(...) }`. This is the boundary where exceptions leave the adapter world and enter the `Result` world. Code above `call` never needs to try/catch adapter calls.

### `budget.consume` after

After a successful adapter response, `budget.consume` is called with `resp.usage` plus `resp.cost` if present. `consume` increments internal counters and then checks whether any limit has been crossed; if so it throws `BudgetExhausted`. This post-call throw is also caught and returned as a `Result` error. The asymmetry — `assertNotExhausted` before, `consume` after — reflects the lifecycle: pre-check prevents obviously-wasted requests, post-consume enforces the limit based on actual usage reported by the provider.

### Schema validation branch

The structured output branch only executes when `options.schema` is present AND `resp.stopReason !== 'tool_call'`. The `tool_call` guard exists because when the model decides to call a tool instead of producing a structured output, its `content` field is either empty or contains a tool-use block — not parseable JSON conforming to the output schema. Attempting to validate tool-call responses against the schema would always fail, producing spurious `ParseError` results. The branch:

1. `JSON.parse(resp.message.content)` — if this throws, returns `ParseError` with code `'parse.response_json'`.
2. `validate(parsed, options.schema)` — runs the Standard Schema validation; on failure returns the `ValidationError` directly (not re-wrapped).
3. On success, sets `output.value = validated.value`.

### Full `CallOutput` shape

```ts
type CallOutput<T> = {
  message: Message & { role: 'assistant' };  // the assistant turn, for appending to history
  value?: T;                                  // present only if schema provided and not tool_call
  usage: Usage;                               // input/output/cached token counts
  cost?: number;                              // present only if adapter reported cost
  stopReason: StopReason;                     // 'end_turn' | 'tool_call' | 'max_tokens' | 'stop_sequence'
};
```

`message` is always present and ready to append to the conversation history. `value` is absent when no schema was given or when `stopReason === 'tool_call'`. `cost` mirrors the adapter's optional reporting — not all providers return cost.

---

## stream

`stream.ts` is the streaming primitive. It is an async generator that performs the same compress/budget preamble as `call`, then delegates to `adapter.stream` and re-yields chunks while intercepting usage chunks for budget tracking.

### Same compress/budget-check preamble as `call`

The compress step and `assertNotExhausted` check are identical in structure and ordering to `call`. One difference: in `stream`, `assertNotExhausted` throws directly (not caught into a `Result`) because the function signature is `async function*` — generators cannot return a `Result` on error; they can only throw. Callers of `stream` must wrap the iteration in try/catch to handle `BudgetExhausted`. This is a deliberate asymmetry: streaming and non-streaming primitives have different error surfaces due to the generator constraint.

The `NormalizedRequest` assembly is identical to `call`'s conditional spread pattern across all seven optional fields.

### Delegates to `adapter.stream`

```ts
for await (const chunk of options.adapter.stream(req)) { ... }
```

`adapter.stream` returns an `AsyncIterable<StreamChunk>`. The primitive consumes it with `for await`, giving it the opportunity to intercept each chunk before re-yielding.

### Intercepts `usage` chunks

When a chunk with `type === 'usage'` arrives and a budget is present:

```ts
if (chunk.type === 'usage' && options.budget) {
  options.budget.consume({
    ...chunk.usage,
    ...(chunk.cost !== undefined ? { cost: chunk.cost } : {}),
  });
}
```

`consume` may throw `BudgetExhausted` — if it does, the exception propagates out of the generator, terminating the iteration and surfacing the error to the caller. This is the streaming equivalent of `call`'s post-response `consume` catch block, but without the `Result` wrapping.

### Re-yields all chunks including the usage chunk

`yield chunk` runs unconditionally after the intercept block, regardless of whether the chunk was a `usage` chunk. The consumer receives every chunk the adapter emits, including the usage metadata. This is important because the caller may need the usage data for its own display, logging, or metrics — the primitive consuming the chunk for budget purposes does not entitle it to suppress the chunk from the caller. The budget tracking is a side effect, not a filter.
