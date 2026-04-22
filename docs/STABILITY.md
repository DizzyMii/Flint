# Stability Policy

From v1.0.0, Flint follows [Semantic Versioning](https://semver.org/):

- **Patch** (`1.0.x`): bug fixes, non-breaking internal changes
- **Minor** (`1.x.0`): new opt-in features, new exports
- **Major** (`x.0.0`): breaking changes to public API

### Public API surface

All named exports from: `flint`, `flint/budget`, `flint/errors`, `flint/compress`, `flint/recipes`, `flint/memory`, `flint/rag`, `flint/safety`, `flint/testing`, `@flint/adapter-anthropic`, `@flint/adapter-openai-compat`, `@flint/graph`, `@flint/landlord`.

TypeScript shapes of: `ProviderAdapter`, `NormalizedRequest`, `NormalizedResponse`, `StreamChunk`, `Message`, `Tool`, `Result`, `Usage`, `StopReason`.

### Not public API

Internal file paths, the `raw` field on `NormalizedResponse`, anything not in the above list.
