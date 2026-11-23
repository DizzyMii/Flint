# Flint Roadmap

**Last updated:** 2026-11-23

Flint's pitch is a token-efficient agent runtime. Every item below either makes that claim more true or makes it measurable. Anything else waits.

---

## Shipped — runtime hardening

The claims in the README now hold at runtime, and each one has a regression test.

| Claim | What makes it true | Proof |
|---|---|---|
| Dollar caps | Pricing as data, central cost in `call()`, pre-flight `max_tokens` clamp, fail-closed `budget.unpriced` | `adapter-anthropic/test/contract.test.ts` (maxDollars end to end) |
| Token efficiency | Rolling 4-breakpoint cache layout; prefix-stable `contextManager()` | `adapter-anthropic/test/bench.test.ts` — $/task gate, simulated cache |
| No provider 400s from Flint | Turn-atomic transforms, `checkTranscript`, `compress.malformed` | `flint/test/hardening.test.ts` |
| Errors as values, resilient | Classified `AdapterError`, retries with retry-after | `flint/test/hardening.test.ts`, adapter contract tests |
| Lossless protocol | Thinking replay via `providerContent`, `isError`, `parseError`, `refusal` | adapter contract tests |
| Recoverable runs | Event log, `transcriptFrom`, `partialRun`, graph checkpoints | `flint/test/hardening.test.ts`, `graph/test/semantics.test.ts` |

## Next — make efficiency visible to users

1. **Live-API benchmark.** Run `bench.test.ts`'s scenario against the real API behind a manual CI job with a spend cap; publish measured $/task next to the simulated figure. The simulator is a model of billing, not billing.
2. **Cache diagnostics in the event log.** Emit per-step cache hit ratio and flag a collapse in cache reads (a prefix invalidator) as an event.
3. **Calibrated compaction horizon.** Replace the default horizon (remaining budget steps, else 8) with an estimate learned from the run's own step rate.

## Frozen — do not start without a user asking

| Item | Why it waits |
|---|---|
| Gemini / Bedrock adapters | The contract just changed; prove it on two adapters first |
| Vector-store adapters for RAG | Not on the token-efficiency path |
| `flint init` CLI, TypeDoc | Docs are ahead of demand already |
| Graph visualization, distributed runners | Graph is experimental; usage decides whether it survives |

## Cancelled

- **Tracer platform + ingestion** (2026-04-27 spec/plan) — a hosted product inside a library. Tracing is the event log; any backend is a sink.
- **Tracer SDK** as a separate package — superseded by `onEvent` / `eventLog()`.

## Open decisions for the maintainer

- `landlord` is published under the unscoped name `landlord` while the docs say `@flint/landlord`. Pick one before the first publish.
- All packages are still `0.0.0` while `BREAKING_CHANGES.md` talks about v1.0. Decide whether the first publish is 0.x (experimental packages included) or 1.0 (stable surface only).
