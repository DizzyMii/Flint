# Flint Agent Loop + Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `budget()` and `agent()` stubs with real implementations. Wire budget exhaustion through `call` (Result) and `stream` (throw). Tighten `CallOptions<T>.schema` generic so `call<T>({ schema })` enforces schema-output = `T`.

**Architecture:** Five tasks, dependency-ordered. Budget first (no deps), then `call` adapts to real budget throws plus the generic tightening, then a single `stream` budget test, then the `agent` loop which composes `call` + `execute`, finally verify/tag.

**Tech Stack:** Existing flint scaffold (TypeScript strict, vitest, tsup, pnpm). No new runtime deps.

**Reference spec:** `docs/superpowers/specs/2026-04-20-flint-agent-budget-design.md`

---

## Pre-flight

All work happens in `C:/Users/KadeHeglin/Downloads/Projects/Flint/`. Shell is Git Bash on Windows; use Unix syntax. Substitute `pnpm` → `npx pnpm@9.15.0` for every pnpm command.

Current state after Plan 2:
- 29 commits, tagged `v0.0.0` and `v0.1.0`
- Primitives implemented: `call`, `stream`, `validate`, `execute`, `count`
- `agent`, `budget` still stubs throwing `NotImplementedError`
- 82 tests passing across 15 files in flint package

## File map for this plan

```
packages/flint/
├── src/
│   ├── budget.ts                  # MODIFY: stub → real impl
│   ├── agent.ts                   # MODIFY: stub → real impl
│   └── primitives/
│       └── call.ts                # MODIFY: tighten schema generic + wrap BudgetExhausted
└── test/
    ├── budget.test.ts             # REPLACE: full coverage
    ├── agent.test.ts              # REPLACE: full coverage
    ├── call.test.ts               # APPEND: budget cases
    └── stream.test.ts             # APPEND: budget case
```

No files created; no files deleted.

---

## Task 1: Real `budget()` implementation

**Files:**
- Modify: `packages/flint/src/budget.ts`
- Replace: `packages/flint/test/budget.test.ts`

- [ ] **Step 1: Replace `packages/flint/test/budget.test.ts` with full coverage**

