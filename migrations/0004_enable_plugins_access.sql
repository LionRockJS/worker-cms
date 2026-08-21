-- ============================================================
-- Additive migration: preserve plugin admin access under the two-key gate.
--
-- Reaching a plugin's admin pages now requires BOTH the CMS-side
-- `plugin:access` permission and one of that plugin's own declared permissions
-- (see src/features/plugins/routes/admin-proxy.ts). Before this, a plugin's
-- declared permission alone was enough — so a role granted, say,
-- `checkin:door` could reach the check-in admin without holding
-- `plugin:access`. Those roles would lose access on deploy.
--
-- This grants `plugin:access` to exactly the roles that could already reach a
-- plugin admin: any role holding a permission that is not one of the built-ins
-- listed below is, by definition, holding a plugin-declared one. Access is
-- preserved as it stands today and nothing is widened — every one of these
-- roles could already pass the old gate.
--
-- Idempotent (INSERT OR IGNORE) and a no-op on a fresh install, whose
-- role_permissions table is empty. Keep the built-in list in step with
-- PERMISSIONS in src/types.ts if a new built-in is ever added *before* this
-- migration has been applied everywhere; afterwards it is history and must not
-- be edited.
-- ============================================================

INSERT OR IGNORE INTO role_permissions (role, permission)
SELECT DISTINCT role, 'plugin:access'
FROM role_permissions
WHERE permission NOT IN (
    'content:read', 'content:write', 'content:publish', 'content:delete', 'content:import',
    'trash:restore', 'trash:purge', 'tag:write', 'taxonomy:write', 'media:upload',
    'plugin:access', 'plugin:manage', 'menu:manage', 'pagetype:write', 'blocktype:write',
    'users:manage', 'roles:manage', 'credits:share'
);
