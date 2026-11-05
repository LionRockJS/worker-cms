// Run the CMS Worker locally under Miniflare, outside `wrangler dev`.
//
// Nothing is configured twice: bindings, vars, compatibility settings, assets,
// Durable Objects, queues, rate limits and cron come from wrangler.toml, and
// secrets from .dev.vars, exactly as `wrangler dev --local` reads them. State
// lives in .wrangler/state/v3, so this server and `wrangler dev` share the
// same local D1 databases, R2 bucket and Durable Objects.
//
//   node server.js              build, bundle, then serve
//   node server.js --no-build   serve the last bundle in dist/worker
//   node server.js --no-cron    do not fire the cron triggers
//   PORT=8788 node server.js    another port (CANONICAL_ORIGIN must match)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";

const CONFIG = "wrangler.toml";
const OUT_DIR = "dist/worker";
const BUNDLE = `${OUT_DIR}/index.js`;
const PERSIST = ".wrangler/state/v3";
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const args = new Set(process.argv.slice(2));

// `wrangler deploy --dry-run` runs the [build] command (npm run build) and then
// bundles src/index.ts the same way a deploy would, without uploading anything.
if (args.has("--build")) {
  execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", OUT_DIR, "--config", CONFIG], {
    stdio: "inherit",
  });
}
if (!existsSync(BUNDLE)) {
  console.error(`No bundle at ${BUNDLE}. Run with --build first.`);
  process.exit(1);
}

const config = unstable_readConfig({ config: CONFIG });
const { workerOptions } = unstable_getMiniflareWorkerOptions(CONFIG);

// The OAuth callback and the canonical-host guard both assume this origin.
const canonical = workerOptions.bindings?.CANONICAL_ORIGIN;
if (canonical && Number(new URL(canonical).port || 80) !== PORT) {
  console.warn(`CANONICAL_ORIGIN is ${canonical} but the server listens on port ${PORT}.`);
}

// wrangler's helper still emits Miniflare 4-shaped options; Miniflare 5 converts them.
const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        ...workerOptions,
        // Durable Object state is keyed by worker name + class (e.g. local-PageSyncDO).
        name: config.name,
        modules: [{ type: "ESModule", path: BUNDLE }],
      },
    ],
    host: HOST,
    port: PORT,
    resourcePersistencePath: PERSIST,
    log: new Log(LogLevel.ERROR),
  }),
);

const url = await mf.ready;
console.log(`0xCMS listening at ${url} (open ${canonical ?? url})`);

// Miniflare does not fire cron triggers on its own. Support the "*/N * * * *"
// form wrangler.toml uses, aligned to the wall clock like Cloudflare's.
const timers = [];
if (!args.has("--no-cron")) {
  for (const cron of workerOptions.cronTriggers ?? []) {
    const match = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim());
    if (!match) {
      console.warn(`Cron "${cron}" is not supported locally; trigger it by hand.`);
      continue;
    }
    const everyMs = Number(match[1]) * 60_000;
    const fire = async () => {
      try {
        const worker = await mf.getWorker();
        const result = await worker.scheduled({ cron, scheduledTime: new Date() });
        console.log(`[cron] "${cron}" ${result.outcome}`);
      } catch (error) {
        console.error(`Cron "${cron}" failed:`, error);
      }
    };
    const first = everyMs - (Date.now() % everyMs);
    timers.push(setTimeout(() => {
      fire();
      timers.push(setInterval(fire, everyMs));
    }, first));
    console.log(`Cron "${cron}" fires every ${match[1]} min`);
  }
}

const shutdown = async () => {
  for (const timer of timers) clearTimeout(timer), clearInterval(timer);
  await mf.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
