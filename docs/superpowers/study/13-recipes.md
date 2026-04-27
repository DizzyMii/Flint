# 13 — Recipes

**Source:** `packages/flint/src/recipes.ts`
**See also:** Doc 09 (agent loop — react wraps agent), Doc 06 (call primitive — used by retryValidate and reflect), Doc 11 (chunk — used by summarize recipe)

---

## react

`react` is a thin wrapper over `agent` that supplies a fixed system prompt encoding the ReAct reasoning format.

### REACT_SYSTEM

```ts
const REACT_SYSTEM =
  'You are a ReAct agent. Think step by step. Use tools when needed. When you have the final answer, respond without calling tools.';
```

The prompt instructs the model to reason step by step (Thought), use tools when needed (Action), and produce a direct response when it has a final answer (terminal condition). The classic ReAct loop — Thought → Action → Observation → Thought → ... — is entirely a property of how the model interprets this instruction. No code in `react` or `agent` explicitly parses "Thought:", "Action:", or "Observation:" prefixes. The model produces them as part of its content when following the instruction; the agent loop treats that content as an ordinary assistant message and simply checks `stopReason === 'tool_call'` to decide whether to continue. The reasoning pattern is prompt-driven, not parser-driven.

### Implementation

```ts
export async function react(opts: ReactOptions): Promise<Result<AgentOutput>> {
  const { adapter, model, question, tools, budget, maxSteps } = opts;
  const messages: Message[] = [
    { role: 'system', content: REACT_SYSTEM },
    { role: 'user', content: question },
  ];
  return agent({ adapter, model, messages, tools, budget,
    ...(maxSteps !== undefined ? { maxSteps } : {}) });
}
```

`react` prepends `REACT_SYSTEM` as a system message and seeds the conversation with the caller's `question` as the first user turn. It then forwards everything to `agent` unchanged. The `maxSteps` conditional spread avoids passing `maxSteps: undefined` to `agent`, since `agent` defaults `maxSteps` to `Number.POSITIVE_INFINITY` when the key is absent — passing the key explicitly as `undefined` would shadow that default with `undefined`, which `??` would then still resolve to `Infinity`, but passing an explicit undefined key is semantically imprecise. The conditional spread is the same defensive pattern used throughout the codebase.

### Why this is the entire implementation

ReAct is a prompting technique, not an execution architecture. The agent loop in `agent.ts` already handles the Thought→Action→Observation cycle mechanically: it calls the model, if the model requests tools it executes them (Observation), appends results to the conversation, and loops. The model's Thought and Action outputs are just text in `message.content`. The `REACT_SYSTEM` prompt tells the model to produce that reasoning structure — nothing more is needed. Adding `REACT_SYSTEM` is the difference between an agent that may or may not reason explicitly and one that is instructed to. Changing the reasoning strategy (e.g., Chain-of-Thought, Tree-of-Thought, ReWOO) requires only changing the system prompt, not the loop.

---

## retryValidate

`retryValidate` calls the `call` primitive with a schema and automatically retries on validation or parse failures, coaching the model toward a valid response with each retry.

### Loop structure

```ts
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  const res = await call({ adapter, model, messages: convo, schema });
  ...
}
```

The loop runs up to `maxAttempts` times. `convo` is a shallow copy of `options.messages` made at entry — the original caller array is never mutated. The loop appends to `convo` directly so each retry carries the full conversation history including all prior correction messages.

### Success path

```ts
if (res.ok && res.value.value !== undefined) {
  return { ok: true, value: res.value.value };
}
```

`res.value.value` is the schema-validated typed output (`T`) set by `call` when parsing and validation succeed. The `!== undefined` check is required because `CallOutput<T>` has `value?: T` — it is absent when no schema is provided or when `stopReason === 'tool_call'`. Since `retryValidate` always passes a schema, `value` will be present on a successful non-tool-call response. The double condition is defensive.

### Retriable error codes

