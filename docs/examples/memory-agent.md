# Memory-Backed Agent

This example builds a multi-turn conversational agent that persists context across calls using `conversationMemory()` with automatic summarization.

## What this demonstrates

- `conversationMemory()` — persistent conversation state
- Automatic summarization when context grows large
- Multi-turn conversation loop
- Inspecting memory state

## Setup

```ts
import { agent } from 'flint';
import { budget } from 'flint/budget';
import { conversationMemory } from 'flint/memory';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
```

## Create conversation memory

```ts
const memory = conversationMemory({
  adapter,
  model: 'claude-haiku-4-5-20251001', // cheaper model for summarization
  maxMessages: 20,    // summarize when history exceeds 20 messages
  keepLast: 6,        // keep 6 most recent messages verbatim after summarizing
});
```

## Send a message and persist the response

```ts
async function chat(userMessage: string): Promise<string> {
  // Get current messages from memory (includes any prior summary)
  const messages = await memory.messages();

  const res = await agent({
    adapter,
    model: 'claude-opus-4-7',
    messages: [
      { role: 'system', content: 'You are a helpful coding assistant. Remember context from earlier in our conversation.' },
      ...messages,
      { role: 'user', content: userMessage },
    ],
    budget: budget({ maxSteps: 5, maxDollars: 0.20 }),
  });

  if (!res.ok) throw res.error;

  // Persist both the user message and assistant response
  await memory.add({ role: 'user', content: userMessage });
  await memory.add(res.value.message);

  return res.value.message.content;
}
```

## Multi-turn conversation

```ts
console.log(await chat("I'm building a REST API in TypeScript. What framework should I use?"));
// → "For TypeScript REST APIs, I'd recommend Express with type definitions..."

console.log(await chat("What about input validation? I want type-safe request parsing."));
// → "Since you're using Express, Zod works great for request validation..."
// (agent remembers "Express" from the previous turn)

console.log(await chat("Show me a minimal example with one endpoint."));
// → "Here's a minimal Express + Zod endpoint..."
// (agent remembers the full context)
```

## Inspect memory state

```ts
const currentMessages = await memory.messages();
console.log(`Messages in memory: ${currentMessages.length}`);

// Check if a summary exists (created after maxMessages is exceeded)
const hasSummary = currentMessages.some(m => m.role === 'system' && m.content.includes('Summary'));
console.log('Has summary:', hasSummary);
```

## How auto-summarization works

When `memory.messages()` returns more messages than `maxMessages`, the next call to `memory.add()` triggers a summarization:

1. An LLM call (using the `model` from options) summarizes the oldest messages
2. The summary is prepended as a system message
3. The oldest messages are dropped, keeping the last `keepLast` messages verbatim

This keeps the context window manageable for long conversations without losing important context.

## Persistent storage

For conversations that survive process restarts, serialize and restore memory:

```ts
// Save
const snapshot = await memory.export(); // returns serializable object
await fs.writeFile('memory.json', JSON.stringify(snapshot));

// Restore
const saved = JSON.parse(await fs.readFile('memory.json', 'utf-8'));
const memory = conversationMemory({ adapter, model: 'claude-haiku-4-5-20251001', maxMessages: 20, keepLast: 6 });
await memory.import(saved);
```

## See also

- [Memory](/features/memory) — full memory API
- [agent()](/primitives/agent) — agent loop
- [compress()](/features/compress) — alternative context management via message compression
