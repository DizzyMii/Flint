---
"flint": patch
---

Fix `ConversationMemory.append` type signature: it was declared as returning `void` but the implementation is `async` and performs summarization. The interface now correctly returns `Promise<void>` so callers don't silently drop the promise.
