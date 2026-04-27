# 14 — Graph

**Source:** `packages/graph/src/index.ts`
**See also:** Doc 07 (budget.consume — called per node), Doc 01 (Result\<T,E\>)

## node / edge / state builders

### node(fn)

```ts
export function node<S>(fn: NodeFn<S>): Node<S> {
  return { __type: 'node', fn };
}
```

`node` wraps a bare function in an object with a `__type: 'node'` brand field. The wrapper exists entirely for runtime type discrimination: when a `GraphDefinition` is assembled, `def.nodes` is a `Record<string, Node<S>>` where every value is the branded wrapper. The `executeNodeFn` helper then accesses `n.fn` — if `n` had been stored as a raw function, distinguishing a node from a plain callback or an edge object would require `typeof` checks and would lose the ability to attach additional metadata to the node record in future versions without a breaking change. The brand also makes accidental misuse of an edge as a node (or vice versa) a TypeScript compile error rather than a silent runtime failure.

`NodeFn<S, _Input = S>` has an `_Input` phantom type parameter that is not used in the function signature — it is a hook for future direction-typed edges without changing the runtime shape.

### edge(from, to, when?)

```ts
export function edge<S>(
  from: string | string[],
  to: string | string[],
  when?: EdgeCondition<S>,
): Edge<S> {
  return { __type: 'edge', from, to, ...(when ? { when } : {}) };
}
```

`from` and `to` each accept either a single node name or an array of node names, enabling many-to-many edge definitions in one declaration. The `when` predicate is a pure `(state: S) => boolean` — it receives the post-execution state of the source node and returns whether this edge should be followed. When `when` is absent, the edge is unconditional: `run` and `runStream` both test `e.when === undefined || e.when(st)`, so a missing predicate always evaluates as "follow this edge."

The `when` field is conditionally spread into the returned object (`...(when ? { when } : {})`). This keeps the property absent rather than `undefined` on edges with no condition, which matters for any code that uses `Object.keys` or `JSON.stringify` on edge objects and would otherwise see a spurious `when` key.

### state\<S\>()

```ts
export function state<S>(): { readonly __type: 'state'; readonly __shape: S } {
  return { __type: 'state', __shape: undefined as S };
}
```

`state<S>()` is a phantom type carrier with zero meaningful runtime payload. `__shape` is typed as `S` but initialized to `undefined` — the cast is safe because `__shape` is never read at runtime; it exists only so TypeScript can infer and propagate the `S` type parameter. The purpose is to bind `GraphDefinition<S>` to an explicit state shape at definition time without requiring an actual instance of `S`. Without this carrier, `graph<S>(def)` would require the caller to write `graph<MyState>(def)`, duplicating the type annotation. With it, `def.state` constrains the generic and the TypeScript compiler enforces that `nodes`, `edges`, and all predicates agree on the same state shape.

## GraphDefinition\<S\>

```ts
export type GraphDefinition<S> = {
  state: { readonly __type: 'state'; readonly __shape: S };
  entry: string;
  nodes: Record<string, Node<S>>;
  edges: Edge<S>[];
};
```

- `state` — the phantom carrier produced by `state<S>()`; its sole purpose is to fix `S` at definition time
- `entry` — the name of the node where execution begins; looked up in `def.nodes` on the first iteration of the run loop
- `nodes` — a string-keyed record mapping node names to their `Node<S>` wrappers; `executeNodeFn` performs the lookup and throws `graph.node_not_found` if the name is absent
- `edges` — a flat array of all `Edge<S>` definitions; there is no adjacency map or pre-built index; `findEdgesFrom` performs a linear scan on every step

The flat-array choice for edges is intentional: graph definitions are authored once and are typically small (tens of nodes, not thousands). A linear scan costs nothing perceptible for any realistic agent graph and avoids the overhead of building and maintaining an index structure. If a definition grew to hundreds of nodes, converting `edges` to a `Map<string, Edge<S>[]>` grouped by source would be a localized optimization in `findEdgesFrom` with no API change.

## RunContext

