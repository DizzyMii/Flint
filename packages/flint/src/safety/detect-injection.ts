export type InjectionPattern = {
  name: string;
  regex: RegExp;
};

export type InjectionMatch = {
  pattern: string;
  snippet: string;
};

export type InjectionDetectionResult = {
  detected: boolean;
  matches: InjectionMatch[];
};

export const injectionPatterns: InjectionPattern[] = [
  {
    name: 'ignore_instructions',
    regex: /\bignore\s+(?:all\s+|previous\s+|above\s+)?(?:prior\s+)?(?:instructions?|rules?|prompts?)\b/i,
  },
  {
    name: 'override_role',
    regex: /\byou\s+are\s+now\s+(?:a|an)\b/i,
  },
  {
    name: 'system_preamble',
    regex: /^\s*(?:system|assistant|user)\s*:\s*/im,
  },
  {
    name: 'role_confusion',
    regex: /<\|?(?:im_start|im_end|system|user|assistant)\|?>/i,
  },
  {
    name: 'bypass_safety',
    regex: /\b(?:bypass|disable|turn\s+off|jailbreak)\s+(?:safety|filter|restriction|guardrail)/i,
  },
  {
    name: 'leak_prompt',
    regex: /\b(?:reveal|show|print|dump|repeat)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?)/i,
  },
  {
    name: 'untrusted_tag_forgery',
    regex: /<\/?\s*untrusted\b[^>]*>/i,
  },
];

const SNIPPET_CONTEXT = 20;

export function detectPromptInjection(text: string): InjectionDetectionResult {
  const matches: InjectionMatch[] = [];
  for (const { name, regex } of injectionPatterns) {
    const match = regex.exec(text);
    if (match) {
      const start = Math.max(0, match.index - SNIPPET_CONTEXT);
      const end = Math.min(text.length, match.index + match[0].length + SNIPPET_CONTEXT);
      matches.push({ pattern: name, snippet: text.slice(start, end) });
    }
  }
  return { detected: matches.length > 0, matches };
}
