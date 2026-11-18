// Generate a standalone workerd config, optionally build first or serve it.
// Node/Miniflare are used during preparation only; the final server is workerd.
import { localPluginViewsOptions } from './tools/local-plugin-views.mjs';
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { createRequire } from "node:module";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";

try { process.loadEnvFile(".env"); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!["--build", "--serve"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
}
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const cronPort = Number(process.env.CRON_PORT ?? 8788);
if (![port, cronPort].every((n) => Number.isInteger(n) && n > 0 && n < 65536) || port === cronPort) {
  throw new Error("PORT and CRON_PORT must be different ports between 1 and 65535.");
}
const configPath = resolve("config.capnp");
const bundle = "dist/worker/index.js";
if (args.has("--build")) {
  execFileSync("node_modules/.bin/wrangler", ["deploy", "--dry-run", "--outdir", "dist/worker", "--config", "wrangler.toml"], { stdio: "inherit" });
}
if (!existsSync(bundle)) throw new Error(`No ${bundle}. Run node server-workerd.mjs --build first.`);
const config = unstable_readConfig({ config: "wrangler.toml" });
const { workerOptions } = unstable_getMiniflareWorkerOptions("wrangler.toml");
const localViews = localPluginViewsOptions();
workerOptions.serviceBindings = { ...workerOptions.serviceBindings, ...localViews.serviceBindings };
workerOptions.bindings = { ...workerOptions.bindings, ...localViews.bindings };

const canonical = (workerOptions.bindings?.CANONICAL_ORIGIN ?? "").trim().replace(/\/$/, "");
const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const publicOrigin = canonical && !loopback.has(new URL(canonical).hostname) ? canonical : "";
if (publicOrigin && new URL(publicOrigin).protocol !== "https:") throw new Error("Public CANONICAL_ORIGIN must use https.");
if (publicOrigin && !loopback.has(host)) console.warn("Restrict this port to your reverse proxy; it must set CF-Connecting-IP.");

// Ask the installed Miniflare to assemble its binding implementations. Its
// debug export contains the Worker sources, extensions and disk service paths.
// Replace Node-backed assets/Images before assembly, and discard the dev entry.
delete workerOptions.assets;
delete workerOptions.images;
workerOptions.serviceBindings = {
  ...workerOptions.serviceBindings,
  VIEWS: { disk: { path: resolve("dist/views") } },
};
const temp = mkdtempSync(join(tmpdir(), "cms-workerd-"));
const debugPath = join(temp, "config.json");
const previousDebug = process.env.MINIFLARE_WORKERD_CONFIG_DEBUG;
process.env.MINIFLARE_WORKERD_CONFIG_DEBUG = debugPath;
let assembled;
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ ...workerOptions, name: config.name, modules: [{ type: "ESModule", path: bundle }] }],
  host: "127.0.0.1", port: 0, cf: false,
  resourcePersistencePath: resolve(".wrangler/state/v3"),
}));
try {
  await mf.ready;
  assembled = JSON.parse(readFileSync(debugPath, "utf8"));
} finally {
  await mf.dispose();
  if (previousDebug === undefined) delete process.env.MINIFLARE_WORKERD_CONFIG_DEBUG;
  else process.env.MINIFLARE_WORKERD_CONFIG_DEBUG = previousDebug;
  rmSync(temp, { recursive: true, force: true });
}
const cms = `core:user:${config.name}`;
const worker = (source, bindings) => ({
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: ["service_binding_extra_handlers"],
  modules: [{ name: "main.js", esModule: source }], bindings,
});
const services = new Map(assembled.services.map((service) => [service.name, service]));
if (!services.has(cms)) throw new Error("Installed Miniflare changed its service naming; cannot export safely.");
const views = services.get(cms).worker.bindings.find((binding) => binding.name === "VIEWS");
if (!views?.service || !services.get(views.service.name)?.disk) throw new Error("Expected a disk-backed VIEWS binding.");
const diskName = views.service.name;
views.service = { name: "cms:views" };
services.set("cms:views", { name: "cms:views", worker: worker(`
export default { async fetch(request, env) {
  const response = await env.FILES.fetch(request);
  const headers = new Headers(response.headers);
  const path = new URL(request.url).pathname;
  const types = { css: "text/css", js: "text/javascript", json: "application/json", liquid: "text/plain", svg: "image/svg+xml" };
  const type = types[path.split(".").pop()];
  if (type) headers.set("Content-Type", type + "; charset=utf-8");
  return new Response(response.body, { status: response.status, headers });
} };`, [{ name: "FILES", service: { name: diskName } }]) });
services.set("cms:http", { name: "cms:http", worker: worker(`
export default { fetch(request, env) {
  const origin = ${JSON.stringify(publicOrigin)};
  if (origin) {
    const url = new URL(request.url), target = new URL(origin);
    url.protocol = target.protocol; url.host = target.host;
    request = new Request(url, request);
    request.headers.set("Host", target.host);
  }
  return env.CMS.fetch(request);
} };`, [{ name: "CMS", service: { name: cms } }]) });
services.set("cms:cron", { name: "cms:cron", worker: worker(`
export default { async fetch(request, env) {
  if (request.method !== "POST") return new Response("POST required", { status: 405 });
  for (const cron of ${JSON.stringify(workerOptions.cronTriggers ?? [])}) {
    await env.CMS.scheduled({ cron, scheduledTime: Date.now() });
  }
  return new Response("Scheduled jobs completed\\n");
} };`, [{ name: "CMS", service: { name: cms } }]) });

