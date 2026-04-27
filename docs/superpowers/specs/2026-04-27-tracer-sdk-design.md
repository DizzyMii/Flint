# Tracer SDK Design

**Sub-project:** `@tracer/sdk` — TypeScript instrumentation SDK for the Tracer platform  
**Repo:** `tracer` monorepo (`packages/sdk/`)  
**Date:** 2026-04-27

---

## Goal

Ship a zero-config TypeScript SDK that auto-instruments Vercel AI SDK calls and sends spans to the Tracer ingest pipeline. Developers add one setup call; every `generateText`, `streamText`, etc. call is traced automatically.

---

## Scope

**In scope (v1):**
- Custom OpenTelemetry `SpanExporter` that POSTs spans to the Tracer ingest endpoint as OTLP JSON
- `createTracer({ apiKey, url })` factory that wires the exporter into OTel's `BatchSpanProcessor`
- `flush()` for serverless runtimes where the process may exit before the batch timer fires
- Node.js runtime only

**Out of scope (v2+):**
- Eval/scoring API (`tracer.score(spanId, { score, label })`)
- Edge runtime support
- Auto-SIGTERM flush handler
- Python SDK
- Browser/client-side tracing

---

## Architecture

### Approach

Implement a thin custom `SpanExporter` on top of `@opentelemetry/sdk-trace-base`. The OTel package provides battle-tested `BatchSpanProcessor` (buffering, retry, flush) — the SDK only writes the HTTP export layer and the OTLP conversion.

### Package structure

```
packages/sdk/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
│   ├── index.ts       — public API: createTracer(), TracerConfig type
│   ├── provider.ts    — BasicTracerProvider + BatchSpanProcessor wiring
│   ├── exporter.ts    — TracerExporter implements SpanExporter
│   └── convert.ts     — ReadableSpan[] → OtlpPayload conversion
└── test/
    ├── exporter.test.ts
    ├── provider.test.ts
    └── convert.test.ts
```

### Dependencies

| Dependency | Role |
|---|---|
| `@opentelemetry/sdk-trace-base` | `BasicTracerProvider`, `BatchSpanProcessor`, `SpanExporter`, `ReadableSpan` |
| `@opentelemetry/api` | `TracerProvider` interface (peer dep of sdk-trace-base) |
| `@tracer/types` | `OtlpPayload`, `OtlpSpan`, `OtlpAttribute` for OTLP JSON shape |

---

## Components

### `src/convert.ts`

Converts an array of OTel `ReadableSpan` objects into an `OtlpPayload` that the ingest-worker's Zod schema accepts.

Key mappings:
- `span.startTime` (hrtime tuple `[seconds, nanoseconds]`) → `startTimeUnixNano` string: `String(BigInt(s) * 1_000_000_000n + BigInt(ns))`
- `span.attributes` → `OtlpAttribute[]` with typed value union (`stringValue`, `intValue`, `doubleValue`, `boolValue`)
- `span.parentSpanId` → omitted if undefined
- `span.events` → `OtlpEvent[]` with same attribute mapping
- `span.status.code` → numeric code (0 = unset, 1 = ok, 2 = error)
- All spans packed into a single `resourceSpans[0].scopeSpans[0].spans` array

Exported function:
```ts
export function toOtlpPayload(spans: ReadableSpan[]): OtlpPayload
```

### `src/exporter.ts`

```ts
export class TracerExporter implements SpanExporter {
  constructor(private config: { url: string; apiKey: string }) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    // convert spans → OtlpPayload
    // POST to ${config.url}/v1/traces with Authorization: Bearer ${config.apiKey}
    // 202 → ExportResultCode.SUCCESS
    // non-2xx or network error → ExportResultCode.FAILED
  }

  shutdown(): Promise<void> { return Promise.resolve() }
}
```

Error handling: non-2xx responses and network failures both resolve to `ExportResultCode.FAILED`. The `BatchSpanProcessor` handles retries (up to 3, exponential backoff). Failures are silent to the application — observability failures must never crash production code.

### `src/provider.ts`

```ts
export function buildProvider(config: TracerConfig): {
  provider: BasicTracerProvider
  flush: () => Promise<void>
}
```

Wires `TracerExporter` → `BatchSpanProcessor` (512 span buffer, 5s export interval) → `BasicTracerProvider`. Returns the provider and a `flush` function that calls `provider.forceFlush()`.

### `src/index.ts`

Public API — re-exports only what developers need:

```ts
export type TracerConfig = {
  apiKey: string
  url: string
}

export function createTracer(config: TracerConfig): {
  provider: BasicTracerProvider
  flush: () => Promise<void>
}
```

---

## Data Flow

```
Vercel AI SDK call
  → span created by BasicTracerProvider
  → span.end() → BatchSpanProcessor buffers
  → flush trigger (512 spans | 5s timer | flush())
  → TracerExporter.export(batch)
  → toOtlpPayload(batch) → OtlpPayload JSON
  → POST /v1/traces { Authorization: Bearer <apiKey> }
  → 202 Accepted → ExportResultCode.SUCCESS
                 → ExportResultCode.FAILED (retried by BatchSpanProcessor, then dropped)
```

---

## Developer Usage

```ts
// app/instrumentation.ts (Next.js) or server startup
import { createTracer } from '@tracer/sdk'

const { provider, flush } = createTracer({
  apiKey: process.env.TRACER_API_KEY!,
  url: process.env.TRACER_INGEST_URL!,
})

// Per AI call:
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'Hello',
  experimental_telemetry: {
    isEnabled: true,
    tracer: provider.getTracer('my-app'),
  },
})

// Serverless — flush before function returns:
await flush()
```

---

## Testing

### `test/convert.test.ts`
- Attribute type mapping: string → `stringValue`, integer → `intValue`, float → `doubleValue`, boolean → `boolValue`
- Nanosecond timestamp conversion from hrtime tuple
- `parentSpanId` omitted when undefined
- Events array mapped correctly

### `test/exporter.test.ts`
- POSTs to correct URL with `Authorization: Bearer <key>` header
- Body is valid OTLP JSON
- `SUCCESS` on 202 response
- `FAILED` on 500 response
- `FAILED` on network error (fetch throws)
- Uses `vi.spyOn(globalThis, 'fetch')` — same pattern as `clickhouse.test.ts`

### `test/provider.test.ts`
- `createTracer` returns `{ provider, flush }`
- `provider.getTracer()` returns a tracer
- `flush()` resolves without throwing

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Ingest endpoint returns non-2xx | `FAILED` — BatchSpanProcessor retries up to 3x, then drops |
| Network error (fetch throws) | `FAILED` — same retry path |
| Spans lost after retries | Silently dropped — never throws into application code |
| `flush()` called with empty buffer | Resolves immediately, no-op |
| Invalid `apiKey` / `url` | 401 from ingest → `FAILED` → spans dropped after retries |

---

## What Is Not Designed Here

- Eval scoring API — deferred to v2
- Edge runtime — deferred to v2
- SIGTERM auto-flush — left to the developer; documented in usage notes
- Python SDK — separate project
