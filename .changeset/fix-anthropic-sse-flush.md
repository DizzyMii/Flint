---
"@flint/adapter-anthropic": patch
---

Flush the trailing SSE buffer when the stream closes. The Anthropic adapter's `parseSSE` only emitted events split on `\n\n`, so a final event (such as `message_stop`) that arrives without a trailing blank line was left in the buffer and silently dropped — preventing the terminal `usage`/`end` chunks from being yielded. This mirrors the flush already performed by the OpenAI-compat adapter.