// Keep only the services reachable from the standalone sockets. Optional
// loopback bindings are for Miniflare logging/pretty errors, not storage I/O.
for (const service of services.values()) {
  if (!service.worker) continue;
  service.worker.bindings = (service.worker.bindings ?? []).filter((binding) => binding.service?.name !== "loopback");
  if (service.worker.globalOutbound?.name === "outbound:0") service.worker.globalOutbound = { name: "internet" };
  // The debug JSON omits the inMemory Void union member; spell it out below.
  if (service.worker.durableObjectStorage && !Object.keys(service.worker.durableObjectStorage).length) {
    service.worker.durableObjectStorage = { inMemory: null };
  }
}
const selected = new Map();
function visit(name) {
  if (selected.has(name)) return;
  const service = services.get(name);
  if (!service) throw new Error(`Missing standalone service: ${name}`);
  selected.set(name, service);
  function references(value, key) {
    if (typeof value === "string" && ["serviceName", "localDisk"].includes(key)) visit(value);
    else if (Array.isArray(value)) value.forEach((item) => references(item));
    else if (value && typeof value === "object") {
      if (value.name && services.has(value.name)) visit(value.name);
      for (const [childKey, child] of Object.entries(value)) if (childKey !== "name") references(child, childKey);
    }
  }
  references(service.worker);
}
visit("cms:http"); visit("cms:cron");
function capnp(value) {
  if (value === null) return "void";
  if (Array.isArray(value)) return `[${value.map(capnp).join(",\n")}]`;
  if (typeof value === "object") return `(${Object.entries(value).map(([key, item]) => `${key} = ${capnp(item)}`).join(",\n")})`;
  return JSON.stringify(value);
}
const output = {
  services: [...selected.values()], extensions: assembled.extensions,
  sockets: [
    { name: "http", address: `${host}:${port}`, http: {}, service: { name: "cms:http" } },
    { name: "cron", address: `127.0.0.1:${cronPort}`, http: {}, service: { name: "cms:cron" } },
  ],
};
// Write secrets to a private file on the same filesystem, then replace the
// destination atomically. An existing symlink is replaced without following it.
const configTemp = mkdtempSync(join(dirname(configPath), ".cms-workerd-"));
try {
  const stagedConfig = join(configTemp, "config.capnp");
  writeFileSync(stagedConfig, `# Generated by server-workerd.mjs; contains local secrets.\nusing Workerd = import "/workerd/workerd.capnp";\nconst config :Workerd.Config = ${capnp(output)};\n`, { flag: "wx", mode: 0o600 });
  renameSync(stagedConfig, configPath);
} finally {
  rmSync(configTemp, { recursive: true, force: true });
}
console.log(`Generated ${configPath}. Run: node_modules/.bin/workerd serve --experimental config.capnp`);
console.log(`Cron socket: POST http://127.0.0.1:${cronPort}/ (external scheduler required). Images transforms are disabled.`);
if (args.has("--serve")) {
  const require = createRequire(import.meta.url);
  const workerd = require("workerd");
  const child = spawn(workerd.default ?? workerd, ["serve", "--experimental", configPath], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => { console.error(error); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
