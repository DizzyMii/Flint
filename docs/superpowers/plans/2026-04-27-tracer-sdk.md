# Tracer SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@tracer/sdk` — a TypeScript SDK that wraps OTel's `BatchSpanProcessor` with a custom HTTP exporter, giving developers a single `createTracer()` call that auto-instruments Vercel AI SDK.

**Architecture:** A custom `TracerExporter` converts OTel `ReadableSpan[]` to OTLP JSON and POSTs to the Tracer ingest endpoint. `buildProvider` wires it into `BatchSpanProcessor` (512-span buffer, 5s timer) + `BasicTracerProvider`. The public `createTracer()` factory returns `{ provider, flush }`.

**Tech Stack:** TypeScript 5, `@opentelemetry/sdk-trace-base` ^1.25, `@opentelemetry/api` ^1.9, `@tracer/types` (workspace), Vitest

---

## File Map

```
packages/sdk/
├── package.json                   — package metadata + OTel deps
├── tsconfig.json                  — extends ../../tsconfig.base.json
├── vitest.config.ts               — node environment, test/**/*.test.ts
└── src/
│   ├── convert.ts                 — toOtlpPayload(ReadableSpan[]): OtlpPayload
│   ├── exporter.ts                — TracerExporter implements SpanExporter
│   ├── provider.ts                — buildProvider: wires exporter into BatchSpanProcessor
│   └── index.ts                   — public API: TracerConfig type + createTracer()
└── test/
    ├── convert.test.ts            — attribute mapping, timestamp conversion, events
    ├── exporter.test.ts           — fetch spy tests: URL, headers, 202/500/network
    └── provider.test.ts           — createTracer shape, getTracer, flush
```

---

## Task 1: Package Scaffold

**Files:**
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`
- Create: `packages/sdk/vitest.config.ts`
- Create: `packages/sdk/src/convert.ts` (stub)
- Create: `packages/sdk/src/exporter.ts` (stub)
- Create: `packages/sdk/src/provider.ts` (stub)
- Create: `packages/sdk/src/index.ts` (stub)

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p packages/sdk/src packages/sdk/test
```

- [ ] **Step 2: Create `packages/sdk/package.json`**

```json
{
  "name": "@tracer/sdk",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-trace-base": "^1.25.0",
    "@tracer/types": "workspace:*"
  },
  "devDependencies": {
    "typescript": "*",
    "vitest": "*"
  }
}
```

- [ ] **Step 3: Create `packages/sdk/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022"]
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 4: Create `packages/sdk/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 5: Create source stubs**

`packages/sdk/src/convert.ts`:
```typescript
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import type { OtlpPayload } from '@tracer/types'

export function toOtlpPayload(_spans: ReadableSpan[]): OtlpPayload {
  throw new Error('not implemented')
}
```

`packages/sdk/src/exporter.ts`:
```typescript
import type { ExportResult, ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'

export class TracerExporter implements SpanExporter {
  constructor(private config: { url: string; apiKey: string }) {}
  export(_spans: ReadableSpan[], _resultCallback: (result: ExportResult) => void): void {
    throw new Error('not implemented')
  }
  shutdown(): Promise<void> { return Promise.resolve() }
}
```

`packages/sdk/src/provider.ts`:
```typescript
export function buildProvider(_config: { apiKey: string; url: string }): never {
  throw new Error('not implemented')
}
```

`packages/sdk/src/index.ts`:
```typescript
export type TracerConfig = {
  apiKey: string
  url: string
}

export function createTracer(_config: TracerConfig): never {
  throw new Error('not implemented')
}
```

- [ ] **Step 6: Install dependencies**

```bash
pnpm install
```

Expected: `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` appear in `node_modules`.

- [ ] **Step 7: Verify the package is picked up by the root test runner**

```bash
pnpm test 2>&1 | head -5
```

