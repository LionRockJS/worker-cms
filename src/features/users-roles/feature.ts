import type { CmsFeature } from '../../core/feature';

/**
 * User and role administration: the Users screen and the Roles/permissions
 * editor. The credits panel on both screens is contributed by the credits
 * feature, not owned here.
 *
 * Core owns the role tables, picker options, and permission resolution.
 * Existing roles and grants continue to apply when the administration
 * screens and their role store are disabled.
 */
export const usersRolesFeature: CmsFeature = {
  id: 'users-roles',
  // No `requires`: contributed permissions and the credits panels both arrive
  // through core's extension points, so this installs with neither feature.
  navKeys: ['users', 'roles'],
};
