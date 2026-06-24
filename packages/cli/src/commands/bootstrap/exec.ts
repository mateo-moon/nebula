/**
 * No-shell process execution primitives shared by the bootstrap providers and
 * the `apply` command.
 *
 * Everything runs via {@link run} / {@link kubectl}, which use `execFileSync`
 * (argv, **no /bin/sh**). Interpolated values are passed as distinct argv
 * elements and are therefore never interpreted by a shell, which closes the
 * command-injection surface (a PR-influenced `config.ts` project id, a K8s API
 * status string, a `--name` flag, etc. can no longer break out of the argument).
 *
 * This module is a deliberate leaf (no imports from `shared` or `apply`) so that
 * `apply` can depend on it without creating an import cycle (`shared` imports
 * `apply` for `synthAndApply`).
 */
import { execFileSync } from "node:child_process";

export function log(msg: string): void {
  console.log(msg);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunOptions {
  /**
   * Pipe stdio (capture stdout/suppress inherited output) instead of inheriting
   * the parent TTY. Does NOT by itself suppress errors — pair with
   * `ignoreErrors` for probe-style calls.
   */
  silent?: boolean;
  /** Return `error.stdout || ""` on non-zero exit instead of throwing. */
  ignoreErrors?: boolean;
  /** Stdin for the child. */
  input?: string;
  /** Env merged over `process.env` (used to inject KUBECONFIG). */
  env?: NodeJS.ProcessEnv;
  /** Working directory. */
  cwd?: string;
  /** Kill the child after this many ms. */
  timeoutMs?: number;
}

/**
 * Run `bin args[]` with **no shell**. On success returns stdout. On non-zero
 * exit: if `ignoreErrors`, returns `error.stdout || ""` (probe-friendly);
 * otherwise throws an Error that **includes stderr + stdout** so diagnostics are
 * not silently discarded.
 */
export function run(bin: string, args: string[], options: RunOptions = {}): string {
  try {
    return execFileSync(bin, args, {
      encoding: "utf-8",
      stdio: options.silent
        ? ["pipe", "pipe", "pipe"]
        : ["inherit", "inherit", "inherit"],
      input: options.input,
      env: options.env,
      cwd: options.cwd,
      timeout: options.timeoutMs,
    }) as string;
  } catch (error: any) {
    if (options.ignoreErrors) {
      return (error.stdout ?? "").toString();
    }
    const stderr = (error.stderr ?? "").toString().trim();
    const stdout = (error.stdout ?? "").toString().trim();
    throw new Error(
      `${bin} ${args.join(" ")} failed (exit ${error.status ?? "?"})` +
        (stderr ? `\nstderr: ${stderr}` : "") +
        (stdout ? `\nstdout: ${stdout}` : ""),
    );
  }
}

/** Env with `KUBECONFIG` pointed at `kubeconfig` (or `process.env` unchanged). */
export function kcEnv(kubeconfig?: string): NodeJS.ProcessEnv | undefined {
  return kubeconfig ? { ...process.env, KUBECONFIG: kubeconfig } : undefined;
}

export interface KubectlOptions {
  /** Target this kubeconfig via env (replaces the old `KUBECONFIG=... ` shell prefix). */
  kubeconfig?: string;
  silent?: boolean;
  ignoreErrors?: boolean;
  input?: string;
  timeoutMs?: number;
}

/** `kubectl` with no shell; targets `kubeconfig` via env (no shell prefix string). */
export function kubectl(args: string[], options: KubectlOptions = {}): string {
  return run("kubectl", args, {
    silent: options.silent,
    ignoreErrors: options.ignoreErrors,
    input: options.input,
    env: kcEnv(options.kubeconfig),
    timeoutMs: options.timeoutMs,
  });
}

/** True if `cmd` is on PATH. */
export function commandExists(cmd: string): boolean {
  return run("which", [cmd], { silent: true, ignoreErrors: true }).trim().length > 0;
}

export interface WaitForOptions {
  /** What is being waited for (used in timeout/progress messages). */
  label: string;
  /** Deadline in milliseconds. */
  timeoutMs: number;
  /** Poll interval (default 5s). */
  intervalMs?: number;
  /** Behavior when the deadline elapses. */
  onTimeout?: "throw" | "warn" | "continue";
}

/**
 * Poll `check` until it returns true or the deadline elapses. `check` may log
 * its own progress and may throw (transient probe failures are tolerated). The
 * intentional throw/warn/silent difference between waiters becomes `onTimeout`.
 */
export async function waitFor(
  opts: WaitForOptions,
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 5000;
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      if (await check()) return;
    } catch {
      // transient probe failure — keep waiting
    }
    await sleep(intervalMs);
  }
  const onTimeout = opts.onTimeout ?? "warn";
  if (onTimeout === "throw") {
    throw new Error(
      `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ${opts.label}`,
    );
  }
  if (onTimeout === "warn") {
    log(`   ⚠️  Timed out waiting for ${opts.label}, continuing...`);
  }
}
