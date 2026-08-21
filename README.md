# worker-cms
Content management system on Workers

## Features

- **OAuth 2.1** login via Eventuai, GitHub, Google, Microsoft, or Apple with PKCE (Proof Key for Code Exchange); Apple ID tokens are signature- and nonce-verified
- **Dual JWT** security – short-lived access tokens (15 min) + rotatable refresh tokens (7 days) stored as httpOnly cookies; refresh tokens are hashed and stored in D1 for revocation
- **Capability-based access** – routes enforce granular permissions resolved from built-in or custom roles; delegated user/role managers cannot grant authority they do not already hold
- **Separated D1 content stores** – the CMS database keeps auth, sessions, draft, trash, taxonomy, and media metadata; the published database keeps only live content (pages, tag links and the tag catalogue) for public reads. Both call the page tables `pages` / `page_tags` — same name, same shape — so a published database can serve as the next host's working set; this repo disambiguates by binding (`DB.pages` vs `PUBLISHED_DB.pages`)
- **Page versioning** – `pages.lect` is the working copy and the single source of truth for a draft; every save appends a `page_versions` row. The log is an append-only backup: the newest row mirrors `pages.lect`, older rows are restore candidates. There is deliberately no current-version pointer
- **Live collaborative editing** – Markdown richtext fields use a Yjs `Y.Text`
  sequence CRDT, so concurrent character-level edits merge; ordinary form
  fields use explicit field-level LWW registers. `PageSyncDO` persists both
  overlays plus editor presence in Durable Object SQLite and clears them on save.
