// Copy the self-hosted CMS's D1 databases out of the data volume while the CMS
// keeps running. Each database is a SQLite file in WAL mode; VACUUM INTO on a
// read-only connection writes a consistent single-file copy that any SQLite
// tool can open. Run it in a throwaway container from the CMS image:
//
//   docker run --rm -u "$(id -u):$(id -g)" \
//     -v worker-cms_cms-state:/data -v "$PWD":/out -v ~/worker-cms/docker:/tools:ro \
//     --entrypoint node ghcr.io/lionrockjs/0xcms:development /tools/d1-snapshot.mjs
//
// Writes cms.sqlite (DB) and cms-published.sqlite (PUBLISHED_DB) to /out.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dir = '/data/v3/d1/miniflare-D1DatabaseObject';
const files = readdirSync(dir).filter((file) => /^[0-9a-f]{64}\.sqlite$/.test(file));
if (!files.length) throw new Error(`No D1 databases in ${dir}; is the data volume mounted at /data?`);

for (const file of files) {
  const db = new DatabaseSync(`${dir}/${file}`, { readOnly: true });
  const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  const out = `/out/${hasUsers ? 'cms' : 'cms-published'}.sqlite`;
  if (existsSync(out)) rmSync(out);
  db.prepare('VACUUM INTO ?').run(out);
  db.close();
  console.log(`${out.slice('/out/'.length)} <- ${file.slice(0, 12)}…`);
}
