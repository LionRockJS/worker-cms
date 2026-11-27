# Plugin view loading

Plugins → Edit → View loading selects how the host obtains a plugin's static
Liquid and JSON views. Existing registrations default to **Host**, which fetches
files from the plugin Worker as before. Browser URLs and authentication remain
on the CMS origin in all modes. Dynamic page data, actions and approved JS/CSS
assets continue using their existing plugin routes.

**Bucket (R2 cache)** stores each successful static view response on its first
fetch and reads it from R2 on later requests. Configure a dedicated private R2
bucket on the CMS Worker before selecting this option. `npm run setup` offers
an optional plugin view cache when the plugins feature is enabled. It creates or
reuses `<namespace>-plugin-views` (customizable) and adds `PLUGIN_VIEWS_BUCKET`
to `wrangler.toml`, including configs that predate this option. Local setup adds
the binding for local R2 simulation without creating Cloudflare resources.
Declining leaves any existing binding unchanged. Host remains the default for
each plugin; provisioning the bucket does not switch plugin settings.

For manual configuration:

```toml
[[r2_buckets]]
binding = "PLUGIN_VIEWS_BUCKET"
bucket_name = "cms-plugin-views"
```

Bucket mode is stored as `cmsViewSource: "bucket"` in the plugin's existing
config JSON; an absent setting defaults to Host. No database migration is required. The setting applies
to browser-fetched admin templates and the server-side plugin snippet fallback.
Missing bindings and R2 failures fall back to fetching from the plugin.

Bucket mode is for static source files; it explicitly overrides the plugin
SDK's default `no-store` template header. Do not select it for views whose source
changes with live application data. Cookie-bearing responses, redirects, errors
and executable assets are never cached. Redirect aliases to shared CMS snippets
continue to resolve normally.

Cache keys include registration identity, plugin URL, credential, exact request
headers, view URL and plugin revision. Credentials and request identity are
hashed in keys. Authenticated and public view routes cannot share entries. Every
browser view request still passes the host's authorization and disclosure audit.
Objects contain only source bytes and content type, not page data or response
cookies. Plugin revisions use Worker version metadata where available, otherwise
manifest version. Bump that version whenever views change; plugins without a
revision bypass bucket caching. Old objects can be removed using an R2 lifecycle
rule for `plugin-views/` (for example after 30 days), causing a fresh fill on the
next request. Switching back to Host immediately bypasses bucket reads.

This reduces plugin Worker requests for static files. It does not bypass the CMS
Worker or make the private bucket public, and the plugin must still be reachable
for manifest resolution and dynamic page requests.


## Local files (self-hosted)

Both `server.mjs` and `server-workerd.mjs` inject a read-only
`PLUGIN_LOCAL_VIEWS` disk binding when the server `.env` contains:

```dotenv
PLUGIN_VIEWS_DIR=/srv/cms/plugin-views
```

In the Docker image, set `PLUGIN_VIEWS_DIR` (and `PLUGIN_VIEWS_NGINX`) in
`cms.env` instead, and bind-mount the directory read-only at that path, for
example `- /srv/cms/plugin-views:/srv/cms/plugin-views:ro` under the service's
`volumes` in `compose.yaml`. Recreate the container to apply it.

Restart the server (or regenerate standalone workerd configuration) and select
**Local files** in the plugin setting. The choice is saved as
`cmsViewSource: "local"`. It is unavailable without the disk binding. The CMS
streams files directly by default; Nginx is optional. Cloudflare deployments
continue to use Host or Bucket.

Copy the plugin's static `views/` contents into:

```text
/srv/cms/plugin-views/<manifest-id>/<revision>/templates/*.json
/srv/cms/plugin-views/<manifest-id>/<revision>/sections/*.liquid
/srv/cms/plugin-views/<manifest-id>/<revision>/snippets/**/*.liquid
/srv/cms/plugin-views/<manifest-id>/<revision>/locales/*.json
```

Use the revision reported by the plugin's Worker metadata, falling back to its
manifest version. The CMS chooses the revision from the manifest, never from
the browser query string. Install the new revision's files before deploying the
plugin. Keep this directory limited to trusted static view source. Changes to
static views require a new revision. Dynamic data and actions still use the
plugin Worker. Missing files, read failures and missing revisions fall back to
the plugin, preserving redirects/aliases to shared host snippets.

### Optional Nginx delivery

The expandable setup panel in Plugins → Edit includes the configuration below.
Put these locations inside the existing HTTPS server block. The alias must point
to the same directory mounted by `PLUGIN_VIEWS_DIR` (including when Nginx and the
CMS run in separate containers). Then set `PLUGIN_VIEWS_NGINX=true` in the server
`.env` and restart/regenerate the configuration. Leave that flag false or unset
when accessing the CMS directly or using a tunnel without Nginx.

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header CF-Connecting-IP $remote_addr;
    proxy_ignore_headers X-Accel-Redirect;
}

location ~ ^/admin/plugins/[a-z][a-z0-9-]*/views/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header CF-Connecting-IP $remote_addr;
    proxy_cache off;
}

location ^~ /_plugin_views/ {
    internal;
    alias /srv/cms/plugin-views/;
    types {
        application/json json;
        text/plain liquid;
    }
    default_type text/plain;
    add_header X-Content-Type-Options nosniff always;
    add_header Cache-Control "private, no-cache" always;
}
```

The CMS still performs authentication, plugin access checks and disclosure audit.
It checks file existence through a local HEAD request and returns a validated
`X-Accel-Redirect: /_plugin_views/<manifest-id>/<revision>/<view-path>`.
Nginx performs internal delivery; a direct request to `/_plugin_views/` returns
404. Server-side snippet resolution always reads source bytes from the disk
binding instead of returning an internal redirect. A missing file falls back to
the plugin. External plugin view responses cannot supply `X-Accel-Redirect`.
Keep the CMS backend port reachable only from the reverse proxy and do not
configure a shared cache for authenticated view responses. Preserve any existing
WebSocket proxy settings when merging these locations into your deployment.

Nginx references: [internal locations](https://nginx.org/en/docs/http/ngx_http_core_module.html#internal),
[alias](https://nginx.org/en/docs/http/ngx_http_core_module.html#alias),
[upstream header handling](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ignore_headers).
