# Stability Policy

Flint follows [Semantic Versioning](https://semver.org/):

- **Patch** (`x.y.Z`): bug fixes, non-breaking internal changes
- **Minor** (`x.Y.0`): new opt-in features, new exports, additive fields on public types, documented behaviour fixes
- **Major** (`X.0.0`): breaking changes to the stable surface below

## Stable

All named exports from `flint`, `flint/budget`, `flint/errors`, `flint/compress`, `flint/context`, `flint/pricing`, `flint/recipes`, `flint/memory`, `flint/rag`, `flint/safety`, `flint/testing`, `@flint/adapter-anthropic`, `@flint/adapter-openai-compat`.

TypeScript shapes of `ProviderAdapter`, `NormalizedRequest`, `NormalizedResponse`, `StreamChunk`, `Message`, `Tool`, `ToolContext`, `Result`, `Usage`, `StopReason`, `AgentEvent`.

Additive changes to these types (a new optional field, a new union member such as a `StopReason` or `StreamChunk` variant) ship in minor releases. Write `switch` statements over these unions with a `default` branch.

### Semantics that are part of the contract

- `Usage.input` counts uncached input tokens only; `cached` and `cacheWrite` are disjoint from it.
- `cost` is in US dollars. A budget with `maxDollars` never silently skips enforcement: it fails with `budget.unpriced` when a call cannot be priced.
- `call()`, `agent()` and adapters return errors as values; adapters throw `AdapterError` with a `kind` and `retryable` flag, and never retry on their own.
- Compress transforms and context strategies must keep the transcript well-formed (`checkTranscript`).

## Experimental (not covered by this policy)

- `@flint/graph`
- `landlord` (`orchestrate`, `decompose`, the workflow runtime and its tools). The workflow script guard is a determinism aid, not a security boundary.

Experimental packages may change in any minor release. They graduate when their API has gone two minor releases without a breaking change.

## Not public API

Internal file paths, the `raw` field on `NormalizedResponse`, the contents of `ProviderContent.blocks` (opaque, provider-owned), and anything not listed above.
