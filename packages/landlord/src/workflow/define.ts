// src/workflow/define.ts
import { MetaError } from './errors.ts';
import type { WorkflowModule } from './types.ts';

export function defineWorkflow(def: WorkflowModule): WorkflowModule {
  if (
    def.meta === undefined ||
    typeof def.meta.name !== 'string' ||
    typeof def.meta.description !== 'string'
  ) {
    throw new MetaError('defineWorkflow requires meta with string name and description');
  }
  if (typeof def.run !== 'function') {
    throw new MetaError('defineWorkflow requires a run function');
  }
  return def;
}
