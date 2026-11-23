import type { Message } from './types.ts';

/**
 * A turn is the smallest unit a transform may drop or keep: an assistant message together with
 * the tool results answering its tool calls, or any other single message. Splitting a turn
 * produces a transcript that providers reject.
 */
export type Turn = { start: number; messages: Message[] };

export function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i] as Message;
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const ids = new Set(msg.toolCalls.map((c) => c.id));
      const turn: Message[] = [msg];
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j] as Message;
        if (next.role !== 'tool' || !ids.has(next.toolCallId)) break;
        turn.push(next);
        j++;
      }
      turns.push({ start: i, messages: turn });
      i = j;
      continue;
    }
    turns.push({ start: i, messages: [msg] });
    i++;
  }
  return turns;
}

export type TranscriptIssue = { index: number; problem: string };

/**
 * Structural problems a provider would reject: tool results without a matching earlier tool call,
 * duplicate results, and tool calls left unanswered before the conversation moves on. A trailing
 * assistant message with unanswered calls is allowed (the caller is about to execute them).
 */
export function checkTranscript(messages: Message[]): TranscriptIssue[] {
  const issues: TranscriptIssue[] = [];
  let pending = new Set<string>();
  let pendingFrom = -1;
  const answered = new Set<string>();
  messages.forEach((msg, index) => {
    if (msg.role === 'tool') {
      if (!pending.has(msg.toolCallId)) {
        issues.push({
          index,
          problem: answered.has(msg.toolCallId)
            ? `duplicate result for tool call "${msg.toolCallId}"`
            : `tool result "${msg.toolCallId}" has no matching tool call in the preceding assistant turn`,
        });
        return;
      }
      pending.delete(msg.toolCallId);
      answered.add(msg.toolCallId);
      return;
    }
    if (pending.size > 0) {
      issues.push({
        index: pendingFrom,
        problem: `tool call(s) ${[...pending].map((id) => `"${id}"`).join(', ')} have no result`,
      });
    }
    pending = new Set();
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      pending = new Set(msg.toolCalls.map((c) => c.id));
      pendingFrom = index;
    }
  });
  return issues;
}
