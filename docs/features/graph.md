# Graph

> [!WARNING]
> **Experimental — not covered by the semver stability policy.** `@flint/graph` may change in any release, including patch releases. Pin an exact version and review the changelog before upgrading.

A stateful graph DSL for multi-node agent workflows. Define typed nodes, conditional edges, and run the graph to completion — or stream events node-by-node.

## Install

```bash
npm install @flint/graph
```

## Importing

```ts
import { state, node, edge, graph, memoryCheckpointStore } from '@flint/graph';
```

---

## Core concepts

A graph has four building blocks:

| Concept | What it is |
|---|---|
| **State** | A typed object that flows through every node |
| **Node** | An async function that receives the state and returns an updated state |
| **Edge** | A directed connection between nodes, with an optional condition |
| **Graph** | A definition that ties state, nodes, and edges together, plus an `entry` node name |

**Terminal state** — a node with no outgoing edges is a terminal node. When the runner reaches it, execution stops and the final state is returned.

**Fan-out** — an edge can route to multiple nodes at once (`to: ['nodeA', 'nodeB']`). See [Fan-out and join](#fan-out-and-join).

**Conditional routing** — supply a `when` predicate to an edge. The runner picks the first matching edge from a node. If no edge matches, the run fails with `graph.no_matching_edge`.

**Validation** — `graph()` checks the definition when it is called: the `entry` node and every edge endpoint must exist in `nodes`, and `from`/`to` arrays must be non-empty. A bad definition throws a `TypeError` immediately rather than failing mid-run.

---

## Fan-out and join

When the matching edge has more than one target, the runner:

1. Runs every target concurrently on the **pre-fan-out state**. Each target consumes one budget step, the same as any other node.
2. Merges the results in target order: starting from the pre-fan-out state, each target contributes the top-level keys it changed. If two targets change the same key, the later target in the array wins.
3. For each target, evaluates its first matching outgoing edge against the **merged** state, then decides:
   - Every target is terminal (no outgoing edges) → the graph ends with the merged state.
   - Every non-terminal target leads to the same single node → execution continues at that **join** node.
   - Targets lead to different nodes → the run fails with `graph.ambiguous_join`.
   - A target has outgoing edges but none match → the run fails with `graph.no_matching_edge`.

```ts
type Research = { query: string; web?: string; papers?: string; answer?: string };

const g = graph<Research>({
  state: state<Research>(),
  entry: 'plan',
  nodes: {
    plan: node<Research>((s) => s),
    web: node<Research>(async (s) => ({ ...s, web: await searchWeb(s.query) })),
    papers: node<Research>(async (s) => ({ ...s, papers: await searchPapers(s.query) })),
    synthesize: node<Research>(async (s) => ({ ...s, answer: combine(s.web, s.papers) })),
  },
  edges: [
    edge<Research>('plan', ['web', 'papers']), // fan-out
    edge<Research>(['web', 'papers'], 'synthesize'), // join
  ],
});
```

The join node can fan out again. A fan-out target's own edge must lead to a single node; if it leads to another fan-out, the run fails with `graph.ambiguous_join`.

---

## Graph definition example

```ts
import { state, node, edge, graph } from '@flint/graph';
import { budget } from 'flint/budget';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { call } from 'flint';

// 1. Define your state shape
type PipelineState = {
  input: string;
  draft: string;
  revised: string;
  approved: boolean;
};

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

// 2. Define nodes
const drafterNode = node<PipelineState>(async (st, ctx) => {
  const res = await call({
    adapter: ctx.adapter,
    model: ctx.model,
    messages: [{ role: 'user', content: `Draft a short reply to: ${st.input}` }],
  });
  if (!res.ok) throw res.error;
  return { ...st, draft: res.value.message.content };
});

const reviewerNode = node<PipelineState>(async (st, ctx) => {
  const res = await call({
    adapter: ctx.adapter,
    model: ctx.model,
    messages: [{ role: 'user', content: `Is this reply good? Reply "yes" or "no".\n\n${st.draft}` }],
  });
  if (!res.ok) throw res.error;
  const approved = res.value.message.content.toLowerCase().includes('yes');
  return { ...st, approved };
});

const reviserNode = node<PipelineState>(async (st, ctx) => {
  const res = await call({
    adapter: ctx.adapter,
    model: ctx.model,
    messages: [{ role: 'user', content: `Improve this reply:\n\n${st.draft}` }],
  });
  if (!res.ok) throw res.error;
  return { ...st, draft: res.value.message.content };
});

const finalizeNode = node<PipelineState>(async (st) => {
  return { ...st, revised: st.draft };
});

// 3. Define edges
const edges = [
  edge<PipelineState>('drafter', 'reviewer'),
  edge<PipelineState>('reviewer', 'finalizer', (st) => st.approved),
  edge<PipelineState>('reviewer', 'reviser', (st) => !st.approved),
  edge<PipelineState>('reviser', 'reviewer'),
  // 'finalizer' has no outgoing edge — it is the terminal node
];

// 4. Assemble the graph
const pipeline = graph<PipelineState>({
  state: state<PipelineState>(),
  entry: 'drafter',
  nodes: {
    drafter: drafterNode,
    reviewer: reviewerNode,
    reviser: reviserNode,
    finalizer: finalizeNode,
  },
  edges,
});

// 5. Run it
const res = await pipeline.run(
  { input: 'How do I reset my password?', draft: '', revised: '', approved: false },
  {
    adapter,
    model: 'claude-opus-4-7',
    budget: budget({ maxSteps: 20, maxDollars: 0.50 }),
  },
);

if (res.ok) {
  console.log(res.value.revised);
}
```

---

## API reference

### `state<S>()`

Create a typed state marker. This is a no-op at runtime — it exists to anchor the generic `S` type parameter on the graph definition.

```ts
function state<S>(): { readonly __type: 'state'; readonly __shape: S }
```

### `node<S>(fn)`

Define a node function.

```ts
function node<S>(fn: NodeFn<S>): Node<S>

type NodeFn<S> = (state: S, ctx: RunContext) => Promise<S> | S

type RunContext = {
  adapter: ProviderAdapter;
  model: string;
  budget: Budget;
  logger?: Logger;
  signal?: AbortSignal;
};
```

Nodes receive the current state and the run context (which includes the adapter and model). Return the updated state — do not mutate the incoming object.

### `edge<S>(from, to, when?)`

Define a directed connection.

```ts
function edge<S>(
  from: string | string[],
  to: string | string[],
  when?: EdgeCondition<S>,
): Edge<S>

type EdgeCondition<S> = (state: S) => boolean;
```

- `from` and `to` can be single node names or arrays of names.
- If `to` is an array with more than one name, the edge triggers a fan-out.
- `when` is optional; omitting it means the edge always matches.

### `graph<S>(def)`

Assemble a graph from a definition and return a `Graph<S>` with `run()` and `runStream()` methods.

```ts
function graph<S>(def: GraphDefinition<S>): Graph<S>

type GraphDefinition<S> = {
  state: { readonly __type: 'state'; readonly __shape: S };
  entry: string;
  nodes: Record<string, Node<S>>;
  edges: Edge<S>[];
};

type Graph<S> = {
  run(initialState: S, ctx: RunContext, opts?: RunOptions<S>): Promise<Result<S>>;
  runStream(initialState: S, ctx: RunContext, opts?: RunOptions<S>): AsyncIterable<GraphEvent<S>>;
};

type RunOptions<S> = {
  checkpoint?: { store: CheckpointStore<S>; runId: string };
};
```

---

## Errors

`run()` never throws. Every failure comes back as `{ ok: false, error }`:

| Failure | `error` |
|---|---|
| A node function throws a non-`FlintError` | `FlintError` with code `graph.node_failed`; the message names the node and `cause` is the original error |
| A node throws a `FlintError` (for example from `call()` or `agent()`) | That error, unchanged |
| The budget runs out | `BudgetExhausted`, unchanged |
| No edge matches | `FlintError` with code `graph.no_matching_edge` |
| Fan-out targets lead to different nodes | `FlintError` with code `graph.ambiguous_join` |

`runStream()` throws the same errors from the iterator instead of returning a `Result`.

---

## `runStream()`

`runStream()` returns an `AsyncIterable` that yields events as the graph executes. Use it to build live UIs, log progress, or implement custom checkpointing.

```ts
type GraphEvent<S> =
  | { type: 'enter'; node: string; state: S }
  | { type: 'exit';  node: string; state: S }
  | { type: 'edge';  from: string; to: string; state: S };
```

Each node execution emits:
1. `enter` — before the node function runs
2. `exit` — after the node function returns
3. `edge` — the transition that was taken

On a fan-out, the runner emits an `edge` and `enter` for each target, then an `exit` for each target once all of them finish, then an `edge` from each non-terminal target to the join node, carrying the merged state.

### Example

```ts
const stream = pipeline.runStream(initialState, {
  adapter,
  model: 'claude-opus-4-7',
  budget: budget({ maxSteps: 20 }),
});

for await (const event of stream) {
  if (event.type === 'enter') {
    console.log(`→ entering node: ${event.node}`);
  }
  if (event.type === 'exit') {
    console.log(`← exiting node:  ${event.node}`);
  }
  if (event.type === 'edge') {
    console.log(`  edge: ${event.from} → ${event.to}`);
  }
}
```

Errors inside `runStream()`, `BudgetExhausted` included, are thrown from the iterator rather than wrapped in a `Result`. Catch them at the `for await` level:

```ts
try {
  for await (const event of pipeline.runStream(initialState, ctx)) {
    // handle events
  }
} catch (err) {
  console.error('Graph run failed:', err);
}
```

---

## Checkpointing

Pass `{ checkpoint: { store, runId } }` as the third argument to `run()` or `runStream()` to make a run resumable:

- After each node completes, the runner calls `store.save(runId, nextNodeId, state)`, where `nextNodeId` is the node it will run next. A fan-out is saved as one step: the checkpoint is written after the targets finish and the join is resolved, so a failure inside a fan-out resumes from the node that fanned out.
- When the run reaches a terminal node, it calls `store.delete(runId)`.
- When a run starts, it calls `store.load(runId)`. If a checkpoint exists, the run resumes from the saved node and state and ignores `initialState`.

```ts
function memoryCheckpointStore<S>(): CheckpointStore<S>

interface CheckpointStore<S> {
  save(runId: string, nodeId: string, state: S): Promise<void>;
  load(runId: string): Promise<{ nodeId: string; state: S } | null>;
  delete(runId: string): Promise<void>;
}
```

### Example

```ts
import { memoryCheckpointStore } from '@flint/graph';

const store = memoryCheckpointStore<PipelineState>();
const checkpoint = { store, runId: 'ticket-1234' };

const first = await pipeline.run(initialState, ctx, { checkpoint });
if (!first.ok) {
  // Suppose 'reviewer' failed. Nodes that already finished are not run again:
  // the retry resumes at 'reviewer' with the state that 'drafter' produced.
  const retry = await pipeline.run(initialState, ctx, { checkpoint });
}
```

`memoryCheckpointStore()` keeps checkpoints in process memory, so they do not survive a restart. For durable resumption, implement `CheckpointStore<S>` against a database or other persistent storage. The stored state must survive your store's serialization: if you save to JSON, avoid `Date`, `Map` and class instances in the state.

## See also

- [agent()](/primitives/agent) — single-agent loop; use inside node functions
- [call()](/primitives/call) — single LLM call; use inside node functions
- [Budget](/features/budget) — `RunContext` requires a budget
- [Safety](/features/safety) — apply safety utilities to tools used inside nodes
- [Recipes](/features/recipes) — simpler multi-step patterns without graph DSL overhead
- [Example: Graph Workflow](/examples/graph-workflow)
- [FAQ: When should I use graph vs agent()?](/guide/faq#when-should-i-use-flintgraph-vs-agent)
- [Landlord](/landlord/) — for multi-agent parallel workflows
