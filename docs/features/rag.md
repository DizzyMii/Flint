# RAG

Retrieval-Augmented Generation: chunk documents, store embeddings, and retrieve relevant context at query time.

Flint's RAG module gives you the building blocks — a `chunk()` splitter, an `Embedder` interface you implement with your preferred embedding model, a `memoryStore()` in-memory vector store, and a `retrieve()` helper that wires them together. **Bring your own embeddings**: Flint does not bundle an embedding model.

## Importing

```ts
import { chunk, memoryStore, retrieve } from 'flint/rag';
import type { Doc, Match, Filter, Embedder, VectorStore, ChunkOpts, RetrieveOpts } from 'flint/rag';
```

---

## `memoryStore()`

An in-memory vector store backed by cosine-similarity search. Documents survive for the lifetime of the `VectorStore` instance — nothing is persisted to disk.

### Type

```ts
interface VectorStore {
  upsert(docs: Doc[]): Promise<void>;
  query(vec: number[], k: number, filter?: Filter): Promise<Match[]>;
  delete(ids: string[]): Promise<void>;
}

function memoryStore(): VectorStore;
```

### Supporting types

```ts
type Doc = {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
};

type Match = {
  id: string;
  text: string;
  score: number;           // cosine similarity, 0–1
  metadata?: Record<string, unknown>;
};

type Filter = Record<string, unknown>;
```

### Methods

| Method | Description |
|--------|-------------|
| `upsert(docs)` | Insert or update documents. If a doc with the same `id` already exists it is replaced. All embeddings in the store must share the same dimension — mixing dimensions throws a `TypeError`. |
| `query(vec, k, filter?)` | Return the top-`k` matches by cosine similarity. Optionally restrict candidates to docs whose `metadata` contains all key-value pairs in `filter`. |
| `delete(ids)` | Remove documents by id. |

### Example

```ts
import { memoryStore } from 'flint/rag';

const store = memoryStore();

// Upsert two documents (embeddings must be pre-computed)
await store.upsert([
  { id: 'doc-1', text: 'The capital of France is Paris.', embedding: [0.1, 0.9, 0.3] },
  { id: 'doc-2', text: 'The capital of Germany is Berlin.', embedding: [0.2, 0.8, 0.4] },
]);

// Query with a pre-computed vector
const matches = await store.query([0.15, 0.85, 0.35], 1);
// matches[0].text === 'The capital of France is Paris.'
// matches[0].score  ≈ 0.99 (cosine similarity)

// Metadata filtering — only return docs tagged with source: 'wiki'
const filtered = await store.query(queryVec, 5, { source: 'wiki' });
```

**Limitation:** All documents are stored in process memory. For production workloads with large corpora, swap `memoryStore()` for a persistent store (e.g. Pinecone, Qdrant, pgvector) that implements the same `VectorStore` interface.

---

## `Embedder` interface

Flint defines the `Embedder` interface but does not provide an implementation. You supply one using whatever embedding API or model you prefer.

### Type

```ts
interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}
```

| Member | Description |
|--------|-------------|
| `embed(texts)` | Accept a batch of strings; return one embedding vector per string. The returned array must be the same length as `texts`. |
| `dimensions` | The fixed vector dimension this embedder produces. |

### Example implementation (OpenAI)

```ts
import OpenAI from 'openai';
import type { Embedder } from 'flint/rag';

const openai = new OpenAI();

const openAIEmbedder: Embedder = {
  dimensions: 1536, // text-embedding-3-small output size

  async embed(texts: string[]): Promise<number[][]> {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return response.data.map((d) => d.embedding);
  },
};
```

### Example implementation (local / custom)

```ts
import type { Embedder } from 'flint/rag';

// Stub for illustration — replace with your model inference call
const localEmbedder: Embedder = {
  dimensions: 384,
  async embed(texts) {
    // e.g. call a local Ollama endpoint, a WASM model, etc.
    return texts.map(() => Array.from({ length: 384 }, Math.random));
  },
};
```

---

## `chunk()`

