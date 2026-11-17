# cms-plugin-events

Reference plugin for the Worker CMS. It is a standalone Cloudflare Worker that
the CMS calls over HTTPS after runtime URL registration.
It demonstrates all five plugin extension points in one small file
(`src/index.ts`):

| Capability | What this plugin does |
|------------|-----------------------|
| Content types | Registers an `event` blueprint (`@date`, `venue`, `location:events-map`, `speakers[]`). |
| Fields & blocks | Registers an `events-map` field type and serves its Liquid snippet. |
| Lifecycle hooks | Subscribes to `publish` / `unpublish` / `delete` and logs the payload. |
| Admin routes + nav | Adds an **Events** nav item and renders a page at `/admin/plugins/events/dashboard`. |
| Publish target | Declares `publishTarget: true` and logs each full page snapshot — replace the log lines with an IPFS pin, webhook, or search-index push. |

## The plugin contract

A plugin is any Worker that answers these requests under the reserved
`/__plugin` prefix:

| Route | Purpose |
|-------|---------|
| `GET /__plugin/manifest` | Returns the JSON manifest (id, name, hooks, nav, contentTypes, fieldTypes). |
| `GET /__plugin/views/*` | Serves the plugin's Liquid templates (field/block snippets). |
| `ALL /__plugin/admin/*` | Renders the plugin's admin pages. Receives `x-cms-user`. |
| `POST /__plugin/hooks/<event>` | Receives `{ event, page, user }` for a subscribed lifecycle event. |
| `POST /__plugin/publish/page` | Receives the full `{ page, tags, publishedAt }` snapshot when a page publishes (only if the manifest sets `publishTarget: true`). |
| `POST /__plugin/publish/remove` | Receives `{ uuid }` when a page is unpublished or deleted. |
| `POST /__plugin/publish/remove-tag` | Receives `{ tagId }` when a tag is deleted (optional — 404 is ignored). |

Hook, publish, and admin calls carry an `x-plugin-secret` header containing this
plugin registration's dedicated secret, so the plugin can verify the request
came from the CMS. Treat `x-cms-user` as trusted only after verifying that
secret.

Hooks are fire-and-forget notifications; **publish calls are awaited** and a
non-2xx response is reported in the CMS editor as a failed publish target.

## Deploy + wire into the CMS

```bash
cd docs/examples/plugin-events
npm install
npx wrangler deploy
```

In the CMS, open **Admin → Plugins → Register plugin**, paste the deployed Worker
URL, review the discovered manifest, and copy its generated secret. Store that
secret on the plugin and redeploy it:

```bash
cd docs/examples/plugin-events
npx wrangler secret put PLUGIN_SECRET
npx wrangler deploy
```

Then enable the registration. No CMS service binding or redeploy is required. The **Events** nav
item appears, the `event` page type becomes available in the editor, and
publishing fires this plugin's `publish` hook (visible in
`wrangler tail cms-plugin-events`).

Only install plugins you trust: plugin admin HTML is proxied onto the CMS origin,
and explicitly approved JS/CSS assets run with same-origin authority.