```ts
export type RunContext = {
  adapter: ProviderAdapter;
  model: string;
  budget: Budget;
  logger?: Logger;
  signal?: AbortSignal;
};
```

`RunContext` is passed to every node function via `executeNodeFn(nodeName, st, ctx)` → `n.fn(st, ctx)`. Its fields:

- `adapter` — the provider implementation (Anthropic, OpenAI-compat, etc.) that node functions call when they need an LLM turn
- `model` — the model identifier string forwarded to the adapter; node functions can override it per-call if needed
- `budget` — the shared `Budget` instance; the graph's run loop calls `budget.consume` once per node for step tracking, and node functions that call `call(...)` or `stream(...)` will further consume the same budget for tokens and dollars
- `logger` — optional structured logger; undefined-safe at the graph level since the graph itself does not log; nodes may use it
- `signal` — optional `AbortSignal`; the graph does not check it directly but passes context through so nodes can respect cancellation

`RunContext` is passed at call time rather than captured at `graph<S>(def)` creation. This is the critical design choice that makes a `Graph<S>` instance reusable: the same compiled graph definition can be executed with different adapters, models, and budgets across multiple calls to `run` or `runStream` without any state leaking between runs. Capturing context at creation time would force a new `graph()` call for every configuration combination.

## GraphEvent\<S\>

```ts
export type GraphEvent<S> =
  | { type: 'enter'; node: string; state: S }
  | { type: 'exit'; node: string; state: S }
  | { type: 'edge'; from: string; to: string; state: S };
```

Three event types emitted by `runStream`:

