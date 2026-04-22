# v0 Status & API Stability

Flint is in **v0** — under active development and not yet published to npm. This page documents what that means for code you write against it.

## What v0 means

- The package is not on npm. Install from the GitHub repository.
- The public API may change without a major version bump before 1.0.
- Breaking changes will be documented in the changelog (`.changeset/`).
- There is no guaranteed deprecation window before 1.0.

## What is considered stable

These signatures are unlikely to change:

| Surface | Status |
|---|---|
| `call()`, `stream()`, `validate()`, `execute()`, `count()` | Stable |
| `tool()` type and factory | Stable |
| `agent()` core options (`adapter`, `model`, `messages`, `tools`, `budget`) | Stable |
| `ProviderAdapter` interface | Stable |
| `Result<T>` shape | Stable |
| `Message`, `Tool`, `Usage`, `StopReason` types | Stable |

## What may change

| Surface | Notes |
|---|---|
| `agent()` advanced options (`onStep`, `compress`, `maxSteps`) | Signatures may evolve |
| Compress transform signatures | `CompressCtx` may gain fields |
| Recipes API (`react`, `retryValidate`, `reflect`, `summarize`) | High-level API under iteration |
| `@flint/graph` DSL | State machine API actively being designed |
| Budget `consume()` / `remaining()` | Minor additions possible |
| Safety utilities | Signatures mostly stable; option sets may grow |

## How to protect yourself

**Pin your version:**
```sh
npm install github:DizzyMii/flint#abc1234
```

**Watch for breaking changes:**
The root `.changeset/README.md` and commit history document all breaking changes. The commit message prefix `feat!:` or `fix!:` signals a breaking change.

**Write integration tests.** Flint's primitives are easily testable with the built-in mock adapter (`flint/testing`).

## When will 1.0 land?

When the API surface is proven stable through real usage. There is no committed timeline.

## See also

- [Installation](/guide/installation) — runtime requirements
- [Guide](/guide/) — what Flint is and how it fits together
- [STABILITY.md](/STABILITY) — detailed stability policy
