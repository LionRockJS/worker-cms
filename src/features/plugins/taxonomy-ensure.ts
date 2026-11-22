import type { AppContext } from '../../core/http/context';
import { resolveCmsConfig } from '../../core/db/content-config';
import { serviceMutationAuditEvidence } from '../../core/db/audit';
import { guard, json, resultGuard, snapshot } from '../../core/db/bounded-mutation';
import { classFor, strongestClass } from '../../core/db/data-classes';
import { abortIf } from '../../core/db/transaction-guard';
import { nextIdSql } from '../../core/pages/snapshot-id';
import { auditBackgroundReads, flushReadAudit } from '../../core/http/access-log';
import { assertRegulatedWritesAllowed } from '../../core/http/regulated-writes';
import { slugify } from '../../core/http/forms';
import { noteActingUser, unavailable } from './evidence-common';
import { assertPluginPageAuthority, type PluginPageMutationAuthority } from './page-update-evidence';

const MAX_TAXONOMIES = 100;
const TAXONOMY_FIELDS = ['id', 'uuid', 'name', 'slug', 'created_at', 'updated_at'];
const NEXT_TAXONOMY_ID = nextIdSql('taxonomies');

interface TaxonomyIdentity {
  name: string;
  slug: string;
  uuid: string;
}

export async function ensurePluginTaxonomies(c: AppContext, authority: PluginPageMutationAuthority, input: unknown): Promise<Response> {
  assertPluginPageAuthority(authority, 'taxonomy-ensure');
  if (!authority.taxonomyCreationApproved) return c.json({ error: 'forbidden' }, 403);

  const raw = input && typeof input === 'object' && 'names' in input ? input.names : null;
  if (!Array.isArray(raw)) return c.json({ error: 'invalid_body' }, 400);
  if (raw.length > MAX_TAXONOMIES) return c.json({ error: 'batch_too_large', max: MAX_TAXONOMIES }, 413);

  const names = new Set<string>();
  for (const value of raw) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 200 || /\p{Cc}/u.test(name)) return c.json({ error: 'invalid_taxonomy_name' }, 400);
    names.add(name);
  }
  if (!names.size) return c.json({ taxonomies: [] });

  assertRegulatedWritesAllowed(c.env);
  try {
    const config = await resolveCmsConfig(c.env);
    const configured = Object.entries(config.taxonomies);
    const configuredByName = new Map(configured.map(([slug, name]) => [name, slug]));
    const bases = new Map([...names].map(name => [name, configuredByName.get(name) ?? (slugify(name).slice(0, 80).replace(/-$/, '') || 'taxonomy')]));
    const scope = `name IN (SELECT value FROM json_each(?)) OR EXISTS (
      SELECT 1 FROM json_each(?) e WHERE slug = e.value OR substr(slug, 1, length(e.value) + 1) = e.value || '-'
    )`;
    const args = [json([...names]), json([...new Set(bases.values())])];
    const existing = await snapshot<TaxonomyIdentity & { id: number }>(c, 'taxonomies', TAXONOMY_FIELDS, scope, args);
    const byName = new Map(existing.map(row => [row.name, row]));
    const occupied = new Set(existing.map(row => row.slug));
    const created: TaxonomyIdentity[] = [];
    for (const [name, base] of bases) {
      if (byName.has(name)) continue;
      let slug = base;
      let suffix = 1;
      while (occupied.has(slug) || (Object.hasOwn(config.taxonomies, slug) && config.taxonomies[slug] !== name)) {
        slug = `${base}-${++suffix}`;
      }
      occupied.add(slug);
      created.push({ uuid: crypto.randomUUID(), name, slug });
    }

    const dataClass = strongestClass([
      authority.dataClass,
      ...[...existing, ...created].map(row => classFor(authority.policy, 'taxonomy', row.slug)),
    ]);
    await auditBackgroundReads(c.env, [{
      action: 'plugin.taxonomy-ensure-source-read', kind: 'table', key: 'taxonomies',
      targetType: 'taxonomies', ids: existing.map(row => String(row.id)), count: existing.length,
      minimumClass: dataClass === 'none' ? undefined : dataClass,
    }], authority.actor);
    if (await flushReadAudit(c)) throw new Error('Taxonomy source evidence unavailable');

    const clock = await c.env.DB.prepare('SELECT CURRENT_TIMESTAMP now').first<{ now: string }>();
    if (!clock) throw new Error('Taxonomy clock unavailable');
    const detail: Record<string, unknown> = {
      operation_id: crypto.randomUUID(), registry_id: authority.registryId,
      identity_fingerprint: authority.identityFingerprint, principal: 'credential_authenticated_plugin',
    };
    noteActingUser(c, detail);
    const statements = [...authority.check(), guard(c, 'taxonomies', TAXONOMY_FIELDS, existing, scope, args)];
    const receipts = created.map(row => {
      const receipt = serviceMutationAuditEvidence(c.env, {
        action: 'taxonomy.create', entityType: 'taxonomy', entityId: row.uuid, detail,
      }, authority.actor, dataClass, authority.policy, c);
      statements.push(
        c.env.DB.prepare(`INSERT INTO taxonomies(id, uuid, name, slug) VALUES (${NEXT_TAXONOMY_ID}, ?, ?, ?)`).bind(row.uuid, row.name, row.slug),
        abortIf(c.env, 'changes() < 1'),
        receipt.write,
      );
      return receipt;
    });
    const finalRows = [...existing, ...created.map(row => ({ ...row, created_at: null, updated_at: null }))];
    statements.push(
      resultGuard(c, 'taxonomies', TAXONOMY_FIELDS.filter(field => field !== 'id'), finalRows, clock.now, scope, args),
      guard(c, 'taxonomies', TAXONOMY_FIELDS, existing, `(${scope}) AND uuid NOT IN (SELECT value FROM json_each(?))`, [...args, json(created.map(row => row.uuid))]),
      abortIf(c.env, `EXISTS (SELECT 1 FROM taxonomies WHERE (${scope}) AND (typeof(id) <> 'integer' OR id < 1 OR id > 9007199254740991))`, args),
      ...receipts.map(receipt => receipt.guard),
      ...authority.check(),
    );
    await c.env.DB.batch(statements);
    const slugs = new Map([...existing, ...created].map(row => [row.name, row.slug]));
    return c.json({ taxonomies: [...names].map(name => ({ name, slug: slugs.get(name)! })) });
  } catch {
    return unavailable(c, authority.actor);
  }
}
