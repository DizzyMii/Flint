import type { WorkflowEvent } from './types.ts';

export type EventSink = (event: WorkflowEvent) => void;

export class EventEmitter {
  private readonly events: WorkflowEvent[] = [];

  constructor(private readonly sink?: EventSink) {}

  emit(event: WorkflowEvent): void {
    this.events.push(event);
    this.sink?.(event);
  }

  all(): WorkflowEvent[] {
    return this.events;
  }
}
