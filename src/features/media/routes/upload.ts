// POST /admin/upload — the editor's file/picture upload endpoint.
//
// Extracted from routes/admin/api.ts so the media feature owns every route
// that writes to the bucket and the media_files table.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { requirePermission } from '../../../core/auth/guards';
import { rateLimitByIP } from '../../../core/http/rate-limit';
import { logAudit } from '../../../core/db/audit';
import { slugify, str } from '../../../core/http/forms';
import { validateUpload } from '../security';
import { mediaClassifier } from '../regulated';

export const mediaUploadRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Upload ───────────────────────────────────────────────────────────────────

mediaUploadRoutes.use('/upload', rateLimitByIP((env) => env.UPLOAD_RATE_LIMITER));
mediaUploadRoutes.use('/upload', requirePermission('media:upload'));

mediaUploadRoutes.post('/upload', async (c) => {
  if (!c.env.MEDIA_BUCKET) {
    return c.json({ success: false, error: 'MEDIA_BUCKET binding is not configured' }, 501);
  }

  // Private-by-default for regulated destinations: the object marker is written
  // here, so it protects the object afterwards whatever the classification
  // table says. An upload that cannot be classified is refused rather than
  // guessed — mis-marking is durable, while a refusal costs a retry.
  const classify = await mediaClassifier(c.env);

  const form = await c.req.formData();
  const uploadedFiles = [...form.values()].filter((value) => typeof value !== 'string');
  if (uploadedFiles.length > 10) return c.json({ success: false, error: 'too_many_files' }, 413);
  const uploadDirectory = slugify(str(form.get('dir')) || 'upload') || 'upload';
  const now = new Date();
  const datePath = `${now.getUTCFullYear()}/${now.getUTCMonth() + 1}/${now.getUTCDate()}`;
  const files: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let errorStatus: 413 | 415 | undefined;

  for (const [, value] of form.entries()) {
    if (typeof value === 'string') continue;
    const file = value as File;
    if (!file.name) continue;

    const headerBytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const validation = validateUpload(file, headerBytes);
    if (!validation.ok) {
      errors.push({ file: file.name, error: validation.error });
      errorStatus = errorStatus ?? validation.status;
      continue;
    }

    const safeName = file.name.replace(/[^a-z0-9-_.]/gi, '');
    const key = `${uploadDirectory}/${datePath}/${crypto.randomUUID()}-${safeName}`;
    const disposition = classify(key);
    if (disposition === 'unknown') {
      return c.json({ success: false, error: 'classification_unavailable' }, 503);
    }
    await c.env.MEDIA_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: validation.contentType },
      ...(disposition === 'withheld' ? { customMetadata: { cmsPrivate: '1' } } : {}),
    });
    const url = `/media/${key}`;
    await c.env.DB.prepare(
      'INSERT INTO media_files (key, url, filename, content_type, size) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(key, url, file.name, validation.contentType, file.size)
      .run();
    logAudit(c, 'media.upload', 'media', key, { filename: file.name, size: file.size });
    files.push(url);
  }

  if (errors.length > 0 && files.length === 0) {
    return c.json({ success: false, files, errors }, errorStatus ?? 415);
  }
  return c.json({ success: true, files, errors });
});
