# 02 — Error Taxonomy

**Source:** `packages/flint/src/errors.ts`
**See also:** Doc 01 (Result\<T\>)

## FlintError base class

`FlintError` extends native `Error`. Constructor signature: `constructor(message: string, opts: FlintErrorOptions)` where `FlintErrorOptions = { code: string; cause?: unknown }`.

The constructor calls `super(message, { cause: opts.cause })`, threading `cause` into the native Error chain so `error.cause` is populated and Node's error formatting prints the chain automatically. It then assigns `this.code = opts.code` and `this.name = 'FlintError'`.

The `name` assignment is required because the prototype chain sets `name` to `'Error'` by default — the property lives on `Error.prototype`, not on the instance. Re-assigning it on the instance shadows the prototype value, so `error.name` reflects the actual subclass name in stack traces and `util.inspect` output without needing `instanceof` at the display layer. Every subclass repeats this pattern, overwriting `name` to its own string.

`code` is `readonly string`, not a union type, so the field accepts any string at the type level and new subclasses can introduce new codes without touching the base type.

## Why string codes, not an enum

An enum compiles to a runtime object. Any module that imports the enum pulls that object into its bundle even if it only matches against one variant — dead-code elimination cannot remove a mutable object. String literals are inlined by the compiler and are fully tree-shakeable.

String codes are also forward-compatible: adding a new code (`adapter.stream`, `graph.invalid_edge`) is a non-breaking additive change. Adding an enum member is technically breaking under strict exhaustiveness checks and forces a version bump in published packages.

The codes use a dotted namespace convention (`adapter.network`, `parse.tool_input`, `budget.tokens`). This lets callers match a whole category without enumerating every variant:

```ts
if (error.code.startsWith('adapter.')) { /* any provider failure */ }
if (error.code.startsWith('budget.'))  { /* any budget limit */     }
```

Prefix matching is impossible with numeric enum values and awkward with string enums that don't encode hierarchy.

## The 7 subclasses

**`AdapterError`** — Network-level or HTTP-level provider failure. Used when the adapter cannot reach the provider or the provider returns an error response. Codes: `adapter.call_failed` (generic adapter failure), `adapter.network` (connection-level failure, e.g. DNS or socket error), `adapter.http.${status}` (non-success HTTP status, interpolated with the numeric code), `adapter.stream` (streaming connection broke mid-response), `adapter.parse` (adapter could not parse the provider's response body).

**`ValidationError`** — Standard Schema validation failed on input or output data. Code: `validation.failed`. The `cause` field holds the raw `issues` array from the schema library so callers can inspect individual field errors without parsing the message string.

**`ToolError`** — A tool handler threw during execution. Code: `tool.handler_threw`. The `cause` field is the original thrown value, preserving the original stack trace and type without wrapping it in a string.

**`BudgetExhausted`** — A budget limit was crossed during agent execution. Codes: `budget.steps` (step count exceeded), `budget.tokens` (token budget exceeded), `budget.dollars` (cost budget exceeded). Budget methods throw this class internally but the primitives layer catches it and converts it to a `Result` before it crosses the public API boundary, so external callers see it as a typed failure, not an uncaught exception.

**`ParseError`** — JSON parsing failed. Codes: `parse.response_json` (model response body was not valid JSON), `parse.tool_input` (tool input JSON parsed but failed schema validation; wraps a `ValidationError` as `cause`). The two codes distinguish a syntax failure from a semantic one.

**`TimeoutError`** — A tool execution exceeded its configured timeout. Code: `tool.timeout`. Separate from `ToolError` so callers can distinguish a hung tool from a tool that actively threw.

**`NotImplementedError`** — Marks unimplemented code paths. Unique in that its constructor takes `what: string` with no `opts` parameter; it generates both the message (`Not implemented: ${what}`) and the code (`not_implemented`) internally. This prevents callers from accidentally passing a wrong code and makes stub creation a one-liner.

## Code catalogue

All code strings used across the codebase, alphabetical:

| Code | Class |
|---|---|
| `adapter.call_failed` | `AdapterError` |
| `adapter.http.${status}` | `AdapterError` |
| `adapter.network` | `AdapterError` |
| `adapter.parse` | `AdapterError` |
| `adapter.stream` | `AdapterError` |
| `agent.max_steps_exceeded` | (agent layer, not a direct subclass) |
| `budget.dollars` | `BudgetExhausted` |
| `budget.steps` | `BudgetExhausted` |
| `budget.tokens` | `BudgetExhausted` |
| `graph.invalid_edge` | (graph layer) |
| `graph.no_matching_edge` | (graph layer) |
| `graph.node_not_found` | (graph layer) |
| `not_implemented` | `NotImplementedError` |
| `parse.response_json` | `ParseError` |
| `parse.tool_input` | `ParseError` |
| `tool.approval_denied` | (tool layer) |
| `tool.handler_threw` | `ToolError` |
| `tool.timeout` | `TimeoutError` |
| `validation.failed` | `ValidationError` |

19 entries total. The `graph.*`, `agent.*`, and `tool.approval_denied` codes are constructed by layers above `errors.ts` but still routed through one of the seven subclasses — they are not defined in `errors.ts` itself but are part of the full runtime code space.

## Why distinct classes

The primary benefit is `instanceof` narrowing. A caller can write:

```ts
try {
  await agent.run();
} catch (e) {
  if (e instanceof AdapterError)    { /* retry logic   */ }
  if (e instanceof BudgetExhausted) { /* stop the loop */ }
  if (e instanceof FlintError)      { /* all Flint errors, fallback */ }
}
```

TypeScript narrows `e` to the specific class inside each branch, giving access to `e.code`, `e.cause`, and any future subclass-specific fields without explicit casting.

The alternative — a single `FlintError` with a `type: ErrorKind` discriminant — forces callers to first catch the base class and then switch on `type`. TypeScript cannot prove exhaustiveness across a `catch` + `switch` combination the same way it can across `instanceof` checks, so the narrowing is weaker and the boilerplate is higher. It also means all error-handling knowledge lives in one sprawling switch rather than being co-located with the specific error types.

The `FlintError` base class still provides a single catch-all. Any code that doesn't need to distinguish error categories can catch `FlintError` and read `.code` as a string without caring about the class hierarchy.
