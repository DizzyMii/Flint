# 15 — Landlord: Multi-Tenant Agent Orchestration

**Source:** `packages/landlord/src/`
**See also:** Doc 09 (agent loop — each tenant runs an agent), Doc 07 (budget — shared job-level budget consumed across all tenants and the decompose call), Doc 06 (call — validateCheckpoint uses call directly)

---

## Contract and Checkpoint schemas (`contract.ts`)

```ts
export const CheckpointSchema = z.object({
  name: z.string(),
  description: z.string(),
  schema: z.record(z.unknown()),
});

export const ContractSchema = z.object({
  tenantId: z.string().default(() => crypto.randomUUID().slice(0, 8)),
  role: z.string(),
  objective: z.string(),
  subPrompt: z.string(),
  checkpoints: z.array(CheckpointSchema),
  outputSchema: z.record(z.unknown()),
  toolsAllowed: z.array(z.string()).optional(),
  toolsDenied: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).default([]),
  maxRetries: z.number().default(3),
});
```

**`CheckpointSchema`** — three fields.

- `name`: short identifier, used as the tool name suffix after sanitization.
- `description`: natural-language milestone condition. Appears in the system prompt and is the semantic criterion the LLM judge evaluates against in `validateCheckpoint`.
- `schema`: `z.record(z.unknown())` — a Zod passthrough for a JSON Schema object. Zod validates that it is a plain object (not null, not a primitive); it does not recursively validate the JSON Schema structure. The actual JSON Schema enforcement runs at checkpoint-call time via AJV in `validate.ts`.

**`ContractSchema`** — nine fields.

- `role`: short unique name for the tenant. Also used as the graph node key in `dependsOn`, as the directory name under the job output dir, and as the key in the `jobArtifacts` and `tenantOutcomes` maps. Uniqueness of `role` is assumed but not enforced at schema level — duplicate roles would cause the later contract to overwrite the earlier one in `byRole` during `resolveOrder` and in `jobArtifacts` during `orchestrate`.
- `objective`: one-sentence description of what the tenant must accomplish. Appears verbatim in the system prompt as `Objective: ${contract.objective}`.
- `subPrompt`: the task text the tenant receives as the user message. Decouples the objective (what it must do) from the prompt (what it is told). The LLM decomposing the job writes both — the objective is for the system prompt's framing, the subPrompt is the concrete instructions fed as the user turn.
- `checkpoints`: ordered list of milestones the tenant must declare. Each checkpoint becomes a tool the tenant can call. The order matters for the system prompt's checkpoint instruction list but not for pass/fail accounting — all must be passed regardless of call order.
- `outputSchema`: JSON Schema for the tenant's output as a whole. Stored on the contract but not currently validated against the final `artifacts` record in `runTenant` — it is passed to the LLM during decompose so the LLM can write a schema describing what the tenant will produce. Future enforcement would call AJV against `artifacts` before `runTenant` returns `ok`.
- `toolsAllowed` / `toolsDenied`: optional lists of tool names for per-tenant filtering. Defaults to `undefined` — when both are absent, all user tools pass through. See `filterTools` below.
- `dependsOn`: `default([])` — defaults to an empty array, meaning independent tenants require no explicit `dependsOn` declaration. Values are `role` strings, not `tenantId`s — the dependency graph is keyed on human-readable role names.
- `maxRetries`: `default(3)` — maximum number of agent-run attempts before escalation. The retry loop in `runWithRetry` runs `for (let attempt = 0; attempt < contract.maxRetries; attempt++)`, so `maxRetries: 3` allows exactly three full agent runs.
- `tenantId`: `default(() => crypto.randomUUID().slice(0, 8))` — an 8-character hex fragment auto-generated when the LLM's emitted contract does not include one (which is always the case, since `emit_plan`'s JSON schema does not include `tenantId`). This field exists for correlation in logs and events but is not used as a key in any map.

