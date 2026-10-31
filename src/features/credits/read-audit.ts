import { recordTableReads } from '../../core/http/access-log';
import type { AuditActor } from '../../core/db/audit';
import { CREDIT_CURRENCIES, type CreditCurrency } from './currencies';

/** Wallets use composite keys; even a zero/default balance discloses that wallet's state. */
export function recordWalletReads(userId: number | null, currencies: readonly CreditCurrency[] = CREDIT_CURRENCIES, actor?: AuditActor): void {
  if (userId !== null) recordTableReads('credit.wallet-read', 'credit_wallets', currencies.map(currency => `${userId}:${currency}`), actor);
  recordTableReads('credit.pool-read', 'shared_credits', currencies, actor);
}
