// test/workflow/journal.test.ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileJournalStore, hashCall, memoryJournalStore } from '../../src/workflow/journal.ts';

describe('hashCall', () => {
  it('is stable regardless of opts key order', () => {
    const a = hashCall('p', { label: 'x', phase: 'y' });
    const b = hashCall('p', { phase: 'y', label: 'x' });
    expect(a).toBe(b);
  });
  it('changes when the prompt changes', () => {
    expect(hashCall('a', {})).not.toBe(hashCall('b', {}));
  });
});

describe('memoryJournalStore', () => {
  it('appends and loads entries in order', async () => {
    const s = memoryJournalStore();
    await s.append('run1', { index: 0, hash: 'h0', result: 'r0' });
    await s.append('run1', { index: 1, hash: 'h1', result: 'r1' });
    const entries = await s.load('run1');
    expect(entries.map((e) => e.result)).toEqual(['r0', 'r1']);
  });
});

describe('fileJournalStore', () => {
  it('round-trips entries through JSONL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jrnl-'));
    const s = fileJournalStore(dir);
    await s.append('runA', { index: 0, hash: 'h', result: { ok: true } });
    const entries = await s.load('runA');
    expect(entries).toEqual([{ index: 0, hash: 'h', result: { ok: true } }]);
  });
});