- **Private R2 media uploads** – picture fields upload to a private R2 bucket and are served back through the Worker at `/media/...`
- **Tailwind CSS + VanillaJS** admin UI rendered from Liquid views; the rich-text field keeps a contenteditable preview, its Markdown source, and the submitted HTML in sync (`marked` + `turndown`, bundled by esbuild)
- **Plugins** – extend the CMS with separate Worker plugins (lifecycle hooks, content types, fields/blocks, admin pages, publish targets). See [Plugins](#plugins).
- **Pluggable publish targets** – publishing fans out to one or more adapters: the published D1 database (default), static JSON in an R2 bucket, or any plugin Worker (IPFS, webhooks, search indexes). See [Publish targets](#publish-targets).
- **Credits & diamonds** – two independent per-user currencies that meter chargeable plugin actions; atomic, overdraft-proof, ledger-audited, each with admin grants, user-to-user transfers, and a shared site-wide pool that covers users who run out. See [Credits](#credits).

---

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create the D1 databases

```bash
npx wrangler d1 create cms
npx wrangler d1 create cms-published
```

Copy the `database_id` values printed by the commands into `wrangler.toml`:

- `cms` -> `DB`
- `cms-published` -> `PUBLISHED_DB`

`DB` is the private CMS/admin database. It stores users, sessions, drafts,
trash, taxonomy, page versions, and media metadata.

`PUBLISHED_DB` is the published-content database. It stores the `pages`,
`page_tags` and `tags` rows used by public readers — the `tags` catalogue is
mirrored from `DB.tags` by the publish path, so a reader can resolve a tag link
to a name and a grouping without the CMS database. A separate public Worker can be
deployed with only this binding, so it has no access to CMS users, sessions,
drafts, or trash.

For an existing deployment, keep the existing `DB` binding and create the new
`PUBLISHED_DB`. Rows are not moved automatically; publish the pages again, or
copy the current published rows into `cms-published`.

> **Breaking rename (August 2026).** `draft_pages` → `pages`,
> `draft_page_tags` → `page_tags` in `DB`, and `live_pages` → `pages`,
> `live_page_tags` → `page_tags` in `PUBLISHED_DB`. The generated baselines
> below create the new names; a database created before the rename must be
> migrated by hand (`ALTER TABLE ... RENAME TO ...` plus its indexes and
> triggers) before deploying a Worker that reads them. Since both bindings now
> use the same table name, a query aimed at the wrong binding no longer fails
> loudly — check the binding first when page reads or writes land somewhere
> unexpected. An upgraded CMS database may also still carry legacy `live_*`
> tables; current routes ignore them and use `PUBLISHED_DB` instead.

### 3. Run migrations

```bash
npx wrangler d1 migrations apply cms
npx wrangler d1 migrations apply cms-published
```

For local development, the checked-in script applies both local databases:

```bash
npm run db:migrate
```

For production, add `--remote` to each `wrangler d1 migrations apply` command.

The `cms` migrations create auth tables plus draft, trash, taxonomy,
versioning, media tables, and (with the `jobs` feature installed) the
`admin_jobs` table for durable background admin actions such as long plugin
duplicate/delete requests. The `cms-published` migrations create only the three
published content tables (`pages`, `page_tags`, `tags`). They do not
automatically import rows from other D1 databases.

The baseline migrations are generated from the `schema.sql` fragments beside
the code they belong to — edit those, not `migrations/*.sql`, and run
`npm run build:migrations`. See [Feature profiles](#feature-profiles) for
choosing which features a deployment installs.

### 4. Create and bind the private R2 media bucket

Picture fields upload files to the `MEDIA_BUCKET` R2 binding. R2 buckets are not public by default; this CMS keeps the bucket private and serves objects through the Worker at `/media/<key>`.

Create the bucket:

```bash
npx wrangler r2 bucket create worker-cms-media
```

Bind it in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "worker-cms-media"
```

The checked-in `wrangler.toml` already contains this binding. If you choose another bucket name, update both the create command and `bucket_name`.

This `/admin/upload` endpoint is the signed-in editor workflow: it validates
browser image uploads and records `media_files` metadata. Plugin Workers use
the separate authenticated `/__cms/files` API documented below when they need
generic host-owned binary storage.

If uploads return a Cloudflare challenge page such as `Just a moment... Enable JavaScript and cookies to continue`, create a narrow Cloudflare skip rule for the authenticated upload endpoint. The Worker still requires a valid CMS session and editor role before writing to R2.

In the Cloudflare dashboard:

1. Go to **Security rules** or **Security > WAF > Custom rules**.
2. Create a custom rule named `Skip CMS upload challenge`.
3. Use this expression:
   ```text
(http.host eq "cms.eventuai.com" and http.request.uri.path eq "/admin/upload" and http.request.method eq "POST")
   ```
4. Set **Action** to **Skip**.
5. Select the product that appears in **Security > Events** for the failed upload, commonly **All managed rules**, **All Super Bot Fight Mode rules**, **Browser Integrity Check**, or **Security Level**.
6. Save the rule and retry the upload.

Cloudflare Bot Fight Mode on the Free plan cannot be skipped by a custom rule. If Security Events shows Bot Fight Mode, disable Bot Fight Mode for the zone or move to Super Bot Fight Mode/Bot Management so this endpoint can be exempted.

The page editor uses a Worker-owned preview route for picture field thumbnails:

```text
/media-preview/<key>
```

It reads the object from R2 and resizes it to a 100×100 WebP square through the
Cloudflare **Images binding**, then caches the result:

```toml
[images]
binding = "IMAGES"
```

The binding works on `workers.dev` — no zone, custom domain, or **Images >
Transformations** zone setting required. The route serves the original
`/media/<key>` object instead whenever the transform cannot or should not run:
no `IMAGES` binding, a missing object, a non-image content type, an input over
20 MB, or a decode failure. Remove the binding to always serve full-size
originals.

### 5. Configure secrets

```bash
# Random 32-byte secret for signing JWTs – e.g. openssl rand -hex 32
npx wrangler secret put JWT_SECRET
```

Then add a secret for each provider you enable (see step 6).

Create a `.dev.vars` file for local development (see `.dev.vars.example`).

### 6. Enable OAuth providers

Set `ENABLED_PROVIDERS` in `wrangler.toml` to a comma-separated list of the
providers you want to offer on the login page:

```toml
ENABLED_PROVIDERS = "eventuai,github,google,microsoft,apple"
```

Users will see one sign-in button per listed provider, in that order.
Add the Client ID and secret for every provider you enable.

To link an additional OAuth provider to the same CMS account, sign in first,
then start that provider's flow from the profile page (or use
`/auth/start?provider=google&link=1`).
The callback attaches the new provider identity to the current user; it will
not silently merge logged-out accounts just because their emails match.

#### Eventuai (self-hosted OAuth worker)

1. Register the CMS as a client on your OAuth worker — see the OAuth worker README for the `POST /admin/setup-clients` call.
2. Copy the generated `clientId` into `wrangler.toml`:
   ```toml
   EVENTUAI_CLIENT_ID = "<client-id>"
   ```
3. Store the matching secret:
   ```bash
   npx wrangler secret put EVENTUAI_CLIENT_SECRET
   ```

#### GitHub

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Set **Authorization callback URL** to your `OAUTH_REDIRECT_URI` (e.g. `https://cms.example.com/auth/callback`).
3. Copy the **Client ID** into `wrangler.toml`:
   ```toml
   GITHUB_CLIENT_ID = "<client-id>"
   ```
4. Generate a **Client Secret** and store it:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

#### Google

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**.
2. Click **Create Credentials → OAuth 2.0 Client ID** (type: *Web application*).
3. Add your `OAUTH_REDIRECT_URI` as an authorised redirect URI.
4. Copy the **Client ID** into `wrangler.toml`:
   ```toml
   GOOGLE_CLIENT_ID = "<client-id>"
   ```
5. Store the **Client Secret**:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

#### Microsoft

1. Open **Microsoft Entra admin center → App registrations → New registration**.
2. Add your `OAUTH_REDIRECT_URI` as a web redirect URI.
3. Copy the **Application (client) ID** into `wrangler.toml`:
   ```toml
   MICROSOFT_CLIENT_ID = "<client-id>"
   ```
4. Optionally set `MICROSOFT_TENANT` to `common`, `organizations`, `consumers`, or a tenant ID/domain. It defaults to `common`.
5. Store the client secret:
   ```bash
   npx wrangler secret put MICROSOFT_CLIENT_SECRET
   ```

#### Apple

1. In Apple Developer, configure **Sign in with Apple** for your Services ID.
2. Add your `OAUTH_REDIRECT_URI` as a return URL.
3. Copy the Services ID into `wrangler.toml`:
   ```toml
   APPLE_CLIENT_ID = "<services-id>"
   ```
4. Apple has no static client secret. `APPLE_CLIENT_SECRET` is an ES256 JWT
   signed with the `.p8` key from
   [Keys](https://developer.apple.com/account/resources/authkeys/list). `npm run setup`
   asks for the key file, key ID, and team ID and uploads the signed JWT for you.
   To mint one outside the wizard:
   ```bash
   npm run apple:client-secret -- \
     --key-file ./AuthKey_XXXXXXXXXX.p8 \
     --team-id <team-id> \
     --client-id <services-id>
   npx wrangler secret put APPLE_CLIENT_SECRET
   ```
   `--key-id` defaults to the ID in the `AuthKey_<key-id>.p8` filename. Apple caps
   the lifetime at six months (`--expires-in-days`, default 180), so re-run this
   and re-upload the secret before it expires or Apple sign-in starts failing.

> **Note:** GitHub and Google users have their role defaulted from the database.
> Promote accounts to `admin` / `editor` with the SQL command in step 7.

### 7. Set the first user's role

After signing in for the first time, update your role to `admin` in the CMS database. Multiple roles can be stored as a comma-separated list, for example `admin,viewer`:

```bash
npx wrangler d1 execute cms --remote \
  --command "UPDATE users SET role='admin,viewer' WHERE email='you@example.com'"
```

### 8. Run locally

```bash
npm run dev
```

Visit **http://localhost:8787** → redirects to the login page.

### 9. Deploy

```bash
npm run deploy
```

---

## Plugins

The CMS can be extended with **plugins**, each of which is a separate Cloudflare
Worker registered at runtime by HTTPS URL. Registration, enable/disable,
credential rotation, delegated page-type scopes, assets, quotas, and credits are
managed under **Admin → Plugins** without redeploying the CMS.

Every new manifest should declare one browser trust level with `trustLevel`
(or `trust_level` in static JSON):

| Level | Browser behavior | Intended use |
|-------|------------------|--------------|
| `server-only` | No admin nav, browser assets, or custom page views are allowed | Hooks, APIs, publish targets, content types |
| `sandboxed-ui` | Admin pages run in an iframe without `allow-same-origin`; the document has an opaque origin and cannot reach CMS DOM/session authority | Read-only or independently authenticated third-party UI |
| `trusted-ui` | Approved assets and proxied pages may execute in CMS chrome on the CMS origin | Audited first-party UI that must integrate deeply with the editor |

`sandboxed-ui` deliberately has no direct CMS-authenticated mutation bridge yet,
and it cannot declare `editViews`, `newViews`, or `readViews`; use
`trusted-ui` only after code review when those capabilities are required.
Legacy manifests remain compatible by defaulting to `trusted-ui`. Older plugins
could expose unlisted admin routes, so the CMS cannot safely infer that a
manifest without nav or assets is server-only. The Plugins admin screen shows
the effective level so this fallback is visible rather than silent.

A plugin can add six things:

- **Lifecycle hooks** – run on page `create`/`update`/`publish`/`unpublish`/`delete`
  plus `submission` when a live-only page is mirrored into draft (webhooks,
  external search indexing, cache purge, notifications). Hooks are best-effort
  and never block the editor.
- **Content types** – register new `blueprint`/`blocks`/`blockLists`/`taxonomies`/`taxonomyLists`
  that merge into the editor's config. Plugin-contributed page types, block
  types, and taxonomies appear (read-only) in **Admin → Page Types / Block Types / Taxonomies**, badged with
  the contributing plugin's name. A companion plugin can also request delegated
  access with `readTypes`/`writeTypes` to use existing page types through the
  `/__cms` API without contributing their blueprints; an admin must approve
  those delegated scopes in plugin management before they are honored. Use `"*"`
  in `readTypes` or `writeTypes` to request access to all concrete page types.
- **Fields & blocks** – register new pagefield types and serve their Liquid
  snippets, which render through the CMS editor.
- **Edit, create & read views** – list page-type slugs in the manifest
  `editViews`, `newViews` (and/or `readViews`) to render the *whole* edit form,
  create form, or read-only view for those types yourself, instead of the
  built-in structured editor.
  See [Plugin edit views](#plugin-edit-views).
- **Admin routes + nav** – add an admin page (proxied at
  `/admin/plugins/<id>/...`) and a navigation entry. A nav item may set
  `group: 'settings'` to nest under the sidebar's **Settings** group instead of
  the top level; `roles` restricts who sees it. Plugin admin pages render in the
  CMS origin, so besides `admin` they are reachable only by a role holding both
  `plugin:access` (granted in the CMS) and one of the permissions that plugin
  declares — neither key alone opens the page, and a plugin that declares no
  permissions stays admin-only.
- **Publish targets** – declare `publishTarget: true` in the manifest to receive
  full page snapshots whenever a page is published or unpublished (pin to IPFS,
  push to a search index, trigger a static-site rebuild). Unlike hooks, publish
  calls are awaited and failures surface in the editor. See
  [Publish targets](#publish-targets).

A manifest may also declare, all admin-configured rather than plugin-enforced:
`permissions` (extra permission types offered in the Roles admin, each of which
must be namespaced to the plugin's own id — `events:manage`, never
`content:write` or another plugin's name), `assets`
(JS/CSS the plugin wants to run inside CMS chrome — each path must be approved
and content-hash pinned before it survives sanitization), `limits` (quotas the
CMS enforces on page creation), `credits` (chargeable actions and their
wallet), `autoPublishTypes` (owned types republished on save once already
live), `contentTypes.publishLect` (fields stripped at publish time — see
[Publish targets](#publish-targets)), `i18n: true` (the plugin serves its own
locale catalogs), and `autoTenant: true` (see
[Automatic tenant registration](#automatic-tenant-registration)).

For a plugin that uses the shared SDK's enrollment helper, `tenantVars` may
list environment variable names to copy into a newly enrolled tenant record's
`vars` object. The CMS reads this declaration from the plugin manifest and
forwards the names as `tenant_vars` during Connect; the plugin SDK copies the
matching non-empty Worker env values after the ticket is redeemed. Existing
tenant-specific `vars` win on rotation, so an operator's override is not
silently replaced. Do not list the connection fields (`CMS_URL`,
`PLUGIN_SECRET`, `SIGN_KEY`, or the tenant metadata fields); those are reserved
by the SDK.

For example:

```json
{
  "autoTenant": true,
  "tenantVars": [
    "GITHUB_APP_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_SECRET"
  ]
}
```

With no plugins registered, the system is inert and adds no plugin traffic.

### Localized Liquid views

Core and plugin Liquid views share the CMS translation catalog. Use a namespaced
key:

```liquid
{{ "plugin.events.guest_list" | t }}
```

> **Views auto-escape.** Sections are rendered in the browser by
> `client-render.js` with LiquidJS `outputEscape: 'escape'`, so every `{{ … }}`
> is HTML-escaped by default — adding `| escape` double-escapes the text and
> shows `&amp;lt;` in the UI. Values that are deliberately HTML (a server-built
> fragment, an inline SVG icon) need an explicit `| raw`.

Bundled defaults live in `src/core/views/locales/<locale>.json`, plus a fragment
per feature at `src/features/<id>/views/locales/<locale>.json`; the build merges
them into the single catalog the browser fetches. Administrators can add
supported content/UI locales and override or extend keys at **Settings →
Languages → Translations**; database values win over bundled JSON. Missing keys
fall back through the locale's configured fallback, then English, then render as
the key itself. Plugin keys should use `plugin.<plugin-id>.*` to avoid collisions.

The `language` value used by content remains separate from the signed-in user's
`uiLocale`. `mis` is the protected default content language meaning “language
unspecified” and cannot be enabled as a UI locale. Liquid views can also use
`l10n_number` and `l10n_date`; `uiLocale` and `uiDirection` are available as
render globals for locale-aware plugin behavior.

### How it works

Each plugin Worker implements a small HTTP contract under the reserved
`/__plugin` prefix (`/manifest`, `/views/*`, `/admin/*`, `/edit`, `/hooks/<event>`).
The CMS discovers enabled plugins from its `plugins` table, fetches and validates
their manifests (including a 256 KiB response limit), forwards the signed-in user
plus that plugin's dedicated secret on outbound calls, and merges approved
contributions into the editor. The reverse `/__cms` API requires `x-plugin-id`
and the matching plugin row's own `x-plugin-secret`; the legacy environment
`PLUGIN_SECRET` is never accepted for inbound authentication.

A registry row is identified by its URL, but every capability the CMS grants a
plugin — asset, page-type and file-prefix approvals, host-held `plugin_state`,
tenant enrollment, limit and credit settings, and the admin proxy's permission
gate — is keyed by the `manifest.id` the plugin asserts about itself. The CMS
therefore **pins** that id to the row on first resolution and enforces it after:
a second plugin serving an id another row owns is ignored, and a plugin whose id
changes stops resolving until an admin re-approves it under Plugins → (plugin) →
edit. Re-approval deliberately revokes the previous identity's approvals (its
host-held state moves across), and deleting a plugin releases its id along with
everything keyed to it — including when the plugin is offline at the time.

### Plugin edit views

By default every page is edited and created through the built-in structured
editor. A plugin can take over the whole edit form, create/new form, or both for
the page types it owns by listing their slugs in the manifest:

```js
const MANIFEST = {
  id: 'events',
  // …
  contentTypes: { blueprint: { event: ['@date', 'venue'] } },
  editViews: ['event'],
  newViews: ['event'],
};
```

For a page of one of those types the CMS `POST`s the editor context to the
plugin's `/__plugin/edit` endpoint (JSON body + `x-plugin-secret` + `x-cms-user`).
`editViews` owns existing-page edit forms; `newViews` owns create forms. Existing
plugins that only declare `editViews` continue to own both edit and create forms
for backwards compatibility.

```jsonc
{
  "mode": "edit",                 // or "new"
  "action": "/admin/pages/42",    // where the plugin's <form> must POST back
  "backHref": "/admin",
  "language": "en",
  "uiLocale": "zh-hant",        // CMS controls; separate from content language
  "uiDirection": "ltr",
  "pageType": "event",
  "page": { "id": 42, "name": "…", "slug": "…", "weight": 5,
            "start": null, "end": null, "timezone": "+0800",
            "editors": null, "lect": "{…stringified lect JSON…}" },
  "versions": [{ "id": 9, "created_at": "…", "action": "update" }],
  "flash": "…", "errors": ["…"]
}
```

The plugin returns an **HTML fragment** with `x-cms-chrome: 1` (and optionally a
percent-encoded `x-cms-title`); the CMS wraps it in the standard admin chrome and
serves it under the CMS origin. The fragment's `<form>` posts back to `action`
using the normal CMS field-name conventions (`@attr`, `.field|<lang>`, `*pointer`,
plus `name`/`slug`/`weight`/`page_type`/`action`), so save, versioning, and
publish all flow through the CMS's existing handler unchanged. Returning `404`
(or any error / non-HTML response) makes the CMS fall back to the built-in editor,
so a half-built plugin can never lock an editor out of a page. Like proxied admin
pages, the wrapped fragment runs under the CMS's strict nonce CSP — contribute
any field markup through Liquid snippets / view files rather than inline scripts.

To bypass a plugin edit view and use the built-in structured editor for a single
page, append **`?native=1`** (or `?editor=cms`) to the edit URL, e.g.
`/admin/pages/42/edit?native=1`. The flag is carried through the editor's form
action and post-save redirect, so it survives validation errors and reloads.

#### Read views

Every page also has a built-in **read-only view** at `/admin/pages/<id>/read`
(the eye icon on the dashboard, or *View* in the editor header): the same
structured content rendered as static text instead of inputs. A plugin can take
over that view for the page types it owns exactly like the edit view — list the
slugs under `readViews` (independent of `editViews`; a plugin may own the edit
view, the read view, both, or neither):

```js
const MANIFEST = {
  id: 'events',
  // …
  editViews: ['event'],
  newViews: ['event'],
  readViews: ['event'],
};
```

For a page of one of those types the CMS `POST`s a read context to the plugin's
`/__plugin/read` endpoint (JSON body + `x-plugin-secret` + `x-cms-user`). It
mirrors the edit context but omits the form-submission fields (`mode`, `action`,
`flash`, `errors`) and adds `editHref` — a link back to the CMS editor:

```jsonc
{
  "editHref": "/admin/pages/42/edit",
  "backHref": "/admin",
  "language": "en",
  "pageType": "event",
  "page": { "id": 42, "name": "…", "slug": "…", "weight": 5,
            "start": null, "end": null, "timezone": "+0800",
            "editors": null, "lect": "{…stringified lect JSON…}" },
  "versions": [{ "id": 9, "created_at": "…", "action": "update" }]
}
```

The plugin returns an **HTML fragment** with `x-cms-chrome: 1` (and optionally a
percent-encoded `x-cms-title`), wrapped in the standard admin chrome under the
strict nonce CSP — just like the edit view. Returning `404` (or any error /
non-HTML response) falls back to the built-in read view, and `?native=1`
(or `?editor=cms`) forces it, so a half-built plugin can never hide a page.

Admin responses are `X-Frame-Options: DENY` by default. A plugin **full-document**
admin response (no `x-cms-chrome`) may opt into being shown in a same-origin
`<iframe>` by setting `x-cms-frame: 1`; the proxy translates it to
`X-Frame-Options: SAMEORIGIN` with `frame-ancestors 'self'` (e.g. an EDM editor
embedding its own email preview). It is same-origin only — the response is still
served on the CMS origin.

### Adding a plugin

1. Build/deploy the plugin Worker (see [`examples/plugin-events`](examples/plugin-events)
   for a complete reference implementing all six capabilities).
2. Open **Admin → Plugins → Register plugin**, enter its public HTTPS base URL,
   and leave it disabled until you have reviewed its manifest and code.
3. Copy the generated dedicated secret from the plugin edit screen and store it
   on the plugin Worker with `wrangler secret put PLUGIN_SECRET`.
4. Enable the plugin and explicitly approve only the assets and delegated
   `readTypes`/`writeTypes` it needs.

> **Trust boundary:** server-side Worker separation limits database and secret
> access; it does not automatically isolate browser code. `server-only` has no
> browser surface, `sandboxed-ui` uses an opaque-origin iframe, and
> `trusted-ui` executes with CMS same-origin authority. SRI pins the reviewed
> bytes but does not make those bytes benign. Review trusted UI source, grant
> least privilege, and rotate/revoke its dedicated secret if compromised.

### Automatic tenant registration

A multi-tenant plugin Worker serves several CMS hosts and keeps one
`tenant:<cms origin>` record per host in its own `TENANTS` KV namespace, holding
that pair's secret. Steps 3 above (copy the secret by hand) becomes a button
when the plugin's manifest declares `"autoTenant": true`: **Admin → Plugins →
(plugin) → Connect plugin**. Rotating the secret re-pushes it automatically.

The handshake never puts the secret on an unauthenticated wire, and never lets a
caller talk this CMS into registering someone else:

1. The CMS mints a single-use ticket (256-bit, 5-minute TTL), stores only its
   SHA-256 in `settings`, and POSTs `{tenant, plugin_id, ticket}` plus the
   optional manifest-declared `tenant_vars` names to the plugin's
   `/__plugin/tenants/enroll`. **No secret or variable value is in this
   request.**
2. The plugin redeems the ticket by calling `POST {tenant}/__cms/tenant/claim`
   — dialing the named origin *itself*, so a request that lies about which CMS
   it is can never be redeemed. Only this response carries the secret.
3. The CMS destroys the ticket (compare-and-delete, so a wrong guess cannot burn
   a pending enrollment and two racing claims cannot both win) and audits the
   outcome as `plugin.tenant.connect`.

Requirements: `CANONICAL_ORIGIN` must be set — it is both the tenant id and the
origin the plugin verifies against — and the plugin must have a dedicated
secret. If `tenantVars` is present in the manifest, the plugin SDK copies the
matching non-empty Worker env values into the new tenant's `vars` object after
the claim; existing tenant-specific values win during rotation. **Disconnect**
asks the plugin to drop this CMS's record, authenticated with the pairwise
secret, so it can only ever remove its own row.

Plugins that expose the shared authenticated tenant configuration endpoint at
`/__plugin/tenants/config` also get editable `tenantVars` fields on this page
after the CMS is connected. The CMS reads the declared values with the
pairwise secret and sends partial `PUT` updates; blank fields remove a value.
Undeclared variables and connection fields are preserved and cannot be changed
through this UI.

### Plugin write-back authentication

Server-to-server calls from a plugin to `/__cms/*` must send:

```http
x-plugin-id: events
x-plugin-secret: <that plugin's dedicated secret>
```

Owned blueprint types are writable. Manifest `readTypes` and `writeTypes` stay
inert until an administrator approves them, including wildcard `"*"` requests.
Responses under `/__cms` use `Cache-Control: no-store`. Existing plugin rows
whose `secret` is `NULL` must be rotated in the admin before they can call this
API; they fail closed with `503 plugin_api_unavailable`.

### Authenticated file API

Plugins that declare `filePrefixes` in their manifest may request use of the
host's private `MEDIA_BUCKET` without binding that bucket into a multi-tenant
plugin Worker. A CMS administrator must approve each declared prefix in the
plugin's **Files** configuration screen first. Approval reserves that prefix
globally, including nested paths, so one plugin cannot overwrite another
plugin's folder. The API has no theme-specific behavior. The same plugin
authentication headers are required:

```http
x-plugin-id: theme-editor
x-plugin-secret: <that plugin's dedicated secret>
```

For example, a plugin that stores themes and generated documents can declare:

```json
{
  "filePrefixes": ["themes/", "plugin-data/"]
}
```

The API uses only the intersection of declared and approved prefixes; before
approval it returns `403 file_storage_not_approved`.

The generic API is:

```http
GET  /__cms/files?prefix=<approved-prefix>&delimiter=/  → list folders/files
GET  /__cms/files?key=<approved-key>                    → stream one file
HEAD /__cms/files?key=<approved-key>                    → existence check
PUT  /__cms/files?key=<approved-key>                    → write request bytes
```

`PUT` preserves the request content type and is capped at 50 MiB. List results
include `objects`, `delimited_prefixes`, `truncated`, and a continuation
`cursor` when needed. A list without `prefix` uses the first approved prefix.
Keys and list prefixes must stay inside one of the approved prefixes; traversal,
backslashes, and file keys ending in `/` are rejected. The API currently has no
delete operation; a plugin must not assume host-backed files can be removed
through this surface.

The host owns the bucket and the plugin owns only its authenticated request.
Do not add a direct `MEDIA_BUCKET` binding to a plugin that serves multiple CMS
tenants: one binding cannot select a different host's bucket per request.

### Plugin state

A plugin Worker typically serves several CMS hosts. Anything describing **one
host's** relationship with the outside world — a connected GitHub App
installation, a linked account, a per-host preference — belongs to that host,
not to the plugin: a copy kept plugin-side outlives the host it describes, is
invisible to that host's admins, and is readable by whoever operates the plugin.

`/__cms/state` is where that lives:

```http
GET    /__cms/state?prefix=github.     → { state: [{ key, value, updated_at }] }
GET    /__cms/state/github.connection  → { key, value, updated_at }  (404 if absent)
PUT    /__cms/state/github.connection    { "value": { … } }
DELETE /__cms/state/github.connection
```

Entries are namespaced by the **authenticated caller's manifest id**, taken from
the credential rather than from the request, so one plugin cannot address
another's keys. Keys match `^[a-z0-9._-]{1,64}$`, values are JSON capped at
64 KB, and a plugin may hold 100 keys. `value` is opaque — the CMS stores and
returns it without parsing.

**Not a secret store.** Rows live in D1, which is plaintext at rest. Credentials
belong in the plugin's own Worker secrets; only non-secret metadata goes here.

Unregistering a plugin drops its state along with its asset and page-type
approvals. All three are keyed by manifest id, so the cleanup needs the plugin
to be resolvable when it is deleted; removing one that is disabled or
unreachable deletes the row and logs what was left behind.

The `@lionrockjs/worker-cms-plugin` SDK wraps this as `PluginState`
(`pluginState(env, pluginId)`), which caches hits per isolate, scoped to the
tenant. A missing key reads as `null`; an unreachable host throws, so "nothing
stored" is never confused with "could not ask".

---

## Security model and release checklist

- Keep `JWT_SECRET` and OAuth client secrets in Cloudflare secrets (or
  `.dev.vars` locally), never in `wrangler.toml` or source control. Cloudflare
  account, zone, route, D1, R2, and OAuth client IDs are identifiers, not bearer
  credentials.
- Set `CANONICAL_ORIGIN` and use HTTPS. Configure `ALLOWED_EMAIL_DOMAINS` when
  the CMS is not intended to allow open viewer registration.
- Access JWTs are intentionally short-lived (15 minutes). Refresh sessions can
  be revoked immediately, but an already-issued access token can retain its
  embedded role until it expires; use a shorter TTL or a per-request session /
  authorization-version check for deployments that require immediate demotion.
- Plugin URL validation rejects obvious private-address literals, but it is not
  a complete DNS-rebinding defense. Only users with `plugin:manage` should
  register audited plugin origins.
- Run `npm test`, `npm run type-check`, and `npm audit` before release. The July
  2026 security review covered OAuth, sessions, RBAC, cross-origin mutations,
  plugins, uploads/media, rendering/CSP, structured JSON, publishing, and
  dependencies; it is not a substitute for an independent penetration test.

---

## Credits

Some actions cost **credits**, a per-user balance the host meters and charges.
Plugins declare their chargeable actions in the manifest (`credits`); an admin
sets prices under **Plugins → Credits**. `page_create` costs are charged
automatically by the host every time a page of that type is created (both the
`/__cms` write-back API and the built-in editor); `metered` costs are reported
by the plugin via `POST /__cms/credits/charge`; `recurring` costs bill reported
usage monthly through the cron sweep (see
[Recurring subscriptions](#recurring-subscriptions)). Charging is atomic and
overdraft-proof — a balance can never go below zero — and every change is
appended to the `credit_ledger` audit trail shown on the profile page.

**Managing balances (admin).** From **Users → _(a user)_ → Credits**, an admin
grants or deducts credits with a mandatory note. Deductions use the same
overdraft guard as spends.

**Transferring credits (any admin-area user).** From your own **Profile →
Credits**, you can send credits to another user by email. The move is atomic
and overdraft-guarded, and writes a paired ledger row on each side
(`transfer:send` / `transfer:receive`). Two rules apply: you cannot send to
yourself, and you cannot send to an administrator — admins manage credits
through the users admin above rather than by receiving transfers.

**Shared pool.** Besides per-user balances each currency has one site-wide
pool (`shared_credits`) with its own append-only ledger — it belongs to all users.
When a charged action costs more than the acting user's own balance, the pool
pays the **full** amount instead (all-or-nothing per pool, never split),
recorded in the shared ledger with that user as beneficiary; a spend fails
with 402 only when neither balance covers it. Credits flow **into** the pool
two ways: any user can donate their own credits from their **Profile**
(`shared:donate`, paired rows on both ledgers), and admins top it up — or
claw it back, note required — from the **Users** admin. Credits flow **out**
only through the automatic fallback above or through the privileged grant:
holders of the `credits:share` permission ("Transfer shared credits to a
user") get a **Grant from shared pool** form on a user's edit page that moves
pool credits into that user's balance (`shared:send` / `shared:receive`) —
users can never pull pool credits into their own account themselves. Admins
always hold the permission, and it can be granted to any custom role under
**Roles**.

### Currencies: credits and diamonds

There are two wallets, and they never convert into one another:

| Currency | Balance | Shared pool | For |
|---|---|---|---|
| `credit` | `credit_wallets` row | `shared_credits` row | ordinary metered actions — page creates, EDM sends |
| `diamond` | `credit_wallets` row | `shared_credits` row | premium actions the operator pays real money for — SMS and WhatsApp delivery |

A cost picks its wallet in the manifest with `"currency": "diamond"`; omitting
the field means credits, so every existing manifest keeps its meaning. An
unrecognised currency **drops** the cost rather than defaulting, so a typo can
never silently bill the wrong wallet.

Everything else is per currency and symmetric: balances, the shared pool and
its fallback, transfers, donations, admin adjustments, the ledger (each row
carries its `currency`), and recurring subscriptions (billed in whatever
currency the cost declares at sweep time). A diamond charge is refused when
the diamond balance and the diamond pool are both short — however many credits
the payer holds, and vice versa. The plugin API reports which wallet fell
short: a 402 carries `credit.currency`, so a plugin can say "buy diamonds"
rather than "buy credits". A single page type priced by two plugins in two
currencies costs both at once, all-or-nothing: if the second wallet is short,
the first is refunded before the create is refused.

The supported currency catalog lives in
`src/features/credits/currencies.ts`. The profile, user edit screen, users
admin and sidebar all render contributed wallet arrays. Balances and shared
pools are keyed by currency rows, so adding another currency needs only a
catalog entry, translations, and optional styling — no core TypeScript or SQL
change.

Balances live in `credit_wallets` (one row per user per currency), not in
columns on `users`. Fresh installs get that shape from the generated baseline.
Databases that predate it were migrated by one-off scripts that have since been
removed from the tree; a database still carrying the legacy balance columns
must copy them into `credit_wallets` by hand before deploying a Worker that
reads it. Legacy columns are simply unused afterwards, and fresh databases
never create them.

### Recurring subscriptions

A cost declared with `"charge": "recurring"` bills a plugin-reported usage
quantity once a month instead of per action. The plugin reports usage with
`POST /__cms/credits/usage`; the host keeps one `credit_subscriptions` row per
(user, plugin, cost) and the cron sweep bills due rows through the same
`spendCredits()` path as every other charge — same ledger rows, same shared-pool
fallback, same currency rules.

- `billing: "advance"` charges `ceil(quantity / per) * price` for the coming
  month, starting on the first sweep after the subscription is created.
- `billing: "arrears"` charges the **peak** usage since the last charge, one
  month after creation, so usage cannot dodge the bill by shrinking just before
  the boundary.

The sweep claims a period before spending it (advancing `next_charge_at` under
a guard on its old value), so concurrent sweeps cannot double-claim and a crash
misses a charge rather than double-billing. Insufficient credits flip the row to
`past_due` and retry daily; an unreachable plugin defers it an hour; a manifest
that no longer declares the cost cancels the row.

---

## Database schema

With every feature enabled, the generated initial migrations create **33
application D1 tables**: 31 in the private CMS database and 2 in the published
database. Live page editing also uses 2 SQLite tables inside each page's
Durable Object; these are not D1 tables.

The counts below exclude D1/SQLite internal tables and Durable Object storage,
and assume the default profile in `cms.features.json` — a smaller profile
creates fewer tables.

The migration history is flattened into one initial file per D1 database, and
these baselines are intended for **fresh databases**. Wrangler will not re-run
a modified `0001` that a database has already recorded, so an existing
installation picks up neither newly enabled features (see
[Feature profiles](#feature-profiles) for the additive-migration flow) nor the
August 2026 table rename, which has to be applied by hand.

An upgraded deployment may show additional legacy `live_*` tables in `DB`;
current CMS routes ignore those tables and use `PUBLISHED_DB` instead.

### Feature profiles

`cms.features.json` is the single switch per feature. Editing it and running
`npm run build` regenerates two things: the code registries a feature is
mounted through, and the schema its tables come from.

**Code.** `tools/build-features.mjs` writes `src/generated/` from
the profile, discovering each slice by convention (`feature.ts` exports one
`CmsFeature`; `routes.ts` / `routes/*.ts` export `*Routes`). Because those
generated files are the only thing importing a slice, dropping a feature takes
its modules out of the bundle.

**Schema.** Each feature keeps its SQL fragment next to its code —
`src/features/trash/schema.sql`, `src/features/plugins/schema.sql`, and so on —
and `tools/build-migrations.mjs` concatenates the enabled ones into the flat
files Wrangler applies:

```
src/core/schema.sql + every enabled fragment  →  migrations/0001_initial_schema.sql
src/core/publish/schema.sql                   →  migrations/published/0001_published_schema.sql
```

This exists because Wrangler allows exactly one `migrations_dir` per D1
database and has no CLI override — features cannot each own a folder that
Wrangler walks. It does **not** need extra databases: every feature shares the
same two, owning tables rather than databases.

A feature may own code, tables, or both. Ten are switchable:

| Feature | Owns |
|---|---|
| `plugins` | The plugin platform: registry, hooks, proxy, manage UI, `/__cms` API — plus `plugins`, `plugin_asset_approvals`, `plugin_file_prefix_approvals`, `plugin_page_type_approvals`, `plugin_state` (+4 indexes) |
| `credits` | Metered billing (credits and diamonds) and the credit summary screen — plus `credit_wallets`, `credit_ledger`, `shared_credits`, `shared_credit_ledger`, `credit_subscriptions` (+4 indexes) |
| `search` | The advanced-search screen and bulk actions (code only; the query builder is core) |
| `users-roles` | The user and role admin screens (code only; the tables and permission resolver are core) |
| `i18n` | The languages and translations screens (code only; see the note below) |
| `trash` | `trash_pages`, `trash_page_tags`, `trash_page_versions` (+2 indexes, 2 triggers) |
| `runtime-content-types` | `page_types`, `block_types` (+1 trigger) |
| `media` | R2 uploads, `/media` delivery, the Files browser — plus `media_files` |
| `plugin-pointer-indexes` | the 4 `idx_pages_pointer_*` expression indexes (requires `plugins`) — schema only, in its own slice directory |
| `jobs` | Durable background execution for long plugin actions and bulk page actions — the queue consumer, the runner, plus `admin_jobs` (+2 indexes) |

After editing `cms.features.json`:

```bash
npm run build
```

No code feature depends directly on another. Feature-owned runtime behavior is
composed through `src/features/services.ts`, whose concrete entries are
generated from `cms.features.json` just like `src/features/routers.ts`.
Contracts stay with their owning feature; callers use a local structural view
of a named service operation. An absent service is inert — pages are free
without `credits`, the Import/Export buttons disappear without the
import-export plugin, and the role editor lists only built-in permissions
without `plugins`. Core-wide platform hooks still use
`src/core/extensions.ts`. `feature.ts` supports `requires` for a genuine
dependency, validated by `assertFeatureRegistry` at startup; today none
declares one.

`npm run check:boundaries` enforces this. Nothing outside `src/features/` may
import a feature — not `src/core/`, not `src/routes/`, not `src/index.ts` —
and no feature may import a sibling it has not declared.
Type-only imports count, because `tsc` fails on those too: an `import type`
reaching into a feature is exactly how a feature stays undroppable while
looking clean.

A fragment is any `src/**/schema.sql` (or `*.schema.sql`) declaring
`-- feature: <id>` in its header — the id, not the path, is what
`cms.features.json` switches on. A fragment also declares its dependencies as
`-- requires: <ids>`; the assembler orders fragments accordingly and refuses a
profile that enables a feature whose dependency is off.

**Turning a feature off never drops tables.** It only stops creating them on
fresh installs, so existing data is never at risk. Conversely, a database that
already applied the baseline will not pick up a newly enabled feature from a
regenerated baseline — D1 tracks migrations by filename, so a rewritten `0001`
is skipped. Emit an additive migration instead:

```bash
npm run build:migrations -- --enable credits
```

That writes `migrations/000N_enable_credits.sql` from the same fragment. The
fragments are idempotent (`CREATE ... IF NOT EXISTS`, `INSERT OR IGNORE`), so
applying it to a database that already has the tables is a no-op.

Because all features share one `d1_migrations` table, **migration filenames
must be globally unique** — a second `0002_add_index.sql` from a different
feature would be silently treated as already applied. Prefix migration files
with the feature id.

`npm run check:profiles` executes every profile against an in-memory SQLite and
verifies each feature is removable without breaking the rest; it runs as part
of `npm test`.

`locales` and `locale_messages` are **core**, not a fragment: the admin chrome
resolves the viewer's locale on every render, so the CMS cannot serve a page
without them. The optional part is the `i18n` *code* feature — the screens for
editing locales and translations. Serving the UI's own catalog
(`GET /admin/i18n/catalog/:locale`) stays core too.

The credits fragment owns `credit_wallets`, both ledgers, shared pools, and
subscriptions. Disabling the feature therefore leaves no credit-specific
objects in a fresh core-only database.

#### Deleting a feature's source

Switching a feature off keeps its code in the tree (out of the bundle, but
still there to read and audit). To remove it outright, delete the directory
**and** its key in `cms.features.json` — with the key still listed,
`build:migrations` refuses the build rather than silently treating the feature
as schema-only:

```bash
rm -rf src/features/trash
```

Then drop `"trash"` from `cms.features.json` and run `npm run build`. Every
switchable feature now has a directory to delete, so this works for all of
them. One detail: `plugin-pointer-indexes` declares `-- requires: plugins`, so
dropping the platform means dropping that slice in the same edit.

A key listed with no directory *and* no schema fragment fails the build rather
than being treated as a code-free feature — that is deliberate, because a
silently ignored key is how a table goes missing.

Views go with the slice: a feature's Liquid sections, template maps, snippets,
browser scripts and locale fragments live in `src/features/<id>/views/`, and
`npm run build:views` assembles only the enabled ones into `dist/views/` (what
wrangler uploads). Turning a feature off drops its screens and its translations
from the bundle without deleting anything.

What deletion does not clean up: the feature's `test/*.test.ts`. Remove those by
hand.

### CMS database (`DB`) — 30 tables

The private schema is divided into five feature categories:

- **Content (13)**
  - Page lifecycle: `pages`, `page_versions`, `trash_pages`, `trash_page_versions`
  - Classification: `taxonomies`, `tags`, `page_tags`, `trash_page_tags`
  - Content model and media: `page_types`, `block_types`, `media_files`
  - Localization: `locales`, `locale_messages`
- **Identity and access (5)**
  - `users`, `user_oauth_identities`, `sessions`, `roles`, `role_permissions`
- **Credits (5)**
  - `credit_wallets`, `credit_ledger`, `shared_credits`, `shared_credit_ledger`, `credit_subscriptions`
- **Plugin (7)**
  - `plugins`, `plugin_asset_approvals`, `plugin_file_prefix_approvals`, `plugin_page_type_approvals`, `plugin_state`, `settings`, `admin_jobs`
- **Compliance (1)**
  - `audit_log`

`admin_jobs` is grouped with Plugin because it coordinates long-running plugin
admin actions, although it also runs advanced-search bulk actions. The general
`settings` table is grouped there because it stores runtime CMS and plugin
configuration.

### Published database (`PUBLISHED_DB`) — 3 tables

| Table | Purpose |
|-------|---------|
| `pages` | Published page metadata and structured `lect` content |
| `page_tags` | Published page ↔ tag relationships |
| `tags` | Published tag catalogue (name, slug, weight, `taxonomy_slug`, `lect`) |

The three tables carry the same names and shapes as their `DB` counterparts, so
a published database can be handed to another host as its working set (publish
A → B, then B → C). `taxonomies` deliberately stays CMS-only: published pages
group by tag, and the grouping key travels on the tag as `taxonomy_slug`.
`tags` is written only by the publish path — tag create, edit and delete push
immediately, so a rename reaches readers without republishing every page that
uses it, and **Admin → Tags → Sync published** backfills a database whose
catalogue predates this table. Rows here are partitioned by writer: this Worker only
upserts and deletes rows keyed by uuids it minted, while external submission
Workers are INSERT-only. See [`src/core/publish/README.md`](src/core/publish/README.md).

Keeping public content in this separate database allows a public Worker to read
published pages without receiving access to users, sessions, drafts, trash,
plugin configuration, or other private CMS state.

### Live editing Durable Object — 3 tables per page object

| Table | Purpose |
|-------|---------|
| `lww_field_ops` | Unsaved per-user LWW register operations for ordinary form fields; a disconnect can remove that user's uncommitted values |
| `crdt_text_docs` | Compacted Yjs state for Markdown richtext fields; concurrent insert/delete operations merge and remain until save |
| `presence` | Currently connected editors and their last-seen/last-active state |

These tables are created by `PageSyncDO` in Durable Object SQLite storage, not
by the D1 migration directories. A save serializes the converged richtext HTML
through the normal form handler, appends the page version, then clears both live
overlays. Connected editors then initialize a fresh Yjs document epoch from the
committed Markdown, so later incremental updates do not depend on discarded
history. Unlike ordinary LWW values, a disconnected user's Yjs operations are
not selectively removed: removing causally integrated sequence operations would
break CRDT semantics. They remain visible for another editor to save.

### Publish / un-publish flow

```
                       ┌──▶  d1      PUBLISHED_DB.pages (default)
DB.pages ── Publish ───┼──▶  r2      PUBLISH_BUCKET pages/<uuid>.json + index.json
                       └──▶  plugin  /__plugin/publish/* (IPFS, webhooks, …)
```

Publish builds one snapshot from `DB.pages` (page row, denormalized tag links,
and the tag rows behind them) and fans it out to every configured
**publish target**; un-publish and page
deletion remove the page from every target the same way. See
[Publish targets](#publish-targets).

The default `d1` target upserts the snapshot into `PUBLISHED_DB.pages` by
`uuid`, preserving the draft page's numeric `id`, and replaces its `page_tags`
links; un-publish deletes both. The same write also upserts the tags that page
uses into `PUBLISHED_DB.tags`, under the CMS's own tag ids — a published
`page_tags.tag_id` only resolves because both databases agree on the id. Tag
edits push on their own too, so a rename reaches readers without republishing
every page that carries the tag, and a tag delete removes the catalogue row
along with its links.

**Data minimization.** A plugin may declare `contentTypes.publishLect` rules
for page types it owns — `keep` (allow-list) or `drop` (deny-list) of top-level
`lect` fields — so PII, operational history, or secrets never reach the
published database or any other target. The same projection is applied to the
draft side wherever draft and live are compared, so projected types do not show
as permanently "modified since publish".

**Submission mirrors are never published or unpublished.** A published row
without a draft counterpart is ingested back into `DB.pages` as a submission
(cron-driven, or on demand via `POST /__cms/ingest/submissions`) and fires the
`submission` hook; publishing one would overwrite the original live row and
unpublishing one would delete it, so both are refused before reaching an
adapter.

## Publish targets

Publishing is adapter-based (`src/core/publish/`). Built-in targets are selected with
the `PUBLISH_TARGETS` var (comma-separated, defaults to `"d1"`):

| Target | Requires | What it does |
|--------|----------|--------------|
| `d1` | `PUBLISHED_DB` binding | Upserts `pages` / `page_tags` / `tags` in the published database (the original flow) |
| `r2` | `PUBLISH_BUCKET` binding | Writes static JSON: `pages/<uuid>.json` (full snapshot, `lect` parsed) plus `index.json` (listing of all live pages) |

```toml
[[r2_buckets]]
binding = "PUBLISH_BUCKET"
bucket_name = "worker-cms-published"

[vars]
PUBLISH_TARGETS = "d1,r2"
```

**Plugin targets** are not listed in `PUBLISH_TARGETS`; any plugin whose
manifest declares `publishTarget: true` automatically receives publish traffic
using that registration's dedicated secret. Two ready-to-deploy plugins:

- [`plugin-publish-ipfs`](https://github.com/zeroxcms/plugin-publish-ipfs) — pins
  each published page to IPFS via the Pinata API, tracks `uuid → CID` in KV so
  un-publish unpins.
- [`plugin-publish-webhook`](https://github.com/zeroxcms/plugin-publish-webhook) —
  forwards publish events to external URLs as HMAC-signed JSON webhooks (search
  indexers, static-site rebuilds, deploy hooks).

The contract is three POST endpoints, JSON body, `x-plugin-secret` header:

| Endpoint | Body | When |
|----------|------|------|
| `/__plugin/publish/page` | `{ page, tags, tagCatalogue, publishedAt }` | page published (`tagCatalogue` holds the full tag rows behind `tags`) |
| `/__plugin/publish/remove` | `{ uuid }` | page unpublished or deleted |
| `/__plugin/publish/tags` | `{ tags }` | tags created or edited (optional — a 404 is ignored) |
| `/__plugin/publish/remove-tag` | `{ tagId }` | tag deleted (optional — a 404 is ignored) |

All targets are awaited on publish; per-target failures are logged and reported
in the editor flash message (`Page published, but these targets failed: …`)
without blocking the targets that succeeded.

The admin UI's publish-status badges read live state from the first configured
target that supports reads (`d1`, or `r2` when `d1` is absent). Plugin targets
are write-only.

---

## Project structure

The codebase is split along one line: **`core/` is what every deployment has,
`features/` is what a deployment chooses.** Nothing in `core/` imports a
feature implementation or feature-owned contract. Installed feature routers
and runtime services are selected by generated registries, while genuinely
core-wide platform hooks use `core/extensions.ts`.
`tools/check-boundaries.mjs` enforces this and fails the build when it is
violated; see [Feature profiles](#feature-profiles) for the switch that turns
features on and off.

```
├── cms.features.json      # One switch per feature — the profile for this deployment
├── migrations/            # GENERATED from the schema.sql fragments; do not edit
│   ├── 0001_initial_schema.sql
│   └── published/0001_published_schema.sql
├── tools/                 # Node-side generators and guards; never shipped
│   ├── build-features.mjs     # cms.features.json -> src/generated/*
│   ├── build-migrations.mjs   # schema.sql fragments -> migrations/*
│   ├── build-views.mjs        # views/ fragments -> dist/views/*
│   ├── check-boundaries.mjs   # import-layering rules
│   ├── check-profiles.mjs     # every feature profile executes and is removable
│   ├── write-if-changed.mjs   # generator helper: only rewrite changed output
│   └── install.mjs            # `npm run setup` wizard
├── src/
│   ├── index.ts           # Worker entry: fetch, queue, scheduled, DO exports
│   ├── types.ts           # Env bindings and shared content types
│   ├── cms-config.ts      # Compiled base blueprint, blocks and taxonomies
│   ├── core/              # Never optional
│   │   ├── extensions.ts  # What core will call if a feature provides it
│   │   ├── feature.ts     # The CmsFeature manifest contract
│   │   ├── schema.sql     # Core tables (users, pages, tags, roles, locales…)
│   │   ├── views/         # The core slice of the view tree — layout, sections,
│   │   │                  #   template maps, snippets, locales, browser scripts
│   │   ├── templates/     # Server renderers for the core admin screens
│   │   ├── http/          # Headers, rate limit, request context, D1 sessions, forms
│   │   ├── auth/          # JWT, sessions, cookies, guards, roles, permissions
│   │   ├── db/            # Page/tag stores, lect, search, settings, content
│   │   │                  #   config, audit log, submission ingest, validation
│   │   ├── render/        # Liquid, layout, admin chrome (buildBaseProps/renderPage)
│   │   ├── pages/         # Bulk page actions (publish/unpublish/trash a set)
│   │   ├── publish/       # Draft -> live pipeline and the d1/r2 adapters
│   │   └── durable-objects/  # PageSyncDO (live editing), FormOnceDO (form tokens)
│   ├── generated/         # GENERATED feature registries; do not edit
│   ├── features/          # Optional; each directory is one switchable feature
│   │   ├── plugins/       # The plugin platform: registry, hooks, proxy,
│   │   │                  #   manage UI, and the /__cms write-back API
│   │   ├── credits/       # Metered billing and the credit summary screen
│   │   ├── search/        # Advanced search screen and bulk actions
│   │   ├── media/         # R2 uploads, /media delivery, the Files browser
│   │   ├── trash/         # Soft-delete holding area
│   │   ├── jobs/          # Queue-backed runner for long admin/plugin actions
│   │   ├── runtime-content-types/  # Admin for DB-defined page/block types
│   │   ├── i18n/          # Languages and translations admin
│   │   ├── plugin-pointer-indexes/ # Schema-only slice: pointer expression indexes
│   │   └── users-roles/   # User and role administration
│   └── routes/            # The composition root: the only hand-written code
│       ├── auth.ts        #   that mounts feature routers and calls feature
│       └── admin/         #   services. OAuth 2.1 login / callback / logout /
│                          #   refresh, and the capability-protected admin
│                          #   routes (pages, tags, settings, profile, JSON API)
├── assets-source/         # Sources compiled into dist/views/assets/ — kept OUT
│   ├── admin.css          #   of the view tree because wrangler serves the
│   ├── richtext-md.js     #   assets directory publicly. tailwind-sources.css
│   └── tailwind-sources.css  # is GENERATED by build:views from the profile,
│                          #   so the stylesheet prunes disabled features
├── dist/views/            # GENERATED by `npm run build:views`: src/core/views
│                          #   plus the enabled features'. This is the directory
│                          #   wrangler uploads — never edit it.
├── dictionary/            # Generated OpenCC tables for Chinese search
├── package.json
├── tsconfig.json
└── wrangler.toml
```

### A feature directory

Every feature reads the same way, so a slice is self-describing:

```
src/features/trash/
├── feature.ts     # The CmsFeature manifest: id, requires, navKeys, baseProps
├── routes.ts      # Admin router (or routes/<name>.ts when it owns several)
├── template.ts    # Server renderer (or templates/<name>.ts)
├── schema.sql     # Its tables, declaring `-- feature: trash`
└── views/         # Its Liquid sections, template maps, snippets, browser
                   #   scripts and locale fragments — same layout as
                   #   src/core/views, merged into dist/views when enabled
```

`feature.ts` is the only thing core sees. Routers are registered separately
(`src/features/routers.ts`) because a router reaches back into the admin chrome
through `renderPage`, and listing them alongside the manifests would make the
import graph cyclic.

A feature may depend on another only by declaring it in `requires`, which is
validated at startup and enforced by the boundary guard. **Today no code feature
declares one.** Each slice installs alone and an absent one is inert:

| Would-be dependency | How it is avoided instead |
|---|---|
| `users-roles` → `credits` | The wallet panels arrive as contributed base props through the generated feature-service registry |
| `users-roles` → `plugins` | Plugin-contributed permissions reach the role editor the same way; without `plugins` it lists only built-in ones |
| `credits` → `plugins` | Priced actions cross the service boundary as untrusted structural shapes the credits feature validates itself |
| `runtime-content-types` → `plugins` | The "owned by" column reads core's `contentTypeContributors` |
| `search` → the import/export provider | The CSV export button reads `importExportHrefs` and hides when nobody provides it |

The only real declared dependency anywhere is in schema: the
`plugin-pointer-indexes` fragment states `-- requires: plugins`, so a profile
that enables it without the plugin platform fails the build. (The credits
fragment's `-- requires: core` is a no-op — `core` is implicit and ignored by
the assembler.)
