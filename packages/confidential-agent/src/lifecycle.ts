import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";

/** One lifetime for the agent's HTTP modules, readiness gate and native helper. */
export class AgentLifecycle {
  private readonly stop = new AbortController();
  private readonly cleanup: (() => Promise<void>)[] = [];
  private readonly pending = new Set<Promise<void>>();
  private finish!: (error?: Error) => void;
  private stopping?: Promise<void>;
  readonly closed = new Promise<Error | undefined>(resolve => { this.finish = resolve; });
  readonly signal = this.stop.signal;

  server(server: Server): void {
    if (this.signal.aborted) {
      const close = () => { server.closeAllConnections(); server.close(); };
      if (server.listening) close(); else server.once("listening", close);
      throw new Error("Agent is stopping");
    }
    server.once("error", () => { void this.close(new Error("Agent listener failed")); });
    this.cleanup.push(() => new Promise(resolve => {
      server.closeAllConnections();
      if (!server.listening) { server.close(); resolve(); }
      else server.close(() => resolve());
    }));
  }

  task(task: Promise<void>): void {
    this.pending.add(task);
    void task.catch(() => { if (!this.signal.aborted) void this.close(new Error("Agent module failed")); })
      .finally(() => this.pending.delete(task));
  }

  native(child: ChildProcess): void {
    if (this.signal.aborted) { child.kill("SIGTERM"); throw new Error("Agent is stopping"); }
    child.once("error", () => { void this.close(new Error("Native storage helper failed")); });
    child.once("exit", () => { if (!this.signal.aborted) void this.close(new Error("Native storage helper stopped")); });
    this.cleanup.unshift(() => new Promise<void>((resolve, reject) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timeout = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* PID 1 exit also closes its private namespace. */ }
        reject(new Error("Native storage helper did not stop"));
      }, 65_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      // After dropping UID the HTTP agent cannot signal a root-owned helper.
      // EOF on this inherited private channel requests shutdown without a
      // public control API or retaining a capability to kill other processes.
      if (child.stdin) { child.stdin.on("error", () => {}); child.stdin.end(); }
      else child.kill("SIGTERM");
    }));
  }

  close(error?: Error): Promise<void> {
    if (this.stopping) return this.stopping;
    let stopped!: () => void;
    this.stopping = new Promise(resolve => { stopped = resolve; });
    this.stop.abort();
    void (async () => {
      // Close public listeners before asking storage to release mount leases.
      for (const clean of [...this.cleanup].reverse()) {
        try { await clean(); } catch { error ??= new Error("Agent cleanup failed"); }
      }
      await Promise.allSettled([...this.pending]);
      this.finish(error);
      stopped();
    })();
    return this.stopping;
  }
}
