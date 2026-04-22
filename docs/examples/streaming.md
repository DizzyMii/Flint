# Streaming

Receive tokens as they arrive using `AsyncIterable<StreamChunk>`.

```ts
import { stream } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import { budget } from 'flint/budget';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const b = budget({ maxTokens: 2000 });
let fullText = '';

process.stdout.write('Response: ');

for await (const chunk of stream({
  adapter,
  model: 'claude-opus-4-7',
  messages: [{ role: 'user', content: 'Explain async iterators in TypeScript in three paragraphs.' }],
  budget: b,
})) {
  switch (chunk.type) {
    case 'text':
      process.stdout.write(chunk.delta);
      fullText += chunk.delta;
      break;
    case 'usage':
      // Budget is consumed automatically
      console.log(`\nTokens: input=${chunk.usage.input}, output=${chunk.usage.output}`);
      if (chunk.cost !== undefined) {
        console.log(`Cost: $${chunk.cost.toFixed(6)}`);
      }
      break;
    case 'end':
      console.log(`\nStop reason: ${chunk.reason}`);
      break;
  }
}

console.log(`\nBudget remaining: ${b.remaining().tokens} tokens`);
```

## See also
- [stream()](/primitives/stream) — full API and StreamChunk types
- [Budget](/features/budget) — streaming budget consumption
