// Run the CMS Worker on this machine under Miniflare, outside `wrangler dev`.
//
// Nothing is configured twice: bindings, vars, compatibility settings, assets,
// Durable Objects, queues, rate limits and cron come from wrangler.toml, and
// secrets from .dev.vars, exactly as `wrangler dev --local` reads them. State
// lives in .wrangler/state/v3, so this server and `wrangler dev` share the
// same local D1 databases, R2 bucket and Durable Objects.
//
// CANONICAL_ORIGIN picks the mode:
//   http://localhost:<port>   local development: browse this server directly.
//   https://cms.example.com   public: a tunnel or reverse proxy forwards that
//                             domain to HOST:PORT. The Worker sees each request
//                             as https://cms.example.com/..., as it would on
//                             Cloudflare, so the canonical-host guard, __Host-
//                             cookies and Origin checks hold behind the proxy.
//
//   node server.mjs --build      build and bundle first, then serve
//   node server.mjs              serve the last bundle in dist/worker
//   node server.mjs --no-cron    do not fire the cron triggers
//   PORT=8788 node server.mjs    another port
//   HOST=0.0.0.0 node server.mjs listen beyond loopback (proxy on another host)
//
// PORT and HOST can also live in .env. That file configures this server only;
// Worker vars and secrets stay in .dev.vars. Variables already set in the shell win.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";

const CONFIG = "wrangler.toml";
const OUT_DIR = "dist/worker";
const BUNDLE = `${OUT_DIR}/index.js`;
const PERSIST = ".wrangler/state/v3";

try {
  process.loadEnvFile(".env");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const canonical = (workerOptions.bindings?.CANONICAL_ORIGIN ?? "").trim().replace(/\/$/, "");
const publicOrigin = canonical && !LOOPBACK.has(new URL(canonical).hostname) ? canonical : null;

if (publicOrigin) {
  if (new URL(publicOrigin).protocol !== "https:") {
    console.error(`CANONICAL_ORIGIN ${publicOrigin} must be https for a public domain.`);
    process.exit(1);
  }
  // Every client arrives from the proxy's address. The rate limiters and the
  // audit log key on CF-Connecting-IP, which Miniflare only fills in when the
  // request does not already carry it, so the proxy must set it, and nothing
  // but the proxy should be able to reach this port.
  if (!LOOPBACK.has(HOST)) {
    console.warn(
      `Listening on ${HOST}: a client that reaches this port directly can send its own ` +
        `CF-Connecting-IP. Firewall it so only the proxy can connect.`,
    );
  }
} else if (canonical && Number(new URL(canonical).port || 80) !== PORT) {
  // The OAuth callback and the canonical-host guard both assume this origin.
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
    // Public mode: rewrite each request's URL and Host to the public origin, as
    // wrangler dev --local-upstream does. The browser-facing scheme is https at
    // the proxy even though the hop to this server is plain http.
    ...(publicOrigin ? { upstream: publicOrigin } : {}),
    resourcePersistencePath: PERSIST,
    log: new Log(LogLevel.ERROR),
  }),
);

const url = await mf.ready;
if (publicOrigin) {
  console.log(`0xCMS listening at ${url}, served as ${publicOrigin}`);
  console.log(`Point the tunnel or reverse proxy for ${new URL(publicOrigin).host} at ${url}`);
} else {
  console.log(`0xCMS listening at ${url} (open ${canonical || url})`);
}

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
