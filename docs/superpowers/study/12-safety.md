# 12 — Safety

**Source:** `packages/flint/src/safety/`

**See also:** Doc 01 (Tool, ToolPermissions, ContentPart), Doc 02 (FlintError — tool.approval_denied)

---

## detect-injection

### Patterns

`injectionPatterns` is a static array of `{ name, regex }` objects. Every pattern uses the `i` flag; most also use `\b` word-boundary anchors to avoid false positives on substrings.

**1. `ignore_instructions`**

```
/\bignore\s+(?:all\s+|previous\s+|above\s+)?(?:prior\s+)?(?:instructions?|rules?|prompts?)\b/i
```

Catches phrasing like "ignore all previous instructions", "ignore rules", "ignore prior prompts". The nested optional groups handle the common variations without needing multiple patterns. `\s+` rather than a literal space is required because attackers frequently insert Unicode spaces or soft hyphens to evade literal matching.

**2. `override_role`**

```
/\byou\s+are\s+now\s+(?:a|an)\b/i
```

Targets the canonical jailbreak opener "you are now a [character]". The `(?:a|an)` forces the article to be present, reducing false positives on legitimate "you are now connected" type sentences.

**3. `system_preamble`**

```
/^\s*(?:system|assistant|user)\s*:\s*/im
```

The `m` flag makes `^` match the start of any line, not just the string. Catches fake role headers like `System:` or `assistant:` injected into user content to simulate a multi-turn transcript being prepended to the real prompt.

**4. `role_confusion`**

```
/<\|?(?:im_start|im_end|system|user|assistant)\|?>/i
```

Targets the special delimiters used by ChatML-format prompts: `<|im_start|>`, `<|im_end|>`, `<system>`, etc. An attacker who knows the model was fine-tuned on ChatML can smuggle these tokens to escape the user turn.

**5. `bypass_safety`**

```
/\b(?:bypass|disable|turn\s+off|jailbreak)\s+(?:safety|filter|restriction|guardrail)/i
```

Catches explicit phrases naming the act of circumventing safety controls. "turn off" is split with `\s+` to handle "turn  off" with extra whitespace.

**6. `leak_prompt`**

```
/\b(?:reveal|show|print|dump|repeat)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?)/i
```

Targets prompt-extraction commands. `(?:system\s+)?` makes the word "system" optional so both "repeat your instructions" and "reveal the system prompt" match. `instructions?` handles singular and plural.

**7. `untrusted_tag_forgery`**

```
/<\/?\s*untrusted\b[^>]*>/i
```

Catches attempts to forge the `<untrusted>` wrapper tags that the `boundary` module uses to delimit untrusted content. Without this pattern, an attacker could inject a closing `</untrusted>` tag inside their content to escape the untrusted block and have subsequent text treated as trusted. `<\/?` matches both open and close tags; `\b[^>]*` allows for attributes (including a forged nonce attempt). The `\s*` between `<\/?` and the tag name catches obfuscation attempts that insert whitespace after the slash — for example `< /untrusted>` or `</ untrusted>` — spacing variations that a naive `<\/untrusted` literal would miss.

### Snippet context window

```ts
const SNIPPET_CONTEXT = 20;
const start = Math.max(0, match.index - SNIPPET_CONTEXT);
const end = Math.min(text.length, match.index + match[0].length + SNIPPET_CONTEXT);
```

20 characters is enough to show what surrounds the matched phrase without exposing a meaningful portion of a long system prompt. At 20 chars the snippet is sufficient for a log entry or audit display; at 50+ it risks leaking sensitive prompt content to the consumer of the detection result.

### Return shape — all matches, not first

`detectPromptInjection` iterates every pattern with `regex.exec` (stateless; each call starts from index 0 on a non-`g` regex — if any pattern carried the `g` flag, calling `regex.exec` or `test` on the same regex object across invocations would advance `lastIndex`, causing the pattern to silently skip matches on subsequent calls and requiring a manual `lastIndex = 0` reset before each use; by omitting `g`, the patterns are always stateless and safe to call any number of times without resetting) and appends to `matches` for each hit. The function returns `{ detected: boolean, matches: InjectionMatch[] }` where `matches` contains every pattern that fired, not just the first. The design rationale: a caller blocking on `detected` gets a simple boolean gate; a caller building an audit log or explainability UI gets the full list of attack vectors present. Stopping at the first match would hide compound attacks (an input that combines `ignore_instructions` with `leak_prompt`) and make logging incomplete.

