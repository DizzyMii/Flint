# Tracer — Platform + Ingestion Sub-Project Design

**Date:** 2026-04-27  
**Status:** Approved  
**Sub-project:** 1 of N — Platform + Ingestion (data plane + minimal control plane)  
**Product:** Tracer — eval-first AI observability API for TypeScript developers  
**Scope boundary:** Traces flowing end-to-end into ClickHouse, API key management via REST. No Clerk, no Stripe, no dashboard, no SDK package.

---

## Design Philosophy

**The data path is sacred.** Every other component can be slow, dumb, or missing. The ingest pipeline cannot drop data. 202 immediately, retry forever, DLQ as last resort.

**Boring infrastructure, sharp product.** The stack is entirely managed services — Cloudflare, ClickHouse Cloud, Neon, Vercel. Zero ops. Complexity budget is spent on product experience, not keeping servers alive.

**OTel vocabulary, LLM soul.** Use OpenTelemetry's span model because it ages well and the ecosystem knows it. Name things as an LLM developer would: cost, tokens, prompt, completion, model.

**Eval-first means traces serve tests, not dashboards.** Every schema decision is evaluated against: does this make it easier to run the same eval suite in CI and in production?

**TypeScript-native, not TypeScript-ported.** The type system makes correct usage obvious and incorrect usage a compile error.

**Deliberate smallness.** Features are liabilities. When in doubt, no.

**Ghost-mode constraints are load-bearing.** If a design requires someone to be on-call for it, the design is wrong.

---

## Repository Structure

New standalone repository (working name: `tracer`). pnpm monorepo.

```
tracer/
├── packages/
│   ├── types/              # @tracer/types — shared OTel span types, API request/response shapes
│   ├── ingest-worker/      # Cloudflare Worker — validates + enqueues traces
│   ├── consumer-worker/    # Cloudflare Worker — batches + writes to ClickHouse
│   └── api-worker/         # Cloudflare Worker — control plane REST API (Hono)
├── services/
│   └── dashboard/          # Next.js app — stub only in this sub-project
├── db/
│   ├── migrations/         # Neon Postgres migrations (Drizzle ORM)
│   └── schema.ts           # Shared Drizzle schema
├── scripts/
│   └── smoke.ts            # E2E smoke test: create project → send trace → assert in ClickHouse
├── wrangler.toml           # Root Wrangler config with environment definitions
├── pnpm-workspace.yaml
└── package.json
```

The three workers share types from `@tracer/types`. Each worker has its own `wrangler.toml`. No shared runtime code — each worker is independently deployable.

---

## Trace Data Model

### Wire format: OTLP/HTTP JSON

