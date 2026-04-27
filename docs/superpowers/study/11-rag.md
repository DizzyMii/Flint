# 11 — RAG (Retrieval-Augmented Generation)

**Source:** `packages/flint/src/rag.ts`

**See also:** Doc 01 (Result pattern), Doc 03 (Embedder/VectorStore structural interface rationale)

## Doc

```ts
export type Doc = {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
};
```

`id` is the stable identifier used by `memoryStore` for upsert-or-insert logic and by `delete`. `text` is the original string the embedding was computed from; it is stored alongside the vector so that `query` can return readable content without a separate document lookup. `embedding` is `number[]` rather than `Float32Array` or another typed array: `number[]` is valid in every JavaScript environment without typed array support, requires no conversion when constructing docs programmatically, and carries identical arithmetic semantics — all cosine math reduces to the same floating-point operations regardless of container type. For typical RAG corpus sizes (thousands to tens of thousands of vectors at 768–3072 dimensions), the performance difference between `number[]` and `Float32Array` is negligible compared to network round-trips to embedding APIs. `metadata` is an optional open-ended record that `memoryStore.query` can filter on using exact-match semantics.

## Match

```ts
export type Match = {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
};
```

`Match` is the output type of `VectorStore.query`. `id` and `text` mirror the source `Doc` fields. `score` is the cosine similarity value produced by `cosineSimilarity`; the range is [-1, 1] in general, and [0, 1] in practice when using embeddings from providers like OpenAI or Cohere that produce non-negative output vectors. The type does not clamp or normalize the score — that is an implementation detail of whatever `VectorStore` is in use; `memoryStore` passes cosine values through unmodified. `metadata` is forwarded from the source `Doc` when present.

## Embedder

```ts
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}
```

`embed` is batched by design: it takes an array of strings and returns one `number[]` embedding vector per string, in order. The batch interface is not optional boilerplate — embedding providers like OpenAI only expose a batch endpoint; issuing one HTTP call per text string would multiply API overhead by corpus size. Even for single-query use (as in `retrieve`), the call goes through the same batched signature: `embed([query])` returns `[[...]]` and the caller takes index 0.

`dimensions` is the fixed length of every vector this embedder produces. `memoryStore` reads `dimensions` for validation: once the first doc is stored, every subsequent doc's `embedding.length` must match. The property lives on the interface rather than being inferred at runtime because the dimension is a property of the model, not of any particular batch — declaring it explicitly makes dimension mismatches detectable before any embedding is computed.

## VectorStore

```ts
export interface VectorStore {
  upsert(docs: Doc[]): Promise<void>;
  query(vec: number[], k: number, filter?: Filter): Promise<Match[]>;
  delete(ids: string[]): Promise<void>;
}
```

`VectorStore` is a structural interface rather than a class or abstract base for the same reason `ProviderAdapter` is structural (Doc 03): any object that satisfies the shape is a valid store. This lets `memoryStore` (in-process, no dependencies) and production stores — Pinecone, Weaviate, Chroma, pgvector — be used interchangeably by callers without a wrapper or adapter layer.

`upsert` inserts or replaces by `id`; the semantics guarantee idempotency across repeated ingest runs. `query` takes a raw vector (not a string), `k` as the result count, and an optional `Filter` for metadata pre-filtering before scoring. `delete` accepts a list of ids for bulk removal.

The `Filter` alias (`Record<string, unknown>`) is exported separately so callers can name it without importing the full `VectorStore` shape.

## cosineSimilarity (private)

Not exported. Callers reach similarity scores through `memoryStore.query` or a custom `VectorStore` implementation; the raw math is an implementation detail.

```ts
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

The formula is `dot(a, b) / (||a|| * ||b||)`. All three accumulators are computed in a single pass to avoid iterating the arrays twice. The `?? 0` fallback handles the case where `b` is shorter than `a` (mismatched dimensions); this is a safety net — `memoryStore` prevents dimension mismatches via the `dimension` guard in `upsert`, so in practice both vectors will always be the same length. The zero-norm guard `if (normA === 0 || normB === 0) return 0` avoids dividing by zero when either input is the all-zeros vector; returning 0 rather than `NaN` keeps sort order stable and prevents downstream consumers from receiving `NaN` scores.

## memoryStore

`memoryStore` returns a `VectorStore` backed by a plain in-memory `Doc[]` array. It closes over two pieces of state: `docs` (the store contents) and `dimension` (the expected embedding length, set on first insert).

### Defensive copy in upsert

```ts
const doc: Doc = {
  id: raw.id,
  text: raw.text,
  embedding: raw.embedding.slice(),
  ...(raw.metadata !== undefined ? { metadata: { ...raw.metadata } } : {}),
};
```

`raw.embedding.slice()` copies the array so mutations to the caller's original `Doc` object after `upsert` returns cannot corrupt stored vectors. `{ ...raw.metadata }` performs a shallow copy of the metadata object for the same reason. The spread is conditional — only applied when `raw.metadata` is not `undefined` — so docs without metadata do not grow a spurious empty `metadata: {}` field.

### Dimension enforcement

```ts
if (dimension === undefined) {
  dimension = doc.embedding.length;
} else if (doc.embedding.length !== dimension) {
  throw new TypeError(`Embedding dimension mismatch: expected ${dimension}, got ${doc.embedding.length}`);
}
```

`dimension` is `undefined` until the first doc is stored, at which point it is locked to that doc's embedding length. All subsequent upserts must match exactly. This catches dimension mismatches that arise from switching embedding models mid-session or from a misconfigured `Embedder.dimensions` property. The check runs before the upsert-or-insert logic so no partial state is written on failure.

### Upsert-or-insert via findIndex

```ts
const idx = docs.findIndex((d) => d.id === doc.id);
if (idx !== -1) {
  docs[idx] = doc;
} else {
  docs.push(doc);
}
```

`findIndex` is O(n) per doc in the batch. For in-memory stores at typical corpus sizes this is acceptable; production stores back this with an index. The replace path (`docs[idx] = doc`) overwrites the entire stored `Doc` object rather than merging fields, so stale embeddings or text cannot linger after an update.

### query: filter, score, sort, slice

```ts
let candidates = docs;
if (filter !== undefined) {
  candidates = docs.filter((doc) => {
    if (doc.metadata === undefined) return false;
    for (const key of Object.keys(filter)) {
      if (doc.metadata[key] !== filter[key]) return false;
    }
    return true;
  });
}
return candidates
  .map((doc) => ({ id: doc.id, text: doc.text, score: cosineSimilarity(vec, doc.embedding), ... }))
  .sort((a, b) => b.score - a.score)
  .slice(0, k);