Expected: runs without crashing (no test files yet, so just 0 tests pass).

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/
git commit -m "feat(sdk): package scaffold"
```

---

## Task 2: OTLP Conversion (`convert.ts`)

**Files:**
- Create: `packages/sdk/test/convert.test.ts`
- Modify: `packages/sdk/src/convert.ts`

The `toOtlpPayload` function converts OTel `ReadableSpan[]` to the OTLP JSON shape the ingest-worker validates. Key mappings:
- `span.startTime` / `endTime` are `[seconds, nanoseconds]` hrtime tuples → nanosecond string: `String(BigInt(s) * 1_000_000_000n + BigInt(ns))`
- `span.attributes` values map to typed `OtlpAttributeValue` union
- `span.parentSpanId` is included only when truthy
- All spans are packed into `resourceSpans[0].scopeSpans[0].spans`

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/test/convert.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { toOtlpPayload } from '../src/convert.ts'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

function makeSpan(overrides: Partial<{
  name: string
  kind: number
  traceId: string
  spanId: string
  parentSpanId: string | undefined
  startTime: [number, number]
  endTime: [number, number]
  statusCode: number
  attributes: Record<string, unknown>
  events: Array<{ name: string; time: [number, number]; attributes?: Record<string, unknown> }>
}> = {}): ReadableSpan {
  const opts = {
    name: 'test.span',
    kind: 0,
    traceId: 'abc123def456abc1abc123def456abc1',
    spanId: 'abc123def456abc1',
    parentSpanId: undefined as string | undefined,
    startTime: [1700000000, 0] as [number, number],
    endTime: [1700000001, 500000000] as [number, number],
    statusCode: 0,
    attributes: {} as Record<string, unknown>,
    events: [] as Array<{ name: string; time: [number, number]; attributes?: Record<string, unknown> }>,
    ...overrides,
  }
  return {
    name: opts.name,
    kind: opts.kind,
    spanContext: () => ({ traceId: opts.traceId, spanId: opts.spanId, traceFlags: 1 }),
    parentSpanId: opts.parentSpanId,
    startTime: opts.startTime,
    endTime: opts.endTime,
    status: { code: opts.statusCode },
    attributes: opts.attributes,
    events: opts.events.map(e => ({ name: e.name, time: e.time, attributes: e.attributes ?? {} })),
    links: [],
    ended: true,
    duration: [1, 0] as [number, number],
    resource: {} as never,
    instrumentationLibrary: { name: 'test' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan
}

describe('toOtlpPayload', () => {
  it('wraps spans in resourceSpans structure', () => {
    const payload = toOtlpPayload([makeSpan()])
    expect(payload.resourceSpans).toHaveLength(1)
    expect(payload.resourceSpans[0].scopeSpans).toHaveLength(1)
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1)
  })

  it('maps traceId, spanId, and name', () => {
    const span = makeSpan({ traceId: 'trace001', spanId: 'span001', name: 'llm.call' })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan.traceId).toBe('trace001')
    expect(otlpSpan.spanId).toBe('span001')
    expect(otlpSpan.name).toBe('llm.call')
  })

  it('converts startTime hrtime to nanosecond string', () => {
    const span = makeSpan({ startTime: [1700000000, 0] })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan.startTimeUnixNano).toBe('1700000000000000000')
  })

  it('converts endTime hrtime with sub-second component', () => {
    const span = makeSpan({ endTime: [1700000001, 500000000] })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan.endTimeUnixNano).toBe('1700000001500000000')
  })

  it('omits parentSpanId when undefined', () => {
    const span = makeSpan({ parentSpanId: undefined })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan).not.toHaveProperty('parentSpanId')
  })

  it('includes parentSpanId when set', () => {
    const span = makeSpan({ parentSpanId: 'parent001' })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan.parentSpanId).toBe('parent001')
  })

  it('maps string attribute to stringValue', () => {
    const span = makeSpan({ attributes: { 'llm.model': 'gpt-4o' } })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan.attributes).toContainEqual({ key: 'llm.model', value: { stringValue: 'gpt-4o' } })
  })

  it('maps integer attribute to intValue', () => {
    const span = makeSpan({ attributes: { 'llm.tokens.input': 100 } })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan.attributes).toContainEqual({ key: 'llm.tokens.input', value: { intValue: 100 } })
  })

  it('maps float attribute to doubleValue', () => {
    const span = makeSpan({ attributes: { 'llm.cost_usd': 0.001 } })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan.attributes).toContainEqual({ key: 'llm.cost_usd', value: { doubleValue: 0.001 } })
  })

  it('maps boolean attribute to boolValue', () => {
    const span = makeSpan({ attributes: { 'llm.streaming': true } })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan.attributes).toContainEqual({ key: 'llm.streaming', value: { boolValue: true } })
  })

  it('maps events with name and nanosecond timestamp', () => {
    const span = makeSpan({
      events: [{ name: 'first_token', time: [1700000000, 100000000] }],
    })
    const otlpSpan = toOtlpPayload([span]).resourceSpans[0].scopeSpans[0].spans[0]
    expect(otlpSpan.events).toHaveLength(1)
    expect(otlpSpan.events![0].name).toBe('first_token')
    expect(otlpSpan.events![0].timeUnixNano).toBe('1700000000100000000')
  })

  it('handles multiple spans', () => {
    const spans = [makeSpan({ name: 'span-a' }), makeSpan({ name: 'span-b' })]
    const otlpSpans = toOtlpPayload(spans).resourceSpans[0].scopeSpans[0].spans
    expect(otlpSpans).toHaveLength(2)
    expect(otlpSpans[0].name).toBe('span-a')
    expect(otlpSpans[1].name).toBe('span-b')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/sdk && pnpm test 2>&1 | grep -E "FAIL|Error|✗"
```

