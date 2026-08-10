# Asset sources

Sources that need a build step before the CMS can serve them, compiled into
`dist/views/assets/`:

| Source | Built by | Output |
|---|---|---|
| `admin.css` | `npm run build:css` (Tailwind) | `dist/views/assets/admin.css` |
| `richtext-md.js` | `npm run build:js` (esbuild) | `dist/views/assets/richtext-md.js` |
| `yjs.js` | `npm run build:js` (esbuild) | `dist/views/assets/yjs.js` |

They live here rather than in the view tree because `wrangler.toml` serves the
assets directory in full — sources placed there would be published.

Both write into `dist/views`, which `npm run build:views` assembles from
`src/core/views/` plus the enabled features' `src/features/<id>/views/`. Run the
assembler first: `build:css` reads `tailwind-sources.css`, which it generates
from `cms.features.json`, so a stale list compiles the wrong feature profile.
`tailwind-sources.css` is generated — edit `cms.features.json`, not that file.

Most small CMS browser scripts can live directly in `src/core/views/assets` (or
a feature's `src/features/<id>/views/assets`, declared in its manifest's
`clientAssets`). The rich text editor is different: `richtext-md.js` imports the
npm packages
`marked` and `turndown`. Browsers cannot resolve those package names through the
Worker's `/assets` route, so esbuild combines the editor and its dependencies
into one self-contained file:

```text
client/richtext-md.js
  + marked
  + turndown
  -> dist/views/assets/richtext-md.js
```

The generated file runs only in the browser. The Cloudflare Worker does not
execute it; the Worker serves it at `/assets/richtext-md.js` and receives the
HTML produced by the editor when the form is submitted.

## Building

Run the browser asset build after changing files in this directory:

```sh
npm run build:js
```

`npm run build`, `npm run dev`, `npm test`, and `npm run deploy` also run this
build automatically.

Edit the source file here, not the generated file in `dist/views/assets`.
