import type { CmsFeature } from '../../core/feature';

/**
 * Soft-delete holding area: the trash list, restore-to-draft and permanent
 * delete screens, backed by the trash_* tables in schema/cms/features/trash.sql.
 * Its router is registered in ../routers.ts.
 *
 * This feature owns the audited lifecycle transaction for host and plugin
 * callers. Disabling it leaves retained records intact and rejects deletion.
 */
export const trashFeature: CmsFeature = {
  id: 'trash',
  navKeys: ['trash'],
  clientAssets: ['/assets/editor-trash.js'],
};
