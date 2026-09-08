import { env } from 'cloudflare:workers';

export async function putPublicMedia(key: string, value: Parameters<R2Bucket['put']>[1], options?: R2PutOptions) {
  const result = await env.MEDIA_BUCKET.put(key, value, options);
  await env.DB.prepare('INSERT OR IGNORE INTO media_files (key, url, filename) VALUES (?, ?, ?)')
    .bind(key, `/media/${key}`, key.split('/').pop()).run();
  return result;
}
