# Flint Core Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stub implementations for `call`, `stream`, `validate`, `execute`, `count` with real logic; add `approxCount` heuristic and `mockAdapter` test utility. After this plan, the `flint` primitives work end-to-end against any adapter that implements `ProviderAdapter`.

**Architecture:** Seven tasks, each focused on one primitive or one piece. `mockAdapter` is built first because every subsequent primitive's tests use it. Budget wiring is deferred to Plan 3 — primitives accept `budget?` and call its methods optionally, but tests don't exercise the budget path.

**Tech Stack:** Existing scaffold (TypeScript strict, vitest, tsup, pnpm workspaces). No new runtime dependencies. `@standard-schema/spec` types remain the only import.

**Reference spec:** `docs/superpowers/specs/2026-04-20-flint-core-primitives-design.md`

---

## Pre-flight

All work happens in `C:/Users/KadeHeglin/Downloads/Projects/Flint/`. Shell is Git Bash on Windows; use Unix syntax. Substitute `pnpm` → `npx pnpm@9.15.0` for every pnpm command (pnpm is not globally installed).

Current repo state after Plan 1:
- 20 commits, tagged `v0.0.0`
- `packages/flint/src/primitives/{call,stream,validate,tool,execute,count}.ts` — stubs throwing `NotImplementedError`
- `packages/flint/test/primitives.test.ts` — single test file covering all 6 primitives as stubs
- No `packages/flint/src/testing/` directory

## File map for this plan

```
packages/flint/
├── package.json                               # MODIFY: add ./testing subpath export
├── tsup.config.ts                             # MODIFY: add testing/mock-adapter entry
├── src/
│   ├── testing/
│   │   └── mock-adapter.ts                    # CREATE
│   └── primitives/
│       ├── approx-count.ts                    # CREATE
│       ├── call.ts                            # MODIFY: real impl
│       ├── stream.ts                          # MODIFY: real impl
│       ├── validate.ts                        # MODIFY: real impl
│       ├── execute.ts                         # MODIFY: real impl
│       └── count.ts                           # MODIFY: real impl (dispatches)
└── test/
    ├── primitives.test.ts                     # DELETE (Task 7)
    ├── mock-adapter.test.ts                   # CREATE
    ├── count.test.ts                          # CREATE
    ├── validate.test.ts                       # CREATE
    ├── execute.test.ts                        # CREATE
    ├── call.test.ts                           # CREATE
    └── stream.test.ts                         # CREATE
```

---

## Task 1: `mockAdapter` under `flint/testing` subpath

**Files:**
- Create: `packages/flint/src/testing/mock-adapter.ts`
- Create: `packages/flint/test/mock-adapter.test.ts`
- Modify: `packages/flint/package.json` (exports field)
- Modify: `packages/flint/tsup.config.ts` (add entry)

- [ ] **Step 1: Add the testing subpath to `packages/flint/package.json`**

Current `exports` has 7 entries (`.`, `./memory`, `./rag`, `./compress`, `./recipes`, `./budget`, `./errors`). Add `./testing`.

Open `packages/flint/package.json` and update the `exports` field to:

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./memory": { "types": "./dist/memory.d.ts", "import": "./dist/memory.js" },
  "./rag": { "types": "./dist/rag.d.ts", "import": "./dist/rag.js" },
  "./compress": { "types": "./dist/compress.d.ts", "import": "./dist/compress.js" },
  "./recipes": { "types": "./dist/recipes.d.ts", "import": "./dist/recipes.js" },
  "./budget": { "types": "./dist/budget.d.ts", "import": "./dist/budget.js" },
  "./errors": { "types": "./dist/errors.d.ts", "import": "./dist/errors.js" },
  "./testing": { "types": "./dist/testing/mock-adapter.d.ts", "import": "./dist/testing/mock-adapter.js" }
}
```

- [ ] **Step 2: Add the entry to `packages/flint/tsup.config.ts`**

Update the `entry` array to include the new file:

```ts
import { defineConfig } from 'tsup';

// biome-ignore lint/style/noDefaultExport: tsup requires default export
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/memory.ts',
    'src/rag.ts',
    'src/compress.ts',
    'src/recipes.ts',
    'src/budget.ts',
    'src/errors.ts',
    'src/testing/mock-adapter.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  sourcemap: true,
});
```

- [ ] **Step 3: Write the failing test `packages/flint/test/mock-adapter.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { mockAdapter, scriptedAdapter } from '../src/testing/mock-adapter.ts';
import type { NormalizedResponse, StreamChunk } from '../src/adapter.ts';
import type { Message } from '../src/types.ts';