```ts
import { describe, expect, it } from 'vitest';
import { budget } from '../src/budget.ts';
import { BudgetExhausted } from '../src/errors.ts';

describe('budget', () => {
  it('throws TypeError when no limit field is set', () => {
    expect(() => budget({})).toThrow(TypeError);
  });

  it('accepts any single field', () => {
    expect(() => budget({ maxSteps: 1 })).not.toThrow();
    expect(() => budget({ maxTokens: 1 })).not.toThrow();
    expect(() => budget({ maxDollars: 0.01 })).not.toThrow();
  });

  it('exposes limits', () => {
    const b = budget({ maxSteps: 5, maxTokens: 100 });
    expect(b.limits.maxSteps).toBe(5);
    expect(b.limits.maxTokens).toBe(100);
    expect(b.limits.maxDollars).toBeUndefined();
  });

  it('consume increments steps by 1 per call', () => {
    const b = budget({ maxSteps: 10 });
    b.consume({ input: 1, output: 1 });
    b.consume({ input: 1, output: 1 });
    b.consume({ input: 1, output: 1 });
    expect(b.remaining().steps).toBe(7);
  });

  it('consume accumulates tokens (input + output + cached)', () => {
    const b = budget({ maxTokens: 1000 });
    b.consume({ input: 100, output: 50, cached: 20 });
    expect(b.remaining().tokens).toBe(1000 - 170);
  });

  it('consume accumulates cost', () => {
    const b = budget({ maxDollars: 1.0 });
    b.consume({ cost: 0.25 });
    b.consume({ cost: 0.3 });
    expect(b.remaining().dollars).toBeCloseTo(0.45);
  });

  it('throws BudgetExhausted when consume exceeds maxSteps', () => {
    const b = budget({ maxSteps: 2 });
    b.consume({});
    b.consume({});
    expect(() => b.consume({})).toThrow(BudgetExhausted);
  });

  it('BudgetExhausted has correct code for steps', () => {
    const b = budget({ maxSteps: 1 });
    b.consume({});
    try {
      b.consume({});
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExhausted);
      expect((e as BudgetExhausted).code).toBe('budget.steps');
    }
  });

  it('BudgetExhausted has correct code for tokens', () => {
    const b = budget({ maxTokens: 50 });
    try {
      b.consume({ input: 40, output: 20 });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as BudgetExhausted).code).toBe('budget.tokens');
    }
  });

  it('BudgetExhausted has correct code for dollars', () => {
    const b = budget({ maxDollars: 0.5 });
    try {
      b.consume({ cost: 0.6 });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as BudgetExhausted).code).toBe('budget.dollars');
    }
  });

  it('assertNotExhausted throws when already over', () => {
    const b = budget({ maxSteps: 1 });
    b.consume({});
    // already at exhaustion boundary
    expect(() => b.assertNotExhausted()).toThrow(BudgetExhausted);
  });

  it('assertNotExhausted passes when under limits', () => {
    const b = budget({ maxSteps: 5 });
    b.consume({});
    expect(() => b.assertNotExhausted()).not.toThrow();
  });

  it('remaining returns undefined for unset fields', () => {
    const b = budget({ maxSteps: 5 });
    const r = b.remaining();
    expect(r.steps).toBe(5);
    expect(r.tokens).toBeUndefined();
    expect(r.dollars).toBeUndefined();
  });

  it('remaining returns 0 when exactly at limit, not negative', () => {
    const b = budget({ maxSteps: 2 });
    b.consume({});
    b.consume({});
    expect(b.remaining().steps).toBe(0);
  });

  it('remaining returns 0 when over limit (not negative)', () => {
    const b = budget({ maxTokens: 10 });
    try {
      b.consume({ input: 100 });
    } catch {
      // expected
    }
    expect(b.remaining().tokens).toBe(0);
  });

  it('steps check takes priority over tokens when both exceeded', () => {
    const b = budget({ maxSteps: 1, maxTokens: 10 });
    // First consume: steps goes to 1, tokens to 1000 — both exceeded
    try {
      b.consume({ input: 500, output: 500 });
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as BudgetExhausted).code).toBe('budget.steps');
    }
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- budget
```

Expected: all tests fail because `budget()` is still a stub throwing `NotImplementedError` on construction, and `consume`/`remaining`/`assertNotExhausted` also throw.

- [ ] **Step 3: Rewrite `packages/flint/src/budget.ts`**

```ts
import { BudgetExhausted } from './errors.ts';
import type { Usage } from './types.ts';

export type BudgetLimits = {
  maxSteps?: number;
  maxTokens?: number;
  maxDollars?: number;
};

export type BudgetRemaining = {
  steps?: number;
  tokens?: number;
  dollars?: number;
};

export type ConsumeInput = Partial<Usage> & { cost?: number };

export type Budget = {
  readonly limits: BudgetLimits;
  consume(x: ConsumeInput): void;
  assertNotExhausted(): void;
  remaining(): BudgetRemaining;
};

type ExhaustedField = {
  field: 'steps' | 'tokens' | 'dollars';
  limit: number;
  used: number;
};

export function budget(limits: BudgetLimits): Budget {
  if (
    limits.maxSteps === undefined &&
    limits.maxTokens === undefined &&
    limits.maxDollars === undefined
  ) {
    throw new TypeError(
      'budget: at least one of maxSteps, maxTokens, or maxDollars must be set',
    );
  }

  let stepsUsed = 0;
  let tokensUsed = 0;
  let dollarsUsed = 0;

  function isExhausted(): ExhaustedField | null {
    if (limits.maxSteps !== undefined && stepsUsed >= limits.maxSteps) {
      return { field: 'steps', limit: limits.maxSteps, used: stepsUsed };
    }
    if (limits.maxTokens !== undefined && tokensUsed >= limits.maxTokens) {
      return { field: 'tokens', limit: limits.maxTokens, used: tokensUsed };
    }
    if (limits.maxDollars !== undefined && dollarsUsed >= limits.maxDollars) {
      return { field: 'dollars', limit: limits.maxDollars, used: dollarsUsed };
    }
    return null;
  }

  return {
    limits,
    consume(x) {
      stepsUsed += 1;
      tokensUsed += (x.input ?? 0) + (x.output ?? 0) + (x.cached ?? 0);
      dollarsUsed += x.cost ?? 0;
      const exhausted = isExhausted();
      if (exhausted) {
        throw new BudgetExhausted(
          `Budget exhausted: ${exhausted.field} used ${exhausted.used} >= limit ${exhausted.limit}`,
          { code: `budget.${exhausted.field}` },
        );
      }
    },
    assertNotExhausted() {
      const exhausted = isExhausted();
      if (exhausted) {
        throw new BudgetExhausted(
          `Budget already exhausted: ${exhausted.field} used ${exhausted.used} >= limit ${exhausted.limit}`,
          { code: `budget.${exhausted.field}` },
        );
      }
    },
    remaining() {
      return {
        ...(limits.maxSteps !== undefined
          ? { steps: Math.max(0, limits.maxSteps - stepsUsed) }
          : {}),
        ...(limits.maxTokens !== undefined
          ? { tokens: Math.max(0, limits.maxTokens - tokensUsed) }
          : {}),
        ...(limits.maxDollars !== undefined
          ? { dollars: Math.max(0, limits.maxDollars - dollarsUsed) }
          : {}),
      };
    },
  };
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- budget
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 16 tests pass, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/budget.ts packages/flint/test/budget.test.ts
git commit -m "feat(flint): implement budget with throw-on-exhaustion semantics"
```

