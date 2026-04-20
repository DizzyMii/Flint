import { NotImplementedError } from './errors.ts';

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

export function memoryStore(): VectorStore {
  return {
    async upsert() {
      throw new NotImplementedError('rag.memoryStore.upsert');
    },
    async query() {
      throw new NotImplementedError('rag.memoryStore.query');
    },
    async delete() {
      throw new NotImplementedError('rag.memoryStore.delete');
    },
  };
}

export type ChunkOpts = {
  size: number;
  overlap?: number;
};

export function chunk(_text: string, _opts: ChunkOpts): string[] {
  throw new NotImplementedError('rag.chunk');
}

export type RetrieveOpts = {
  embedder: Embedder;
  store: VectorStore;
  k: number;
  filter?: Filter;
};

export async function retrieve(_query: string, _opts: RetrieveOpts): Promise<Match[]> {
  throw new NotImplementedError('rag.retrieve');
}
