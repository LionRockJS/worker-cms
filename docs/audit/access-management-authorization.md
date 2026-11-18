# Transaction-bound access-management authorization

Local W4b continuation, 2 November 2026. The preceding host authentication-denial implementation is committed on `main` as `5656af1`. This increment covers user role assignment/deletion and custom role creation, grant replacement and deletion. W4b remains open; this record is repository evidence, not deployed acceptance.

## Authority at the write boundary

`captureAccessAuthorization()` reads the actor's current stored role, managed role names/builtin flags and complete stored grant pairs in one D1 batch. It derives authority using the same resolver as ordinary permission checks, preserving unmanaged built-in defaults, managed overrides, legacy orphan grants and administrator behavior. The fresh map replaces any earlier request permission cache for subsequent target checks.

The first statement of each covered business/evidence batch checks the captured actor role, session ownership, JWT expiry, session expiry and absolute session lifetime. It also checks exact role/grant catalogue equality, including counts and same-count replacements. Revocation, demotion, required-grant loss, stronger target grants or changes to implicit built-in management after the snapshot prevent a stale write. Existing target, last-administrator, business-state and exact evidence guards remain in the same transaction.

The catalogue comparison includes role names/builtin flags and grant pairs, not labels or timestamps. An unrelated authority-catalogue change can conservatively refuse the operation. Catalogue serialization and comparison costs need deployment-specific capacity verification. The guard checks authority at batch admission: a legitimate operation may then reduce its own grants or demote its actor. There is no old-authority postcondition that vetoes that authorized reduction.

Core role-store mutations require the corresponding captured management authorization and execute its guard. Grant replacement/deletion also enforce the delegated permission ceiling directly, covering callers outside the HTTP routes. This contract is for trusted host callers with an authenticated actor; it does not independently authenticate arbitrary supplied JWT claims. Case-normalized administrator targets and reserved role names receive the same protections as ordinary names.

## Durable object-policy refusals

Named user/role policy refusals now await `permission.denied` evidence through the existing exact primary-write/outbox fallback contract. Reasons cover stronger target/requested roles, excessive grants, locked/built-in roles, self-deletion, last-administrator protection and loss of the management capability before capture. Detail contains only a bounded host reason and registered route pattern. Target names, labels, submitted forms and private path parameters are excluded; existing authenticated actor/classification rules apply.

Both-store evidence failure preserves refusal as generic 503/no-store. A guard/transport failure is reported as unavailable with the existing incomplete coarse incident when configured; it is not falsely classified as a proven policy denial. A lost commit acknowledgment still requires state/event reconciliation before retrying. See the [denial record](authentication-denial-evidence.md) and [mutation record](w4b-durable-mutation-evidence.md).

## Validation and remaining scope

The 55 new regressions cover successful delegated mutations, concurrent actor/session/catalogue changes, same-count grant swaps, target authority changes, fresh request-cache use, authorized self-reduction, named private refusals, mixed-case reserved identities, primary/outbox failure and direct-store proof/permission ceilings. Existing role-store/evidence tests also exercise the required authorization contract.

Validation: the final serial suite passed **1,652 tests across 74 files**, including 55 new authorization regressions. Build, TypeScript, feature-profile, import-boundary, generated consistency and whitespace checks passed. The full-suite log contains no cancellation, uncaught-exception or unhandled-error diagnostic. These are local results, not deployed acceptance.

Classification remains resolved before the transaction; broader classification/policy-version and approval checks remain open. Other content, plugin/service and external mutations, general operation identities and cross-store recovery remain W4b work. This increment adds no schema or regulated-write bypass. Production migration, deployment, schedule/receiver configuration, retention/capacity/recovery acceptance and compliance sign-off were not performed.

## Subsequent classification-version checks

The [policy-version continuation](classification-policy-version.md) supersedes the earlier pre-transaction classification limitation for the covered access-management routes. Core authorization captures a classification generation and rechecks it in the admission guard, including direct role stores. The route evidence additionally records/checks its explicit classification generation. Classification changes now use the same authority mechanism for `menu:manage`. Other approvals/policy versions and mutation families remain open.
