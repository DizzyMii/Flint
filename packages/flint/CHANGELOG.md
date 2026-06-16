# flint

## 0.0.1

### Patch Changes

- af3034d: Harden `approxCount` (and the `count` fallback) against non-serializable tool-call arguments. `JSON.stringify` could throw on circular references or `BigInt` values, or return `undefined` for a bare `undefined`, crashing a pure token estimate. Such arguments now contribute 0 tokens instead of throwing.
- cfda49e: Fix `ConversationMemory.append` type signature: it was declared as returning `void` but the implementation is `async` and performs summarization. The interface now correctly returns `Promise<void>` so callers don't silently drop the promise.
- 39a1bfe: Broaden the private-key pattern in the `secretPatterns` redaction preset. The previous regex only matched key types made of uppercase letters and spaces, so it missed the most common modern formats — generic PKCS#8 `-----BEGIN PRIVATE KEY-----` (no type word), `ENCRYPTED PRIVATE KEY`, and types containing digits or hyphens. These are now redacted.
