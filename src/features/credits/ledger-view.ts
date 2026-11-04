// Display shape for credit ledger rows, shared by every screen this feature
// contributes a credits panel to (the profile page and the users admin).

import type { CreditLedgerRow } from './service';

/** The display-relevant columns shared by credit_ledger and shared_credit_ledger rows. */
type CreditLedgerViewSource = Pick<CreditLedgerRow, 'delta' | 'balance_after' | 'action' | 'note' | 'created_by' | 'created_at'>;

export interface UserCreditLedgerRow {
  delta: string;
  isSpend: boolean;
  balanceAfter: number;
  action: string;
  note: string;
  createdBy: string;
  createdAt: string;
}

/** Reservation correlation belongs in stored evidence; retain the existing
 * visible batch breakdown and empty single-create/refund notes. Other notes
 * remain ordinary user/provider text, including unrelated JSON. */
function visibleLedgerNote(note: string | null): string {
  if (!note?.startsWith('{"record_type":"cms.page-create-reservation.v1",')) return note ?? '';
  try {
    const metadata = JSON.parse(note);
    if (typeof metadata.operation_id !== 'string' || Object.keys(metadata).some(key => !['record_type','operation_id','breakdown'].includes(key))) return note;
    return metadata.breakdown === undefined ? '' : JSON.stringify(metadata.breakdown);
  } catch { return note; }
}

/** Maps a credit_ledger or shared_credit_ledger row to the display shape
 *  shared by the users admin and the profile page. */
export function creditLedgerRowForView(row: CreditLedgerViewSource): UserCreditLedgerRow {
  return {
    delta: row.delta > 0 ? `+${row.delta}` : String(row.delta),
    isSpend: row.delta < 0,
    balanceAfter: row.balance_after,
    action: row.action,
    note: visibleLedgerNote(row.note),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
