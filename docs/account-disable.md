# Disable an account and reuse its sign-in identities

A signed-in user can disable their own account from **Profile → Disable account**.
The acknowledgment and confirmation explain that access to this account will be lost.
The operation retains the account record, roles, email and existing content. It marks
`users.disabled_at`, replaces the legacy primary OAuth key, removes all linked OAuth
identities, and revokes all sessions atomically with durable audit outbox evidence.
Disabled accounts cannot authenticate, refresh sessions, or authorize new mutations.
There is no self-service reactivation.

To reuse a released identity, sign in to the destination account and choose **Connect**
for its provider on the Profile page. Complete provider authentication to link it.
An identity owned by an active account remains unavailable for linking elsewhere.
No data or roles are transferred between accounts. The retained email remains reserved;
an ordinary sign-in does not merge accounts based on matching email addresses.

Fresh installations include `disabled_at` in the generated baseline. Before deploying
to an existing database, apply `migrations/manual/2026-11-14_account_disable.sql` once.
This migration is separate from the account IP access upgrade.
