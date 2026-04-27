# 03 — The Adapter Contract

**Source:** `packages/flint/src/adapter.ts`
**See also:** Doc 01 (types), Doc 02 (errors)

## NormalizedRequest

`NormalizedRequest` is the single type the core passes to every adapter. It has 9 fields:

**`model: string`** — The provider-specific model identifier string (e.g. `"claude-opus-4-5"`, `"gpt-4o"`). The adapter passes it through verbatim to the provider's wire request. No normalization — the caller is responsible for supplying the right string for the target adapter. This is intentional: a canonical model enum would require core changes for every new model release (providers add models frequently), model strings are inherently provider-specific with no universal normalization possible, and keeping `model` as a raw string allows adding new adapters and new models without any core changes.

**`messages: Message[]`** — The full conversation history as Flint's `Message` union. Adapters translate each branch to the provider's wire format: `system` → Anthropic's top-level `system` field or OpenAI's `{ role: 'system' }` message; `user` with `ContentPart[]` → the provider's multi-modal content array; `tool` → Anthropic's `tool_result` block nested inside a `user` turn, or OpenAI's top-level `{ role: 'tool', tool_call_id }` message. The adapter owns all of this translation; the core passes `messages` without inspecting its contents.

**`tools?: Tool[]`** — Array of `Tool<unknown, unknown>` definitions to expose to the model. The adapter converts each tool to the provider's schema format. For JSON Schema derivation the adapter uses `tool.jsonSchema ?? { type: 'object' }`: if the tool author supplied a manual `jsonSchema` override it wins; otherwise the fallback is a permissive catch-all. This is intentional — the `Tool.input` field holds a `StandardSchemaV1` validator, but Standard Schema does not guarantee a spec-compliant JSON Schema can always be derived from an arbitrary validator, so the adapter does not attempt automatic derivation.

**`schema?: StandardSchemaV1`** — A Standard Schema validator for structured-output mode. When present, the adapter must instruct the provider to emit JSON conforming to the schema. Adapters derive the JSON Schema for the wire request using `tool.jsonSchema ?? { type: 'object' }` from the `Tool` type — `jsonSchema` is Flint's explicit escape hatch for adapter authors to supply a spec-compliant JSON Schema. There is no guaranteed way to derive a full JSON Schema from an arbitrary `StandardSchemaV1` instance (the `['~standard'].types` property holds TypeScript type witnesses, not a JSON Schema). This is not a raw JSON Schema object — it is a Standard Schema instance. Adapters must not pass it directly to the provider; they must use the `jsonSchema` escape hatch or fall back to `{ type: 'object' }`.

**`maxTokens?: number`** — Maximum completion tokens to generate. When absent the adapter may omit the field (provider default) or apply its own cap. The field is not required because many exploratory or chat use cases don't need a hard limit.

**`temperature?: number`** — Sampling temperature. Provider semantics differ slightly (some clamp, some interpolate differently), but the adapter passes through the value as-is. When absent the adapter omits the field and lets the provider use its default.

**`stopSequences?: string[]`** — List of strings that, if generated, cause the model to stop early. The adapter passes these through to the provider's stop sequence parameter. When absent the field is omitted.

**`cache?: 'auto' | 'off'`** — Cache control hint. Only the Anthropic adapter acts on this field; all other adapters ignore it. When `'auto'`, the Anthropic adapter adds `cache_control: { type: 'ephemeral' }` breakpoints to mark cacheable content boundaries. When `'off'` or absent, no cache control headers are added. The core passes this field through exactly as supplied by the caller — it does not set `cache` autonomously. Callers set `cache: 'off'` when cache hits are undesirable (e.g. benchmarks measuring raw latency).

