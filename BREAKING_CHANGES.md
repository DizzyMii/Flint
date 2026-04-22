# Breaking Changes

## v1.0.0 (from v0)

### adapter-openai-compat: count() removed from adapter surface

Previously `count` was a stub throwing `NotImplementedError`. It is now omitted. `flint`'s `count()` primitive falls back to `approxCount` automatically when `adapter.count` is `undefined`.

**Migration:** No action required if you use `import { count } from 'flint'`. Direct callers of `adapter.count(...)` should switch to `count(messages, model)` from `flint`.

### All packages: 0.0.0 -> 1.0.0

Versioning is synchronized via Changesets. Use `pnpm changeset` for any change affecting published behavior.