- `enter` — emitted immediately before the node function executes; `state` is the pre-execution state
- `exit` — emitted immediately after the node function returns; `state` is the post-execution state (may differ from `enter`'s state)
- `edge` — emitted after edge resolution; `state` is the post-execution (or post-fan-out-merge) state at the moment the transition is taken

`state` is included in every event rather than emitted only on change. This gives callers a complete snapshot at each observation point without any bookkeeping on their side: a UI rendering the current state after each step just reads `event.state` from the last `exit` event; a logger recording state evolution does the same from every event in sequence. Omitting `state` from `edge` events would force callers to track which `exit` event's state corresponds to which `edge` event — an error-prone correlation.

## graph\<S\> factory

`graph<S>(def)` closes over `def` and returns a `Graph<S>` object with two methods: `run` and `runStream`.

### findEdgesFrom(nodeName)

```ts
function findEdgesFrom(nodeName: string): Edge<S>[] {
  return def.edges.filter((e) => matchesFrom(e.from, nodeName));
}
```

`matchesFrom` handles the `from: string | string[]` union:

```ts
function matchesFrom(from: string | string[], nodeName: string): boolean {
  return Array.isArray(from) ? from.includes(nodeName) : from === nodeName;
}
```

Linear scan over `def.edges` on every call. Justified because graph definitions are small; the overhead of indexing (an extra pass at creation time, a `Map` in closure) is not warranted. If an edge is defined with `from: ['a', 'b']`, both node `a` and node `b` will find it via `matchesFrom`.

### executeNodeFn

```ts
async function executeNodeFn(nodeName: string, st: S, ctx: RunContext): Promise<S> {
  const n = def.nodes[nodeName];
  if (n === undefined) {
    throw new FlintError(`Node "${nodeName}" not found in graph`, {
      code: 'graph.node_not_found',
    });
  }
  return n.fn(st, ctx);
}
```

The guard against a missing node name is necessary because both `def.entry` and edge `to` targets are plain strings. TypeScript cannot statically verify that every string in an edge's `to` field names a key in `def.nodes` — that would require template literal types and exhaustive checks at definition time, which the API does not enforce. The runtime check covers the gap. `FlintError` is thrown unconditionally (not returned as a `Result`) because node-not-found is a programmer error in the graph definition, not a recoverable runtime condition.

## run()

`run` executes nodes in an infinite loop, advancing `currentNode` on each iteration:

```ts
for (;;) {
  ctx.budget.consume({ input: 0, output: 0 });
  st = await executeNodeFn(currentNode, st, ctx);
  const outgoing = findEdgesFrom(currentNode);
  if (outgoing.length === 0) return { ok: true, value: st };
  const matching = outgoing.find((e) => e.when === undefined || e.when(st));
  if (matching === undefined) return { ok: false, error: new FlintError(...) };
  const resolved = resolveNext(matching.to);
  // advance currentNode ...
}
```

### Budget consume per iteration

`ctx.budget.consume({ input: 0, output: 0 })` is called at the top of every loop iteration, before `executeNodeFn`. Passing `{ input: 0, output: 0 }` charges zero tokens and zero dollars — the call exists only to increment `stepsUsed` by 1. This gives callers a simple knob (`maxSteps`) to bound graph traversal without needing to know token counts. The `BudgetExhausted` throw from `consume` is caught in `run` and returned as `{ ok: false, error }`, consistent with how `call` handles budget exhaustion.

### Terminal condition

If `findEdgesFrom(currentNode)` returns an empty array, the current node has no outgoing edges and is a terminal node. Execution ends with `{ ok: true, value: st }` — the final state.

### Edge matching

```ts
const matching = outgoing.find((e) => e.when === undefined || e.when(st));
```

First-match semantics: the first edge whose `when` predicate returns true (or which has no `when`) is taken. Edge ordering within `def.edges` therefore matters when multiple edges share the same `from`. If no edge matches, the result is `{ ok: false, error }` with code `graph.no_matching_edge` — a defined edge was declared but no predicate was satisfied, which indicates a logic error in the graph definition.

### resolveNext — three outcome cases

```ts
function resolveNext(to: string | string[]):
  | { fanOut: false; next: string }
  | { fanOut: true; targets: string[] }
```

1. **Single string** (`to` is a `string`): `{ fanOut: false, next: to }` — advance directly to that node.
2. **Array with more than one element** (`to.length > 1`): `{ fanOut: true, targets: to }` — parallel fan-out execution.
3. **Array with exactly one element** (`to.length === 1`): treated as `{ fanOut: false, next: to[0] }` — syntactic convenience for authors who write `to: ['nodeName']`; no fan-out overhead.
4. **Empty array** (`to.length === 0`): throws `FlintError` with code `graph.invalid_edge` immediately — an edge with no destination is a definition error.

### Fan-out mechanics

```ts
const preState = st;
const resolvedStates = await Promise.all(
  resolved.targets.map((targetNode) => executeNodeFn(targetNode, preState, ctx)),
);
st = Object.assign({} as object, ...(resolvedStates as object[])) as S;
const firstTarget = resolved.targets[0];
currentNode = firstTarget;
```

All fan-out targets receive the same `preState` — the state before any of them ran. They execute concurrently via `Promise.all`. Their results are merged with `Object.assign` into a fresh object: a shallow left-to-right merge where later targets' keys overwrite earlier ones. The merge produces the new `st`.

After fan-out, `currentNode` is set to `resolved.targets[0]` — the first target in the array. This is the node used for the next `findEdgesFrom` lookup, meaning the graph continues from whichever fan-out target is listed first. Graph authors must account for this when designing fan-out + convergence patterns: only the first target's outgoing edges are followed after the merge.

The fan-out model is intentionally shallow. It does not recursively resolve edges for each fan-out target — it only executes the node function and merges state. This keeps fan-out semantics predictable: it is a single parallel execution step, not a recursive sub-graph.

### Error handling

`BudgetExhausted` from `budget.consume` is caught and returned as `{ ok: false, error }`. All other errors from `budget.consume` or from node functions propagate as uncaught exceptions. This is consistent with the design philosophy in Doc 01: `Result<T>` wraps expected failures; unexpected programmer errors escape as exceptions.

## runStream()

`runStream` is an async generator implementing the same traversal logic as `run` but yielding `GraphEvent<S>` at each observation point:

```ts
async *runStream(initialState, ctx) {
  for (;;) {
    ctx.budget.consume({ input: 0, output: 0 });          // throws BudgetExhausted
    yield { type: 'enter', node: currentNode, state: st }; // pre-execution snapshot
    st = await executeNodeFn(currentNode, st, ctx);
    yield { type: 'exit', node: currentNode, state: st };  // post-execution snapshot
    // ... edge resolution ...
    yield { type: 'edge', from: fromNode, to: ..., state: st }; // transition record
  }
}
```

Key differences from `run`:

- `budget.consume` is called bare — no try/catch. A `BudgetExhausted` throw propagates directly from the async generator as an exception on the iterator. The caller's `for await` loop sees it as a thrown error, not a yielded value. This is identical to how the `stream` primitive handles it (Doc 07): async generators have no mechanism to return a value on error, so the exception is the only propagation path.
- On a terminal node (no outgoing edges), `runStream` uses `return` to end the generator naturally — the `for await` loop exits cleanly without an exception.
- On a no-matching-edge error, `runStream` throws `FlintError` directly (no `Result` wrapping), consistent with the propagation model.

Streaming exists because real-time visibility into graph execution is a first-class requirement: UIs need to update as nodes run, loggers need granular records, and debugging requires knowing exactly which edges were taken and what state looked like at each step. `run` discards all intermediate state; `runStream` exposes it without any additional bookkeeping in calling code.

## isBudgetExhausted

```ts
function isBudgetExhausted(e: unknown): e is Error {
  return e instanceof Error && (e as { name?: unknown }).name === 'BudgetExhausted';
}
```

Duck-type check: tests `e.name === 'BudgetExhausted'` rather than `e instanceof BudgetExhausted`. The reason is cross-bundle safety. In a monorepo or a project where `flint` and `flint/graph` are bundled separately, the `BudgetExhausted` class in the graph bundle's closure and the `BudgetExhausted` class in the flint bundle's closure are two distinct class objects. `instanceof` walks the prototype chain against the specific constructor reference; if the thrown error was created by one bundle's constructor and `instanceof` tests against the other bundle's constructor, the check returns `false` even though the error is semantically a `BudgetExhausted`. Name-based duck-typing bypasses prototype chain comparison entirely: if it has `name === 'BudgetExhausted'` it is treated as one, regardless of which bundle instantiated it. The `instanceof Error` pre-check ensures the value is at least an `Error` before accessing `.name`, guarding against non-Error throwables.

## memoryCheckpointStore

```ts
export function memoryCheckpointStore<S>(): CheckpointStore<S> {
  const store = new Map<string, { nodeId: string; state: S }>();
  return {
    async save(runId, nodeId, st) { store.set(runId, { nodeId, state: st }); },
    async load(runId) { return store.get(runId) ?? null; },
    async delete(runId) { store.delete(runId); },
  };
}
```

`memoryCheckpointStore` wraps a `Map<string, { nodeId: string; state: S }>` in the `CheckpointStore<S>` interface. The interface defines:

- `save(runId, nodeId, state)` — upserts the checkpoint for `runId`; overwriting any prior checkpoint for the same run ID
- `load(runId)` — returns `{ nodeId, state }` if a checkpoint exists, or `null` if not (not `undefined` — the interface contract uses `null` for "not found" to avoid accidental truthiness issues with optional chaining)
- `delete(runId)` — removes the checkpoint; idempotent if the ID does not exist

The checkpoint store is separate from the graph's runtime state by design. The `Graph<S>` instance itself is stateless between `run` / `runStream` calls — all mutable state lives in the `st` local variable inside each invocation. Checkpoints are an external persistence concern: they allow a long-running graph to be interrupted (budget exhausted, process crash, deliberate pause) and resumed at a known node with a known state. Embedding checkpoint logic inside `run` would couple two orthogonal concerns and make it impossible to use the graph without a checkpoint store.

The in-memory implementation is suitable for testing and short-lived processes. Production use cases would implement `CheckpointStore<S>` against a database or key-value store; the interface's async methods (`Promise<void>`, `Promise<{...} | null>`) are designed for this — the in-memory implementation wraps synchronous `Map` operations in async wrappers at negligible cost.