**Why Zod, not a custom validator.** `ContractSchema.safeParse` is called on every item in the LLM-emitted contracts array inside `decompose`. Zod's `safeParse` returns a discriminated `{ success: true, data } | { success: false, error }` without throwing. The `error` object carries field-level `ZodError` issues. Custom validators would require writing field-presence checks and coercion logic that Zod's `default()` already handles — in particular `tenantId`, `dependsOn`, and `maxRetries` all have defaults that would need manual injection. Zod applies those defaults automatically during `safeParse`, so the output `Contract` is always a fully-populated object even when the LLM omits those optional fields.

---

## decompose (`decompose.ts`)

### DECOMPOSE_SYSTEM prompt

```
You are the Landlord, an agentic orchestrator. Decompose the user request into independent
sub-tasks for isolated worker agents (tenants) that can run in parallel where possible.
For each tenant return: role (short unique name), objective, subPrompt (what the tenant receives),
checkpoints (list of {name, description, schema} with lenient JSON Schemas), outputSchema,
and dependsOn (roles whose outputs this tenant needs). Keep the plan minimal.
Call the emit_plan tool with the contracts array.
```

The prompt does three things: (1) establishes the Landlord persona to anchor the model in its orchestrator role, (2) enumerates the required fields so the LLM constructs a structurally complete contract, and (3) instructs the LLM to call `emit_plan` — without this imperative the model might instead respond with a prose description of the plan.

"Keep the plan minimal" is load-bearing: without it, a general-purpose LLM will over-decompose, creating spurious dependencies and unnecessary sequential ordering that eliminates parallelism.

### emit_plan tool — handwritten JSON Schema

```ts
const EMIT_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    contracts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          objective: { type: 'string' },
          subPrompt: { type: 'string' },
          checkpoints: { type: 'array', items: { ... required: ['name','description','schema'] } },
          outputSchema: { type: 'object' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['role', 'objective', 'subPrompt', 'checkpoints', 'outputSchema'],
      },
    },
  },
  required: ['contracts'],
};
```

The JSON Schema is handwritten rather than derived from `ContractSchema` via Standard Schema. The reason is structural: Standard Schema validators define runtime TypeScript validation, not necessarily serializable JSON Schema. Flint's tool machinery accepts a `jsonSchema` override field for exactly this case — when the LLM-facing shape needs to be specified explicitly to get predictable structured output from the model. Using the Zod schema's internal representation would require a Zod-to-JSON-Schema conversion step (a third-party package) and would include runtime-only Zod internals that are not valid JSON Schema. Writing the schema by hand keeps the LLM-facing contract explicit and auditable. `dependsOn` is not in `required` because the LLM reliably omits it for independent tenants — making it required would cause schema validation failures in the model's output, reducing decompose reliability.

### anySchema() — pass-through Standard Schema validator

```ts
function anySchema(): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': { version: 1, vendor: 'landlord', validate: (v) => ({ value: v }) },
  };
}
```

`tool()` in Flint requires a `input` field typed as `StandardSchemaV1`. The Standard Schema validate step runs when the tool's handler is invoked — it parses the raw LLM-supplied arguments into the typed input. For `emit_plan`, the real structural enforcement is the `jsonSchema` field sent to the model. At handler-call time, the arguments have already been coerced by the LLM into the declared JSON Schema shape, so a second parse is redundant. `anySchema()` satisfies the Standard Schema contract by always returning `{ value: v }` — the validate step always passes. The actual structure of `v` is then accessed with a type assertion (`planCall.arguments as { contracts?: unknown[] }`) rather than relying on TypeScript narrowing from the schema validator.

### Result extraction and silent drop

```ts
const planCall = result.value.message.toolCalls?.find((tc) => tc.name === 'emit_plan');
if (planCall === undefined) {
  return { ok: false, error: new Error('LLM did not call emit_plan — no plan produced') };
}

const raw = planCall.arguments as { contracts?: unknown[] };
const rawContracts = raw.contracts ?? [];

const contracts: Contract[] = [];
for (const item of rawContracts) {
  const parsed = ContractSchema.safeParse(item);
  if (parsed.success) contracts.push(parsed.data);
}
```

