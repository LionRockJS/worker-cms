# Plugin API features and limits

This document describes the plugin contract implemented by this CMS host.
The optional `plugins` feature provides the server-to-server `/__cms` API and
the host-to-plugin manifest, admin, editor, hook and publication integrations.
The implementation in [the API router](../src/features/plugins/api/index.ts)
and [manifest types](../src/features/plugins/types.ts) is authoritative.

## Authentication and approvals

Send `x-plugin-id: <manifest id>` and `x-plugin-secret: <registration secret>`
on `/__cms` requests. Use the connected CMS's canonical URL. The host resolves
an enabled, approved plugin registration and checks that registration's own
secret; the host's legacy environment `PLUGIN_SECRET` is not accepted inbound.
This API uses plugin credentials rather than a browser session.

Writes can address types owned through `contentTypes.blueprint` and declared
`contentTypes.writeTypes` approved by an administrator. Reads additionally
include approved `contentTypes.readTypes`. A declared delegated scope has no
effect until approved under **Plugins → plugin → Page types**. An approved
`*` grants access to concrete types; do not send `*` as a page's `page_type`.

`x-acting-user-id` can carry user attribution or identify a credit payer where
supported. It does not authenticate a user or grant that user's permissions;
guarded mutation evidence identifies the credential-authenticated plugin and
records user assertions separately.

Automatic connection uses `autoTenant: true`, the plugin's enrollment/revocation
handlers and `POST /__cms/tenant/claim`. Claim is the exception to secret
authentication: it requires a single-use, plugin-bound enrollment ticket, valid
for five minutes. The host returns the tenant identity, CMS URL and pairwise
secret. Optional `tenantVars` declares safe plugin environment variable names
for the SDK's tenant setup; the host does not send their values.

## Plugin-to-CMS endpoints

All paths below are relative to `/__cms`. JSON requests should send
`Content-Type: application/json`; file PUT sends the raw object body.

| Method and path | Features |
| --- | --- |
| `GET /pages` | List one required `page_type`, with `limit`/`offset`, text query `q`, parent `page_id`, pointer, scalar, range and ID/slug filters. Optional `fields` projection, `include_tags=1`, `include_live_status=1` and `count=0`. |
| `POST /pages/list-batch` | Body `{ queries: [...] }`. Multiple keyed type lists, each with `key`, `page_type`, `limit`, `sort`, `order`; optional scalar/range/ID filters and taxonomy grouping via `group_by`. |
| `POST /pages/search` | Structured criteria across readable types, AND/OR matching, sorting, page-based pagination and optional `include_tags: true`. Use `GET /content-meta` for searchable paths. |
| `GET /pages/:id` | Read a scoped draft page with parsed `lect`. |
| `POST /pages` | Create a page with required `page_type`; supports name, slug, structured `lect`, parent, scheduling, weight and tag IDs. |
| `POST /pages/batch` | Body `{ pages: [...] }`. Create pages across writable types; returns `created`, indexed `errors` and `count`. |
| `PUT /pages/:id`, `PATCH /pages/:id` | Equivalent partial updates, merging `lect`; can update metadata and tag associations. Optional `if_lect` requires an exact stored-lect precondition. |
| `PATCH /pages/batch` | Body `{ pages: [{ id, lect, version_action? }, ...] }`. Merge partial lect for each page; returns `updated`, indexed `errors` and `count`. |
| `POST /pages/duplicate` | Copy a type's collection selected by source parent or pointer; supports target parent, `drop_lect`, lect overrides and resumable `cursor`. Returns `count`, `next_cursor`, `done`. |
| `POST /pages/publish` | Body `{ ids: [...] }`. Publish scoped draft pages to configured targets; reports indexed failures, including failed targets. |
| `DELETE /pages/:id` | Move a scoped page to trash and attempt publication withdrawal separately. |
| `DELETE /pages/batch` | Body `{ ids: [...] }`. Trash a bounded set of scoped pages. |
| `DELETE /pages/children` | Select by `page_type` and `parent_page_id` or pointer filters. Returns `trashed` and `done`; repeat while `done` is false. Published copies are not withdrawn by this endpoint. |
| `GET /content-meta` | Readable page types, languages, default language, taxonomy names/slugs and searchable `path_specs`; optional `types` filter. |
| `POST /tags/ensure` | Body `{ tags: [{ taxonomy, name }, ...] }`. Find or create tags by taxonomy slug and name; requires write scope. |
| `GET /limits` | Effective declared quotas and usage. Supply `page_id` for parent usage or `pointer_value` for pointer usage; otherwise scoped usage is `null`. |
| `POST /ingest/submissions` | Run bounded, resumable ingestion of published-only submissions into draft. Requires the manifest's `submission` hook. |
| `GET /state` | List this plugin's host-owned state, optionally filtered by `prefix`. |
| `GET /state/:key` | Read one state entry; missing entries return 404. |
| `PUT /state/:key` | Store `{ value: <JSON> }`. Wire reads return the serialized JSON value in the entry's `value` field. |
| `DELETE /state/:key` | Delete an entry; deleting a missing entry succeeds. |
| `GET /sequences/:key` | Read this plugin's counter; an unused counter reads as zero. |
| `POST /sequences/:key/next` | Atomically increment and return a counter; first value is one. |
| `GET /files` | List approved storage prefixes using `prefix`, optional `/` delimiter, `limit` and continuation `cursor`. With `key`, download one object instead. |
| `HEAD /files?key=...` | Read object metadata without its body. |
| `PUT /files?key=...` | Write an object to an approved prefix in the host's `MEDIA_BUCKET`. No file-delete endpoint is provided. |