```

Filter semantics are AND, not OR: every key in `filter` must have an exact-match (`===`) value in `doc.metadata` for the doc to be a candidate. Docs with no `metadata` field are excluded when any filter is specified. Filter is applied before scoring to avoid computing cosine similarity for docs that would be dropped anyway. Sorted descending by score so the highest-similarity match is index 0. Sliced to `k` after sorting — no approximation or early termination; the full filtered set is scored.

### delete

```ts
const idSet = new Set(ids);
let i = docs.length;
while (i--) {
  const doc = docs[i];
  if (doc && idSet.has(doc.id)) {
    docs.splice(i, 1);
  }
}
```

Iterates backwards so `splice` at index `i` does not shift earlier indices and invalidate `i`. The `Set` makes membership checks O(1) per doc rather than O(ids.length). Mutates `docs` in place.

### No persistence

`memoryStore` is intentionally ephemeral — there is no serialization, no disk write, no snapshot. It is suited for testing, short-lived agents, and situations where the corpus is re-ingested on each run. Persistence requires a different `VectorStore` implementation.

## chunk

```ts
export function chunk(text: string, opts: ChunkOpts): string[] {
  const { size, overlap = 0 } = opts;
  if (size <= 0) throw new TypeError(`chunk: size must be > 0, got ${size}`);
  if (overlap >= size) throw new TypeError(`chunk: overlap must be < size, got overlap=${overlap} size=${size}`);
  if (text.length === 0) return [];
  const step = size - overlap;
  const result: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    result.push(text.slice(start, start + size));
  }
  return result;
}
```

### Guards

`size <= 0` throws immediately — a zero or negative chunk size is meaningless and would produce an infinite loop. `overlap >= size` throws because `step = size - overlap` would be zero or negative, again producing an infinite loop or chunks with no net forward progress. Both guards fire before any allocation.

### Step and overlap math

```
step = size - overlap
chunk[0] = text[0 .. size)
chunk[1] = text[step .. step + size)
overlap between chunk[0] and chunk[1] = size - step = overlap characters
```

The overlap window is at the tail of chunk N and the head of chunk N+1. A concept or sentence that straddles a boundary will appear in full (or near-full) in at least one chunk and partially in both, which prevents context loss when that chunk is retrieved in isolation.

### Empty string

Returns `[]` immediately rather than producing a single empty-string chunk, which would be a meaningless embedding target.

### Last chunk

`text.slice(start, start + size)` never throws when `start + size` exceeds `text.length`; `slice` clamps automatically. The last chunk may therefore be shorter than `size`.

## retrieve

```ts
export async function retrieve(query: string, opts: RetrieveOpts): Promise<Match[]> {
  const { embedder, store, k, filter } = opts;
  const [vec] = await embedder.embed([query]);
  if (vec === undefined) {
    throw new TypeError('retrieve: embedder returned no vectors');
  }
  if (filter !== undefined) {
    return store.query(vec, k, filter);
  }
  return store.query(vec, k);
}
```

`embedder.embed([query])` wraps the single query string in an array to satisfy the batched `Embedder` interface. The destructuring `const [vec] =` takes only index 0 — the only element in a single-element batch. The `vec === undefined` guard handles a malfunctioning embedder that returns an empty array; without it, `cosineSimilarity` would receive `undefined` and produce `NaN` scores silently.

`filter` is forwarded to `store.query` unchanged when present; when absent, `store.query` is called without the argument rather than with `undefined`, to stay consistent with implementations that use `arguments.length` checks rather than `=== undefined` checks. `retrieve` performs no post-processing on the returned `Match[]` — transformation of results (re-ranking, threshold filtering, top-k truncation beyond what the store does) is the caller's responsibility.
