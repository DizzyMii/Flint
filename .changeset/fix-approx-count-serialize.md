---
"flint": patch
---

Harden `approxCount` (and the `count` fallback) against non-serializable tool-call arguments. `JSON.stringify` could throw on circular references or `BigInt` values, or return `undefined` for a bare `undefined`, crashing a pure token estimate. Such arguments now contribute 0 tokens instead of throwing.