---

## redact

### `redactString`

```ts
function redactString(s: string, patterns: RegExp[], replacement: string): string {
  return patterns.reduce((acc, p) => acc.replace(p, replacement), s);
}
```

A left fold over the patterns array. Each iteration produces a new string with that pattern's matches replaced; the result feeds into the next iteration. Because all `secretPatterns` use the `g` flag, `String.prototype.replace` replaces all occurrences globally. The fold approach means patterns are applied sequentially and independently — a later pattern can match text that was not touched by earlier patterns, which is correct behaviour for non-overlapping secret types.

### `redactMessage`

`redactMessage` dispatches on `typeof msg.content`. When content is `string` (system, assistant, tool roles), it calls `redactString` directly. When content is `ContentPart[]` (user role only), it maps over the array: `text` parts pass their `.text` field through `redactString`; all other part types (image, image_b64) are passed through unchanged. Image parts carry URLs or base64 blobs and are left unchanged. Running regex over a base64-encoded blob is ineffective because encoding transforms each token's character sequence, breaking pattern matching against the original bytes. It is also potentially destructive: a partial replacement inside a base64 string would corrupt the encoding. The `secretPatterns` are designed for inline text tokens and are simply not applicable to binary-encoded data.

### `secretPatterns`

| Pattern | What it catches |
|---|---|
| `/sk-[a-zA-Z0-9]{32,}/g` | OpenAI API keys (`sk-` prefix, 32+ alphanumeric chars) |
| `/sk-ant-[a-zA-Z0-9_-]{32,}/g` | Anthropic API keys (`sk-ant-` prefix) |
| `/AKIA[0-9A-Z]{16}/g` | AWS access key IDs (`AKIA` prefix, 16 uppercase alphanumeric) |
| `/ghp_[a-zA-Z0-9]{36}/g` | GitHub personal access tokens (`ghp_`) |
| `/ghs_[a-zA-Z0-9]{36}/g` | GitHub server-to-server tokens (`ghs_`) |
| `/gho_[a-zA-Z0-9]{36}/g` | GitHub OAuth tokens (`gho_`) |
| `/xox[baprs]-[a-zA-Z0-9-]{10,}/g` | Slack tokens: bot (`xoxb`), app (`xoxa`), post (`xoxp`), refresh (`xoxr`), secret (`xoxs`) |
| `/sk_(?:live\|test)_[a-zA-Z0-9]{24,}/g` | Stripe secret keys (live and test modes) |
| `/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g` | PEM-encoded private keys (RSA, EC, etc.); `[\s\S]+?` matches across newlines non-greedily to handle concatenated keys in a single string |
| `/\b\d{3}-\d{2}-\d{4}\b/g` | US Social Security Numbers in `NNN-NN-NNNN` format |
| `/\b(?:\d{4}[\s-]?){3}\d{4}\b/g` | Credit card numbers: 16 digits optionally separated by spaces or hyphens in groups of 4 |

### Why `redact` is a Transform

```ts
export function redact(opts: RedactOptions): Transform {
  const replacement = opts.replacement ?? '[REDACTED]';
  return async (messages) => messages.map((m) => redactMessage(m, opts.patterns, replacement));
}
```

`Transform` is the type used by the compress pipeline (Doc 08). A `Transform` is `(messages: Message[]) => Promise<Message[]>`. Returning a `Transform` from `redact` means it can be passed directly to `pipeline()` alongside compression and summarisation transforms without any adapter code. The caller composes safety and compression in a single pipeline call; the runtime invokes them in order before each inference request.

The returned function is declared `async` even though there is no `await` inside it. The reason is purely type-mechanical: `Transform` requires a `Promise<Message[]>` return type, and marking the function `async` automatically wraps the synchronous `Array.prototype.map` result in a `Promise`. Without `async`, the return type would be `Message[]`, which does not satisfy `Transform` — the alternative would be an explicit `Promise.resolve(messages.map(...))` wrapper. Using `async` is the cleaner way to satisfy the type contract without adding visual noise.

---

## permissioned-tools

### Filter chain

