export type Doc = {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
};

export type Match = {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export type Filter = Record<string, unknown>;

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

export interface VectorStore {
  upsert(docs: Doc[]): Promise<void>;
  query(vec: number[], k: number, filter?: Filter): Promise<Match[]>;
  delete(ids: string[]): Promise<void>;
}

// Private helper — not exported.
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function memoryStore(): VectorStore {
  const docs: Doc[] = [];
  let dimension: number | undefined;

  return {
    async upsert(incoming: Doc[]): Promise<void> {
      for (const raw of incoming) {
        // Defensive copy so later mutations to caller's object don't affect the store.
        const doc: Doc = {
          id: raw.id,
          text: raw.text,
          embedding: raw.embedding.slice(),
          ...(raw.metadata !== undefined ? { metadata: { ...raw.metadata } } : {}),
        };

        if (dimension === undefined) {
          dimension = doc.embedding.length;
        } else if (doc.embedding.length !== dimension) {
          throw new TypeError(
            `Embedding dimension mismatch: expected ${dimension}, got ${doc.embedding.length}`,
          );
        }

        const idx = docs.findIndex((d) => d.id === doc.id);
        if (idx !== -1) {
          docs[idx] = doc;
        } else {
          docs.push(doc);
        }
      }
    },

    async query(vec: number[], k: number, filter?: Filter): Promise<Match[]> {
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
        .map((doc) => ({
          id: doc.id,
          text: doc.text,
          score: cosineSimilarity(vec, doc.embedding),
          ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },

    async delete(ids: string[]): Promise<void> {
      const idSet = new Set(ids);
      let i = docs.length;
      while (i--) {
        if (idSet.has(docs[i]!.id)) {
          docs.splice(i, 1);
        }
      }
    },
  };
}

export type ChunkOpts = {
  size: number;
  overlap?: number;
};

export function chunk(text: string, opts: ChunkOpts): string[] {
  const { size, overlap = 0 } = opts;

  if (size <= 0) {
    throw new TypeError(`chunk: size must be > 0, got ${size}`);
  }
  if (overlap >= size) {
    throw new TypeError(`chunk: overlap must be < size, got overlap=${overlap} size=${size}`);
  }

  if (text.length === 0) return [];

  const step = size - overlap;
  const result: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    result.push(text.slice(start, start + size));
  }
  return result;
}

export type RetrieveOpts = {
  embedder: Embedder;
  store: VectorStore;
  k: number;
  filter?: Filter;
};

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
