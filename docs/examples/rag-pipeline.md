# RAG Pipeline

This example builds a complete Retrieval-Augmented Generation (RAG) pipeline: chunk a document, embed and store chunks, retrieve relevant context at query time, and pass it to the LLM.

## What this demonstrates

- `chunk()` — splitting text into overlapping segments
- `memoryStore()` — in-memory vector store
- `retrieve()` — cosine similarity search
- Injecting retrieved context into `call()` messages

## The embedder

You supply the embedding function. This example uses a mock — swap in OpenAI or any other provider:

```ts
import { call } from 'flint';
import { chunk, memoryStore, retrieve } from 'flint/rag';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

// In production: replace with a real embedding API
async function embed(text: string): Promise<number[]> {
  // OpenAI example:
  // const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  // return res.data[0].embedding;

  // Mock: hash-based pseudo-embedding for demonstration
  const hash = [...text].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return Array.from({ length: 8 }, (_, i) => Math.sin(hash + i));
}
```

## Step 1: Chunk the document

```ts
const document = `
WebAssembly (Wasm) is a binary instruction format for a stack-based virtual machine.
Wasm is designed as a portable compilation target for programming languages, enabling
deployment on the web for client and server applications.

Key features of WebAssembly:
- Near-native performance
- Language agnostic (compiles from C, C++, Rust, Go, and many others)
- Runs in all modern browsers
- Memory-safe sandbox execution
- Interoperability with JavaScript

WebAssembly use cases include:
- High-performance web applications (games, video editing, CAD)
- Serverless functions
- Plugin systems
- Cryptography
`;

const chunks = chunk(document, {
  size: 150,    // target chunk size in characters
  overlap: 30,  // characters of overlap between adjacent chunks
});

console.log(`Created ${chunks.length} chunks`);
// → Created 5 chunks
```

## Step 2: Embed and store

```ts
const store = memoryStore();
await store.add(chunks, embed);
console.log(`Stored ${chunks.length} embeddings`);
```

## Step 3: Retrieve relevant chunks

```ts
const query = 'What programming languages does WebAssembly support?';

const results = await retrieve(store, query, embed, { topK: 3 });

console.log('Relevant chunks:');
for (const result of results) {
  console.log(`  [score: ${result.score.toFixed(3)}] ${result.text.slice(0, 80)}...`);
}
```

## Step 4: Inject context and call the LLM

```ts
const context = results.map((r, i) => `[${i + 1}] ${r.text}`).join('\n\n');

const res = await call({
  adapter,
  model: 'claude-opus-4-7',
  messages: [
    {
      role: 'system',
      content: `You are a helpful assistant. Answer based on the provided context only.\n\nContext:\n${context}`,
    },
    {
      role: 'user',
      content: query,
    },
  ],
});

if (res.ok) {
  console.log(res.value.message.content);
  // → "WebAssembly supports C, C++, Rust, Go, and many other programming languages..."
}
```

## Complete pipeline function

```ts
import { call } from 'flint';
import { chunk, memoryStore, retrieve } from 'flint/rag';
import { anthropicAdapter } from '@flint/adapter-anthropic';

const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });

async function buildRagPipeline(documents: string[], embedFn: (text: string) => Promise<number[]>) {
  const store = memoryStore();

  // Index all documents
  for (const doc of documents) {
    const chunks = chunk(doc, { size: 512, overlap: 64 });
    await store.add(chunks, embedFn);
  }

  return async function query(question: string) {
    const results = await retrieve(store, question, embedFn, { topK: 5 });
    const context = results.map(r => r.text).join('\n\n');

    return call({
      adapter,
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: `Answer based on this context:\n\n${context}` },
        { role: 'user', content: question },
      ],
    });
  };
}

// Usage
const ask = await buildRagPipeline([document], embed);
const answer = await ask('What are WebAssembly use cases?');
if (answer.ok) console.log(answer.value.message.content);
```

## Production considerations

For production RAG, swap `memoryStore()` for a real vector database:

```ts
import type { EmbeddingStore } from 'flint/rag';

// Implement the EmbeddingStore interface for your database
const pgvectorStore: EmbeddingStore = {
  async add(chunks, embedder) { /* INSERT INTO embeddings */ },
  async query(embedding, topK) { /* SELECT ... ORDER BY cosine_distance */ },
};
```

See [RAG](/features/rag) for the full API and `EmbeddingStore` interface.

## See also

- [RAG](/features/rag) — full RAG API
- [call()](/primitives/call) — LLM call with messages
- [FAQ: How does Flint handle RAG?](/guide/faq#how-does-flint-handle-rag)