```ts
export function permissionedTools(tools: Tool[], opts: PermissionedToolsOptions): Tool[] {
  return tools.filter((t) => {
    if (opts.allow && !opts.allow.includes(t.name)) return false;  // 1
    if (opts.deny?.includes(t.name)) return false;                  // 2
    if (opts.requireScopes) {                                        // 3
      const scopes = t.permissions?.scopes ?? [];
      if (!opts.requireScopes.every((s) => scopes.includes(s))) return false;
    }
    if (opts.filter && !opts.filter(t)) return false;               // 4
    return true;
  });
}
```

All four checks are applied in sequence within a single `Array.prototype.filter` predicate. They are ordered from coarsest (name-based policy) to finest (arbitrary predicate), and each is independently skipped when its option is absent.

**Step 1 — `allow` whitelist.** If `allow` is defined, the tool's name must appear in the list. An absent `allow` option means all names pass this step. The whitelist is the first gate because it can immediately discard every tool not explicitly listed, making the subsequent checks cheaper.

**Step 2 — `deny` blacklist.** If `deny` is defined and contains the tool's name, the tool is rejected. `deny` is checked after `allow`; a tool on both lists is blocked by `deny`. The optional-chaining call `opts.deny?.includes(t.name)` short-circuits when `deny` is absent.

**Step 3 — `requireScopes`.** When defined, every string in `requireScopes` must appear in `tool.permissions.scopes`. If the tool has no `permissions` object at all, `scopes` defaults to `[]` and the check fails — a tool without declared permissions cannot satisfy any scope requirement. This is the correct fail-closed behaviour: an undeclared tool should not gain access to a scoped context.

**Step 4 — custom `filter` predicate.** The last step is a caller-supplied `(tool: Tool) => boolean`. It runs after all policy and capability checks so it can inspect the full tool definition including permissions, and it does not need to replicate allow/deny logic. Typical uses: filtering by `tool.permissions.destructive`, filtering by a computed attribute not captured in the option fields.

**Why all four applied in order rather than short-circuiting at first pass.** Each layer is conceptually independent: `allow`/`deny` is named-tool policy set by the deployment operator; `requireScopes` is capability-based access control derived from the tool's own declared permissions; `filter` is arbitrary runtime logic. Collapsing them would prevent callers from using, say, `deny` without `allow`, or `filter` without scope requirements. The sequential application also makes the rejection reason predictable — a tool fails at the first check it cannot satisfy, which is easy to reason about in audits.

---

## require-approval

### Wrapping a tool

`requireApproval<Input, Output>(t, opts)` returns a new `Tool<Input, Output>` that is structurally identical to `t` except for two differences: `handler` is replaced with `wrappedHandler`, and `permissions.requireApproval` is set to `true`. Setting the flag on the returned tool lets `permissionedTools` and any UI layer detect that this tool demands human confirmation without inspecting the handler.

### Approval context

`ApprovalContext<Input>` carries `{ tool: Tool<Input>, input: Input }`. The `onApprove` callback receives this context so it has everything needed to surface a human-readable confirmation request: the tool's name and description, and the exact input that will be executed if approved. `ApprovalResult` is `boolean | { approved: boolean; reason?: string }`. The handler normalises both to `{ approved, reason }` immediately after resolution.

### `Promise.race` and timeout

```ts
const approvalPromise = opts.onApprove({ tool: t, input });
const timeoutPromise = new Promise<ApprovalResult>((resolve) => {
  timeoutId = setTimeout(
    () => resolve({ approved: false, reason: 'Approval timed out' }),
    timeoutMs,
  );
});
const raw = await Promise.race<ApprovalResult>([approvalPromise, timeoutPromise]);
```

Default timeout is `5 * 60 * 1000` ms (5 minutes). The timeout promise resolves — it does not reject. `Promise.race` therefore always resolves; the `await` never throws from the race itself. This is a deliberate design: the timeout is a policy outcome (denied), not an error condition that should propagate as an exception. The calling code can treat timeout-denial identically to human-denial.

### Denial path

```ts
if (!result.approved) {
  throw new FlintError(
    `Tool "${t.name}" approval denied${result.reason ? `: ${result.reason}` : ''}`,
    { code: 'tool.approval_denied' },
  );
}
```

