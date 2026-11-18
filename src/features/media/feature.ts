import type { CmsFeature } from '../../core/feature';

/**
 * R2-backed media: the public /media and /media-preview routes, the editor's
 * upload endpoint, and the Files browser.
 *
 * The public routes are not admin routes, so they are registered in
 * ../routers.ts under publicRouters and mounted by src/index.ts rather than
 * by the admin router.
 */
export const mediaFeature: CmsFeature = {
  id: 'media',
  clientAssets: ['/assets/field-upload.js'],
  navKeys: ['content'],
};