**`signal?: AbortSignal`** — An `AbortSignal` from the caller. Adapters pass this signal to `fetch` (or the provider SDK's equivalent) so that aborting the signal cancels the in-flight HTTP request. When absent, the request runs to completion or timeout. The core itself does not cancel requests; callers that need cancellation create an `AbortController` and pass `controller.signal`.

## NormalizedResponse

`NormalizedResponse` is what every successful adapter call returns.

**`message: Message & { role: 'assistant' }`** — The intersection type is load-bearing. `Message` is a four-branch union; TypeScript distributes `& { role: 'assistant' }` over each union member. The non-assistant branches become `never` (e.g. the `role: 'system'` branch becomes `'system' & 'assistant'` which is `never`), and `never` members simplify away, leaving only the assistant shape. The result type is `{ role: 'assistant'; content: string; toolCalls?: ToolCall[] }`. Callers can access `response.message.toolCalls` without first branching on `role`, because TypeScript has already narrowed to the assistant shape. This distribution-to-never pattern generalises to any discriminated union — understanding the mechanism explains why intersecting a union with a literal type is a reliable narrowing technique. The adapter is responsible for assembling `toolCalls` from the provider's tool-use blocks and `content` from any text output in the same turn.

**`usage: Usage`** — Token counts for the call. `Usage` has three fields: `input: number`, `output: number`, and `cached?: number`. `cached` is only populated by the Anthropic adapter when cache hits are reported; OpenAI-compatible adapters leave it absent. The budget system accumulates these values across calls.

**`cost?: number`** — Optional dollar cost for the call. Adapters that know their pricing tables (input-token cost, output-token cost, cached-token cost) compute this and include it. Adapters that don't know their pricing — e.g. a custom OpenAI-compatible endpoint with unknown pricing — omit the field. The budget system treats `undefined` cost as zero for budget accounting purposes but logs a warning when cost tracking is enabled and cost is missing.

**`stopReason: StopReason`** — Why the model stopped generating. The adapter maps the provider's stop reason string to one of four values: `'end'` (natural completion), `'tool_call'` (model is requesting tool execution), `'max_tokens'` (output was truncated), `'stop_sequence'` (a stop string was hit). The agent loop branches on this value to decide whether to continue iterating.

**`raw?: unknown`** — The unmodified response body from the provider, preserved as-is before any normalization. Adapters that include this field let callers inspect provider-specific fields that `NormalizedResponse` does not surface — for example Anthropic's `model` echo-back, OpenAI's `system_fingerprint`, or per-chunk metadata during streaming. Also the primary debugging surface: when a normalized field looks wrong, comparing against `raw` shows exactly what the provider sent.

## AdapterCapabilities

`AdapterCapabilities` is a flat object with three optional boolean fields. The `capabilities` property is part of the `ProviderAdapter` interface; callers inspect it to conditionally use features rather than hard-coding provider names.

**`promptCache?: boolean`** — Whether this adapter supports prompt caching. `true` for the Anthropic adapter (which acts on `cache: 'auto'`), `false` or absent for OpenAI-compatible adapters (which ignore the `cache` field entirely). Callers and the core can check this before setting `cache: 'auto'` to avoid sending a field that will be silently ignored.

**`structuredOutput?: boolean`** — Whether this adapter supports schema-constrained structured output. Both the Anthropic adapter and OpenAI-compatible adapters set this to `true`. When `false` or absent, callers must not pass a `schema` field on the request, or must handle the possibility that the response body is not guaranteed JSON-conformant.

**`parallelTools?: boolean`** — Whether the adapter and underlying model support returning multiple tool calls in a single turn. Both current adapters set this to `true`. When `false`, the agent loop should not assume `toolCalls` has more than one entry per response turn, and tool orchestration must serialize accordingly.

## ProviderAdapter interface

```ts
export interface ProviderAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  call(req: NormalizedRequest): Promise<NormalizedResponse>;
  stream(req: NormalizedRequest): AsyncIterable<StreamChunk>;
  count?(messages: Message[], model: string): number;
}
```

**Interface not abstract class.** TypeScript uses structural typing: any object whose shape satisfies the interface is a valid `ProviderAdapter`, regardless of inheritance. This means the test suite's `mockAdapter` — a plain object literal with stub implementations of `call` and `stream` — is a valid adapter with zero boilerplate. An abstract class would require `extends` at every implementation site, would prevent using object literals, and would couple unrelated adapters to a shared runtime ancestor. The interface imposes zero runtime cost and maximal implementation flexibility.

**`readonly name: string`** — A stable identifier for the adapter instance, used in log output, error messages, and capability introspection. `readonly` prevents accidental mutation after construction.

**`call` contract.** Must resolve with a `NormalizedResponse` on success. By convention, adapters should throw `AdapterError` on failure — this is not enforced by the type system, but the core's `call` primitive wraps the adapter's `call` in a try/catch and will wrap any thrown `Error` in an `AdapterError` anyway. Throwing `AdapterError` directly (rather than a generic `Error`) ensures error codes and cause chains are meaningful in the returned `Result`. Never returns `Result<NormalizedResponse>` — keeping the adapter boundary throw-based means adapter authors write natural async/await code without constructing `Result` objects, while the public API still never throws.

**`stream` contract.** Returns `AsyncIterable<StreamChunk>`, not `ReadableStream<StreamChunk>`. `AsyncIterable` works natively in every JS environment that supports `for await...of` — Node.js, Bun, Deno, browsers — without requiring a `TransformStream` or `ReadableStream` adapter. `ReadableStream` is a browser API; its Node.js implementation has historically had behavioral differences, and consuming one with `for await...of` requires specific runtime support or polyfills. `AsyncIterable` is the lowest-common-denominator async pull interface and composes directly with the core's `stream` primitive. Adapters implement it by yielding the four `StreamChunk` variants in order: zero or more `text` deltas, zero or more `tool_call` chunks (each complete when emitted), one `usage` chunk, then one `end` chunk. This ordering is by convention — the interface does not enforce it via types or runtime checks. If the ordering matters to the consumer, the consumer currently trusts adapter conformance.

**`count` contract.** Optional. Adapters that have a fast, cheap token-counting API (e.g. a provider-side `/count_tokens` endpoint) implement this to return a synchronous token count. When absent, the core falls back to `approxCount`, which estimates token count from character length without a provider round-trip. Adapters that implement `count` must return a synchronous `number` — the type signature enforces this, as `count` returns `number` not `Promise<number>`. Adapters whose provider counting API is inherently async simply cannot implement `count` and should leave it absent; the core falls back to `approxCount`. There is no workaround (such as batching or caching) that makes an async API synchronous without blocking the event loop. Leaving `count` absent is the correct choice for async-only counting providers.

## Normalization philosophy

The adapter owns 100% of the format translation between Flint's internal types and the provider's wire format. The core — `call`, `stream`, `agent` — never references Anthropic's `tool_use` content block type, never constructs OpenAI's `function` wrapper inside a tool call, and never inspects provider-specific response fields. All of that knowledge lives exclusively inside the adapter implementation.

`NormalizedRequest` and `NormalizedResponse` are the stable contract boundary. The core constructs a `NormalizedRequest` from its inputs and passes it to `adapter.call` or `adapter.stream`. The adapter translates it to and from the provider's wire format and returns a `NormalizedResponse`. The core processes the normalized response. Neither side knows anything about the other's internal representation.

The direct consequence: adding a new provider is a purely additive change — write a new file that exports an object implementing `ProviderAdapter`, no changes to any existing file. No `switch` statement in the core needs updating, no union type needs a new branch, no abstract class needs a new concrete subclass. The interface contract is the complete specification; if the object satisfies it, it works.

This also means the core can be tested against an adapter that never makes network calls. Below is a minimal illustrative adapter — a plain object literal that satisfies the interface with the least possible code:

```ts
const minimalAdapter: ProviderAdapter = {
  name: 'mock',
  capabilities: { structuredOutput: true, parallelTools: true },
  call: async (req) => ({ message: { role: 'assistant', content: 'ok' }, usage: { input: 0, output: 0 }, stopReason: 'end' }),
  stream: async function* (req) { yield { type: 'end', reason: 'end' }; },
};
```

No import of a base class, no `extends`, no overhead. The structural interface is the entire coupling point between the core and any provider — past, present, or future.

For actual tests, use the library's `mockAdapter` / `scriptedAdapter` utilities exported from `flint/testing`. These track the full call history (`adapter.calls`), support scripted per-call responses, and handle both `call` and `stream` — so tests can assert what requests were made and control what responses come back without any boilerplate.