Denial throws `FlintError` with code `tool.approval_denied`. The agent loop catches this as a `ToolError` (Doc 02) and propagates it back to the model as a tool result message, allowing the model to inform the user or try an alternative. Throwing rather than returning an error-shaped object ensures the agent infrastructure that already handles `ToolError` exceptions handles approval denial without needing a new code path.

### `clearTimeout` in finally

```ts
} finally {
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId);
  }
}
```

The `finally` block unconditionally cancels the timer. If `onApprove` resolves before the timeout, the timeout handle is cleared so the timer callback never fires. Without this, the Node event loop stays alive until the timer expires even if the rest of the execution has completed, and in environments with hot-reload or test isolation the lingering callback can fire into a torn-down context. The most immediate practical consequence is in test environments (Jest, Vitest): an uncleared timer keeps the worker process alive after the test suite finishes, causing a "A worker process has failed to exit gracefully" hang that requires force-killing the process.

---

## boundary / untrusted

### `randomNonce(8)`

```ts
function randomNonce(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
```

Called with `bytes = 8`, producing a 16-character lowercase hex string representing 64 bits of randomness. `crypto.getRandomValues` is the Web Crypto API available in all modern runtimes (Node 19+, Deno, Bun, browsers). 8 bytes (64 bits) is sufficient to make nonce forgery computationally infeasible for the lifetime of a single agent session: an attacker in untrusted content would need to guess the nonce to forge a valid `<untrusted nonce="X">` tag, and with 2^64 possible values and a session measured in seconds to minutes, brute force is not viable. Using `crypto.getRandomValues` rather than `Math.random` ensures the nonce is cryptographically unpredictable even if the attacker can observe timing or seed the PRNG.

### `untrusted(content, opts?)`

```ts
export function untrusted(content: string, opts?: UntrustedOptions): string {
  const nonce = randomNonce(8);
  const label = opts?.label ?? 'untrusted';
  return `<${label} nonce="${nonce}">\n${content}\n</${label} nonce="${nonce}">`;
}
```

Generates a fresh nonce per call and wraps content in matching open and close tags with the nonce as an attribute on both. The close tag repeats the nonce attribute to make it maximally difficult to forge a valid pair: an attacker would need to know the nonce to close the block, and cannot close it by injecting a nonce-free `</untrusted>` tag (that would be caught by the `untrusted_tag_forgery` detection pattern). The `label` option allows the tag name to be customised when needed, though the detect-injection pattern is hardcoded to `untrusted`. This means that if a caller uses a custom `label`, the hardcoded `untrusted_tag_forgery` pattern will not catch forgery attempts against that custom tag. Callers using custom labels in injection-sensitive contexts should either stick to the default `'untrusted'` label or add a parallel `detect-injection` pattern that targets their custom label.

### `boundary(opts)`

```ts
export function boundary(
  opts: BoundaryOptions,
): [Message & { role: 'system' }, Message & { role: 'user' }] {
  return [
    { role: 'system', content: opts.trusted },
    { role: 'user', content: untrusted(opts.untrusted) },
  ];
}
```

`BoundaryOptions` has two fields: `trusted: string` (the system prompt / trusted instructions) and `untrusted: string` (externally sourced content — user input, scraped data, tool output from the web). `boundary` returns a two-element tuple `[systemMessage, userMessage]` that the caller splices directly into the message history. The system message carries the trusted instructions unchanged. The user message wraps the untrusted content with `untrusted()`, which internally calls `randomNonce(8)` to generate a per-call nonce.

### Why nonce prevents tag-forgery injection

The `untrusted_tag_forgery` detect-injection pattern flags any `<untrusted ...>` tag appearing in raw input before wrapping. After wrapping, the legitimate tags have the real nonce embedded. An attacker whose input is in `opts.untrusted` cannot forge a closing `</untrusted nonce="X">` tag that matches the real nonce (they do not know X at the time they craft their payload). They also cannot inject a nonce-free `</untrusted>` tag because the detect-injection guard fires on it. The system message communicates the trust model to the model: content appearing inside the `<untrusted>` block is externally sourced and should be treated as data, not instructions. Content outside the block (the system message itself) is authoritative. This gives the model a structural signal — tag presence with a specific nonce — that is computationally infeasible to replicate from within the sandboxed content.
