import type { CmsFeature } from '../../core/feature';

/**
 * Soft-delete holding area: the trash list, restore-to-draft and permanent
 * delete screens, backed by the trash_* tables in schema/cms/features/trash.sql.
 * Its router is registered in ../routers.ts.
 *
 * Host lifecycle routes use the guarded core lifecycle service. Plugin API
 * legacy DB helpers remain separate writers. Removing this feature hides its
 * screens; retained trash tables are not dropped, and a fresh profile without
 * trash storage refuses host trash operations rather than hard-deleting data.
 */
export const trashFeature: CmsFeature = {
  id: 'trash',
  navKeys: ['trash'],
};
