# Flint Compress Transforms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 6 stub transforms in `packages/flint/src/compress.ts` with real implementations (`dedup`, `truncateToolResults`, `windowLast`, `windowFirst`, `summarize`, `orderForCache`); remove `pinSystem` from the public surface.

**Architecture:** Seven tasks. First task removes `pinSystem` (API trim). Next five tasks implement transforms in dependency-free order (pure-compute first, LLM-dependent last). Final task runs integration tests and tags `v0.4.0`.

**Tech Stack:** Existing flint scaffold. No new runtime deps. Works against existing `call()` primitive (Plan 2) and `ProviderAdapter` interface.

**Reference spec:** `docs/superpowers/specs/2026-04-20-flint-compress-transforms-design.md`

---

## Pre-flight

Work in `C:/Users/KadeHeglin/Downloads/Projects/Flint/`. Shell is Git Bash on Windows; Unix syntax. Substitute `pnpm` → `npx pnpm@9.15.0`.

Current state after Plan 4:
- 47 commits, tags `v0.0.0` – `v0.3.0`
- `compress.ts`: `pipeline` real; `dedup`, `truncateToolResults`, `windowLast`, `windowFirst`, `pinSystem`, `summarize`, `orderForCache` all stubs
- `compress.test.ts`: contains stub-era surface tests expecting `NotImplementedError`
- 175 total tests passing

## File map

```
packages/flint/
├── src/
│   └── compress.ts                     # MODIFY: 6 stubs → real impl, remove pinSystem
└── test/
    ├── compress.test.ts                # REPLACE: full per-transform coverage
    └── surface.test.ts                 # MODIFY: drop 'pinSystem' from expected exports
```

---

## Task 1: Remove `pinSystem` from public surface

**Files:**
- Modify: `packages/flint/src/compress.ts`
- Modify: `packages/flint/test/surface.test.ts`

- [ ] **Step 1: Remove `pinSystem` export from `packages/flint/src/compress.ts`**

Find and delete the `pinSystem` export (around the middle of the file):

```ts
export function pinSystem(): Transform {
  return async () => {
    throw new NotImplementedError('compress.pinSystem');
  };
}
```

Remove the entire function. Leave everything else intact.

- [ ] **Step 2: Update `packages/flint/test/surface.test.ts`**

Find the block that asserts compress exports and remove `'pinSystem'` from the array:

```ts
  it('compress subpath resolves', async () => {
    const mod = await import('../src/compress.ts');
    for (const name of [
      'pipeline',
      'dedup',
      'truncateToolResults',
      'windowLast',
      'windowFirst',
      'summarize',
      'orderForCache',
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe('function');
    }
  });
```

(List should have 7 entries, not 8. `pinSystem` is gone.)

- [ ] **Step 3: Update `packages/flint/test/compress.test.ts`**

Find the existing `pinSystem` test case in the current compress.test.ts (from Plan 1 scaffold) and remove it. The current file has an array `transforms` used in a parameterized test — remove the `['pinSystem', pinSystem()]` entry and remove the `pinSystem` import.

Context: the existing `compress.test.ts` has a block like:

```ts
const transforms = [
  ['dedup', dedup()],
  ['truncateToolResults', truncateToolResults({ maxChars: 10 })],
  ['windowLast', windowLast({ keep: 1 })],
  ['windowFirst', windowFirst({ keep: 1 })],
  ['pinSystem', pinSystem()],
  ['orderForCache', orderForCache()],
] as const;
```

Remove the `pinSystem` entry. Remove `pinSystem` from the import at top. The rest of this file will be fully replaced in subsequent tasks — this change is transitional.

- [ ] **Step 4: Run test + typecheck**

```bash
npx pnpm@9.15.0 --filter flint test
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: all tests still pass; remaining compress tests still assert `NotImplementedError` for the other transforms. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/compress.ts packages/flint/test/surface.test.ts packages/flint/test/compress.test.ts
git commit -m "refactor(flint): remove pinSystem from compress surface (covered by alwaysKeep)"
```

---

## Task 2: `dedup()` implementation

**Files:**
- Modify: `packages/flint/src/compress.ts`
- Modify: `packages/flint/test/compress.test.ts`

- [ ] **Step 1: Replace the `dedup` section of `packages/flint/test/compress.test.ts`**