---

## Task 2: Tighten `CallOptions<T>` generic + wrap BudgetExhausted in `call`

**Files:**
- Modify: `packages/flint/src/primitives/call.ts`
- Append to: `packages/flint/test/call.test.ts`

- [ ] **Step 1: Append budget + type tests to `packages/flint/test/call.test.ts`**

Open `packages/flint/test/call.test.ts` and add the following imports at the top (after the existing imports):

```ts
import { budget } from '../src/budget.ts';
import { BudgetExhausted } from '../src/errors.ts';
import { expectTypeOf } from 'vitest';
```

Append these test blocks inside the `describe('call', ...)` block, just before the closing `});`:

```ts
  it('returns Result.error(BudgetExhausted) when budget is exhausted post-consume', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'ok' },
        usage: { input: 50, output: 50 },
        stopReason: 'end',
      }),
    });
    // maxTokens 100, so the first consume (100 tokens) exhausts
    const b = budget({ maxTokens: 100 });
    const res = await call({ adapter, model: 'm', messages: msg, budget: b });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(BudgetExhausted);
      expect(res.error.code).toBe('budget.tokens');
    }
  });

  it('returns Result.error(BudgetExhausted) when budget is already exhausted before call', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'unused' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
    });
    const b = budget({ maxSteps: 1 });
    b.consume({}); // now at limit
    const res = await call({ adapter, model: 'm', messages: msg, budget: b });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(BudgetExhausted);
      expect(res.error.code).toBe('budget.steps');
    }
    // Adapter should NOT have been called because pre-check failed
    expect(adapter.calls).toHaveLength(0);
  });

  it('call<T> type requires schema output to match T', () => {
    // Compile-time test only; expectTypeOf is a no-op at runtime
    type MyShape = { n: number };
    const goodSchema = jsonSchema<MyShape>(
      (v): v is MyShape =>
        typeof v === 'object' && v !== null && 'n' in v && typeof (v as { n: unknown }).n === 'number',
    );
    // Valid: schema returns MyShape, call<MyShape> accepts it
    expectTypeOf(call<MyShape>)
      .parameter(0)
      .toMatchTypeOf<{ schema?: typeof goodSchema }>();
  });
```