The ingest endpoint accepts the standard [OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/#otlphttp) payload. Any OTel-compatible SDK can send to this endpoint with zero modification.

```json
{
  "resourceSpans": [{
    "resource": { "attributes": [] },
    "scopeSpans": [{
      "spans": [ ...spans ]
    }]
  }]
}
```

Maximum 500 spans per request. The SDK batches client-side; the ingest worker does not aggregate.

### LLM-specific attribute namespaces

Standard OTel span attributes with three namespaces:

- `llm.*` — Tracer's own LLM fields: `llm.model`, `llm.provider`, `llm.tokens.input`, `llm.tokens.output`, `llm.cost_usd`, `llm.input`, `llm.output`
- `gen_ai.*` — [OpenLLMetry semantic conventions](https://github.com/traceloop/openllmetry) for cross-tool compatibility
- `tool.*` — Tool call fields: `tool.name`, `tool.input`, `tool.output`

### Span kinds

The `kind` field is a low-cardinality enum:

| Kind | Meaning |
|---|---|
| `llm` | Single model call (generateText, streamText, generateObject) |
| `tool` | Tool execution within an agent loop |
| `agent` | One step of an agent loop |
| `chain` | Logical grouping of multiple spans |

### ClickHouse table: `spans`

```sql
CREATE TABLE spans (
  project_id      UUID,
  trace_id        UUID,
  span_id         UUID,
  parent_span_id  Nullable(UUID),
  name            String,
  kind            LowCardinality(String),   -- llm|tool|agent|chain
  start_time      DateTime64(3, 'UTC'),
  end_time        DateTime64(3, 'UTC'),
  status          LowCardinality(String),   -- ok|error|unset
  attributes      Map(String, String),       -- all llm.*, gen_ai.*, tool.* fields
  events          Array(String),             -- JSON-encoded OTel events
  ingested_at     DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (project_id, trace_id, start_time)
PARTITION BY toYYYYMM(start_time);
```

`Map(String, String)` for attributes provides schema flexibility — adding new LLM fields requires no migrations. The `ORDER BY` key optimises for the dashboard's primary query pattern: all spans for a project in a time range.

---

## Control Plane

### Neon Postgres schema (Drizzle ORM)

```sql
-- projects
id           uuid PRIMARY KEY DEFAULT gen_random_uuid()
name         text NOT NULL
owner_email  text NOT NULL
created_at   timestamptz DEFAULT now()
plan         text DEFAULT 'free'
trace_count  bigint DEFAULT 0

-- api_keys
id           uuid PRIMARY KEY DEFAULT gen_random_uuid()
project_id   uuid REFERENCES projects(id) ON DELETE CASCADE
key_hash     text UNIQUE NOT NULL      -- SHA-256 of raw key, never the raw key
key_prefix   text NOT NULL             -- first 14 chars, e.g. "tr_live_abc123"
name         text                      -- human label, e.g. "production"
created_at   timestamptz DEFAULT now()
revoked_at   timestamptz               -- null = active
```

### REST API (Hono on api-worker)

All endpoints require `X-Admin-Secret: <ADMIN_SECRET>` header. No Clerk in this sub-project. `POST /v1/traces` and `GET /health` are handled by the **ingest-worker**, not the api-worker — they are listed here for completeness.

| Method | Path | Worker | Description |
|---|---|---|---|
| `POST` | `/v1/projects` | api-worker | Create a project |
| `GET` | `/v1/projects/:id` | api-worker | Get project details |
| `POST` | `/v1/projects/:id/api-keys` | api-worker | Issue a new API key |
| `DELETE` | `/v1/projects/:id/api-keys/:kid` | api-worker | Revoke a key |
| `GET` | `/v1/projects/:id/api-keys` | api-worker | List keys (prefix + metadata, never hash) |
| `POST` | `/v1/traces` | ingest-worker | Ingest spans (Bearer auth) |
| `GET` | `/health` | ingest-worker | Liveness check |

### API key lifecycle

```
Creation:
  raw_key = "tr_live_" + randomBytes(24).toString('hex')
  hash    = sha256(raw_key)          → stored in Neon api_keys.key_hash
  prefix  = raw_key.slice(0, 14)    → stored in Neon api_keys.key_prefix
  kv.put(hash, project_id)          → CF KV for fast auth lookup
  return raw_key                     → shown to caller once, never again

Auth check (ingest-worker hot path, <1ms):
  incoming_hash = sha256(bearer_token)
  project_id    = await kv.get(incoming_hash)
  if (!project_id) return 401

Revocation:
  kv.delete(hash)                    → immediate effect
  UPDATE api_keys SET revoked_at = now() WHERE id = $1
```

The ingest worker never touches Neon during trace ingestion. KV is the only auth dependency on the hot path.

---

## Ingestion Pipeline

### ingest-worker

Handles `POST /v1/traces`. No ClickHouse dependency. Fails only on auth or malformed body.

1. Extract Bearer token → SHA-256 → `kv.get(hash)` → `project_id` (or 401)
2. Parse body: validate OTLP/JSON top-level shape (Zod, lightweight)
3. Reject if span count > 500 → 413
4. Enrich: inject `project_id`, `ingested_at` timestamp
5. `queue.send({ project_id, spans, ingested_at })` → 202 Accepted

**p99 target:** < 20ms. **CF KV bindings:** `API_KEYS_KV`. **CF Queue producer binding:** `traces-queue`.

### consumer-worker

Triggered by CF Queues. Receives batches of up to 100 queue messages every ~5 seconds.

1. Receive `MessageBatch` (up to 100 messages)
2. Flatten all spans across messages into one array
3. Map OTLP span shape → ClickHouse row shape
4. Single bulk `INSERT INTO spans VALUES (...)` via ClickHouse HTTP API
5. Success: `batch.ackAll()`
6. ClickHouse error: `batch.retryAll()` → CF Queues retries with exponential backoff
7. After 3 retries: messages route to dead-letter queue (`traces-dlq`) — no active DLQ consumer in V1; messages accumulate for manual inspection and alerting

**CF Queue consumer binding:** `traces-queue`. **DLQ binding (producer only):** `traces-dlq`. **Secrets:** `CLICKHOUSE_URL`, `CLICKHOUSE_PASSWORD`.

### Full data flow

```
SDK → POST /v1/traces (Bearer) → ingest-worker → 202 Accepted
                                      ↓
                                  CF Queue (traces-queue)
                                      ↓ ~5s batch
                                  consumer-worker
                                      ↓ bulk INSERT
                                  ClickHouse (spans table)

Supporting:
  CF KV        → auth fast-path (hash → project_id)
  Neon         → project + api_key metadata (key management only)
  DLQ          → traces-dlq (3-retry dead-letter, alertable)
```

---

## Error Handling

| Failure point | Behavior | HTTP status |
|---|---|---|
| Missing/invalid API key | Return immediately | 401 |
| Malformed OTLP body | Zod error details in response | 400 |
| Span count > 500 | Reject with max hint | 413 |
| CF Queue send fails | Service unavailable | 503 |
| ClickHouse insert fails | `batch.retryAll()` — silent to SDK caller | — |
| 3 retries exhausted | Move to DLQ, no data loss | — |
| Neon unreachable (key management) | Service unavailable | 503 |

---

## Testing Strategy

Three layers:

**1. Unit tests (Vitest)** — pure functions, no I/O:
- OTLP payload validation (valid/invalid/edge cases)
- Span → ClickHouse row mapping
- SHA-256 key hashing and prefix extraction
- Error serialization

**2. Integration tests (Miniflare + real services)** — ingest-worker and consumer-worker tested via Miniflare (CF Workers local runtime). Real Neon dev branch. ClickHouse local via Docker (`clickhouse/clickhouse-server`). Consumer worker tested with a fake `MessageBatch` object.

**3. E2E smoke test (`scripts/smoke.ts`)** — runs against staging:
1. `POST /v1/projects` → create project
2. `POST /v1/projects/:id/api-keys` → get key
3. `POST /v1/traces` → send one span
4. Wait 10s
5. Query ClickHouse: assert span exists with correct `project_id` and `trace_id`

The smoke test runs in CI on every deploy to staging.

---

## Out of Scope (this sub-project)

The following are explicitly deferred to subsequent sub-projects:

- Clerk authentication for the dashboard
- Stripe metered billing
- Next.js dashboard (trace explorer, eval history)
- `@tracer/sdk` package (Vercel AI SDK + Flint wrappers)
- Eval endpoints (`POST /v1/evals/run`, `POST /v1/datasets`)
- Rate limiting per project
- Trace retention policies and pruning
- Per-project ClickHouse quotas
- Python SDK
- Self-hosted deployment

---

## Environment Variables

| Variable | Worker | Description |
|---|---|---|
| `ADMIN_SECRET` | api-worker | Gates all project/key management endpoints |
| `DATABASE_URL` | api-worker | Neon connection string |
| `CLICKHOUSE_URL` | consumer-worker | ClickHouse Cloud HTTPS endpoint |
| `CLICKHOUSE_PASSWORD` | consumer-worker | ClickHouse password (secret) |
| `ENVIRONMENT` | all | `development` \| `staging` \| `production` |

CF KV namespace (`API_KEYS_KV`) and Queue bindings (`traces-queue`, `traces-dlq`) are configured in `wrangler.toml` per environment.
