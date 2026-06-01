// src/workflow/journal.ts
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type JournalEntry = { index: number; hash: string; result: unknown };

export interface JournalStore {
  append(runId: string, entry: JournalEntry): Promise<void>;
  load(runId: string): Promise<JournalEntry[]>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${body}}`;
}

/** FNV-1a (32-bit) hex of the stable-stringified call signature. */
export function hashCall(prompt: string, opts: unknown): string {
  const input = stableStringify({ prompt, opts: opts ?? {} });
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function memoryJournalStore(): JournalStore {
  const runs = new Map<string, JournalEntry[]>();
  return {
    async append(runId, entry) {
      const list = runs.get(runId) ?? [];
      list.push(entry);
      runs.set(runId, list);
    },
    async load(runId) {
      return [...(runs.get(runId) ?? [])];
    },
  };
}

export function fileJournalStore(dir: string): JournalStore {
  const path = (runId: string) => join(dir, `journal-${runId}.jsonl`);
  return {
    async append(runId, entry) {
      await mkdir(dir, { recursive: true });
      await appendFile(path(runId), `${JSON.stringify(entry)}\n`, 'utf-8');
    },
    async load(runId) {
      let text: string;
      try {
        text = await readFile(path(runId), 'utf-8');
      } catch {
        return [];
      }
      return text
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as JournalEntry);
    },
  };
}
