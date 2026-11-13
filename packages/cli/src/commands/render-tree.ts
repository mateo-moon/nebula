import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parse, parseAllDocuments } from "yaml";

export interface RenderTreeOptions {
  /** ROOT:OUT:REVISION, once per tree. */
  side: string[];
  /** Directories under each root whose `index.ts` entries are rendered (default: the root). */
  entries?: string[];
  /** A ConfigManagementPlugin file; otherwise it is read from `pluginEntry`. */
  plugin?: string;
  /** Entry directory, relative to the root, that renders the plugin ConfigMap. */
  pluginEntry?: string;
  /** Name of that ConfigMap (default argocd-cmp-nebula). */
  pluginConfigmap?: string;
  /** Directory put first on PATH. */
  bin?: string;
  /** JSON file with the renderer image's environment; the process environment otherwise. */
  imageEnv?: string;
  /** Extra NAME=VALUE environment for every render. */
  env?: string[];
  /** Read-only Docker config directory for renders that read private image metadata. */
  registryConfig?: string;
  /** Plugin environment variables an Application may carry besides ENTRY_FILE. */
  allowPluginEnv?: string[];
  jobs?: string;
}

interface Result { status: string; ms: number; stdout: Buffer; stderr: Buffer }
interface Entry { path: string; entry: string; apps: string[]; status: string; file: string }
interface Side { root: string; out: string; revision: string; index: Record<string, Entry>; ms: Record<string, number> }

const TIMEOUT_MS = 10 * 60 * 1000;
const IMAGE_KEYS = ["PATH", "HOME", "PNPM_HOME", "XDG_DATA_HOME", "npm_config_store_dir", "NPM_CONFIG_CACHE",
  "COREPACK_HOME", "HELM_CACHE_HOME", "HELM_CONFIG_HOME", "HELM_DATA_HOME", "NODE_VERSION", "YARN_VERSION"];

/** The renderer's environment: tool locations only, never the caller's credentials. */
export function renderEnvironment(image: Record<string, string | undefined>, options: Pick<RenderTreeOptions, "bin" | "env" | "registryConfig">): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    IMAGE_KEYS.filter(key => image[key] !== undefined).map(key => [key, image[key] as string]));
  if (options.bin) env.PATH = `${resolve(options.bin)}:${env.PATH}`;
  env.ARGOCD_EXEC_TIMEOUT = "10m";
  for (const pair of options.env ?? []) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`--env ${pair} is not NAME=VALUE`);
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  if (options.registryConfig !== undefined) {
    if (!isAbsolute(options.registryConfig)) throw new Error("Registry config must be an absolute directory");
    const file = join(options.registryConfig, "config.json");
    if (!statSync(file).isFile()) throw new Error("Registry config.json must be a file");
    accessSync(file, constants.R_OK);
    env.DOCKER_CONFIG = resolve(options.registryConfig);
  }
  return env;
}

const parseAll = (text: string): any[] => parseAllDocuments(text).map(d => d.toJS()).filter(d => d && typeof d === "object");

function entryDirs(dir: string): string[] {
  const found: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (!item.isDirectory() || ["node_modules", "dist", ".git", "target"].includes(item.name)) continue;
    const sub = join(dir, item.name);
    if (existsSync(join(sub, "index.ts"))) found.push(sub);
    found.push(...entryDirs(sub));
  }
  return found;
}

function scriptOf(step: { command?: string[]; args?: string[] }): string {
  const cmd = [...(step.command ?? []), ...(step.args ?? [])];
  if (cmd.length !== 3 || cmd[0] !== "/bin/sh" || cmd[1] !== "-c") throw new Error(`unsupported plugin step: ${JSON.stringify(step)}`);
  return cmd[2]!;
}

/**
 * Render every entry of one or more trees, and every plugin Application those
 * renders declare, with the init and generate scripts of the tree's own
 * ConfigManagementPlugin. Renders run `jobs` at a time, never two in one directory.
 */