- [ ] **Step 2: Run test to confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- call
```

Expected: the two budget tests fail. The first because `call` currently lets `BudgetExhausted` throw instead of wrapping. The second because the pre-check path also throws.

- [ ] **Step 3: Modify `packages/flint/src/primitives/call.ts`**

Replace the entire file content with:

```ts
import type { NormalizedRequest, ProviderAdapter } from '../adapter.ts';
import type { Budget } from '../budget.ts';
import type { Transform } from '../compress.ts';
import { AdapterError, BudgetExhausted, ParseError } from '../errors.ts';
import type {
  Logger,
  Message,
  Result,
  StandardSchemaV1,
  StopReason,
  Usage,
} from '../types.ts';
import { validate } from './validate.ts';

export type CallOptions<T = unknown> = Omit<
  NormalizedRequest,
  'signal' | 'messages' | 'schema'
> & {
  adapter: ProviderAdapter;
  messages: Message[];
  schema?: StandardSchemaV1<unknown, T>;
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

export type CallOutput<T = unknown> = {
  message: Message & { role: 'assistant' };
  value?: T;
  usage: Usage;
  cost?: number;
  stopReason: StopReason;
};

export async function call<T = unknown>(
  options: CallOptions<T>,
): Promise<Result<CallOutput<T>>> {
  if (!options || !options.adapter || !options.model || !options.messages) {
    throw new TypeError(
      'call: options.adapter, options.model, and options.messages are required',
    );
  }

  const ctx = {
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    model: options.model,
  };
  const messages = options.compress
    ? await options.compress(options.messages, ctx)
    : options.messages;

  if (options.budget) {
    try {
      options.budget.assertNotExhausted();
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        return { ok: false, error: e };
      }
      throw e;
    }
  }

  const req: NormalizedRequest = {
    model: options.model,
    messages,
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stopSequences !== undefined ? { stopSequences: options.stopSequences } : {}),
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };

  let resp;
  try {
    resp = await options.adapter.call(req);
  } catch (e) {
    return {
      ok: false,
      error: new AdapterError(
        e instanceof Error ? e.message : 'Adapter call failed',
        { code: 'adapter.call_failed', cause: e },
      ),
    };
  }

  if (options.budget) {
    try {
      options.budget.consume({
        ...resp.usage,
        ...(resp.cost !== undefined ? { cost: resp.cost } : {}),
      });
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        return { ok: false, error: e };
      }
      throw e;
    }
  }

  const output: CallOutput<T> = {
    message: resp.message,
    usage: resp.usage,
    ...(resp.cost !== undefined ? { cost: resp.cost } : {}),
    stopReason: resp.stopReason,
  };

  if (options.schema && resp.stopReason !== 'tool_call') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(resp.message.content);
    } catch (e) {
      return {
        ok: false,
        error: new ParseError('Response content is not valid JSON', {
          code: 'parse.response_json',
          cause: e,
        }),
      };
    }
    const validated = await validate(parsed, options.schema);
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }
    output.value = validated.value;
  }

  return { ok: true, value: output };
}
```

Changes from Plan 2:
1. `CallOptions<T>` becomes generic; `schema` is now typed `StandardSchemaV1<unknown, T>`
2. `Omit` adds `'schema'` to the removed fields so the typed version takes its place
3. Both budget call sites wrap `BudgetExhausted` throws into `Result.error`
4. `output.value = validated.value as T` → just `validated.value` (cast no longer needed because `T` and schema output are unified)
5. Import `BudgetExhausted` from errors

- [ ] **Step 4: Run tests, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- call
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 12 tests pass (9 pre-existing + 3 new), zero type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/primitives/call.ts packages/flint/test/call.test.ts
git commit -m "feat(flint): wrap BudgetExhausted in call + tighten CallOptions<T> schema generic"
```

---

## Task 3: Stream budget propagation test

**Files:**
- Append to: `packages/flint/test/stream.test.ts`

No source change needed — `stream` already propagates throws from the adapter iterable, which includes `BudgetExhausted` thrown by `budget.consume` when the usage chunk arrives.

- [ ] **Step 1: Append budget test to `packages/flint/test/stream.test.ts`**

Add these imports at the top (after existing imports):

```ts
import { budget } from '../src/budget.ts';
import { BudgetExhausted } from '../src/errors.ts';
```

Append this test inside the `describe('stream', ...)` block, before the closing `});`:

```ts
  it('propagates BudgetExhausted when usage chunk exceeds budget', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 50, output: 50 },
        stopReason: 'end',
      }),
      onStream: async function* () {
        yield { type: 'text', delta: 'hi' };
        yield { type: 'usage', usage: { input: 60, output: 60 } };
        yield { type: 'end', reason: 'end' };
      },
    });
    const b = budget({ maxTokens: 100 });
    const iter = stream({ adapter, model: 'm', messages: msg, budget: b });
    await expect(async () => {
      for await (const _chunk of iter) {
        // drain until throw
      }
    }).rejects.toThrow(BudgetExhausted);
  });
```

- [ ] **Step 2: Run test to confirm PASS immediately**

```bash
npx pnpm@9.15.0 --filter flint test -- stream
```

Expected: 6 tests pass (5 pre-existing + 1 new). Since `stream` already propagates adapter throws unchanged, and `budget.consume` now throws real `BudgetExhausted` errors after Task 1, this test should pass without any source modification. If it fails, verify Task 1 landed correctly.

- [ ] **Step 3: Commit**

```bash
git add packages/flint/test/stream.test.ts
git commit -m "test(flint): verify stream propagates BudgetExhausted"
```

---

## Task 4: Real `agent()` implementation

**Files:**
- Modify: `packages/flint/src/agent.ts`
- Replace: `packages/flint/test/agent.test.ts`

- [ ] **Step 1: Replace `packages/flint/test/agent.test.ts` with full coverage**