const textResponse = (content: string): NormalizedResponse => ({
  message: { role: 'assistant', content },
  usage: { input: 10, output: 5 },
  stopReason: 'end',
});

describe('mockAdapter', () => {
  it('records calls in order', async () => {
    const a = mockAdapter({ onCall: () => textResponse('hi') });
    await a.call({ model: 'm', messages: [{ role: 'user', content: 'a' }] });
    await a.call({ model: 'm', messages: [{ role: 'user', content: 'b' }] });
    expect(a.calls).toHaveLength(2);
    expect(a.calls[0]?.messages[0]?.content).toBe('a');
    expect(a.calls[1]?.messages[0]?.content).toBe('b');
  });

  it('increments callIndex across call and stream', async () => {
    const indices: number[] = [];
    const a = mockAdapter({
      onCall: (_req, i) => {
        indices.push(i);
        return textResponse(`r${i}`);
      },
    });
    await a.call({ model: 'm', messages: [] });
    for await (const _ of a.stream({ model: 'm', messages: [] })) {
      // drain
    }
    await a.call({ model: 'm', messages: [] });
    expect(indices).toEqual([0, 1, 2]);
  });

  it('default name is "mock" and capabilities default to {}', () => {
    const a = mockAdapter({ onCall: () => textResponse('x') });
    expect(a.name).toBe('mock');
    expect(a.capabilities).toEqual({});
  });

  it('accepts custom name and capabilities', () => {
    const a = mockAdapter({
      name: 'fake',
      capabilities: { promptCache: true },
      onCall: () => textResponse('x'),
    });
    expect(a.name).toBe('fake');
    expect(a.capabilities.promptCache).toBe(true);
  });

  it('default onStream yields text delta, usage, end', async () => {
    const a = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'hello' },
        usage: { input: 3, output: 2 },
        stopReason: 'end',
      }),
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of a.stream({ model: 'm', messages: [] })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'usage', usage: { input: 3, output: 2 } },
      { type: 'end', reason: 'end' },
    ]);
  });

  it('custom onStream is used when supplied', async () => {
    const a = mockAdapter({
      onCall: () => textResponse('x'),
      onStream: async function* () {
        yield { type: 'text', delta: 'A' };
        yield { type: 'text', delta: 'B' };
        yield { type: 'end', reason: 'end' };
      },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of a.stream({ model: 'm', messages: [] })) {
      chunks.push(chunk);
    }
    expect(chunks.map((c) => (c.type === 'text' ? c.delta : c.type))).toEqual([
      'A',
      'B',
      'end',
    ]);
  });

  it('count delegates to opts.count when provided', () => {
    const a = mockAdapter({
      onCall: () => textResponse('x'),
      count: (messages: Message[]) => messages.length * 100,
    });
    expect(a.count!([{ role: 'user', content: 'hi' }], 'm')).toBe(100);
  });

  it('count is undefined when not provided', () => {
    const a = mockAdapter({ onCall: () => textResponse('x') });
    expect(a.count).toBeUndefined();
  });
});

