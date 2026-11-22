import type { Taxonomy } from '../../../types';
import { exportRows } from '../../../core/config-export';
import { isRecord, planChange, skipItem, type ConfigTransferSection } from '../../../core/config-transfer';
import { contextActor } from '../../../core/db/audit';
import { saveTaxonomy } from '../../../core/evidence/taxonomy-mutation-evidence';
import { recordTaxonomyReads } from '../../../core/http/access-log';
import { slugify } from '../../../core/http/forms';
import { publication } from '../../../features/services';

export const taxonomiesSection: ConfigTransferSection = {
  id: 'taxonomies',
  labelKey: 'settings.transfer.sections.taxonomies',
  order: 20,
  permission: 'taxonomy:write',
  exportRecords(c, after) {
    return exportRows<{ slug: string; name: string }>(c,
      'SELECT slug, name FROM taxonomies WHERE slug > ? ORDER BY slug LIMIT ?', after, row => {
        recordTaxonomyReads('config.export-read', [row]);
        return { key: row.slug, label: row.slug, item: row };
      });
  },
  async plan(c, items) {
    const { results } = await c.env.DB.prepare('SELECT * FROM taxonomies').all<Taxonomy>();
    recordTaxonomyReads('config.import-read', results);
    return items.map((item) => {
      const slug = isRecord(item) && typeof item.slug === 'string' ? item.slug : '';
      const name = isRecord(item) && typeof item.name === 'string' ? item.name.trim() : '';
      if (!slug || slugify(slug) !== slug) return skipItem(slug || '?', 'Invalid slug.');
      if (!name) return skipItem(slug, 'Name is required.');
      const before = results.find((row) => row.slug === slug);
      return planChange(slug, before?.name, name, async () => {
        const moved = await saveTaxonomy(c, { name, slug }, before);
        if (moved.length) await publication()?.publishTagsToTargets(c.env, moved, contextActor(c));
      });
    });
  },
};