```ts
if (code === 'validation.failed' || code === 'parse.response_json') {
  const assistantMsg = convo[convo.length - 1];
  if (assistantMsg?.role === 'assistant') convo.push(assistantMsg);
  convo.push({
    role: 'user',
    content: `Your previous response failed validation: ${err.message}. Please correct it and respond with valid output.`,
  });
  lastRes = { ok: false, error: err } as Result<T>;
  continue;
}
```

Two error codes trigger retry:

- `parse.response_json` — the model's response was not valid JSON; `call` could not even attempt schema validation.
- `validation.failed` — JSON parsed successfully but failed schema validation.

Both codes represent a correctable model output failure — the model produced text but in the wrong format. The correction strategy appends the assistant's bad response to the conversation (so the model can see what it produced) followed by a user message explaining the failure and requesting correction. The `err.message` is included verbatim so the model receives the specific validation failure reason (e.g., "required field 'name' is missing").

The `if (assistantMsg?.role === 'assistant') convo.push(assistantMsg)` guard checks whether `convo`'s last element is already an assistant message before re-appending it. `assistantMsg` is `convo[convo.length - 1]` — the last element already in `convo`, not the response from the current failed `call`. On every normal path through the loop, `convo` ends with a user message: either the original caller messages (first iteration) or the correction prompt appended in the previous iteration. So `assistantMsg?.role` is never `'assistant'` during normal execution — this guard is dead code on the normal retry path. It is a defensive belt against a caller pre-seeding `convo` with a trailing assistant message, or some other unexpected state that leaves `convo` ending with an assistant turn. If that were to happen, pushing `assistantMsg` again would duplicate the message; the guard prevents that corruption.

### Non-retriable errors: bail immediately

```ts
return { ok: false, error: err } as Result<T>;
```

Any error code other than `validation.failed` and `parse.response_json` returns immediately. These represent non-correctable failures: adapter errors (`adapter.call_failed`), budget exhaustion (`budget.exhausted`), abort signals. Retrying after an adapter failure would repeat a request that the adapter or network cannot handle. Retrying after budget exhaustion would always produce another budget exhaustion. Surfacing these immediately is correct — the error is not something a correction prompt can fix.

### Tool-call stop reason: redirect

```ts
// res.ok but no value — tool-call response
convo.push(res.value.message);
convo.push({
  role: 'user',
  content: 'You must produce a direct response matching the schema, not call tools.',
});
lastRes = undefined;
```

When `call` returns `ok: true` but `value` is `undefined`, it means the model responded with `stopReason === 'tool_call'` — it wanted to call a tool rather than produce structured output. `retryValidate` is not designed to execute tools; it expects a direct structured response. The model's tool-call message is appended to the conversation (so the model can see its own behavior) followed by a user message explicitly redirecting it away from tool use. `lastRes` is set to `undefined` — if this is the final attempt, the fallback at the end of the loop uses the `??` operator to return a generic exhaustion error rather than the tool-call result, which would be meaningless to return as a `Result<T>`.

### `lastRes` tracking

```ts
let lastRes: Result<T> | undefined;
// ... in validation.failed branch:
lastRes = { ok: false, error: err } as Result<T>;
// ... in tool_call branch:
lastRes = undefined;
// ... at end of loop:
return lastRes ?? { ok: false, error: new Error('retryValidate: maxAttempts exhausted') as never };
```

`lastRes` captures the most recent retriable error result. At loop exhaustion, if `lastRes` is defined, it carries the last validation/parse error — which is the most informative error to return (it contains the schema failure detail). If `lastRes` is `undefined` (only possible if the last attempt produced a tool-call response), the fallback generic error is returned. The `as never` cast on the fallback `new Error(...)` is a type escape hatch: `Result<T>` requires `{ ok: false; error: FlintError }`, and a plain `Error` is not assignable to `FlintError`. Rather than satisfy the constraint properly — which would require importing `FlintError` and constructing one — the cast bypasses the type system entirely. This is acceptable because the fallback path is a defensive backstop that should rarely fire in practice; coupling the module to `FlintError` purely for this edge case would be unnecessary overhead.