For this and later tasks, treat `compress.test.ts` as being progressively rewritten per-transform. Replace the existing `dedup` surface test with these behavior tests. If the existing file has a `transforms` parameterized loop, split `dedup` out of it — dedup now has its own `describe` block.

Suggested file layout going forward (top of file):

```ts
import { describe, expect, it } from 'vitest';
import {
  dedup,
  orderForCache,
  pipeline,
  summarize,
  truncateToolResults,
  windowFirst,
  windowLast,
} from '../src/compress.ts';
import { mockAdapter } from '../src/testing/mock-adapter.ts';
import type { ContentPart, Message } from '../src/types.ts';
```

Replace the existing `dedup` test block with:

```ts
describe('dedup', () => {
  it('returns empty array for empty input', async () => {
    const t = dedup();
    const out = await t([], {});
    expect(out).toEqual([]);
  });

  it('leaves unique messages unchanged', async () => {
    const t = dedup();
    const msgs: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
    ];
    const out = await t(msgs, {});
    expect(out).toEqual(msgs);
  });

  it('drops duplicate user messages, keeping first occurrence', async () => {
    const t = dedup();
    const msgs: Message[] = [
      { role: 'user', content: 'dup' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'dup' },
    ];
    const out = await t(msgs, {});
    expect(out).toEqual([
      { role: 'user', content: 'dup' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  it('preserves all system messages even when content duplicates', async () => {
    const t = dedup();
    const msgs: Message[] = [
      { role: 'system', content: 'x' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'x' },
    ];
    const out = await t(msgs, {});
    expect(out).toEqual(msgs);
  });

  it('treats ContentPart[] as duplicate via deep equality', async () => {
    const t = dedup();
    const parts: ContentPart[] = [{ type: 'text', text: 'same' }];
    const msgs: Message[] = [
      { role: 'user', content: parts },
      { role: 'user', content: [...parts] }, // different array, same content
    ];
    const out = await t(msgs, {});
    expect(out).toHaveLength(1);
  });

  it('ignores toolCalls when computing duplicate key', async () => {
    const t = dedup();
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: 'same',
        toolCalls: [{ id: 'a', name: 'x', arguments: {} }],
      },
      {
        role: 'assistant',
        content: 'same',
        toolCalls: [{ id: 'b', name: 'x', arguments: {} }],
      },
    ];
    const out = await t(msgs, {});
    expect(out).toHaveLength(1);
  });

  it('does not mutate input array', async () => {
    const t = dedup();
    const msgs: Message[] = [
      { role: 'user', content: 'dup' },
      { role: 'user', content: 'dup' },
    ];
    const copy = [...msgs];
    await t(msgs, {});
    expect(msgs).toEqual(copy);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
```

Expected: new dedup tests fail with `NotImplementedError` from the stub.

- [ ] **Step 3: Replace `dedup` stub in `packages/flint/src/compress.ts`**

Find:

```ts
export function dedup(): Transform {
  return async () => {
    throw new NotImplementedError('compress.dedup');
  };
}
```

Replace with:

```ts
export function dedup(): Transform {
  return async (messages) => {
    const seen = new Set<string>();
    const result: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push(msg);
        continue;
      }
      const contentKey =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const key = `${msg.role}:${contentKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(msg);
    }
    return result;
  };
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 7 dedup tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/compress.ts packages/flint/test/compress.test.ts
git commit -m "feat(flint): implement compress.dedup (system messages exempt)"
```

---

## Task 3: `truncateToolResults({ maxChars })` implementation

**Files:**
- Modify: `packages/flint/src/compress.ts`
- Modify: `packages/flint/test/compress.test.ts`

- [ ] **Step 1: Append truncateToolResults tests to `packages/flint/test/compress.test.ts`**

Add this `describe` block after the `dedup` block (below the closing `});` of the dedup block but before any closing file braces):

```ts
describe('truncateToolResults', () => {
  it('throws TypeError when maxChars is too small', () => {
    expect(() => truncateToolResults({ maxChars: 50 })).toThrow(TypeError);
  });

  it('leaves short tool results unchanged', async () => {
    const t = truncateToolResults({ maxChars: 1000 });
    const msgs: Message[] = [
      { role: 'tool', content: 'short result', toolCallId: 'c1' },
    ];
    const out = await t(msgs, {});
    expect(out).toEqual(msgs);
  });

  it('truncates long tool results with marker', async () => {
    const t = truncateToolResults({ maxChars: 100 });
    const longContent = 'x'.repeat(500);
    const msgs: Message[] = [
      { role: 'tool', content: longContent, toolCallId: 'c1' },
    ];
    const out = await t(msgs, {});
    const resultContent = out[0]?.content;
    expect(typeof resultContent).toBe('string');
    if (typeof resultContent === 'string') {
      expect(resultContent.length).toBeLessThanOrEqual(100);
      expect(resultContent).toContain('truncated');
      expect(resultContent).toContain('400'); // 500 - (100 - markerLen)
    }
  });

  it('preserves toolCallId in truncated message', async () => {
    const t = truncateToolResults({ maxChars: 100 });
    const msgs: Message[] = [
      { role: 'tool', content: 'x'.repeat(500), toolCallId: 'my-id' },
    ];
    const out = await t(msgs, {});
    expect(out[0]).toMatchObject({ toolCallId: 'my-id' });
  });

  it('does not truncate non-tool messages', async () => {
    const t = truncateToolResults({ maxChars: 100 });
    const longContent = 'x'.repeat(500);
    const msgs: Message[] = [
      { role: 'user', content: longContent },
      { role: 'assistant', content: longContent },
      { role: 'system', content: longContent },
    ];
    const out = await t(msgs, {});
    expect(out[0]?.content).toBe(longContent);
    expect(out[1]?.content).toBe(longContent);
    expect(out[2]?.content).toBe(longContent);
  });

  it('does not mutate input', async () => {
    const t = truncateToolResults({ maxChars: 100 });
    const msg: Message = {
      role: 'tool',
      content: 'x'.repeat(500),
      toolCallId: 'c1',
    };
    const original = { ...msg };
    await t([msg], {});
    expect(msg).toEqual(original);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
```

Expected: `truncateToolResults` tests fail — stub throws.

- [ ] **Step 3: Replace stub in `packages/flint/src/compress.ts`**

Find:

```ts
export type TruncateOpts = { maxChars: number };
export function truncateToolResults(_opts: TruncateOpts): Transform {
  return async () => {
    throw new NotImplementedError('compress.truncateToolResults');
  };
}
```

Replace with:

```ts
export type TruncateOpts = { maxChars: number };

export function truncateToolResults(opts: TruncateOpts): Transform {
  if (opts.maxChars <= 50) {
    throw new TypeError(
      `truncateToolResults: maxChars must be > 50 (got ${opts.maxChars})`,
    );
  }
  const { maxChars } = opts;
  return async (messages) => {
    return messages.map((msg) => {
      if (msg.role !== 'tool') return msg;
      if (msg.content.length <= maxChars) return msg;
      const dropped = msg.content.length - maxChars;
      const marker = `…[truncated, ${dropped} chars dropped]`;
      const sliceLen = Math.max(0, maxChars - marker.length);
      return {
        ...msg,
        content: msg.content.slice(0, sliceLen) + marker,
      };
    });
  };
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 6 truncate tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/compress.ts packages/flint/test/compress.test.ts
git commit -m "feat(flint): implement compress.truncateToolResults with marker"
```

---

## Task 4: `windowLast` + `windowFirst` (mirror implementations)

**Files:**
- Modify: `packages/flint/src/compress.ts`
- Modify: `packages/flint/test/compress.test.ts`

- [ ] **Step 1: Append window tests to `packages/flint/test/compress.test.ts`**

Add these two `describe` blocks after the existing transform tests:

```ts
describe('windowLast', () => {
  const fixture: Message[] = [
    { role: 'system', content: 'sys1' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ];

  it('throws TypeError when keep is negative', () => {
    expect(() => windowLast({ keep: -1 })).toThrow(TypeError);
  });

  it('keep: 0, alwaysKeep: [] returns empty', async () => {
    const t = windowLast({ keep: 0, alwaysKeep: [] });
    const out = await t(fixture, {});
    expect(out).toEqual([]);
  });

  it('default alwaysKeep preserves system messages', async () => {
    const t = windowLast({ keep: 2 });
    const out = await t(fixture, {});
    expect(out).toEqual([
      { role: 'system', content: 'sys1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]);
  });

  it('keeps last N non-system messages when alwaysKeep is default', async () => {
    const t = windowLast({ keep: 3 });
    const out = await t(fixture, {});
    expect(out.map((m) => (m as { content: string }).content)).toEqual([
      'sys1',
      'u2',
      'a2',
      'u3',
    ]);
  });

  it('preserves multiple system messages at original positions', async () => {
    const t = windowLast({ keep: 1 });
    const msgs: Message[] = [
      { role: 'system', content: 's1' },
      { role: 'user', content: 'u1' },
      { role: 'system', content: 's2' },
      { role: 'user', content: 'u2' },
      { role: 'user', content: 'u3' },
    ];
    const out = await t(msgs, {});
    expect(out).toEqual([
      { role: 'system', content: 's1' },
      { role: 'system', content: 's2' },
      { role: 'user', content: 'u3' },
    ]);
  });

  it('explicit empty alwaysKeep strips system too', async () => {
    const t = windowLast({ keep: 2, alwaysKeep: [] });
    const out = await t(fixture, {});
    expect(out).toEqual([
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]);
  });

  it('does not mutate input array', async () => {
    const t = windowLast({ keep: 2 });
    const copy = [...fixture];
    await t(fixture, {});
    expect(fixture).toEqual(copy);
  });

  it('keep greater than messages length returns everything eligible', async () => {
    const t = windowLast({ keep: 100 });
    const out = await t(fixture, {});
    expect(out).toEqual(fixture);
  });
});

describe('windowFirst', () => {
  const fixture: Message[] = [
    { role: 'system', content: 'sys1' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
  ];

  it('throws TypeError when keep is negative', () => {
    expect(() => windowFirst({ keep: -1 })).toThrow(TypeError);
  });

  it('keep: 0, alwaysKeep: [] returns empty', async () => {
    const t = windowFirst({ keep: 0, alwaysKeep: [] });
    const out = await t(fixture, {});
    expect(out).toEqual([]);
  });

  it('default alwaysKeep preserves system messages', async () => {
    const t = windowFirst({ keep: 2 });
    const out = await t(fixture, {});
    expect(out).toEqual([
      { role: 'system', content: 'sys1' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('takes first N eligible', async () => {
    const t = windowFirst({ keep: 1 });
    const out = await t(fixture, {});
    expect(out).toEqual([
      { role: 'system', content: 'sys1' },
      { role: 'user', content: 'u1' },
    ]);
  });

  it('does not mutate input', async () => {
    const t = windowFirst({ keep: 2 });
    const copy = [...fixture];
    await t(fixture, {});
    expect(fixture).toEqual(copy);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
```

Expected: stub throws.

- [ ] **Step 3: Replace both stubs in `packages/flint/src/compress.ts`**

Find:

```ts
export type WindowOpts = { keep: number; alwaysKeep?: Array<Message['role']> };
export function windowLast(_opts: WindowOpts): Transform {
  return async () => {
    throw new NotImplementedError('compress.windowLast');
  };
}

export function windowFirst(_opts: WindowOpts): Transform {
  return async () => {
    throw new NotImplementedError('compress.windowFirst');
  };
}
```

Replace with:

```ts
export type WindowOpts = {
  keep: number;
  alwaysKeep?: Array<Message['role']>;
};

function validateWindow(opts: WindowOpts, name: string): void {
  if (opts.keep < 0 || !Number.isInteger(opts.keep)) {
    throw new TypeError(`${name}: keep must be a non-negative integer (got ${opts.keep})`);
  }
}

function applyWindow(
  messages: Message[],
  keep: number,
  alwaysKeepRoles: Array<Message['role']>,
  take: 'first' | 'last',
): Message[] {
  // Partition with original indices
  const kept: Array<{ index: number; msg: Message }> = [];
  const eligible: Array<{ index: number; msg: Message }> = [];
  messages.forEach((msg, index) => {
    if (alwaysKeepRoles.includes(msg.role)) {
      kept.push({ index, msg });
    } else {
      eligible.push({ index, msg });
    }
  });

  const taken =
    take === 'last' ? eligible.slice(Math.max(0, eligible.length - keep)) : eligible.slice(0, keep);

  const merged = [...kept, ...taken].sort((a, b) => a.index - b.index);
  return merged.map((x) => x.msg);
}

export function windowLast(opts: WindowOpts): Transform {
  validateWindow(opts, 'windowLast');
  const alwaysKeepRoles = opts.alwaysKeep ?? ['system'];
  return async (messages) => applyWindow(messages, opts.keep, alwaysKeepRoles, 'last');
}

export function windowFirst(opts: WindowOpts): Transform {
  validateWindow(opts, 'windowFirst');
  const alwaysKeepRoles = opts.alwaysKeep ?? ['system'];
  return async (messages) => applyWindow(messages, opts.keep, alwaysKeepRoles, 'first');
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 13 window tests pass (8 windowLast + 5 windowFirst).

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/compress.ts packages/flint/test/compress.test.ts
git commit -m "feat(flint): implement windowLast and windowFirst with alwaysKeep"
```

---

## Task 5: `orderForCache` implementation

**Files:**
- Modify: `packages/flint/src/compress.ts`
- Modify: `packages/flint/test/compress.test.ts`

- [ ] **Step 1: Append orderForCache tests to `packages/flint/test/compress.test.ts`**

```ts
describe('orderForCache', () => {
  it('returns messages unchanged when no system messages', async () => {
    const t = orderForCache();
    const msgs: Message[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    const out = await t(msgs, {});
    expect(out).toEqual(msgs);
  });

  it('moves a single mid-conversation system message to front', async () => {
    const t = orderForCache();
    const msgs: Message[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u2' },
    ];
    const out = await t(msgs, {});
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ]);
  });

  it('preserves relative order of multiple system messages', async () => {
    const t = orderForCache();
    const msgs: Message[] = [
      { role: 'user', content: 'u1' },
      { role: 'system', content: 's1' },
      { role: 'user', content: 'u2' },
      { role: 'system', content: 's2' },
    ];
    const out = await t(msgs, {});
    expect(out).toEqual([
      { role: 'system', content: 's1' },
      { role: 'system', content: 's2' },
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
    ]);
  });

  it('preserves chronological order of non-system messages', async () => {
    const t = orderForCache();
    const msgs: Message[] = [
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'a2' },
    ];
    const out = await t(msgs, {});
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a2' },
    ]);
  });

  it('does not mutate input', async () => {
    const t = orderForCache();
    const msgs: Message[] = [
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'sys' },
    ];
    const copy = [...msgs];
    await t(msgs, {});
    expect(msgs).toEqual(copy);
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
```

- [ ] **Step 3: Replace stub in `packages/flint/src/compress.ts`**

Find:

```ts
export function orderForCache(): Transform {
  return async () => {
    throw new NotImplementedError('compress.orderForCache');
  };
}
```

Replace with:

```ts
export function orderForCache(): Transform {
  return async (messages) => {
    const systems: Message[] = [];
    const rest: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') systems.push(msg);
      else rest.push(msg);
    }
    return [...systems, ...rest];
  };
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
npx pnpm@9.15.0 --filter flint typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/compress.ts packages/flint/test/compress.test.ts
git commit -m "feat(flint): implement orderForCache (system-first prefix stability)"
```

---

## Task 6: `summarize` implementation (LLM-backed)

**Files:**
- Modify: `packages/flint/src/compress.ts`
- Modify: `packages/flint/test/compress.test.ts`

- [ ] **Step 1: Append summarize tests to `packages/flint/test/compress.test.ts`**

```ts
describe('summarize', () => {
  const makeAdapter = (summary: string) =>
    mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: summary },
        usage: { input: 100, output: 20 },
        stopReason: 'end',
      }),
    });

  const largeFixture: Message[] = [
    { role: 'system', content: 'be helpful' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer' },
    { role: 'user', content: 'third question' },
    { role: 'assistant', content: 'third answer' },
    { role: 'user', content: 'latest question' },
  ];

  it('returns messages unchanged when when() returns false', async () => {
    const adapter = makeAdapter('unused');
    const t = summarize({ when: () => false, adapter, model: 'm' });
    const out = await t(largeFixture, {});
    expect(out).toEqual(largeFixture);
    expect(adapter.calls).toHaveLength(0);
  });

  it('returns messages unchanged when not enough messages to summarize', async () => {
    const adapter = makeAdapter('unused');
    const t = summarize({ when: () => true, adapter, model: 'm', keepLast: 4 });
    const small: Message[] = [
      { role: 'user', content: 'only 1' },
      { role: 'assistant', content: 'only 2' },
    ];
    const out = await t(small, {});
    expect(out).toEqual(small);
    expect(adapter.calls).toHaveLength(0);
  });

  it('summarizes when triggered, preserving last N messages verbatim', async () => {
    const adapter = makeAdapter('Discussed X, Y, Z');
    const t = summarize({ when: () => true, adapter, model: 'm', keepLast: 3 });
    const out = await t(largeFixture, {});

    expect(adapter.calls).toHaveLength(1);
    // First message is the summary
    expect(out[0]?.role).toBe('system');
    expect(typeof out[0]?.content).toBe('string');
    if (typeof out[0]?.content === 'string') {
      expect(out[0].content).toContain('Summary of prior conversation');
      expect(out[0].content).toContain('Discussed X, Y, Z');
    }
    // Last 3 preserved verbatim
    expect(out.slice(1)).toEqual(largeFixture.slice(-3));
  });

  it('uses default keepLast of 4 when not specified', async () => {
    const adapter = makeAdapter('sum');
    const t = summarize({ when: () => true, adapter, model: 'm' });
    const out = await t(largeFixture, {});
    // 1 summary + last 4 verbatim = 5 messages
    expect(out).toHaveLength(5);
    expect(out.slice(1)).toEqual(largeFixture.slice(-4));
  });

  it('returns messages unchanged on adapter error (fail-open)', async () => {
    const adapter = mockAdapter({
      onCall: () => {
        throw new Error('network down');
      },
    });
    const t = summarize({ when: () => true, adapter, model: 'm' });
    const out = await t(largeFixture, {});
    expect(out).toEqual(largeFixture);
  });

  it('honors custom promptPrefix', async () => {
    const adapter = makeAdapter('result');
    const t = summarize({
      when: () => true,
      adapter,
      model: 'm',
      promptPrefix: 'Custom prefix:',
    });
    await t(largeFixture, {});
    const sentMessages = adapter.calls[0]?.messages ?? [];
    const sysMsg = sentMessages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toBe('Custom prefix:');
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
```

- [ ] **Step 3: Replace stub in `packages/flint/src/compress.ts`**

Find:

```ts
export type SummarizeOpts = {
  when: (messages: Message[]) => boolean;
  adapter: ProviderAdapter;
  model: string;
  keepLast?: number;
};
export function summarize(_opts: SummarizeOpts): Transform {
  return async () => {
    throw new NotImplementedError('compress.summarize');
  };
}
```

Replace with:

```ts
export type SummarizeOpts = {
  when: (messages: Message[]) => boolean;
  adapter: ProviderAdapter;
  model: string;
  keepLast?: number;
  promptPrefix?: string;
};

const DEFAULT_SUMMARIZE_PREFIX =
  'Summarize the following conversation concisely, preserving key facts, decisions, and user intent:';

export function summarize(opts: SummarizeOpts): Transform {
  const keepLast = opts.keepLast ?? 4;
  const promptPrefix = opts.promptPrefix ?? DEFAULT_SUMMARIZE_PREFIX;

  return async (messages) => {
    if (!opts.when(messages)) return messages;
    if (messages.length < keepLast + 2) return messages;

    const toSummarize = messages.slice(0, messages.length - keepLast);
    const toKeep = messages.slice(messages.length - keepLast);

    let summary: string;
    try {
      const resp = await opts.adapter.call({
        model: opts.model,
        messages: [
          { role: 'system', content: promptPrefix },
          { role: 'user', content: JSON.stringify(toSummarize, null, 2) },
        ],
      });
      summary = resp.message.content;
    } catch {
      // Fail-open: compression is best-effort
      return messages;
    }

    return [
      { role: 'system', content: `Summary of prior conversation: ${summary}` },
      ...toKeep,
    ];
  };
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 6 summarize tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/compress.ts packages/flint/test/compress.test.ts
git commit -m "feat(flint): implement summarize (LLM-backed, fail-open)"
```

---

## Task 7: Integration tests + full verification + tag v0.4.0

**Files:**
- Modify: `packages/flint/test/compress.test.ts`

- [ ] **Step 1: Append integration tests to `packages/flint/test/compress.test.ts`**

```ts
describe('compress integration (pipeline composition)', () => {
  it('pipeline(dedup, truncateToolResults) applies both in order', async () => {
    const p = pipeline(dedup(), truncateToolResults({ maxChars: 100 }));
    const msgs: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'x'.repeat(500), toolCallId: 'c1' },
    ];
    const out = await p(msgs, {});
    expect(out).toHaveLength(2); // dup dropped
    expect(out[1]?.content).toMatch(/truncated/);
  });

  it('pipeline(windowLast, dedup) windows then dedups', async () => {
    const p = pipeline(windowLast({ keep: 5 }), dedup());
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'user', content: 'd' },
      { role: 'user', content: 'd' },
      { role: 'user', content: 'e' },
    ];
    const out = await p(msgs, {});
    // windowLast keeps system + last 5 (c, d, d, e)... wait: after system, we have 6 non-system. Last 5 = [b, c, d, d, e].
    // So out after windowLast: [sys, b, c, d, d, e]
    // After dedup: [sys, b, c, d, e]
    expect(out.map((m) => (m as { content: string }).content)).toEqual([
      'sys',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('realistic scenario: reduces total character count via window + truncate', async () => {
    const msgs: Message[] = [
      { role: 'system', content: 'be helpful' },
    ];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'user', content: `Question ${i}` });
      msgs.push({ role: 'assistant', content: `Answer ${i}`.repeat(20) });
      msgs.push({ role: 'tool', content: 'x'.repeat(5000), toolCallId: `c${i}` });
    }
    const originalChars = msgs.reduce(
      (acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );

    const p = pipeline(
      windowLast({ keep: 10 }),
      truncateToolResults({ maxChars: 200 }),
    );
    const out = await p(msgs, {});
    const afterChars = out.reduce(
      (acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );

    expect(afterChars).toBeLessThan(originalChars * 0.5); // ≥ 50% reduction
  });
});
```

- [ ] **Step 2: Run tests, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- compress
```

Expected: 3 integration tests pass. Combined with per-transform tests, compress.test.ts should have ~40 tests.

- [ ] **Step 3: Run full repo test suite**

```bash
npx pnpm@9.15.0 test
```

Expected: all packages green. Flint ~205 tests (175 + 40 new compress - approximately 10 stub tests removed). Peer packages still 9 tests.

- [ ] **Step 4: Typecheck + build + lint**

```bash
npx pnpm@9.15.0 typecheck
npx pnpm@9.15.0 --filter flint build
npx pnpm@9.15.0 lint
```

Expected: all clean. `dist/compress.js` size should be modest (under 5 KB — all transforms are small pure functions except summarize which is also compact).

- [ ] **Step 5: Commit any lint fixups**

```bash
git status
```

If modified files exist:

```bash
git add -A
git commit -m "chore: apply biome formatting after compress transforms"
```

- [ ] **Step 6: Tag v0.4.0**

```bash
git tag -a v0.4.0 -m "v0.4.0 — compress transforms (dedup/truncate/window/summarize/orderForCache)"
git tag -l
```

Expected: `v0.0.0`, `v0.1.0`, `v0.2.0`, `v0.3.0`, `v0.4.0`.

- [ ] **Step 7: Final report**

Print:
- Total commits: `git rev-list --count HEAD`
- Total tests: from Step 3
- Bundle: `ls -la packages/flint/dist/compress.js packages/flint/dist/index.js`
- Remaining stubs grep: `grep -rln 'NotImplementedError' packages/flint/src/ packages/*/src/`

Expected remaining stubs:
- `memory.ts` (3 factories) — Plan 6
- `rag.ts` (3 functions) — Plan 6
- `recipes.ts` (4 recipes) — Plan 7
- `@flint/graph` — Plan 8
- `@flint/adapter-anthropic` — Plan 9
- `@flint/adapter-openai-compat` — Plan 10

`compress.ts` should no longer appear in the grep output (only `errors.ts` would show because it *defines* NotImplementedError).

---

## Self-review checklist

- [ ] `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint` all pass from clean
- [ ] `pinSystem` removed from public exports; no stale references in tests
- [ ] All 6 transforms implemented; all tests behavior-focused, not stub-focused
- [ ] `dedup` preserves all system messages
- [ ] `truncateToolResults` TypeErrors on `maxChars <= 50`
- [ ] `windowLast` / `windowFirst` default `alwaysKeep: ['system']`; explicit `[]` strips system
- [ ] `summarize` is fail-open on adapter errors
- [ ] `orderForCache` preserves relative order within system group and within non-system group
- [ ] No new runtime deps
- [ ] `compress.ts` bundle under 5 KB
- [ ] `v0.4.0` tag exists