Expected: tests fail with `Error: not implemented`

- [ ] **Step 3: Implement `packages/sdk/src/convert.ts`**

```typescript
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import type { OtlpPayload, OtlpAttribute, OtlpAttributeValue, OtlpEvent, OtlpSpan } from '@tracer/types'

function hrtimeToNanoString(time: [number, number]): string {
  return String(BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]))
}

function toOtlpAttributeValue(value: unknown): OtlpAttributeValue {
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value }
  }
  return { stringValue: JSON.stringify(value) }
}

function toOtlpAttributes(attrs: Record<string, unknown>): OtlpAttribute[] {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({ key, value: toOtlpAttributeValue(value) }))
}

export function toOtlpPayload(spans: ReadableSpan[]): OtlpPayload {
  return {
    resourceSpans: [{
      scopeSpans: [{
        spans: spans.map(span => {
          const ctx = span.spanContext()
          const result: OtlpSpan = {
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            name: span.name,
            kind: span.kind,
            startTimeUnixNano: hrtimeToNanoString(span.startTime as [number, number]),
            endTimeUnixNano: hrtimeToNanoString(span.endTime as [number, number]),
            status: { code: span.status.code },
            attributes: toOtlpAttributes(span.attributes as Record<string, unknown>),
            events: span.events.map(event => {
              const otlpEvent: OtlpEvent = {
                name: event.name,
                timeUnixNano: hrtimeToNanoString(event.time as [number, number]),
              }
              if (event.attributes && Object.keys(event.attributes).length > 0) {
                otlpEvent.attributes = toOtlpAttributes(event.attributes as Record<string, unknown>)
              }
              return otlpEvent
            }),
          }
          if (span.parentSpanId) result.parentSpanId = span.parentSpanId
          return result
        }),
      }],
    }],
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/sdk && pnpm test 2>&1 | grep -E "Tests|✓|PASS"
```