### Why loop not recursion

`retryValidate` could be written recursively by calling itself on failure with the updated `convo`. A loop is used instead for stack safety: with `maxAttempts` set to a large value, recursion would build a call stack `maxAttempts` frames deep. In JavaScript, deep async recursion is bounded by the engine's stack, not the heap, and a sufficiently large `maxAttempts` would cause a stack overflow. A `for` loop uses O(1) stack depth regardless of `maxAttempts`.

---

## reflect

`reflect` implements a generate-critique-revise loop: it calls the model, evaluates the output with a caller-supplied critic, and if the critic rejects the draft, appends the critique and retries.

### Loop bounds: `maxRevisions + 1` total iterations

```ts
for (let i = 0; i <= maxRevisions; i++) {
```

The loop runs from `i = 0` through `i = maxRevisions` inclusive — that is `maxRevisions + 1` total iterations. Iteration `i = 0` is the initial draft attempt. Iterations `i = 1` through `i = maxRevisions` are revisions. If the loop used `i < maxRevisions`, the initial call at `i = 0` would consume one revision slot, leaving only `maxRevisions - 1` actual revision passes. The `<=` bound ensures `maxRevisions` is the count of revisions after the initial draft, not including the initial draft.

**Edge case: `maxRevisions = 0`.** With `maxRevisions = 0`, the loop runs exactly once (`i = 0` only). The initial draft is generated, the critic is called once, and the loop ends — regardless of whether the critic approved. If the critic approves, the early-exit path returns the draft. If the critic rejects, the critique is injected into `convo` and the loop ends; the fail-open path then returns the draft anyway. This is effectively "generate once, evaluate, return regardless" mode. It is useful as a lightweight quality gate: the caller still gets the critic's feedback via the `crit.critique` value (if it wraps `reflect` to capture it), but no revision tokens are spent and the function always produces a result.

### Critic callback

```ts
critic: (draft: string) => Promise<{ ok: boolean; critique: string }>
```

The caller provides all evaluation logic. `reflect` knows nothing about what "good" means — it only knows how to loop and inject critique. This design allows critics that call a second LLM, run a regex, execute tests, or apply any other evaluation strategy. The `critique` string is what gets injected into the conversation on rejection; its content is entirely the caller's responsibility.

### Early exit on approval

```ts
const crit = await critic(lastDraft);
if (crit.ok) return { ok: true, value: lastDraft };
```

If the critic approves, `reflect` returns immediately with the current draft. It does not wait for `i` to reach `maxRevisions`. This is correct because the critic may approve after the first draft — waiting for more revisions would waste tokens and potentially degrade the output. The `lastDraft` is the string content of `res.value.message.content` from the current iteration's `call`.

### Critique injection

```ts
convo.push(res.value.message);
convo.push({ role: 'user', content: `Critique: ${crit.critique}. Please revise.` });
```

On rejection, the assistant's draft is appended to `convo` and then the critique is injected as a user message. The next loop iteration calls `call` with this extended conversation — the model sees its own prior draft plus the critique as instruction to revise. The critique text from `crit.critique` is prefixed with `"Critique: "` and suffixed with `"Please revise."` — a minimal but reliable framing that signals to the model both the nature of the message and the expected response.

### Fail-open: return last draft after exhausting revisions

```ts
return { ok: true, value: lastDraft };
```

After the loop exhausts all iterations without the critic returning `ok: true`, `reflect` returns `{ ok: true, value: lastDraft }` — the last draft the model produced, even though the critic never approved it. This is a fail-open design: a degraded response is better than no response. The caller receives the best attempt the model produced within the revision budget. Callers that need to know whether the critic approved can run the critic once more on the returned value, or wrap `reflect` in their own approval-check logic. `reflect` does not surface a separate `approved: boolean` field because the primary use case is "get the best revision within budget" rather than "enforce quality gates."

### Why not return `{ ok: false }` on critic exhaustion