```ts
import { describe, expect, it, vi } from 'vitest';
import { agent } from '../src/agent.ts';
import { budget } from '../src/budget.ts';
import { BudgetExhausted, FlintError } from '../src/errors.ts';
import { tool } from '../src/primitives/tool.ts';
import { mockAdapter } from '../src/testing/mock-adapter.ts';
import type { NormalizedResponse } from '../src/adapter.ts';
import type { Message, StandardSchemaV1 } from '../src/types.ts';

const textResponse = (content: string): NormalizedResponse => ({
  message: { role: 'assistant', content },
  usage: { input: 10, output: 5 },
  stopReason: 'end',
});

const toolCallResponse = (
  calls: Array<{ id: string; name: string; arguments: unknown }>,
): NormalizedResponse => ({
  message: { role: 'assistant', content: '', toolCalls: calls },
  usage: { input: 20, output: 8 },
  stopReason: 'tool_call',
});

function anySchema(): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (raw) => ({ value: raw }),
    },
  };
}

const searchTool = tool({
  name: 'search',
  description: 'search the web',
  input: anySchema(),
  handler: async (q: unknown) => ({ hits: ['a', 'b'], query: q }),
});

const boomTool = tool({
  name: 'boom',
  description: 'always throws',
  input: anySchema(),
  handler: () => {
    throw new Error('kaboom');
  },
});

const startMsgs: Message[] = [{ role: 'user', content: 'hello' }];

describe('agent', () => {
  it('returns Result.ok on terminal response with no tool calls', async () => {
    const adapter = mockAdapter({ onCall: () => textResponse('final answer') });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.message.content).toBe('final answer');
      expect(res.value.steps).toHaveLength(0);
    }
  });

  it('round-trips tool calls until terminal', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'search', arguments: { q: 'ts' } }]),
      textResponse('done'),
    ];
    let i = 0;
    const adapter = mockAdapter({ onCall: () => responses[i++]! });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.message.content).toBe('done');
      expect(res.value.steps).toHaveLength(1);
      expect(res.value.steps[0]?.toolResults[0]?.content).toContain('hits');
    }
  });

  it('feeds tool handler errors back as tool messages', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'boom', arguments: {} }]),
      textResponse('apology'),
    ];
    let i = 0;
    const adapter = mockAdapter({ onCall: () => responses[i++]! });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [boomTool],
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const toolMsg = res.value.steps[0]?.toolResults[0];
      expect(toolMsg?.content.toLowerCase()).toContain('error');
      expect(toolMsg?.content).toContain('kaboom');
    }
  });

  it('feeds unknown-tool errors back', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'nonexistent', arguments: {} }]),
      textResponse('recovered'),
    ];
    let i = 0;
    const adapter = mockAdapter({ onCall: () => responses[i++]! });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const toolMsg = res.value.steps[0]?.toolResults[0];
      expect(toolMsg?.content).toContain('unknown tool');
      expect(toolMsg?.content).toContain('nonexistent');
    }
  });

  it('returns Result.error on max steps exceeded', async () => {
    const adapter = mockAdapter({
      onCall: () => toolCallResponse([{ id: 'c1', name: 'search', arguments: { q: 'x' } }]),
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 100 }),
      maxSteps: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(FlintError);
      expect(res.error.code).toBe('agent.max_steps_exceeded');
    }
  });

  it('propagates BudgetExhausted from call as Result.error', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 60, output: 60 },
        stopReason: 'end',
      }),
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      budget: budget({ maxTokens: 100 }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(BudgetExhausted);
    }
  });

  it('invokes onStep once per step with correct shape', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'search', arguments: { q: 'x' } }]),
      textResponse('done'),
    ];
    let i = 0;
    const adapter = mockAdapter({ onCall: () => responses[i++]! });
    const onStep = vi.fn();
    await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 5 }),
      onStep,
    });
    expect(onStep).toHaveBeenCalledTimes(1);
    const step = onStep.mock.calls[0]?.[0];
    expect(step.assistant.role).toBe('assistant');
    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolResults).toHaveLength(1);
    expect(step.usage.input).toBeGreaterThan(0);
  });

  it('calls lazy tools function with messages and step index', async () => {
    const lazy = vi.fn(() => [searchTool]);
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'search', arguments: {} }]),
      textResponse('ok'),
    ];
    let i = 0;
    const adapter = mockAdapter({ onCall: () => responses[i++]! });
    await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: lazy,
      budget: budget({ maxSteps: 5 }),
    });
    expect(lazy).toHaveBeenCalledTimes(2); // once for first call, once for second
    const firstCtx = lazy.mock.calls[0]?.[0];
    expect(firstCtx?.step).toBe(0);
    const secondCtx = lazy.mock.calls[1]?.[0];
    expect(secondCtx?.step).toBe(1);
  });

  it('executes parallel tool calls all at once', async () => {
    const callOrder: string[] = [];
    const parallelTool = tool({
      name: 'p',
      description: 'p',
      input: anySchema(),
      handler: async (x: unknown) => {
        callOrder.push(`start-${(x as { id: string }).id}`);
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(`end-${(x as { id: string }).id}`);
        return { done: true };
      },
    });
    const responses = [
      toolCallResponse([
        { id: 'c1', name: 'p', arguments: { id: 'a' } },
        { id: 'c2', name: 'p', arguments: { id: 'b' } },
        { id: 'c3', name: 'p', arguments: { id: 'c' } },
      ]),
      textResponse('ok'),
    ];
    let i = 0;
    const adapter = mockAdapter({ onCall: () => responses[i++]! });
    await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [parallelTool],
      budget: budget({ maxSteps: 5 }),
    });
    // All starts before any end if truly parallel
    const firstEndIndex = callOrder.findIndex((s) => s.startsWith('end-'));
    const startsBeforeFirstEnd = callOrder.slice(0, firstEndIndex);
    expect(startsBeforeFirstEnd).toHaveLength(3);
    expect(startsBeforeFirstEnd.every((s) => s.startsWith('start-'))).toBe(true);
  });

  it('aggregates usage across steps', async () => {
    const responses = [
      toolCallResponse([{ id: 'c1', name: 'search', arguments: {} }]),
      textResponse('done'),
    ];
    let i = 0;
    const adapter = mockAdapter({ onCall: () => responses[i++]! });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      tools: [searchTool],
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Step 1 usage { input: 20, output: 8 } + terminal { input: 10, output: 5 } = { input: 30, output: 13 }
      expect(res.value.usage.input).toBe(30);
      expect(res.value.usage.output).toBe(13);
    }
  });

  it('treats tool_call stopReason with empty toolCalls as terminal', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'hmm', toolCalls: [] },
        usage: { input: 1, output: 1 },
        stopReason: 'tool_call',
      }),
    });
    const res = await agent({
      adapter,
      model: 'm',
      messages: startMsgs,
      budget: budget({ maxSteps: 5 }),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.steps).toHaveLength(0);
    }
  });
});
```

