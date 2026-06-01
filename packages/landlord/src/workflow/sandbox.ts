import { WorkflowError } from './errors.ts';

function forbidden(name: string): never {
  throw new WorkflowError(
    `${name} is not available inside a workflow script (nondeterministic or host access)`,
    'workflow.sandbox',
  );
}

function blockedCallable(name: string): unknown {
  const fn = (): never => forbidden(name);
  return new Proxy(fn, {
    apply: () => forbidden(name),
    construct: () => forbidden(name),
    get: (_t, prop) => {
      if (prop === 'prototype') return undefined;
      return () => forbidden(name);
    },
  });
}

export function sandboxBindings(): Record<string, unknown> {
  const safeMath = new Proxy(Math, {
    get: (target, prop) => {
      if (prop === 'random') return () => forbidden('Math.random');
      return Reflect.get(target, prop);
    },
  });
  return {
    Date: blockedCallable('Date'),
    Math: safeMath,
    process: blockedCallable('process'),
    require: blockedCallable('require'),
    globalThis: blockedCallable('globalThis'),
    global: blockedCallable('global'),
    fs: blockedCallable('fs'),
    eval: blockedCallable('eval'),
    Function: blockedCallable('Function'),
  };
}