Split a long string into overlapping or non-overlapping fixed-size chunks before embedding. Chunking prevents individual embeddings from spanning too much semantic territory and keeps each vector within your embedding model's context limit.

### Type

```ts
type ChunkOpts = {
  size: number;
  overlap?: number;
};

function chunk(text: string, opts: ChunkOpts): string[];
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `size` | `number` | — | Character count of each chunk. Must be > 0. |
| `overlap` | `number` | `0` | Characters to repeat from the end of one chunk at the start of the next. Must be < `size`. |

### Example

```ts
import { chunk } from 'flint/rag';

const text = 'The quick brown fox jumps over the lazy dog.';

// Non-overlapping chunks of 15 characters
chunk(text, { size: 15 });
// ['The quick brown', ' fox jumps over', ' the lazy dog.']

// Overlapping chunks — 5-character overlap preserves context across boundaries
chunk(text, { size: 15, overlap: 5 });
// ['The quick brown', 'rown fox jumps ', 'mps over the la', 'e lazy dog.']
```

**When to use overlap:** Set `overlap` to roughly 10–20 % of `size` when your documents contain sentences that straddle chunk boundaries and losing the boundary context would harm retrieval quality.

---

## `retrieve()`

A convenience wrapper that embeds a query string and calls `store.query()` in one step.

### Type

```ts
type RetrieveOpts = {
  embedder: Embedder;
  store: VectorStore;
  k: number;
  filter?: Filter;
};

async function retrieve(query: string, opts: RetrieveOpts): Promise<Match[]>;
```

---

## Full RAG pipeline example

This example shows the complete flow: chunk a document, embed the chunks, store them, then retrieve relevant context at query time and inject it into an LLM call.

```ts
import { chunk, memoryStore, retrieve } from 'flint/rag';
import { call } from 'flint';
import type { Embedder } from 'flint/rag';
import { anthropicAdapter } from '@flint/adapter-anthropic';
import OpenAI from 'openai';

// 1. Set up adapter and embedder
const adapter = anthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! });
const openai = new OpenAI();
const embedder: Embedder = {
  dimensions: 1536,
  async embed(texts) {
    const res = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });
    return res.data.map((d) => d.embedding);
  },
};

// 2. Build the store
const store = memoryStore();

// 3. Index a document
const document = `
  Flint is a TypeScript library for building LLM-powered applications.
  It provides primitives for calling language models, managing conversation
  history, and retrieving relevant documents via RAG.
  Flint is model-agnostic and works with any OpenAI-compatible API.
`;

const chunks = chunk(document, { size: 200, overlap: 40 });

// Embed all chunks in one batch call
const embeddings = await embedder.embed(chunks);

await store.upsert(
  chunks.map((text, i) => ({
    id: `doc-chunk-${i}`,
    text,
    embedding: embeddings[i]!,
    metadata: { source: 'flint-overview' },
  })),
);

// 4. At query time — retrieve then generate
async function answer(question: string): Promise<string> {
  const matches = await retrieve(question, { embedder, store, k: 3 });

  const context = matches.map((m) => m.text).join('\n\n');

  const result = await call({
    adapter,
    messages: [
      {
        role: 'system',
        content: `Answer using only the provided context.\n\nContext:\n${context}`,
      },
      { role: 'user', content: question },
    ],
    model: 'claude-haiku-4-5',
  });

  if (!result.ok) throw result.error;
  return result.value.message.content as string;
}

console.log(await answer('What is Flint?'));
```

### Limitations

- **In-memory only.** `memoryStore()` loses all data when the process exits. For persistence, implement `VectorStore` against a database.
- **Bring your own embedder.** Flint intentionally ships no embedding model to avoid bundling large dependencies.
- **Character-based chunking.** `chunk()` splits on character count, not token count or sentence boundaries. For higher-quality retrieval, pre-process text with a sentence splitter before passing it to `chunk()`.

---

## See Also

- [Memory](./memory.md) — conversation history and scratchpad for injecting retrieved context
- [call()](../primitives/call.md) — the low-level LLM call primitive used in the pipeline example
