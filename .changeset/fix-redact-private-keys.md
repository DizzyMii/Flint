---
"flint": patch
---

Broaden the private-key pattern in the `secretPatterns` redaction preset. The previous regex only matched key types made of uppercase letters and spaces, so it missed the most common modern formats — generic PKCS#8 `-----BEGIN PRIVATE KEY-----` (no type word), `ENCRYPTED PRIVATE KEY`, and types containing digits or hyphens. These are now redacted.
