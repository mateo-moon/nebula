/**
 * Automation helpers operating on Pulumi Automation API Stacks.
 * Keeps only stack-based operations matching the new Environment/Project design.
 */
import type { Stack } from '@pulumi/pulumi/automation';

export type StackOp = 'preview' | 'up' | 'destroy' | 'refresh';

type BaseOpts = {
  onOutput?: (out: string) => void;
  color?: 'always' | 'never' | 'auto';
  target?: string[];
  /** Include dependent resources of the provided targets */
  targetDependents?: boolean;
};

export async function runStack(stack: Stack, op: StackOp, opts?: BaseOpts) {
  const io = { onOutput: opts?.onOutput || ((out: string) => process.stdout.write(out)) } as const;
  const base = {
    color: opts?.color || 'always',
    target: opts?.target,
    ...(opts?.targetDependents ? { targetDependents: true } : {}),
    ...io,
  } as const;

  const runWithSignals = async <T>(fn: () => Promise<T>): Promise<T> => {
    let cancelled = false;
    const cancelFn = async () => {
      if (cancelled) return;
      cancelled = true;
      try { process.stderr.write('\nSignal received. Cancelling current Pulumi operation...\n'); } catch {}
      try { await stack.cancel(); } catch {}
    };
    const add = () => { process.once('SIGINT', cancelFn); process.once('SIGTERM', cancelFn); };
    const remove = () => { process.removeListener('SIGINT', cancelFn); process.removeListener('SIGTERM', cancelFn); };
    add();
    try { return await fn(); }
    finally { remove(); }
  };

  if (op === 'preview') return await runWithSignals(() => stack.preview({ diff: true, ...base } as any));
  if (op === 'up') return await runWithSignals(() => stack.up({ ...base } as any));
  if (op === 'destroy') return await runWithSignals(() => stack.destroy({ ...base } as any));
  if (op === 'refresh') return await runWithSignals(() => stack.refresh({ ...base } as any));
  return; // satisfy all code paths
}

export async function previewStack(stack: Stack, opts?: BaseOpts) { return runStack(stack, 'preview', opts); }
export async function upStack(stack: Stack, opts?: BaseOpts) { return runStack(stack, 'up', opts); }
export async function destroyStack(stack: Stack, opts?: BaseOpts) { return runStack(stack, 'destroy', opts); }
export async function refreshStack(stack: Stack, opts?: BaseOpts) { return runStack(stack, 'refresh', opts); }