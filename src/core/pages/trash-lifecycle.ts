import type { Env, JWTPayload } from '../../types';
import type { AuditActor } from '../db/audit';
import type { AppContext } from '../http/context';
import type { ContentBatchContext } from './batch-mutation-evidence';

/** Trusted service adapter, constructed by the credential-owning feature.
 * The trash service never resolves contributor credentials or manufactures a CMS user. */
export interface ServiceTrashAuthority {
  actor: AuditActor;
  check: () => D1PreparedStatement[];
  allows: (pageType: string) => boolean;
  dataClass: 'none'|'pii'|'phi';
  detail: Record<string,unknown>;
  before?: () => D1PreparedStatement[];
  after?: () => D1PreparedStatement[];
  request: AppContext;
}
/** Page identity and metadata for publication withdrawal and lifecycle hooks. */
export interface TrashedPageRef {
  id: number;
  uuid: string;
  name: string;
  slug: string;
  page_type: string | null;
  submission_origin: number;
}

export interface TrashLifecycleService {
  mutatePageLifecycle(
    env: Env,
    user: JWTPayload,
    action: 'trash',
    selection: { ids: number[] },
    context: ContentBatchContext,
  ): Promise<{ count: number; pages: TrashedPageRef[] }>;
  trashPagesAsService(
    env: Env,
    authority: ServiceTrashAuthority,
    ids: number[],
  ): Promise<{ count: number; pages: TrashedPageRef[] }>;
}

export class PageLifecycleUnavailableError extends Error {constructor(readonly rollbackKnown=false){super('Page lifecycle change unavailable');}}