Returning an error when the critic never approves would force callers to handle two outcome types: approved results and revision-budget-exhausted results. In practice, the last draft is useful in both cases. A caller that truly wants to enforce approval can check the result against its critic independently. The fail-open approach makes `reflect` composable — it is a revision amplifier, not a quality gate enforcer.

---

## summarize

`summarize` implements a map-reduce pipeline for summarizing text that may exceed a single context window: split into chunks, summarize each chunk independently, then combine chunk summaries with a separate reduce call.

### Chunking

```ts
const chunks = chunk(text, { size: chunkSize });
```

`chunk` from `packages/flint/src/rag.ts` splits `text` into overlapping segments of `chunkSize` characters. The overlap ensures that context spanning a chunk boundary is not silently lost — a sentence that straddles two chunks appears in both. See Doc 11 for the full overlap and stride mechanics.

### Empty-chunks early return

```ts
if (chunks.length === 0) return { ok: true, value: '' };
```

If `text` is empty or shorter than `chunkSize` in a degenerate configuration, `chunk` may return an empty array. Returning an empty summary immediately avoids a model call for empty input — the correct behavior without needing to special-case the loop below.

### Sequential per-chunk calls — why not parallel

```ts
for (const c of chunks) {
  const res = await call({ ... });
  if (!res.ok) return res;
  summaries.push(res.value.message.content);
}
```

Chunks are summarized sequentially, not with `Promise.all`. For a large document split into many chunks, parallel calls would fire all requests simultaneously, spiking token throughput and potentially triggering provider rate limits. Sequential calls spread the load over time. The cost is higher total latency — `N * per_chunk_latency` instead of `max(per_chunk_latency)` — but for summarization tasks this tradeoff is acceptable. The result quality is identical regardless of order.

The early-return on `!res.ok` propagates the first chunk-level error immediately. There is no partial-success handling — if chunk 3 of 10 fails, the function returns the error without attempting to combine the 2 already-computed summaries. This is intentional: a partial summary could be misleading (it would omit content without signaling which sections were dropped).

### Single-chunk shortcut

```ts
if (chunks.length === 1) return { ok: true, value: summaries[0] as string };
```

When the text fits in a single chunk, there is nothing to reduce — the one chunk summary is the final summary. This avoids an extra model call whose only job would be to restate a single-paragraph input. The `as string` cast is safe because `summaries` is populated only with `res.value.message.content` strings; TypeScript cannot narrow `string[]` indexing to `string` without the cast (index access returns `string | undefined` with `noUncheckedIndexedAccess`).

### Multi-chunk reduce call

```ts
const combineRes = await call({
  adapter,
  model,
  messages: [{
    role: 'user',
    content: `Combine these chunk summaries into one concise overall summary:\n\n${summaries.join('\n\n---\n\n')}`,
  }],
});
```

The reduce step sends all chunk summaries in a single call with a different instruction than the per-chunk summarization prompt. The per-chunk prompt is `"Summarize the following text concisely, preserving key facts:\n\n${c}"` — it asks the model to compress a raw text segment while retaining its key information. The reduce prompt asks to synthesize multiple already-summarized segments into one cohesive summary. Using the same prompt for both would confuse the model — a per-chunk prompt applied to summaries-of-summaries produces redundant meta-summarization behavior. A separate call with a purpose-built instruction yields a more coherent final output.

Chunk summaries are joined with `\n\n---\n\n` — a visual separator that signals to the model that each block is a distinct chunk summary, not a continuous document. This framing reduces the chance the model treats the boundary text as part of a sentence.

### Why the combine call is always separate from the per-chunk calls

The per-chunk prompt and the combine prompt have fundamentally different roles:

- Per-chunk: "You have a raw segment; extract and compress its key information."
- Combine: "You have a set of independent summaries; synthesize them into one narrative."

A single generic prompt that tried to serve both roles would produce inferior results at both. Keeping the calls separate also means the combine prompt can be tuned independently — for example, injecting a word limit, a required output format, or domain-specific merge instructions without affecting the per-chunk behavior. The two-stage design is an intentional seam for future specialization.