Expected: 12 tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/convert.ts packages/sdk/test/convert.test.ts
git commit -m "feat(sdk): OTLP conversion — ReadableSpan[] to OtlpPayload"
```

---

## Task 3: Span Exporter (`exporter.ts`)

**Files:**
- Create: `packages/sdk/test/exporter.test.ts`
- Modify: `packages/sdk/src/exporter.ts`

`TracerExporter` is the HTTP bridge. It receives a batch of `ReadableSpan[]` from `BatchSpanProcessor`, converts them via `toOtlpPayload`, and POSTs to the ingest endpoint. The callback receives `{ code: 0 }` (SUCCESS) on 202, `{ code: 1 }` (FAILED) on any error. Failures are silent to the application.

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/test/exporter.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { TracerExporter } from '../src/exporter.ts'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

afterEach(() => vi.restoreAllMocks())

function makeSpan(): ReadableSpan {
  return {
    name: 'test.span',
    kind: 0,
    spanContext: () => ({ traceId: 'abc123def456abc1abc123def456abc1', spanId: 'abc123def456abc1', traceFlags: 1 }),
    parentSpanId: undefined,
    startTime: [1700000000, 0] as [number, number],
    endTime: [1700000001, 0] as [number, number],
    status: { code: 0 },
    attributes: {},
    events: [],
    links: [],
    ended: true,
    duration: [1, 0] as [number, number],
    resource: {} as never,
    instrumentationLibrary: { name: 'test' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan
}

function exportSpans(exporter: TracerExporter, spans: ReadableSpan[]): Promise<{ code: number }> {
  return new Promise(resolve => exporter.export(spans, resolve as never))
}

describe('TracerExporter', () => {
  it('POSTs to /v1/traces with correct URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const exporter = new TracerExporter({ url: 'https://ingest.example.com', apiKey: 'tr_live_abc' })
    await exportSpans(exporter, [makeSpan()])
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://ingest.example.com/v1/traces')
  })

  it('sends Bearer token in Authorization header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const exporter = new TracerExporter({ url: 'https://ingest.example.com', apiKey: 'tr_live_abc' })
    await exportSpans(exporter, [makeSpan()])
    const [, init] = fetchSpy.mock.calls[0]
    expect((init as RequestInit).headers as Record<string, string>).toMatchObject({
      'Authorization': 'Bearer tr_live_abc',
      'Content-Type': 'application/json',
    })
  })

  it('uses POST method', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const exporter = new TracerExporter({ url: 'https://ingest.example.com', apiKey: 'tr_live_abc' })
    await exportSpans(exporter, [makeSpan()])
    const [, init] = fetchSpy.mock.calls[0]
    expect((init as RequestInit).method).toBe('POST')
  })

  it('body is valid OTLP JSON with resourceSpans', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const exporter = new TracerExporter({ url: 'https://ingest.example.com', apiKey: 'tr_live_abc' })
    await exportSpans(exporter, [makeSpan()])
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toHaveProperty('resourceSpans')
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('test.span')
  })

  it('calls resultCallback with code 0 (SUCCESS) on 202', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const exporter = new TracerExporter({ url: 'https://ingest.example.com', apiKey: 'tr_live_abc' })
    const result = await exportSpans(exporter, [makeSpan()])
    expect(result.code).toBe(0)
  })

  it('calls resultCallback with code 1 (FAILED) on 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('error', { status: 500 }))
    const exporter = new TracerExporter({ url: 'https://ingest.example.com', apiKey: 'tr_live_abc' })
    const result = await exportSpans(exporter, [makeSpan()])
    expect(result.code).toBe(1)
  })

  it('calls resultCallback with code 1 (FAILED) on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const exporter = new TracerExporter({ url: 'https://ingest.example.com', apiKey: 'wrong_key' })
    const result = await exportSpans(exporter, [makeSpan()])
    expect(result.code).toBe(1)
  })

  it('calls resultCallback with code 1 (FAILED) on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network failure'))
    const exporter = new TracerExporter({ url: 'https://ingest.example.com', apiKey: 'tr_live_abc' })
    const result = await exportSpans(exporter, [makeSpan()])
    expect(result.code).toBe(1)
  })

  it('shutdown resolves without throwing', async () => {
    const exporter = new TracerExporter({ url: 'https://ingest.example.com', apiKey: 'tr_live_abc' })
    await expect(exporter.shutdown()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/sdk && pnpm test 2>&1 | grep -E "FAIL|not implemented"
```

Expected: tests fail with `Error: not implemented`

- [ ] **Step 3: Implement `packages/sdk/src/exporter.ts`**

```typescript
import type { ExportResult, ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { ExportResultCode } from '@opentelemetry/sdk-trace-base'
import { toOtlpPayload } from './convert.ts'

export class TracerExporter implements SpanExporter {
  constructor(private config: { url: string; apiKey: string }) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const payload = toOtlpPayload(spans)
    fetch(`${this.config.url}/v1/traces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(payload),
    })
      .then(res => {
        resultCallback({
          code: res.ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED,
        })
      })
      .catch(() => {
        resultCallback({ code: ExportResultCode.FAILED })
      })
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/sdk && pnpm test 2>&1 | grep -E "Tests|✓|PASS"
```

Expected: 8 tests pass in exporter.test.ts, 12 from convert.test.ts — 20 total

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/exporter.ts packages/sdk/test/exporter.test.ts
git commit -m "feat(sdk): TracerExporter — HTTP POST to ingest endpoint"
```

---

## Task 4: Provider and Public API (`provider.ts` + `index.ts`)

**Files:**
- Create: `packages/sdk/test/provider.test.ts`
- Modify: `packages/sdk/src/provider.ts`
- Modify: `packages/sdk/src/index.ts`