The result is extracted by finding the first `emit_plan` tool call in `result.value.message.toolCalls`. `call` (not `agent`) is used for decompose — a single round trip with `emit_plan` as the only tool. The LLM is expected to call `emit_plan` exactly once, terminating after the tool call. If the model returns no `emit_plan` call at all (e.g. it responded with prose instead), `decompose` returns `{ ok: false }` immediately.

Invalid contracts are silently dropped: `ContractSchema.safeParse` failure causes `continue` (implicit via the absence of a push). The rationale for silent drop over hard error: a partially-valid plan is superior to no plan. If the LLM emits 5 contracts and 1 has a structural error (e.g. missing `checkpoints`), dropping the bad contract and proceeding with the 4 valid ones preserves value. Returning `{ ok: false }` for any validation error would cause the entire job to fail on a single malformed contract — an unnecessarily brittle behavior when the overall decomposition is otherwise correct. The source includes a comment noting that a logger, if present, would receive the dropped contract details; the current implementation does not pass a logger to `decompose`, so drops are silent.

---

## resolveOrder — DFS topological sort (`orchestrate.ts`)

```ts
const WHITE = 0;  // unvisited
const GRAY  = 1;  // in-progress (on current DFS stack)
const BLACK = 2;  // finished

const color = new Map(contracts.map((c) => [c.role, WHITE]));
const order: Contract[] = [];

function visit(role: string, stack: string[]): void {
  if (color.get(role) === GRAY) {
    throw new DependencyCycleError(`Dependency cycle: ${[...stack, role].join(' -> ')}`);
  }
  if (color.get(role) === BLACK) return;
  const entry = byRole.get(role);
  if (!entry) return;      // unknown role in dependsOn — silently ignored
  color.set(role, GRAY);
  for (const dep of entry.dependsOn) {
    visit(dep, [...stack, role]);
  }
  color.set(role, BLACK);
  order.push(entry);       // push AFTER recursing — reverse post-order
}

for (const c of contracts) visit(c.role, []);
return order;
```

**WHITE/GRAY/BLACK coloring** is the standard DFS cycle-detection scheme. A node is GRAY from the moment it is entered until all of its descendants are finished. Re-visiting a GRAY node means the DFS has followed a path back to a node already on the current stack — a back edge — which is the definition of a cycle. `DependencyCycleError` is thrown immediately on GRAY revisit, with the path reconstructed from `stack` plus the revisited `role`.

**Reverse post-order** is the correct topological ordering for a DAG. A node is pushed to `order` only after all its dependencies have been recursed (and pushed). This means dependency nodes always appear before dependent nodes in the output array. `orchestrate` later calls `resolveOrder` only to validate that no cycle exists — it does not use the returned array for execution ordering. Execution ordering is handled by the gate `Promise` mechanism (dependencies release their gates before dependents can proceed).

**Unknown role in `dependsOn`** — `byRole.get(role)` returning `undefined` causes an early `return` in `visit`. This means a contract that lists a non-existent role in `dependsOn` is silently treated as having no dependency on that role. This does not throw. Combined with the gate mechanism in `runWithRetry`, the practical effect is that `gates.get(dep)?.promise` resolves to `undefined` for an unknown dep and the await is a no-op — so the tenant runs immediately.

**`DependencyCycleError`** is a named subclass of `Error` with `this.name = 'DependencyCycleError'`. In `orchestrate`, the call to `resolveOrder` is wrapped in a try/catch that converts any thrown `Error` to `{ ok: false, error }`. This is the only place where a cycle produces an observable error to the orchestrate caller.

---

## runTenant (`tenant.ts`)

### Checkpoint tools

Each `Checkpoint` becomes a `Tool` with name `emit_checkpoint__${sanitizeName(cp.name)}`.

```ts
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
```

Any character outside `[a-zA-Z0-9_-]` is replaced with `_`. This ensures the tool name is safe for all provider APIs, which typically restrict tool names to alphanumeric characters, underscores, and hyphens. A checkpoint named `"validate output"` becomes `emit_checkpoint__validate_output`. The double underscore prefix `emit_checkpoint__` serves as a namespace separator, making checkpoint tools visually distinct from user tools in logs and provider UIs.