Page reads address draft data. `include_live_status` adds publication status to
full list rows, not projected rows. `include_tags` also requires full list rows.
Creates, updates, copies and deletion use the host's page history, audit and
lifecycle machinery. Batch lect updates omit live editor Page Sync notifications.

## Enforced request and storage limits

| Operation or resource | Limit and behavior |
| --- | --- |
| General request body | 5 MiB, unless an exception below applies; oversized bodies return HTTP 413 `body_too_large`. Actual streamed bytes are counted. |
| Enrollment claim body | 4 KiB. |
| State request body | 72 KiB; the stored JSON value has the smaller 64 KiB limit below. |
| File upload body | 16 MiB. |
| Page list | Default 50 rows, clamped to 1–500; paginate with `offset`. `count=0` skips the total query and returns `total: -1`. |
| Advanced search | Default 20 rows, clamped to 1–500; `page` starts at 1. |
| Batched lists | At most 20 queries and a combined requested limit of 500 pages; each query requests 1–500. Oversize returns 413 `batch_too_large`. |
| Create, lect-update, publish and ID-delete batches | At most 100 input items; oversize returns 413 `batch_too_large`. |
| Collection duplication | At most 1,000 copies per request, committed in chunks of 100. Resume with `next_cursor` until `done`. |
| Children deletion | At most 1,000 pages per request, committed in chunks of 100. Repeat the selector until `done`. |
| Tag provisioning | At most 200 input tags per request. |
| Tag associations | At most 5,000 distinct valid tag IDs on single create/update input. |
| List lookup filters | At most 500 IDs and 500 slugs; batched lists accept at most 500 IDs per query. |
| List pointer filters | Validation accepts at most 500 distinct values; SQL uses individual binds, so the deployment's database parameter limit may require smaller groups. |
| Scalar field filters | At most 50 distinct values for a regular list, or 50 supplied values per batched-list query. |
| Plugin state | At most 100 distinct keys per plugin. Keys match `^[a-z0-9._-]{1,64}$`; each serialized UTF-8 JSON value is at most 64 KiB. New keys at capacity return 409 `too_many_keys`; overwrites remain allowed. |
| Plugin sequences | At most 1,000 counters per plugin; same key syntax as state. New counters at capacity return 409 `too_many_sequences`; existing counters can still advance. |
| File paths and listing | Normalized UTF-8 path at most 1,024 bytes; no traversal or backslashes. List limit must be 1–1,000, default 1,000. Only `/` is accepted as a delimiter. |
| Submission ingestion | Scans at most 40 source rows and creates at most eight draft pages per invocation; resumes using the host's stored cursor. |
| Manifest permissions | Only the first 32 entries are considered; valid values use the plugin's own `<id>:<suffix>` namespace. |

Limits are implemented in [request body handling](../src/core/http/body-limit.ts),
[page routes](../src/features/plugins/api/pages.ts),
[state storage](../src/features/plugins/state.ts),
[sequences](../src/features/plugins/sequences.ts),
[file routes](../src/features/plugins/api/files.ts),
[tag provisioning](../src/features/plugins/tag-ensure-evidence.ts) and
[submission ingestion](../src/core/db/submission-ingest.ts).

## Configurable quotas and credits