export async function renderTree(options: RenderTreeOptions): Promise<void> {
  if (!options.side?.length) throw new Error("--side is required");
  if (!options.plugin && !options.pluginEntry) throw new Error("--plugin or --plugin-entry is required");
  const jobs = Number(options.jobs ?? availableParallelism());
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs ${options.jobs} is not a positive integer`);
  const sides: Side[] = options.side.map(spec => {
    const [root, out, revision] = spec.split(":");
    if (!root || !out || !revision) throw new Error(`--side ${spec} is not ROOT:OUT:REVISION`);
    return { root: resolve(root), out: resolve(out), revision, index: {}, ms: {} };
  });
  const prefix = (side: Side) => sides.length > 1 ? `${basename(side.out)} ` : "";
  const allowed = new Set(["ENTRY_FILE", ...(options.allowPluginEnv ?? [])]);
  const pluginConfigmap = options.pluginConfigmap ?? "argocd-cmp-nebula";
  const baseEnv = renderEnvironment(
    options.imageEnv ? JSON.parse(readFileSync(options.imageEnv, "utf8")) : process.env, options);
  // The sidecar runs as uid 999 with only the image and pod environment.
  const asSidecar = process.getuid?.() === 0 ? { uid: 999, gid: 0 } : {};
  console.error(`render env ${JSON.stringify(baseEnv)} as ${asSidecar.uid ?? process.getuid?.()}, ${jobs} jobs`);

  function run(script: string, cwd: string, env: Record<string, string>, label: string): Promise<Result> {
    const started = Date.now();
    return new Promise(done => {
      const child = spawn("/bin/sh", ["-c", script], { cwd, env: { ...baseEnv, ...env }, stdio: ["ignore", "pipe", "pipe"], ...asSidecar });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let error: NodeJS.ErrnoException | undefined, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, TIMEOUT_MS);
      child.stdout.on("data", chunk => stdout.push(chunk));
      child.stderr.on("data", chunk => stderr.push(chunk));
      child.on("error", e => { error = e; });
      child.on("close", code => {
        clearTimeout(timer);
        const ms = Date.now() - started;
        const status = error ? `error: ${error.code ?? error.message}` : timedOut ? "error: ETIMEDOUT" : code === 0 ? "ok" : `exit ${code}`;
        console.error(`${status.padEnd(8)} ${String(ms).padStart(7)}ms ${label}`);
        done({ status, ms, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    });
  }

  // At most `jobs` renders at once, and one at a time per directory: each writes its own dist/.
  const queue: { dir: string; task: () => Promise<Result>; done: (r: Result) => void; fail: (e: unknown) => void }[] = [];
  const busy = new Set<string>();
  const pooled = (dir: string, task: () => Promise<Result>) =>
    new Promise<Result>((done, fail) => { queue.push({ dir, task, done, fail }); drain(); });
  function drain(): void {
    for (let i = 0; busy.size < jobs && i < queue.length;) {
      if (busy.has(queue[i]!.dir)) { i++; continue; }
      const { dir, task, done, fail } = queue.splice(i, 1)[0]!;
      busy.add(dir);
      task().then(done, fail).finally(() => { busy.delete(dir); drain(); });
    }
  }

  async function loadPlugin(side: Side): Promise<string> {
    if (options.plugin) return readFileSync(options.plugin, "utf8");
    // Bootstrap: synthesize the entry that installs the plugin and read it from there.
    const outdir = join(tmpdir(), `render-tree-plugin-${process.pid}`);
    const boot = await run("npx tsx index.ts >&2", join(side.root, options.pluginEntry!), { CDK8S_OUTDIR: outdir }, `${prefix(side)}bootstrap ${options.pluginEntry}`);
    if (boot.status !== "ok") throw new Error(`${options.pluginEntry} bootstrap render failed:\n${boot.stderr}`);
    const docs = readdirSync(outdir).filter(f => f.endsWith(".yaml")).flatMap(f => parseAll(readFileSync(join(outdir, f), "utf8")));
    const cm = docs.find(d => d.kind === "ConfigMap" && d.metadata?.name === pluginConfigmap);
    if (!cm?.data?.["plugin.yaml"]) throw new Error(`${options.pluginEntry} renders no ${pluginConfigmap} plugin.yaml`);
    return cm.data["plugin.yaml"];
  }

  // The pool is sized by CPU; report the memory it took, to size the runner by.
  const memory = { anon: 0, current: 0 };
  const read = (file: string) => { try { return readFileSync(join("/sys/fs/cgroup", file), "utf8"); } catch { return ""; } };
  const sampler = read("memory.stat") ? setInterval(() => {
    memory.anon = Math.max(memory.anon, Number(read("memory.stat").match(/^anon (\d+)$/m)?.[1] ?? 0));
    memory.current = Math.max(memory.current, Number(read("memory.current")) || 0);
  }, 1000).unref() : null;

  const started = Date.now();
  for (const side of sides) {
    mkdirSync(join(side.out, "renders"), { recursive: true });
    const bootstrap = await run("pnpm install --frozen-lockfile --prefer-offline >&2", side.root, {}, `${prefix(side)}bootstrap install`);
    if (bootstrap.status !== "ok") {
      writeFileSync(join(side.out, "install.log"), bootstrap.stderr);
      throw new Error(`${side.root}: pnpm install --frozen-lockfile failed; see install.log`);
    }
  }
  const pluginYaml = await loadPlugin(sides[0]!);
  const plugin = parse(pluginYaml).spec;
  const initScript = scriptOf(plugin.init), generateScript = scriptOf(plugin.generate);
  for (const side of sides) {
    writeFileSync(join(side.out, "plugin.yaml"), pluginYaml);
    const init = await run(initScript, side.root, {}, `${prefix(side)}plugin init`);
    writeFileSync(join(side.out, "install.log"), init.stderr);
    if (init.status !== "ok") throw new Error(`${side.root}: plugin init failed; see install.log`);
  }

  const keyOf = (path: string, entry: string, inputs: Record<string, string>) => Object.keys(inputs).length
    ? `${path}#${entry}@${createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 12)}`
    : entry === "index.ts" ? path : `${path}#${entry}`;
  const fileOf = (key: string) => key.replace(/[/#]/g, "__");

  // The index entry is created when the render is first asked for, so index.json
  // lists entries and apps in the same order whatever order renders finish in.
  function render(side: Side, path: string, entry: string, app?: string, inputs: Record<string, string> = {}): Promise<void> | undefined {
    const key = keyOf(path, entry, inputs);
    const known = side.index[key];
    if (known) { if (app && !known.apps.includes(app)) known.apps.push(app); return; }
    const item: Entry = side.index[key] = { path, entry, apps: app ? [app] : [], status: "pending", file: `${fileOf(key)}.yaml` };
    const dir = resolve(side.root, path);
    const env = {
      ARGOCD_ENV_ENTRY_FILE: entry,
      ARGOCD_APP_NAMESPACE: "argocd",
      ARGOCD_APP_REVISION: side.revision,
      ARGOCD_APP_SOURCE_PATH: path,
      ARGOCD_APP_SOURCE_TARGET_REVISION: "main",
      ...inputs,
    };
    const missing = !dir.startsWith(`${side.root}/`) || !existsSync(dir) || !statSync(dir).isDirectory();
    return (missing
      ? Promise.resolve<Result>({ status: "missing path", ms: 0, stdout: Buffer.alloc(0), stderr: Buffer.from(`no directory ${path} in the tree\n`) })
      : pooled(dir, () => run(generateScript, dir, env, `${prefix(side)}${key}`))
    ).then(result => {
      writeFileSync(join(side.out, "renders", item.file), result.stdout);
      writeFileSync(join(side.out, "renders", `${fileOf(key)}.log`), result.stderr);
      item.status = result.status;
      side.ms[key] = result.ms;
    });
  }

  async function renderSide(side: Side): Promise<void> {
    const roots = (options.entries?.length ? options.entries : ["."]).map(dir => join(side.root, dir)).filter(dir => existsSync(dir));
    await Promise.all(roots.flatMap(entryDirs).sort().map(dir => render(side, relative(side.root, dir), "index.ts")));
    // Every plugin Application any render declares is rendered too, keyed by path.
    const seen = new Set<string>();
    for (let changed = true; changed;) {
      changed = false;
      const pending: (Promise<void> | undefined)[] = [];
      for (const key of Object.keys(side.index).sort()) {
        if (seen.has(key)) continue;
        seen.add(key);
        changed = true;
        const item = side.index[key]!;
        const docs = item.status === "ok" ? parseAll(readFileSync(join(side.out, "renders", item.file), "utf8")) : [];
        for (const application of docs.filter(d => d.kind === "Application" && d.apiVersion?.startsWith("argoproj.io/"))) {
          const sources: any[] = application.spec?.sources ?? (application.spec?.source ? [application.spec.source] : []);
          for (const source of sources.filter(s => s.plugin)) {
            const env: { name: string; value?: unknown }[] = source.plugin.env ?? [];
            const other = env.filter(e => !allowed.has(e.name)).map(e => e.name);
            if (other.length) throw new Error(`${application.metadata.name}: plugin env ${other} is not rendered; allow it with --allow-plugin-env`);
            const entry = (env.find(e => e.name === "ENTRY_FILE")?.value as string | undefined) ?? "index.ts";
            const inputs = Object.fromEntries(env.filter(e => e.name !== "ENTRY_FILE")
              .sort((a, b) => a.name.localeCompare(b.name)).map(e => {
                if (typeof e.value !== "string") throw new Error(`${application.metadata.name}: invalid plugin env ${e.name}`);
                return [`ARGOCD_ENV_${e.name}`, e.value];
              }));
            pending.push(render(side, source.path.replace(/\/+$/, ""), entry, application.metadata.name, inputs));
          }
        }
      }
      await Promise.all(pending);
    }
    writeFileSync(join(side.out, "index.json"), JSON.stringify(side.index, null, 1) + "\n");
    writeFileSync(join(side.out, "timings.json"), JSON.stringify(side.ms, null, 1) + "\n");
    const failed = Object.values(side.index).filter(v => v.status !== "ok");
    console.error(`${prefix(side)}rendered ${Object.keys(side.index).length} entries, ${failed.length} failed`);
  }

  await Promise.all(sides.map(renderSide));
  if (sampler) {
    clearInterval(sampler);
    const mib = (bytes: number) => `${Math.round(bytes / 2 ** 20)} MiB`, max = read("memory.max").trim();
    console.error(`cgroup memory, highest sample: anon ${mib(memory.anon)}, with page cache ${mib(memory.current)}, limit ${/^\d+$/.test(max) ? mib(Number(max)) : max || "unknown"}`);
  }
  console.error(`rendered ${sides.length} tree(s) with ${jobs} jobs in ${Date.now() - started}ms`);
}
