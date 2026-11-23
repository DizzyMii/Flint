# Graph Workflow with Checkpointing

This example uses `@flint/graph` to build a 4-node workflow with a conditional branch and checkpoint-based resumption.

## What this demonstrates

- `graph()` — building a typed state-machine workflow
- Node definitions and edge conditions
- Conditional branching
- `runStream()` events
- Checkpointing to resume after failure

## The workflow

```
start
  └── classify
        ├── [simple query] ──→ quick-answer ──→ end
        └── [complex query] ──→ research ──→ synthesize ──→ end
```

## Setup

```ts
import { edge, graph, memoryCheckpointStore, node, state } from '@flint/graph';
import { call } from 'flint';
import { budget } from 'flint/budget';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import * as v from 'valibot';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

type WorkflowState = {
  query: string;
  complexity?: 'simple' | 'complex';
  quickAnswer?: string;
  researchNotes?: string;
  finalAnswer?: string;
};
```

## Define nodes

```ts
async function classifyNode(state: WorkflowState): Promise<WorkflowState> {
  const res = await call({
    adapter,
    model: 'claude-haiku-4-5-20251001',
    messages: [
      { role: 'system', content: 'Classify the query as "simple" (factual, one-sentence answer) or "complex" (requires research). Reply with only the word.' },
      { role: 'user', content: state.query },
    ],
    schema: v.picklist(['simple', 'complex']),
  });
  if (!res.ok) throw res.error;
  return { ...state, complexity: res.value.value };
}

async function quickAnswerNode(state: WorkflowState): Promise<WorkflowState> {
  const res = await call({
    adapter,
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: state.query }],
  });
  if (!res.ok) throw res.error;
  return { ...state, finalAnswer: res.value.message.content };
}

async function researchNode(state: WorkflowState): Promise<WorkflowState> {
  const res = await call({
    adapter,
    model: 'claude-opus-4-7',
    messages: [
      { role: 'system', content: 'Research this topic thoroughly and produce detailed notes.' },
      { role: 'user', content: state.query },
    ],
  });
  if (!res.ok) throw res.error;
  return { ...state, researchNotes: res.value.message.content };
}

async function synthesizeNode(state: WorkflowState): Promise<WorkflowState> {
  const res = await call({
    adapter,
    model: 'claude-opus-4-7',
    messages: [
      { role: 'system', content: 'Synthesize the research notes into a clear, concise answer.' },
      { role: 'user', content: `Research notes:\n${state.researchNotes}\n\nOriginal question: ${state.query}` },
    ],
  });
  if (!res.ok) throw res.error;
  return { ...state, finalAnswer: res.value.message.content };
}
```

## Build the graph

```ts
const workflow = graph<WorkflowState>({
  state: state<WorkflowState>(),
  entry: 'classify',
  nodes: {
    classify: node(classifyNode),
    'quick-answer': node(quickAnswerNode),
    research: node(researchNode),
    synthesize: node(synthesizeNode),
  },
  edges: [
    // Conditional routing after classify
    edge<WorkflowState>('classify', 'quick-answer', (s) => s.complexity === 'simple'),
    edge<WorkflowState>('classify', 'research'),
    edge<WorkflowState>('research', 'synthesize'),
    // 'quick-answer' and 'synthesize' have no outgoing edges, so they end the run
  ],
});
```

## Run with event streaming

```ts
const initialState: WorkflowState = {
  query: 'What is the time complexity of quicksort in the worst case, and why?',
};

const ctx = { adapter, model: 'claude-opus-4-7', budget: budget({ maxSteps: 10 }) };

let finalState = initialState;
for await (const event of workflow.runStream(initialState, ctx)) {
  if (event.type === 'enter') console.log(`→ ${event.node}`);
  if (event.type === 'exit') {
    console.log(`  ✓ ${event.node}`);
    if (event.node === 'classify') console.log(`  complexity: ${event.state.complexity}`);
    finalState = event.state;
  }
}

console.log('\nFinal answer:');
console.log(finalState.finalAnswer);
```

`runStream()` throws if a node fails. Wrap the loop in `try`/`catch`, or use `run()`, which returns a `Result` instead.

## Expected output

```
→ classify
  ✓ classify
  complexity: complex
→ research
  ✓ research
→ synthesize
  ✓ synthesize

Final answer:
Quicksort has O(n²) worst-case time complexity, which occurs when the pivot
selection consistently produces maximally unbalanced partitions...
```

## Checkpointing for resumption

Pass a checkpoint store and a run ID. The runner saves the next node and the current state after every node, and deletes the checkpoint when the run finishes. If a run fails, calling it again with the same `runId` resumes at the node that failed. Nodes that already finished are not run again.

```ts
const store = memoryCheckpointStore<WorkflowState>();
const checkpoint = { store, runId: 'query-42' };

let res = await workflow.run(initialState, ctx, { checkpoint });
if (!res.ok) {
  console.error('Failed:', res.error.message);
  // e.g. 'synthesize' hit a transient API error: retry without re-running classify or research
  res = await workflow.run(initialState, { ...ctx, budget: budget({ maxSteps: 10 }) }, { checkpoint });
}
```

To resume after a process restart, implement `CheckpointStore<WorkflowState>` on durable storage (a database or files) in place of `memoryCheckpointStore()`.

## See also

- [Graph](/features/graph) — full graph API
- [agent()](/primitives/agent) — simpler alternative for open-ended tasks
- [FAQ: When should I use graph vs agent()?](/guide/faq#when-should-i-use-flintgraph-vs-agent)
