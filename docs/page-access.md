# Page access storage

Page permissions live in two private-database tables keyed by the page UUID, never inside the page's `lect` JSON:

- `page_access_policies` — one row per enrolled page: `owner_id`, `enabled`, `group_role`, the three-digit `mode` (owner / group / others, each `0`, `4` or `6`, as in Unix file modes) and an optimistic-concurrency `revision`.
- `page_edit_grants` — the named editors, one `(page_uuid, user_id)` row each.

A page without an enabled policy row keeps site-wide role-based access. The legacy `pages.creator` and `pages.editors` columns are read only as the fallback owner and as the editor labels offered for conversion on enrollment. Usage and the UI are described in the README under **Page access**.

## Why not a `lect` key such as `_permission_mode`

The `_` prefix in `lect` marks keys the CMS reserves (`_type`, `_weight`, `_pointers`, `_blocks`), but `lect` as a whole is page content. Two content behaviours make it the wrong place for permissions:

1. **Restoring a version would roll permissions back.** Every save snapshots `lect` into `page_versions`, and any editor can restore an older version. If permissions were in `lect`, revoking a named editor today and restoring last week's version would silently re-grant them. A content operation must never undo an access decision.

2. **Anyone who can edit content could change access.** A page's `lect` is written by everyone with edit rights, through several paths: the editor form, plugin write-back through `/__cms`, CSV import, field copy/paste, and live collaborative editing. A named editor could submit `_permission_mode: 666` or make themselves owner, and every current and future write path would need to strip the key. As separate tables, the only writer is the page access route, which requires the owner or a site admin, records a `page.access.change` audit event, and checks `revision` so concurrent changes cannot overwrite each other.

Keeping the tables separate also stops permissions from reaching the published database or being copied by duplicate/export, and lets SQLite enforce valid modes (`CHECK`), remove grants when a user is deleted (`ON DELETE CASCADE`), and index grants by user for access-filtered page lists.

This mirrors Linux: permission bits and ACLs belong to the inode (the file's record), not to the file's data blocks. Here `lect` is the data, and the policy row is the inode-side record.