describe('scriptedAdapter', () => {
  it('returns scripted responses in order', async () => {
    const a = scriptedAdapter([textResponse('one'), textResponse('two')]);
    const r1 = await a.call({ model: 'm', messages: [] });
    const r2 = await a.call({ model: 'm', messages: [] });
    expect(r1.message.content).toBe('one');
    expect(r2.message.content).toBe('two');
  });

  it('throws when past end of script', async () => {
    const a = scriptedAdapter([textResponse('only')]);
    await a.call({ model: 'm', messages: [] });
    await expect(a.call({ model: 'm', messages: [] })).rejects.toThrow(
      /past end of scripted responses/i,
    );
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npx pnpm@9.15.0 --filter flint test -- mock-adapter
```

Expected: import error — `src/testing/mock-adapter.ts` does not exist.

- [ ] **Step 5: Write `packages/flint/src/testing/mock-adapter.ts`**

```ts
import type {
  AdapterCapabilities,
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
} from '../adapter.ts';
import type { Message, StreamChunk } from '../types.ts';

export type MockAdapter = ProviderAdapter & {
  calls: NormalizedRequest[];
};

export type MockAdapterOptions = {
  name?: string;
  capabilities?: AdapterCapabilities;
  onCall: (
    req: NormalizedRequest,
    callIndex: number,
  ) => NormalizedResponse | Promise<NormalizedResponse>;
  onStream?: (
    req: NormalizedRequest,
    callIndex: number,
  ) => AsyncIterable<StreamChunk>;
  count?: (messages: Message[], model: string) => number;
};

export function mockAdapter(opts: MockAdapterOptions): MockAdapter {
  const calls: NormalizedRequest[] = [];
  let callIndex = 0;

  async function* defaultStream(
    req: NormalizedRequest,
    index: number,
  ): AsyncIterable<StreamChunk> {
    const resp = await opts.onCall(req, index);
    if (resp.message.content) {
      yield { type: 'text', delta: resp.message.content };
    }
    yield { type: 'usage', usage: resp.usage, ...(resp.cost !== undefined ? { cost: resp.cost } : {}) };
    yield { type: 'end', reason: resp.stopReason };
  }

  const adapter: MockAdapter = {
    name: opts.name ?? 'mock',
    capabilities: opts.capabilities ?? {},
    calls,
    async call(req) {
      calls.push(req);
      const index = callIndex++;
      return opts.onCall(req, index);
    },
    stream(req) {
      calls.push(req);
      const index = callIndex++;
      const iter = opts.onStream
        ? opts.onStream(req, index)
        : defaultStream(req, index);
      return iter;
    },
    ...(opts.count ? { count: opts.count } : {}),
  };

  return adapter;
}

export function scriptedAdapter(
  responses: NormalizedResponse[],
  opts?: { name?: string; capabilities?: AdapterCapabilities },
): MockAdapter {
  return mockAdapter({
    ...(opts?.name !== undefined ? { name: opts.name } : {}),
    ...(opts?.capabilities !== undefined ? { capabilities: opts.capabilities } : {}),
    onCall: (_req, index) => {
      const resp = responses[index];
      if (resp === undefined) {
        throw new Error(
          `scriptedAdapter: reached past end of scripted responses (index ${index}, length ${responses.length})`,
        );
      }
      return resp;
    },
  });
}
```

- [ ] **Step 6: Run the test again, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- mock-adapter
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 10 tests pass, zero type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/flint/package.json packages/flint/tsup.config.ts packages/flint/src/testing packages/flint/test/mock-adapter.test.ts
git commit -m "feat(flint): add mockAdapter testing utility under flint/testing subpath"
```

---

## Task 2: `approxCount` + real `count`

**Files:**
- Create: `packages/flint/src/primitives/approx-count.ts`
- Modify: `packages/flint/src/primitives/count.ts`
- Create: `packages/flint/test/count.test.ts`

- [ ] **Step 1: Write the failing test `packages/flint/test/count.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { count } from '../src/primitives/count.ts';
import { approxCount } from '../src/primitives/approx-count.ts';
import { mockAdapter } from '../src/testing/mock-adapter.ts';
import type { Message } from '../src/types.ts';

describe('approxCount', () => {
  it('returns 0 for empty array', () => {
    expect(approxCount([])).toBe(0);
  });

  it('accounts for role overhead on every message', () => {
    // Empty content still costs ROLE_OVERHEAD (4).
    const msgs: Message[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: '' },
    ];
    expect(approxCount(msgs)).toBe(8);
  });

  it('counts ~1 token per 3.5 chars for string content', () => {
    // "hello world" is 11 chars -> ceil(11/3.5) = 4 tokens + 4 role overhead = 8.
    const msgs: Message[] = [{ role: 'user', content: 'hello world' }];
    expect(approxCount(msgs)).toBe(8);
  });

  it('handles ContentPart[] arrays', () => {
    // text: 10 chars -> ceil(10/3.5) = 3 tokens, image: 512 tokens, role: 4 -> 519.
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'abcdefghij' },
          { type: 'image', url: 'https://example.com/x.png' },
        ],
      },
    ];
    expect(approxCount(msgs)).toBe(519);
  });

  it('counts tool call arguments', () => {
    // role 4, empty assistant content 0, tool call overhead 4, JSON "{\"q\":\"hi\"}" 10 chars -> ceil(10/3.5)=3.
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'hi' } }],
      },
    ];
    expect(approxCount(msgs)).toBe(4 + 4 + 3);
  });

  it('is monotonic: adding a message never decreases the count', () => {
    const base: Message[] = [{ role: 'user', content: 'hi' }];
    const more: Message[] = [...base, { role: 'assistant', content: 'hi back' }];
    expect(approxCount(more)).toBeGreaterThanOrEqual(approxCount(base));
  });
});

describe('count', () => {
  const msgs: Message[] = [{ role: 'user', content: 'hello' }];

  it('falls back to approxCount when no adapter provided', () => {
    expect(count(msgs, 'm')).toBe(approxCount(msgs));
  });

  it('falls back to approxCount when adapter has no count method', () => {
    const a = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
    });
    expect(count(msgs, 'm', a)).toBe(approxCount(msgs));
  });

  it('dispatches to adapter.count when present', () => {
    const a = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
      count: (_m, _model) => 42,
    });
    expect(count(msgs, 'm', a)).toBe(42);
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- count
```

Expected: import error for `approx-count.ts`; `count` stub still throws.

- [ ] **Step 3: Write `packages/flint/src/primitives/approx-count.ts`**

```ts
import type { Message } from '../types.ts';

const APPROX_CHARS_PER_TOKEN = 3.5;
const ROLE_OVERHEAD = 4;
const IMAGE_TOKENS = 512;

function textTokens(s: string): number {
  if (s.length === 0) return 0;
  return Math.ceil(s.length / APPROX_CHARS_PER_TOKEN);
}

export function approxCount(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += ROLE_OVERHEAD;

    if (typeof msg.content === 'string') {
      total += textTokens(msg.content);
    } else {
      for (const part of msg.content) {
        if (part.type === 'text') {
          total += textTokens(part.text);
        } else {
          total += IMAGE_TOKENS;
        }
      }
    }

    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += ROLE_OVERHEAD;
        total += textTokens(JSON.stringify(tc.arguments));
      }
    }
  }
  return total;
}
```

- [ ] **Step 4: Rewrite `packages/flint/src/primitives/count.ts`**

```ts
import type { ProviderAdapter } from '../adapter.ts';
import type { Message } from '../types.ts';
import { approxCount } from './approx-count.ts';

export function count(
  messages: Message[],
  model: string,
  adapter?: ProviderAdapter,
): number {
  if (adapter?.count) {
    return adapter.count(messages, model);
  }
  return approxCount(messages);
}
```

- [ ] **Step 5: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- count
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 9 tests pass, zero type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/flint/src/primitives/approx-count.ts packages/flint/src/primitives/count.ts packages/flint/test/count.test.ts
git commit -m "feat(flint): implement count and approxCount heuristic"
```

---

## Task 3: `validate` real implementation

**Files:**
- Modify: `packages/flint/src/primitives/validate.ts`
- Create: `packages/flint/test/validate.test.ts`

- [ ] **Step 1: Write the failing test `packages/flint/test/validate.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { validate } from '../src/primitives/validate.ts';
import { ValidationError } from '../src/errors.ts';
import type { StandardSchemaV1 } from '../src/types.ts';

// Build a minimal StandardSchema-compliant schema for tests.
function okSchema<T>(value: T): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => ({ value }),
    },
  };
}

function failSchema(issueMessage: string): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => ({ issues: [{ message: issueMessage }] }),
    },
  };
}