- [ ] **Step 2: Run test to confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- agent
```

Expected: `agent()` is still a stub throwing `NotImplementedError`, so every test fails.

- [ ] **Step 3: Rewrite `packages/flint/src/agent.ts`**

```ts
import type { ProviderAdapter } from './adapter.ts';
import type { Budget } from './budget.ts';
import type { Transform } from './compress.ts';
import { FlintError } from './errors.ts';
import { execute } from './primitives/execute.ts';
import { call } from './primitives/call.ts';
import type { Logger, Message, Result, Tool, ToolCall, Usage } from './types.ts';

export type Step = {
  messagesSent: Message[];
  assistant: Message & { role: 'assistant' };
  toolCalls: ToolCall[];
  toolResults: Array<Message & { role: 'tool' }>;
  usage: Usage;
  cost?: number;
};

export type AgentOutput = {
  message: Message & { role: 'assistant' };
  steps: Step[];
  usage: Usage;
  cost: number;
};

export type ToolsCtx = { messages: Message[]; step: number };

export type ToolsParam =
  | Tool[]
  | ((ctx: ToolsCtx) => Tool[] | Promise<Tool[]>);

export type AgentOptions = {
  adapter: ProviderAdapter;
  model: string;
  messages: Message[];
  tools?: ToolsParam;
  budget: Budget;
  maxSteps?: number;
  onStep?: (step: Step) => void;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

async function runToolCall(
  tc: ToolCall,
  tools: Tool[],
): Promise<Message & { role: 'tool' }> {
  const tool = tools.find((t) => t.name === tc.name);
  if (!tool) {
    return {
      role: 'tool',
      content: `Error: unknown tool "${tc.name}"`,
      toolCallId: tc.id,
    };
  }
  const execResult = await execute(tool, tc.arguments);
  if (execResult.ok) {
    const content =
      typeof execResult.value === 'string'
        ? execResult.value
        : JSON.stringify(execResult.value);
    return { role: 'tool', content, toolCallId: tc.id };
  }
  return {
    role: 'tool',
    content: `Error: ${execResult.error.message}`,
    toolCallId: tc.id,
  };
}

function aggregateUsage(steps: Step[], terminal: Usage): Usage {
  let input = terminal.input;
  let output = terminal.output;
  let cached = terminal.cached ?? 0;
  for (const s of steps) {
    input += s.usage.input;
    output += s.usage.output;
    cached += s.usage.cached ?? 0;
  }
  return cached > 0 ? { input, output, cached } : { input, output };
}

function aggregateCost(steps: Step[], terminal: number | undefined): number {
  let total = terminal ?? 0;
  for (const s of steps) {
    total += s.cost ?? 0;
  }
  return total;
}

export async function agent(options: AgentOptions): Promise<Result<AgentOutput>> {
  const maxSteps = options.maxSteps ?? Number.POSITIVE_INFINITY;
  const messages: Message[] = [...options.messages];
  const steps: Step[] = [];

  while (steps.length < maxSteps) {
    // Resolve tools (lazy support)
    const tools: Tool[] =
      options.tools === undefined
        ? []
        : typeof options.tools === 'function'
          ? await options.tools({ messages, step: steps.length })
          : options.tools;

    const result = await call({
      adapter: options.adapter,
      model: options.model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      budget: options.budget,
      ...(options.compress !== undefined ? { compress: options.compress } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    const { message, usage, cost, stopReason } = result.value;

    messages.push(message);

    // Terminal: no tool calls in response
    const hasToolCalls =
      stopReason === 'tool_call' && message.toolCalls && message.toolCalls.length > 0;

    if (!hasToolCalls) {
      return {
        ok: true,
        value: {
          message,
          steps,
          usage: aggregateUsage(steps, usage),
          cost: aggregateCost(steps, cost),
        },
      };
    }

    // Execute tool calls in parallel
    const toolCalls = message.toolCalls ?? [];
    const toolResults = await Promise.all(
      toolCalls.map((tc) => runToolCall(tc, tools)),
    );

    messages.push(...toolResults);

    const step: Step = {
      messagesSent: [...messages],
      assistant: message,
      toolCalls,
      toolResults,
      usage,
      ...(cost !== undefined ? { cost } : {}),
    };
    steps.push(step);

    options.onStep?.(step);
  }

  const lastMessage = messages[messages.length - 1];
  return {
    ok: false,
    error: new FlintError('Agent exceeded maxSteps without reaching a terminal response', {
      code: 'agent.max_steps_exceeded',
      cause: lastMessage,
    }),
  };
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- agent
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 11 tests pass, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/agent.ts packages/flint/test/agent.test.ts
git commit -m "feat(flint): implement agent loop with tool error recovery"
```

---

## Task 5: Full verification and tag v0.2.0

- [ ] **Step 1: Run full test suite**

```bash
npx pnpm@9.15.0 test
```

Expected: all packages green. flint package should have ~100 tests (82 from Plan 2 + 16 new budget + 3 new call + 1 new stream + (11 new agent - 1 old stub) = ~102).

- [ ] **Step 2: Typecheck all packages**

```bash
npx pnpm@9.15.0 typecheck
```

Expected: zero errors.

- [ ] **Step 3: Build flint**

```bash
npx pnpm@9.15.0 --filter flint build
```

Expected: success. `dist/budget.js`, `dist/index.js` updated with real implementations. Bundle size may grow modestly (still under 25 KB target).

- [ ] **Step 4: Lint**

```bash
npx pnpm@9.15.0 lint
```

Expected: clean. If biome flags, run `npx pnpm@9.15.0 format` and inspect the diff.

- [ ] **Step 5: Commit any lint fixups**

```bash
git status
```

If modified files exist:

```bash
git add -A
git commit -m "chore: apply biome formatting after agent + budget implementations"
```

Otherwise skip.

- [ ] **Step 6: Tag v0.2.0**

```bash
git tag -a v0.2.0 -m "v0.2.0 — agent loop and budget implemented"
git tag -l
```

Expected: `v0.0.0`, `v0.1.0`, `v0.2.0` all present.

- [ ] **Step 7: Final report**

Print:
- Total commits: `git rev-list --count HEAD`
- Total tests: (from step 1 output)
- Bundle size of `packages/flint/dist/index.js` and `packages/flint/dist/budget.js`
- Remaining stubs across the codebase: `grep -rn 'NotImplementedError' packages/flint/src/ packages/*/src/ || true`

Expected remaining stubs after Plan 3:
- `compress.ts` (all transforms) — Plan 4
- `memory.ts` (all three factories) — Plan 5
- `rag.ts` (memoryStore, chunk, retrieve) — Plan 5
- `recipes.ts` (all four recipes) — Plan 6
- `@flint/graph` (all) — Plan 7
- `@flint/adapter-anthropic` (all) — Plan 8
- `@flint/adapter-openai-compat` (all) — Plan 9

Everything in `primitives/`, `agent.ts`, `budget.ts`, `tool.ts`, `errors.ts`, `types.ts`, `testing/mock-adapter.ts` should be stub-free.

---

## Self-review checklist (for the implementer)

- [ ] `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint` all pass from clean
- [ ] `budget()` throws `TypeError` when no limits provided
- [ ] `budget.consume` throws `BudgetExhausted` with correct `code` field (`budget.steps` / `budget.tokens` / `budget.dollars`)
- [ ] `call` returns `Result.error(BudgetExhausted)` for both pre-check and post-consume paths
- [ ] `stream` lets `BudgetExhausted` propagate via throw
- [ ] `agent` loop recovers from tool errors by feeding error messages back to the model
- [ ] `agent` returns `Result.error` with `code: 'agent.max_steps_exceeded'` on overflow
- [ ] `CallOptions<T>` generic enforces schema-output matches `T`
- [ ] No new runtime deps
- [ ] `v0.2.0` tag exists
- [ ] Bundle size still under 25 KB
