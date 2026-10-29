import type { CmsFeature } from '../../core/feature';

/**
 * The audit log reader: a filterable view of audit_events for whoever holds
 * audit:read.
 *
 * Only the review surface lives here. The table and the recorder are core,
 * because an install must not be able to drop its audit control and still
 * claim compliance — but a deployment holding no regulated data has no use for
 * the screen, so reviewing it is droppable where recording is not. Its router
 * is registered in ../routers.ts.
 */
export const auditFeature: CmsFeature = {
  id: 'audit',
  navKeys: ['audit'],
};