function asyncOkSchema<T>(value: T): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => Promise.resolve({ value }),
    },
  };
}

describe('validate', () => {
  it('returns Result.ok with the schema value on success', async () => {
    const res = await validate('raw', okSchema({ n: 42 }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ n: 42 });
    }
  });

  it('returns Result.error(ValidationError) on issues', async () => {
    const res = await validate('raw', failSchema('bad thing'));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ValidationError);
      expect(res.error.code).toBe('validation.failed');
    }
  });

  it('awaits async schema results', async () => {
    const res = await validate('raw', asyncOkSchema('ok'));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe('ok');
    }
  });

  it('attaches issues as error.cause', async () => {
    const res = await validate('raw', failSchema('no good'));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.cause).toEqual([{ message: 'no good' }]);
    }
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- validate
```

Expected: stub throws `NotImplementedError`.

- [ ] **Step 3: Rewrite `packages/flint/src/primitives/validate.ts`**

```ts
import { ValidationError } from '../errors.ts';
import type { Result, StandardSchemaV1 } from '../types.ts';

export async function validate<T>(
  value: unknown,
  schema: StandardSchemaV1<unknown, T>,
): Promise<Result<T>> {
  let result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    result = await result;
  }

  if ('issues' in result && result.issues !== undefined) {
    return {
      ok: false,
      error: new ValidationError('Schema validation failed', {
        code: 'validation.failed',
        cause: result.issues,
      }),
    };
  }

  return { ok: true, value: result.value };
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- validate
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/primitives/validate.ts packages/flint/test/validate.test.ts
git commit -m "feat(flint): implement validate primitive"
```

---

## Task 4: `execute` real implementation

**Files:**
- Modify: `packages/flint/src/primitives/execute.ts`
- Create: `packages/flint/test/execute.test.ts`

- [ ] **Step 1: Write the failing test `packages/flint/test/execute.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { execute } from '../src/primitives/execute.ts';
import { tool } from '../src/primitives/tool.ts';
import { ParseError, ToolError } from '../src/errors.ts';
import type { StandardSchemaV1 } from '../src/types.ts';

