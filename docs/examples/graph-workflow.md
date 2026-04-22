# Graph Workflow with Checkpointing

This example uses `@flint/graph` to build a 4-node workflow with a conditional branch and checkpoint-based resumption.

## What this demonstrates

- `graph()` — building a typed state-machine workflow
- Node definitions and edge conditions
- Fan-out and conditional branching
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
import { graph } from '@flint/graph';
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
const workflow = graph<WorkflowState>()
  .node('classify', classifyNode)
  .node('quick-answer', quickAnswerNode)
  .node('research', researchNode)
  .node('synthesize', synthesizeNode)
  // Conditional routing after classify
  .edge('classify', (state) => state.complexity === 'simple' ? 'quick-answer' : 'research')
  .edge('quick-answer', '__end__')
  .edge('research', 'synthesize')
  .edge('synthesize', '__end__')
  .start('classify');
```

## Run with event streaming

```ts
const initialState: WorkflowState = {
  query: 'What is the time complexity of quicksort in the worst case, and why?',
};

const events = workflow.runStream(initialState);

for await (const event of events) {
  switch (event.type) {
    case 'node_start':
      console.log(`→ ${event.node}`);
      break;
    case 'node_complete':
      console.log(`  ✓ ${event.node} (${event.duration}ms)`);
      if (event.node === 'classify') {
        console.log(`  complexity: ${event.state.complexity}`);
      }
      break;
    case 'workflow_complete':
      console.log('\nFinal answer:');
      console.log(event.state.finalAnswer);
      break;
    case 'workflow_error':
      console.error('Error at', event.node, ':', event.error.message);
      break;
  }
}
```

## Expected output

```
→ classify
  ✓ classify (340ms)
  complexity: complex
→ research
  ✓ research (2100ms)
→ synthesize
  ✓ synthesize (890ms)

Final answer:
Quicksort has O(n²) worst-case time complexity, which occurs when the pivot
selection consistently produces maximally unbalanced partitions...
```

## Checkpointing for resumption

```ts
import { writeFile, readFile } from 'node:fs/promises';

// Save checkpoint after each node
const events = workflow.runStream(initialState, {
  onCheckpoint: async (node, state) => {
    await writeFile(`checkpoint-${node}.json`, JSON.stringify(state));
  },
});

// Resume from a checkpoint after failure
const savedState = JSON.parse(await readFile('checkpoint-research.json', 'utf-8'));
const resumeEvents = workflow.runStream(savedState, { startFrom: 'synthesize' });
```

## See also

- [Graph](/features/graph) — full graph API
- [agent()](/primitives/agent) — simpler alternative for open-ended tasks
- [FAQ: When should I use graph vs agent()?](/guide/faq#when-should-i-use-flintgraph-vs-agent)