`buildProvider` wires `TracerExporter` → `BatchSpanProcessor` (512-span buffer, 5s export interval) → `BasicTracerProvider`. `createTracer` is the one public function — it just delegates to `buildProvider`.

- [ ] **Step 1: Write the failing tests**

Create `packages/sdk/test/provider.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createTracer } from '../src/index.ts'

afterEach(() => vi.restoreAllMocks())

describe('createTracer', () => {
  it('returns an object with provider and flush', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const result = createTracer({ apiKey: 'tr_live_test', url: 'https://ingest.example.com' })
    expect(result).toHaveProperty('provider')
    expect(result).toHaveProperty('flush')
  })

  it('flush is a function', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const { flush } = createTracer({ apiKey: 'tr_live_test', url: 'https://ingest.example.com' })
    expect(typeof flush).toBe('function')
  })

  it('provider has getTracer method', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const { provider } = createTracer({ apiKey: 'tr_live_test', url: 'https://ingest.example.com' })
    expect(typeof provider.getTracer).toBe('function')
  })

  it('provider.getTracer returns a tracer with startSpan', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const { provider } = createTracer({ apiKey: 'tr_live_test', url: 'https://ingest.example.com' })
    const tracer = provider.getTracer('my-app')
    expect(typeof tracer.startSpan).toBe('function')
  })

  it('flush resolves without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    const { flush } = createTracer({ apiKey: 'tr_live_test', url: 'https://ingest.example.com' })
    await expect(flush()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/sdk && pnpm test 2>&1 | grep -E "FAIL|not implemented"
```

Expected: provider tests fail with `Error: not implemented`

- [ ] **Step 3: Implement `packages/sdk/src/provider.ts`**

```typescript
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { TracerExporter } from './exporter.ts'

export function buildProvider(config: { apiKey: string; url: string }): {
  provider: BasicTracerProvider
  flush: () => Promise<void>
} {
  const exporter = new TracerExporter(config)
  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5_000,
  })
  const provider = new BasicTracerProvider()
  provider.addSpanProcessor(processor)

  return {
    provider,
    flush: () => provider.forceFlush(),
  }
}
```

- [ ] **Step 4: Implement `packages/sdk/src/index.ts`**

```typescript
import { buildProvider } from './provider.ts'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'

export type TracerConfig = {
  apiKey: string
  url: string
}

export function createTracer(config: TracerConfig): {
  provider: BasicTracerProvider
  flush: () => Promise<void>
} {
  return buildProvider(config)
}
```

- [ ] **Step 5: Run all tests to verify they pass**

```bash
cd packages/sdk && pnpm test 2>&1
```

Expected:
```
Test Files  1 passed (1)   ← provider.test.ts
    Tests  5 passed (5)
... (convert + exporter already passing)
Test Files  3 passed (3)
    Tests  25 passed (25)
```

- [ ] **Step 6: Run the full monorepo test suite**

```bash
cd ../.. && pnpm test 2>&1 | tail -5
```

Expected: all tests across all packages pass

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/provider.ts packages/sdk/src/index.ts packages/sdk/test/provider.test.ts
git commit -m "feat(sdk): provider wiring and createTracer public API"
```

---

## Self-Review

**Spec coverage:**
- [x] Custom `SpanExporter` POSTing OTLP JSON — Task 3 (`exporter.ts`)
- [x] `createTracer({ apiKey, url })` factory — Task 4 (`index.ts`)
- [x] `flush()` for serverless — Task 4 (`provider.ts` `forceFlush`)
- [x] `BatchSpanProcessor` with 512-span buffer / 5s interval — Task 4 (`provider.ts`)
- [x] `toOtlpPayload` conversion with all attribute types — Task 2 (`convert.ts`)
- [x] 202 → SUCCESS, non-2xx → FAILED, network error → FAILED — Task 3
- [x] `parentSpanId` omitted when undefined — Task 2
- [x] Events mapped with nanosecond timestamp — Task 2
- [x] Node.js only (no edge-specific code) — throughout

**Placeholder scan:** None found. All steps have complete code.

**Type consistency:**
- `TracerConfig` defined in `index.ts`, passed through to `buildProvider` and `TracerExporter` — consistent
- `toOtlpPayload` returns `OtlpPayload` from `@tracer/types`, used in `exporter.ts` — consistent
- `BasicTracerProvider` returned from `buildProvider` and re-exported from `createTracer` — consistent
