// Thumbnail service for CMS_RUNTIME=workerd. Plain workerd has no Images
// binding (Miniflare's runs on sharp in its Node process), so server-workerd.mjs
// binds IMAGE_RESIZER to this server and the media preview route posts images
// here. It listens on loopback only, loads sharp on the first request, and
// answers with image/webp or an error status, on which the CMS serves the
// original image instead.
//
//   POST /thumbnail?width=100&height=100   (body: the image, at most 20 MB)
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const port = Number(process.env.RESIZE_PORT ?? 8789);
// Matches MAX_TRANSFORM_BYTES in src/features/media/routes/public.ts.
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SIDE = 2000;

let sharp;
function loadSharp() {
  if (!sharp) {
    sharp = createRequire(import.meta.url)('sharp');
    // libvips' operation cache only helps repeated identical work; drop it to
    // keep the resident size down.
    sharp.cache(false);
  }
  return sharp;
}

function side(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SIDE ? n : null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://resizer');
  const width = side(url.searchParams.get('width'));
  const height = side(url.searchParams.get('height'));
  if (request.method !== 'POST' || url.pathname !== '/thumbnail' || !width || !height) {
    response.writeHead(400).end();
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      response.writeHead(413, { Connection: 'close' }).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  }

  try {
    const image = await loadSharp()(Buffer.concat(chunks))
      .rotate()
      .resize(width, height, { fit: 'cover' })
      .webp()
      .toBuffer();
    response.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': image.length }).end(image);
  } catch {
    // Not an image sharp can decode.
    response.writeHead(415).end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Thumbnail service on 127.0.0.1:${port}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
