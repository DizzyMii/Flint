# count()

Count tokens in a message array.

`count()` delegates to the adapter's token counter when available, and falls back to `approxCount()` — a heuristic based on character length — when the adapter does not implement counting.

## Signature

```ts
function count(
  messages: Message[],
  model: string,
  adapter?: ProviderAdapter
): number
```

## Parameters

| Parameter | Type | Description |
|---|---|---|
| `messages` | `Message[]` | Messages to count |
| `model` | `string` | Model identifier (affects tokenization for some adapters) |
| `adapter` | `ProviderAdapter` | Optional — if provided, uses `adapter.count()` when available |

## Return value

`number` — estimated token count. When no adapter is provided, uses the built-in heuristic (`~chars / 4`).

## Example

```ts
import { count } from 'flint';

const messages = [
  { role: 'user' as const, content: 'What is the capital of France?' },
];

const tokens = count(messages, 'claude-opus-4-7');
console.log(tokens); // approximate count
```

## approxCount

When you only need a rough estimate without an adapter:

```ts
import { approxCount } from 'flint';

const n = approxCount(messages);
```

`approxCount` uses `chars / 4` as a heuristic. It is fast and has no dependencies, but is not accurate for all languages and models.

## See also

- [Budget](/features/budget) — enforce token limits
- [Compress & Pipeline](/features/compress) — reduce token count before sending