### anyObjectSchema() — per-checkpoint input validator

```ts
function anyObjectSchema(): StandardSchemaV1<unknown, Record<string, unknown>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'landlord',
      validate: (v) => {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          return { issues: [{ message: 'Expected an object' }] };
        }
        return { value: v as Record<string, unknown> };
      },
    },
  };
}
```

Unlike `anySchema()` in `decompose`, `anyObjectSchema()` does minimal validation: it rejects non-objects (null, arrays, primitives) but accepts any object shape. This is stricter than `anySchema()` because the checkpoint handler needs `v` typed as `Record<string, unknown>` to pass to `validateCheckpoint`. The actual structure is enforced by the `jsonSchema` field on the tool — the schema the LLM uses to shape its call arguments. The Standard Schema step runs at handler invocation time and gates the TypeScript type narrowing; rejecting non-objects here prevents a class of handler crashes if the LLM produces a malformed call.

### Schema wrapping

```ts
const schema =
  cp.schema.type === 'object'
    ? cp.schema
    : { type: 'object', properties: { result: cp.schema }, required: ['result'] };
```

The `jsonSchema` field on a checkpoint tool must always be an object schema — provider tool-call APIs expect the top-level input to be an object. If the checkpoint's `schema` has `type !== 'object'` (e.g. the LLM emitted `{ type: 'string' }` as the checkpoint schema), it is wrapped in `{ type: 'object', properties: { result: <schema> }, required: ['result'] }`. This preserves the original schema as the `result` field's type constraint without rejecting the checkpoint. AJV in `validateCheckpoint` then validates the full wrapped object shape.

### Handler: checkpoint pass/fail

```ts
handler: async (input) => {
  const verdict = await validateCheckpoint(input, cp, ctx);
  if (verdict.ok && verdict.value.passed) {
    artifacts[cp.name] = input;
    return { ok: true, message: `Checkpoint '${cp.name}' passed.` };
  }
  const explanation = verdict.ok ? verdict.value.explanation : verdict.error.message;
  return {
    ok: false,
    message: `Checkpoint '${cp.name}' failed: ${explanation}. Revise and retry.`,
  };
},
```

On pass: the raw `input` (the object the LLM supplied as tool arguments) is stored in `artifacts[cp.name]`. The tool returns a success message. The model sees `Checkpoint passed.` and continues with its task.

On fail: the tool returns a failure message including the LLM judge's `explanation`. The message ends with `"Revise and retry."` — this is an explicit instruction to the model inside the tool result, prompting it to attempt a corrected checkpoint call within the same agent run rather than treating the failure as terminal. The model can call the same checkpoint tool multiple times; only the last successful call's `input` is stored (because `artifacts[cp.name]` is overwritten on each pass).