function numberSchema(): StandardSchemaV1<unknown, { n: number }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (raw) => {
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'n' in raw &&
          typeof (raw as { n: unknown }).n === 'number'
        ) {
          return { value: { n: (raw as { n: number }).n } };
        }
        return { issues: [{ message: 'must be { n: number }' }] };
      },
    },
  };
}

describe('execute', () => {
  const adder = tool({
    name: 'adder',
    description: 'adds one',
    input: numberSchema(),
    handler: (x) => x.n + 1,
  });

  it('returns Result.ok with handler output on valid input', async () => {
    const res = await execute(adder, { n: 5 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe(6);
    }
  });

  it('returns Result.error(ParseError) on invalid input', async () => {
    const res = await execute(adder, { wrong: 'input' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ParseError);
      expect(res.error.code).toBe('parse.tool_input');
    }
  });

  it('does not invoke handler when input is invalid', async () => {
    let called = false;
    const t = tool({
      name: 't',
      description: 't',
      input: numberSchema(),
      handler: () => {
        called = true;
        return 0;
      },
    });
    await execute(t, { wrong: 'input' });
    expect(called).toBe(false);
  });

  it('returns Result.error(ToolError) when handler throws', async () => {
    const boom = tool({
      name: 'boom',
      description: 'throws',
      input: numberSchema(),
      handler: () => {
        throw new Error('kaboom');
      },
    });
    const res = await execute(boom, { n: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ToolError);
      expect(res.error.code).toBe('tool.handler_threw');
      expect(res.error.cause).toBeInstanceOf(Error);
    }
  });

  it('awaits async handlers', async () => {
    const asyncAdder = tool({
      name: 'async',
      description: 'async',
      input: numberSchema(),
      handler: async (x) => x.n * 2,
    });
    const res = await execute(asyncAdder, { n: 3 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe(6);
    }
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- execute
```

Expected: stub throws.

- [ ] **Step 3: Rewrite `packages/flint/src/primitives/execute.ts`**

```ts
import { ParseError, ToolError } from '../errors.ts';
import type { Result, Tool } from '../types.ts';
import { validate } from './validate.ts';

export async function execute<Input, Output>(
  t: Tool<Input, Output>,
  rawInput: unknown,
): Promise<Result<Output>> {
  const parsed = await validate(rawInput, t.input);
  if (!parsed.ok) {
    return {
      ok: false,
      error: new ParseError(`Tool "${t.name}" input validation failed`, {
        code: 'parse.tool_input',
        cause: parsed.error,
      }),
    };
  }

  try {
    const output = await t.handler(parsed.value);
    return { ok: true, value: output };
  } catch (e) {
    return {
      ok: false,
      error: new ToolError(`Tool "${t.name}" handler threw`, {
        code: 'tool.handler_threw',
        cause: e,
      }),
    };
  }
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- execute
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/primitives/execute.ts packages/flint/test/execute.test.ts
git commit -m "feat(flint): implement execute primitive"
```

---

## Task 5: `call` real implementation

**Files:**
- Modify: `packages/flint/src/primitives/call.ts`
- Create: `packages/flint/test/call.test.ts`

- [ ] **Step 1: Write the failing test `packages/flint/test/call.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { call } from '../src/primitives/call.ts';
import { mockAdapter } from '../src/testing/mock-adapter.ts';
import { AdapterError, ParseError, ValidationError } from '../src/errors.ts';
import type { NormalizedResponse } from '../src/adapter.ts';
import type { Message, StandardSchemaV1 } from '../src/types.ts';

const textResponse = (content: string, stop: 'end' | 'tool_call' = 'end'): NormalizedResponse => ({
  message: { role: 'assistant', content },
  usage: { input: 10, output: 5 },
  stopReason: stop,
});

function jsonSchema<T>(check: (v: unknown) => v is T): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (raw) =>
        check(raw) ? { value: raw } : { issues: [{ message: 'bad shape' }] },
    },
  };
}

const msg: Message[] = [{ role: 'user', content: 'hi' }];

describe('call', () => {
  it('returns Result.ok on adapter success', async () => {
    const adapter = mockAdapter({ onCall: () => textResponse('hello') });
    const res = await call({ adapter, model: 'm', messages: msg });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.message.content).toBe('hello');
      expect(res.value.usage).toEqual({ input: 10, output: 5 });
      expect(res.value.stopReason).toBe('end');
      expect(res.value.value).toBeUndefined();
    }
  });

  it('returns Result.error(AdapterError) when adapter throws', async () => {
    const adapter = mockAdapter({
      onCall: () => {
        throw new Error('http 500');
      },
    });
    const res = await call({ adapter, model: 'm', messages: msg });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(AdapterError);
      expect(res.error.code).toBe('adapter.call_failed');
      expect(res.error.cause).toBeInstanceOf(Error);
    }
  });

  it('validates JSON content against schema when stopReason is end', async () => {
    type Shape = { n: number };
    const schema = jsonSchema<Shape>(
      (v): v is Shape =>
        typeof v === 'object' &&
        v !== null &&
        'n' in v &&
        typeof (v as { n: unknown }).n === 'number',
    );
    const adapter = mockAdapter({ onCall: () => textResponse('{"n":7}') });
    const res = await call({ adapter, model: 'm', messages: msg, schema });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.value).toEqual({ n: 7 });
    }
  });

  it('returns ValidationError when JSON content fails schema', async () => {
    const schema = jsonSchema<{ n: number }>(
      (v): v is { n: number } => typeof v === 'object' && v !== null && 'n' in v,
    );
    const adapter = mockAdapter({ onCall: () => textResponse('{"wrong":true}') });
    const res = await call({ adapter, model: 'm', messages: msg, schema });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ValidationError);
    }
  });

  it('returns ParseError when content is not JSON', async () => {
    const schema = jsonSchema<{ n: number }>(() => true);
    const adapter = mockAdapter({ onCall: () => textResponse('not json') });
    const res = await call({ adapter, model: 'm', messages: msg, schema });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ParseError);
      expect(res.error.code).toBe('parse.response_json');
    }
  });

  it('skips schema validation when stopReason is tool_call', async () => {
    const schema = jsonSchema<unknown>(() => false); // would fail if called
    const adapter = mockAdapter({
      onCall: () => ({
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'x' } }],
        },
        usage: { input: 1, output: 1 },
        stopReason: 'tool_call',
      }),
    });
    const res = await call({ adapter, model: 'm', messages: msg, schema });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.value).toBeUndefined();
      expect(res.value.message.toolCalls).toHaveLength(1);
    }
  });

  it('runs compress pipeline before calling adapter', async () => {
    const adapter = mockAdapter({ onCall: () => textResponse('ok') });
    const compress = async () => [{ role: 'user', content: 'compressed' } as const];
    await call({ adapter, model: 'm', messages: msg, compress });
    expect(adapter.calls[0]?.messages).toEqual([
      { role: 'user', content: 'compressed' },
    ]);
  });

  it('forwards signal to adapter request', async () => {
    const adapter = mockAdapter({ onCall: () => textResponse('x') });
    const controller = new AbortController();
    await call({ adapter, model: 'm', messages: msg, signal: controller.signal });
    expect(adapter.calls[0]?.signal).toBe(controller.signal);
  });

  it('throws TypeError when adapter is missing', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional bad input for test
    await expect(call({ model: 'm', messages: msg } as any)).rejects.toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- call
```

Expected: stub throws.

- [ ] **Step 3: Rewrite `packages/flint/src/primitives/call.ts`**

```ts
import type { NormalizedRequest, ProviderAdapter } from '../adapter.ts';
import type { Budget } from '../budget.ts';
import type { Transform } from '../compress.ts';
import { AdapterError, ParseError } from '../errors.ts';
import type { Logger, Message, Result, StopReason, Usage } from '../types.ts';
import { validate } from './validate.ts';

export type CallOptions = Omit<NormalizedRequest, 'signal' | 'messages'> & {
  adapter: ProviderAdapter;
  messages: Message[];
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
  options: CallOptions,
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
    options.budget.assertNotExhausted();
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
    options.budget.consume({
      ...resp.usage,
      ...(resp.cost !== undefined ? { cost: resp.cost } : {}),
    });
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
    output.value = validated.value as T;
  }

  return { ok: true, value: output };
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- call
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 9 tests pass, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/primitives/call.ts packages/flint/test/call.test.ts
git commit -m "feat(flint): implement call primitive with schema validation"
```

---

## Task 6: `stream` real implementation

**Files:**
- Modify: `packages/flint/src/primitives/stream.ts`
- Create: `packages/flint/test/stream.test.ts`

- [ ] **Step 1: Write the failing test `packages/flint/test/stream.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { stream } from '../src/primitives/stream.ts';
import { mockAdapter } from '../src/testing/mock-adapter.ts';
import type { StreamChunk } from '../src/types.ts';
import type { Message } from '../src/types.ts';

const msg: Message[] = [{ role: 'user', content: 'hi' }];

describe('stream', () => {
  it('yields chunks from the adapter stream in order', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'hello' },
        usage: { input: 3, output: 2 },
        stopReason: 'end',
      }),
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream({ adapter, model: 'm', messages: msg })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'usage', usage: { input: 3, output: 2 } },
      { type: 'end', reason: 'end' },
    ]);
  });

  it('propagates adapter errors mid-stream', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
      onStream: async function* () {
        yield { type: 'text', delta: 'ok' };
        throw new Error('stream broke');
      },
    });
    const iter = stream({ adapter, model: 'm', messages: msg });
    await expect(async () => {
      for await (const _chunk of iter) {
        // drain until error
      }
    }).rejects.toThrow('stream broke');
  });

  it('runs compress pipeline before starting the stream', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
    });
    const compress = async () => [{ role: 'user', content: 'compressed' } as const];
    for await (const _ of stream({ adapter, model: 'm', messages: msg, compress })) {
      // drain
    }
    expect(adapter.calls[0]?.messages).toEqual([
      { role: 'user', content: 'compressed' },
    ]);
  });

  it('forwards signal to adapter request', async () => {
    const adapter = mockAdapter({
      onCall: () => ({
        message: { role: 'assistant', content: 'x' },
        usage: { input: 0, output: 0 },
        stopReason: 'end',
      }),
    });
    const controller = new AbortController();
    for await (const _ of stream({
      adapter,
      model: 'm',
      messages: msg,
      signal: controller.signal,
    })) {
      // drain
    }
    expect(adapter.calls[0]?.signal).toBe(controller.signal);
  });

  it('throws TypeError when adapter is missing', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional bad input for test
    const iter = stream({ model: 'm', messages: msg } as any);
    await expect(async () => {
      for await (const _ of iter) {
        // unreachable
      }
    }).rejects.toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

```bash
npx pnpm@9.15.0 --filter flint test -- stream
```

Expected: stub throws `NotImplementedError`.

- [ ] **Step 3: Rewrite `packages/flint/src/primitives/stream.ts`**

```ts
import type { NormalizedRequest, ProviderAdapter } from '../adapter.ts';
import type { Budget } from '../budget.ts';
import type { Transform } from '../compress.ts';
import type { Logger, Message, StreamChunk } from '../types.ts';

export type StreamOptions = Omit<NormalizedRequest, 'signal' | 'messages'> & {
  adapter: ProviderAdapter;
  messages: Message[];
  budget?: Budget;
  compress?: Transform;
  logger?: Logger;
  signal?: AbortSignal;
};

export async function* stream(
  options: StreamOptions,
): AsyncIterable<StreamChunk> {
  if (!options || !options.adapter || !options.model || !options.messages) {
    throw new TypeError(
      'stream: options.adapter, options.model, and options.messages are required',
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
    options.budget.assertNotExhausted();
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

  for await (const chunk of options.adapter.stream(req)) {
    if (chunk.type === 'usage' && options.budget) {
      options.budget.consume({
        ...chunk.usage,
        ...(chunk.cost !== undefined ? { cost: chunk.cost } : {}),
      });
    }
    yield chunk;
  }
}
```

- [ ] **Step 4: Run test, confirm PASS**

```bash
npx pnpm@9.15.0 --filter flint test -- stream
npx pnpm@9.15.0 --filter flint typecheck
```

Expected: 5 tests pass, zero type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/flint/src/primitives/stream.ts packages/flint/test/stream.test.ts
git commit -m "feat(flint): implement stream primitive with chunk pass-through"
```

---

## Task 7: Remove obsolete test + full verification

**Files:**
- Delete: `packages/flint/test/primitives.test.ts`

- [ ] **Step 1: Delete the old combined test file**

```bash
rm packages/flint/test/primitives.test.ts
```

Every primitive now has its own test file covering behavior far more thoroughly than the old combined file.

- [ ] **Step 2: Run the full flint package test suite**

```bash
npx pnpm@9.15.0 --filter flint test
```

Expected: all tests pass. Running approximate count:
- Existing (before Plan 2): 46 tests
- Removed: ~6 tests (old primitives.test.ts)
- Added: ~10 (mock-adapter) + 9 (count) + 4 (validate) + 5 (execute) + 9 (call) + 5 (stream) = 42
- Expected total: ~82 tests in 15 test files

- [ ] **Step 3: Run typecheck across all packages**

```bash
npx pnpm@9.15.0 typecheck
```

Expected: zero errors.

- [ ] **Step 4: Run build for flint**

```bash
npx pnpm@9.15.0 --filter flint build
```

Expected: `dist/testing/mock-adapter.js` and `dist/testing/mock-adapter.d.ts` exist in addition to the existing 14 files.

- [ ] **Step 5: Verify the new subpath resolves from a consumer**

```bash
ls packages/flint/dist/testing/
```

Expected: `mock-adapter.js`, `mock-adapter.d.ts`, `mock-adapter.js.map`.

- [ ] **Step 6: Run lint across repo**

```bash
npx pnpm@9.15.0 lint
```

Expected: clean. If biome flags issues, run `npx pnpm@9.15.0 format` and inspect the diff; commit any fixups together.

- [ ] **Step 7: Commit the test removal and any lint fixups**

```bash
git add packages/flint/test/primitives.test.ts
git commit -m "chore(flint): remove obsolete combined primitives test"
```

If `pnpm format` modified files in step 6:

```bash
git add -A
git commit -m "chore: apply biome formatting after primitive implementations"
```

- [ ] **Step 8: Tag v0.1.0**

This marks the first version where primitives actually work:

```bash
git tag -a v0.1.0 -m "v0.1.0 — core primitives (call/stream/validate/execute/count) implemented"
```

- [ ] **Step 9: Final report**

Print:
- Total commits: `git rev-list --count HEAD`
- Total tests: (from `pnpm test` output)
- New files: `ls packages/flint/src/testing/ packages/flint/src/primitives/approx-count.ts`
- Bundle size of `dist/index.js`, `dist/testing/mock-adapter.js`

---

## Self-review checklist (for the implementer)

- [ ] `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint` all pass from clean
- [ ] Every file in the File Map has been created or modified as specified
- [ ] No primitive (except `budget.*`) throws `NotImplementedError` anymore
- [ ] `tool()` still a pure constructor (not changed in this plan)
- [ ] `call` returns `Result.ok` or `Result.error` for every code path (except `TypeError` programmer errors)
- [ ] `stream` throws (not Result) — this is intentional per spec
- [ ] `validate` is async; `execute` awaits it
- [ ] `approxCount` is a pure function with no imports except types
- [ ] `mockAdapter` is in `src/testing/`, exported via `flint/testing` subpath only
- [ ] No new runtime dependencies (still zero — `@standard-schema/spec` is types-only)
- [ ] Bundle includes `dist/testing/mock-adapter.js`
- [ ] `v0.1.0` tag exists

## Common gotchas to watch for

1. **`exactOptionalPropertyTypes: true`** — do NOT set a property to `undefined`. Use conditional spread: `...(x !== undefined ? { key: x } : {})`.
2. **`noUncheckedIndexedAccess: true`** — `array[i]` has type `T | undefined`. Use `array[i]?.foo` or narrow first.
3. **StandardSchema validate can be sync or async.** Always `await` result or use `instanceof Promise` check.
4. **Do not import from `flint/testing` in `src/`.** Only tests should import mock adapter. The scaffold's subpath exports are fine since tests use `../src/testing/mock-adapter.ts` directly.
5. **`async function*` without yield is valid.** If stream only throws, don't add a dummy yield. Biome's `noUnreachable` is disabled for the existing stubs via `biome-ignore useYield` — the real stream implementation will have yields, so those ignores are removable once the body contains a yield.
