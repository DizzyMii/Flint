// test/workflow/events.test.ts
import { describe, expect, it } from 'vitest';
import { EventEmitter } from '../../src/workflow/events.ts';
import type { WorkflowEvent } from '../../src/workflow/types.ts';

describe('EventEmitter', () => {
  it('records events and forwards them to the sink', () => {
    const seen: WorkflowEvent[] = [];
    const em = new EventEmitter((e) => seen.push(e));
    em.emit({ type: 'log', message: 'hi' });
    em.emit({ type: 'phase_started', title: 'Find' });
    expect(seen).toHaveLength(2);
    expect(em.all().map((e) => e.type)).toEqual(['log', 'phase_started']);
  });

  it('works with no sink', () => {
    const em = new EventEmitter();
    em.emit({ type: 'log', message: 'x' });
    expect(em.all()).toHaveLength(1);
  });
});