The `verdict.ok` branch covers two distinct failure cases: (1) `verdict.ok === false` means `validateCheckpoint` itself returned an error (e.g. the LLM judge's response was not valid JSON), in which case the error message is used; (2) `verdict.value.passed === false` means the validation ran successfully but the judge ruled the output does not satisfy the checkpoint description.

### filterTools

```ts
function filterTools(userTools: Tool[], contract: Contract): Tool[] {
  if (contract.toolsAllowed !== undefined) {
    return userTools.filter((t) => contract.toolsAllowed?.includes(t.name));
  }
  if (contract.toolsDenied !== undefined) {
    return userTools.filter((t) => !contract.toolsDenied?.includes(t.name));
  }
  return userTools;
}
```

`toolsAllowed` is a whitelist and is checked first — if present, only named tools are permitted. `toolsDenied` is a blacklist and is checked second — if present (and `toolsAllowed` is absent), named tools are excluded. The precedence is intentional: allowlists are more restrictive than denylists and should win when both are specified. Returning all user tools when neither is set is the least-surprise default — a contract that does not configure tool access receives the full set.

Note that checkpoint tools (`checkpointTools`) are not subject to `filterTools` — they are always prepended to `allTools` before `filterTools` runs on user tools. A tenant always has access to its own checkpoint tools regardless of `toolsAllowed`/`toolsDenied`.

### buildSystemPrompt

```ts
const parts: string[] = [`You are a ${contract.role}.`, `Objective: ${contract.objective}`];

// Checkpoint instructions
parts.push(`Checkpoints — call each tool when you reach the milestone:\n${lines.join('\n')}`);
// where each line is: `- ${cp.name}: call \`emit_checkpoint__${sanitizeName(cp.name)}\` when ${cp.description}`

// Shared artifacts
parts.push(`Context from dependencies:\n${JSON.stringify(sharedArtifacts, null, 2)}`);

// Retry context
parts.push(`Previous attempt failed. Retry context:\n${retryContext}`);
```

The prompt is assembled from `parts` joined with `\n\n`. Each section is conditionally included — checkpoints only if `checkpoints.length > 0`, shared artifacts only if the map is non-empty, retry context only if a prior attempt failed. The retry context is the `lastError` string from the previous agent run — either the missing-checkpoint error message or the agent loop's own error — and is included verbatim so the model can reason about what went wrong.

Shared artifacts are serialized as `JSON.stringify(..., null, 2)` — pretty-printed for readability. The namespaced keys (`${dep}.${key}`) are visible to the model and serve as a signal about which dependency produced which artifact. The model is responsible for selecting relevant context from the shared artifacts; the system prompt does not filter or summarize them.

### Budget fallback

```ts
const tenantBudget = ctx.budget ?? makeBudget({ maxSteps: 100 });
```

If no budget is provided in `ctx`, a fallback budget of `maxSteps: 100` is created. This prevents a tenant from running an unbounded agent loop if the caller forgot to pass a budget. The fallback is intentionally generous — 100 steps is far more than most tasks require, but it ensures the agent always terminates. In `orchestrate`, the job-level budget is passed through to `runTenant` via `ctx.budget`, so all tenants and the decompose call share the same budget instance. The budget shared-instance design means token and step spend by one tenant reduces the remaining budget available to subsequent tenants — which is the correct behavior for a shared resource.

### Missing checkpoint detection

```ts
const requiredNames = new Set(contract.checkpoints.map((cp) => cp.name));
const passedNames = new Set(Object.keys(artifacts));
const missing = [...requiredNames].filter((n) => !passedNames.has(n));

if (missing.length > 0) {
  return {
    ok: false,
    error: new Error(`Tenant finished without passing checkpoints: ${missing.join(', ')}`),
  };
}
```

After the agent exits normally (no tool calls in its final response), `runTenant` checks that every checkpoint was called and passed. The `artifacts` map is populated only on checkpoint passes (not failures), so `passedNames` contains exactly the checkpoints whose handler ran successfully and the LLM judge approved. Missing checkpoints mean the model completed its task without reaching all required milestones — this is treated as a failure and triggers a retry in `runWithRetry`. The error message names the specific missing checkpoints, making the `retryContext` passed to the next attempt directly actionable.

---

## orchestrate (`orchestrate.ts`)

### Gate promise pattern

```ts
const gates = new Map<
  string,
  { promise: Promise<Record<string, unknown>>; resolve: (v: Record<string, unknown>) => void }
>();
for (const c of plan) {
  let resolve!: (v: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>((r) => { resolve = r; });
  gates.set(c.role, { promise, resolve });
}
```

Each contract gets a `{ promise, resolve }` pair. The `promise` is an externally-resolvable `Promise` — its `resolve` function is captured and stored alongside it. When a tenant completes (either successfully or after exhausting retries), `gates.get(contract.role)?.resolve(artifacts)` is called, releasing any dependents waiting on that gate.

This pattern replaces a dependency graph executor: instead of computing which tenants are runnable at each tick, every tenant simply `await`s each of its dependency gates. The gate mechanism is self-organizing — tenants become runnable the moment all their dependency gates are resolved, with no central scheduler.

All contracts are dispatched concurrently via `Promise.all(plan.map((c) => runWithRetry(c)))`. Independent tenants (empty `dependsOn`) begin immediately. Dependent tenants block at their `await gates.get(dep)?.promise` calls until dependencies resolve. The effect is maximum parallelism within the dependency constraints.

### runWithRetry — lifecycle

```ts
async function runWithRetry(contract: Contract): Promise<void> {
  // 1. Wait for all dependency gates
  for (const dep of contract.dependsOn) {
    await gates.get(dep)?.promise;
    if (escalatedRoles.has(dep)) { /* escalation propagation */ return; }
  }

  // 2. Build sharedArtifacts
  const sharedArtifacts: Record<string, unknown> = {};
  for (const dep of contract.dependsOn) {
    for (const [k, v] of Object.entries(jobArtifacts[dep] ?? {})) {
      sharedArtifacts[`${dep}.${k}`] = v;
    }
  }

  // 3. Create work directory
  const workDir = join(baseOutputDir, contract.role);
  await mkdir(workDir, { recursive: true });

  // 4. Retry loop
  for (let attempt = 0; attempt < contract.maxRetries; attempt++) {
    const result = await runTenant(contract, toolsFactory(workDir), ctx, lastError, sharedArtifacts);
    if (result.ok) { /* resolve gate, record outcome */ return; }
    lastError = result.error.message;
    onEvent?.({ type: 'tenant_evicted', role, reason: lastError, retry: attempt + 1 });
  }

  // 5. Escalate
  escalatedRoles.add(contract.role);
  gates.get(contract.role)?.resolve({});
  onEvent?.({ type: 'tenant_escalated', role });
}
```

**Escalation propagation.** After awaiting each dependency gate, `runWithRetry` checks `escalatedRoles.has(dep)`. If the dependency escalated, the current tenant escalates immediately with `retriesExhausted: 0` — it ran zero times. The gate is resolved with `{}` (empty artifacts) to unblock any tenants that depend on this tenant. This cascades escalation through the dependency graph without running any downstream work. The rationale: if a required upstream result is unavailable, no amount of retrying the downstream tenant can succeed — it is better to fail fast and preserve the budget.

**sharedArtifacts namespacing.** Artifact keys are prefixed as `${dep}.${key}`. If tenants A and B both produce an artifact named `result`, the current tenant receives them as `A.result` and `B.result` — no collision. The tenant's system prompt receives this map serialized as JSON, and the model can reference specific artifacts by their namespaced keys.

**toolsFactory per attempt.** `toolsFactory(workDir)` is called once per attempt iteration, not once per contract. This gives the caller the opportunity to create fresh tool instances per attempt if needed (e.g. tools that hold internal state). In practice most tool factories return stateless tools, so the per-attempt call is redundant but not harmful.

**Gate resolved with `{}` on escalation.** An escalated tenant cannot produce artifacts, so its gate resolves with an empty object. Dependents of an escalated tenant will see `escalatedRoles.has(dep)` is true and immediately propagate escalation without attempting to read artifacts from `jobArtifacts[dep]` (which would be absent or empty).

### onEvent callback lifecycle

Events in order per tenant:
1. `tenant_started` — emitted at the start of `runWithRetry`, after dependencies are resolved, before the first attempt.
2. `tenant_evicted` — emitted after each failed attempt (before the next retry). `retry` is 1-indexed: first failure emits `retry: 1`.
3. One of:
   - `tenant_complete` — emitted when an attempt returns `result.ok === true`.
   - `tenant_escalated` — emitted when all retries are exhausted or escalation propagated from a dependency.
4. `checkpoint_passed` / `checkpoint_failed` — emitted inside `runTenant` via the checkpoint tool handler. These are not currently implemented in `runTenant` itself — the current code does not call `onEvent` from within `runTenant`. The event type is defined in `LandlordEvent` but the `onEvent` callback is not passed into `runTenant`. This means `checkpoint_passed` and `checkpoint_failed` events are declared in the type union but not yet emitted in the running code.
5. `job_complete` — emitted once after `Promise.all` resolves, regardless of whether the job status is `complete` or `partial`. Carries the full `jobArtifacts` map.

**`complete` vs `partial` status.** `status` is `'complete'` only if every tenant outcome is `status: 'complete'`. Any escalated tenant causes the job to be `'partial'`. The `orchestrate` return is always `{ ok: true, value: OrchestrateResult }` — `orchestrate` itself does not fail when tenants escalate; it returns `partial` so callers can inspect which tenants succeeded and which failed and act accordingly.

---

## validateCheckpoint (`validate.ts`)

`validateCheckpoint` is a two-tier validation function that checks whether a tenant's checkpoint output satisfies the checkpoint definition.

### Tier 1: JSON Schema (AJV)

```ts
const ajv = new Ajv({ allErrors: true });

let validate: ReturnType<typeof ajv.compile>;
try {
  validate = ajv.compile(checkpoint.schema);
} catch {
  validate = ajv.compile({ type: 'object' });  // fallback for invalid schema
}

const tier1Pass = validate(output);
if (!tier1Pass) {
  const explanation = ajv.errorsText(validate.errors) ?? 'JSON Schema validation failed';
  return { ok: true, value: { passed: false, explanation } };
}
```

AJV validates the checkpoint output against the checkpoint's `schema` field. `allErrors: true` collects all validation errors rather than stopping at the first — `ajv.errorsText(validate.errors)` produces a human-readable summary that serves as the `explanation` in the returned verdict. If `checkpoint.schema` is not a valid JSON Schema (i.e. AJV's `compile` throws), the fallback `{ type: 'object' }` schema is used, which accepts any non-null object. The fallback prevents a malformed checkpoint schema from crashing the entire tenant — it degrades to structural-only validation (tier 1 always passes) with semantic validation left to the LLM judge (tier 2).

Tier 1 failure returns `{ ok: true, value: { passed: false, explanation } }` — the function itself succeeded (no error), but the verdict is `passed: false`. The checkpoint tool handler in `runTenant` then returns the failure message to the model, which can revise its output and retry the checkpoint call.

### Tier 2: LLM semantic judge

```ts
const JUDGE_SYSTEM =
  'You are a checkpoint validator. Given a checkpoint definition and the output produced by an agent, ' +
  'judge whether the output genuinely satisfies the checkpoint. ' +
  'Respond ONLY with valid JSON: {"passed": true|false, "explanation": "one sentence reason"}.';
```

If tier 1 passes, a second `call` is made to the LLM with the judge system prompt and a user message containing the checkpoint definition and the agent's output:

```ts
{ checkpoint: { name: checkpoint.name, description: checkpoint.description }, output }
```

The judge uses `checkpoint.description` — the natural-language milestone condition — as the semantic criterion. JSON Schema can validate structure and types but cannot assess whether the content is meaningful. A checkpoint like `"description": "when the summary contains a clear action plan"` cannot be validated by AJV; only semantic reasoning can determine whether the content satisfies it.

**Response parsing.** The judge is instructed to respond with raw JSON. The response is parsed with `JSON.parse(judgeResult.value.message.content)`. If parsing fails (invalid JSON) or the shape is wrong (missing `passed` or `explanation`), `validateCheckpoint` returns `{ ok: false, error }`. These are hard errors from `validateCheckpoint` itself — the checkpoint tool handler treats `verdict.ok === false` the same as `passed: false` (returns a failure message to the model).

**`call`, not `agent`.** `validateCheckpoint` uses the `call` primitive — a single round trip, no tool use, no retry loop. The judge is not an agent; it performs a single classification. Using `agent` would be unnecessary complexity and would consume extra budget steps. The same `ctx` (adapter, model, budget) is shared — so judge calls consume from the same budget as the tenant's agent runs.

**`explanation` field.** The judge's one-sentence explanation is threaded back to the model via the checkpoint tool's failure message: `"Checkpoint failed: ${explanation}. Revise and retry."` If retries exhaust at the `runTenant` level, the last `result.error.message` (which contains the missing-checkpoint error, not the explanation directly) becomes the `retryContext` for the next full agent attempt. The explanation is therefore most useful within a single agent run for guiding checkpoint revision, not across retries.
