# Breaking Changes

## Next minor (runtime hardening)

No API removals. Behaviour changes are listed in `.changeset/runtime-hardening.md` under "Behaviour changes to review when upgrading". The most likely to affect you:

- Anthropic prompt caching defaults to `'auto'`; default `max_tokens` is 16000.
- `maxDollars` now fails closed (`budget.unpriced`) when the adapter cannot price the model.
- `StopReason` includes `'refusal'`.
- `Usage.input` excludes cached tokens on every adapter.

## v1.0.0 (from v0)

### adapter-openai-compat: count() removed from adapter surface

Previously `count` was a stub throwing `NotImplementedError`. It is now omitted. `flint`'s `count()` primitive falls back to `approxCount` automatically when `adapter.count` is `undefined`.

**Migration:** No action required if you use `import { count } from 'flint'`. Direct callers of `adapter.count(...)` should switch to `count(messages, model)` from `flint`.

### All packages: 0.0.0 -> 1.0.0

Versioning is synchronized via Changesets. Use `pnpm changeset` for any change affecting published behavior.