Manifest `limits` can declare page quotas with `total`, `per_parent` or
`per_pointer` scope. The host enforces these during creation, including copies.
An administrator's configured value overrides the manifest default; `null`
means unlimited, and an omitted default is unlimited until configured.
Requests exceeding a quota return 409 `limit_exceeded` with a `violation`.
Candidates without a parent or matching pointer are outside that scoped quota.
`per_second` is an operational limit returned to the plugin for its own
enforcement, rather than a host-enforced API request rate.

When the optional `credits` feature is enabled, it adds:

| Method and path | Features and limits |
| --- | --- |
| `GET /credits` | Effective declared prices and balances. |
| `GET /credits/quote` | Quote a declared key and quantity; quantity 1–1,000,000. |
| `POST /credits/charge` | Charge a declared `metered` key; quantity 1–1,000,000 and `x-acting-user-id` required. Insufficient funds return 402 `insufficient_credits`. |
| `POST /credits/usage` | Report a declared `recurring` key for a user; quantity 0–1,000,000,000. |
| `GET /credits/subscriptions` | Read this contributor's subscriptions, optionally filtered by user. |

The host handles `page_create` charges through its creation pipeline; plugins
should not charge those a second time. Recurring usage is billed by the host's
sweep. Prices and currencies come from host configuration, not plugin requests.
See [the credits routes](../src/features/credits/routes/contributor-api.ts).

## CMS-to-plugin integration

| Manifest capability | Host behavior and restrictions |
| --- | --- |
| Manifest and tenant discovery | Fetches `GET /__plugin/manifest`; supports automatic tenant enrollment and credential rotation/revocation. Plugin IDs match `^[a-z][a-z0-9-]{0,63}$`. |
| Content types and fields | Contributes blueprints, reusable blocks, taxonomy configuration, publish-lect projections and field snippets. |
| Browser trust level | `server-only` has no browser UI; `sandboxed-ui` uses an opaque-origin iframe and cannot declare custom editor/read views; `trusted-ui` permits approved assets and views on the CMS origin. Legacy manifests default to `trusted-ui`. |
| Admin navigation and permissions | Proxies authenticated `/__plugin/admin/...` under `/admin/plugins/<id>` and exposes valid plugin permissions for role assignment. |
| Custom editors and readers | `newViews`, `editViews`, `readViews` replace the corresponding host view for declared types. |
| Lifecycle hooks | Declared `create`, `submission`, `update`, `publish`, `unpublish`, `delete` notifications go to the plugin's hook handlers. They are asynchronous notifications, not a transaction spanning Workers. |
| Publish targets | `publishTarget: true` receives awaited page/remove publication calls, with optional tag catalogue/remove-tag handlers. Target failures are reported to the admin/API caller. |
| Automatic publication | `autoPublishTypes` opts declared types into the host's automatic publication behavior. |
| View delivery | Host, bucket cache or local view sources; see [plugin view loading](plugin-view-loading.md). Serve both public `/__plugin/views/...` for server resolution and authenticated `/__plugin/admin/views/...` for client views. |
| Browser assets | Declare assets in the manifest and obtain admin approval with pinned SRI before JavaScript/CSS can execute. Inline JavaScript is blocked by the host CSP. |
| Tenant files | Declare `filePrefixes` and obtain separate approval. Overlapping prefix reservations are refused; each key/list prefix must stay inside an approved prefix. |

## Failure handling and boundaries

Inspect batch `errors` even on successful HTTP responses: valid rows can be
applied while invalid rows are reported by input index. Chunked operations and
external publication effects are not one all-or-nothing transaction. Preserve
acknowledged progress and reconcile an uncertain commit before retrying.

Common failures include 400 for malformed input, 403 `forbidden` for a wrong
secret, 403 `forbidden_page_type` for an unapproved type, 404 for missing pages
or state, 409 `version_conflict` for a failed update precondition, and 413 for
size/batch limits. File access can return 403 `file_storage_not_enabled` or
`file_storage_not_approved`, and 501 `file_storage_unavailable` without a bucket.

Optional features and deployment policy can restrict the available operations.
Regulated mode currently holds business mutations, ingestion and recurring
billing; audit/classification failures can also refuse otherwise authorized
operations. See [the regulated profile](audit/regulated-profile.md).

Host state is opaque JSON for host-owned settings and relationships, not a
credential store; use plugin Worker secrets for credentials. State is removed
when the plugin is unregistered, while sequence counters deliberately survive
unregistration to prevent number reuse. The API does not expose arbitrary SQL
or unrestricted access to another plugin's data or file prefixes.
