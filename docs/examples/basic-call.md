# Basic Call

Send a single message to an LLM and print the response.

```ts
import { call } from 'flint';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is the capital of France?' },
  ],
});

if (res.ok) {
  console.log(res.value.message.content);
  console.log('Usage:', res.value.usage);
  console.log('Stop reason:', res.value.stopReason);
} else {
  console.error('Error:', res.error.message);
}
```

## With schema validation

Parse and validate a structured JSON response:

```ts
import { call } from 'flint';
import * as v from 'valibot';

const CapitalSchema = v.object({
  city: v.string(),
  country: v.string(),
  population: v.number(),
});

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    { role: 'system', content: 'Respond with JSON only.' },
    { role: 'user', content: 'Capital of France as JSON' },
  ],
  schema: CapitalSchema,
});

if (res.ok && res.value.value) {
  const { city, country, population } = res.value.value;
  console.log(`${city}, ${country} — population: ${population}`);
}
```

## See also
- [call()](/primitives/call) — full API
- [agent()](/primitives/agent) — multi-step loop
- [Quick Start](/guide/quick-start)
