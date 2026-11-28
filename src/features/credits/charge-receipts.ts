import { abortIf } from '../../core/db/transaction-guard';
import type { Env } from '../../types';
import type { CreditSource } from './balances';
import type { CreditCurrency } from './currencies';

export interface ChargeReceiptKey {
  pluginId: string;
  chargeId: string;
  fingerprint: string;
}

interface ChargeResponse {
  ok: true;
  charged: number;
  currency: CreditCurrency;
  balance: number | null;
  source?: CreditSource;
}

export async function readChargeReceipt(env: Env, key: ChargeReceiptKey) {
  const row = await env.DB.prepare(
    'SELECT fingerprint, response FROM plugin_charge_receipts WHERE plugin_id = ? AND charge_id = ?',
  ).bind(key.pluginId, key.chargeId).first<{ fingerprint: string; response: string }>();
  if (!row) return null;
  if (row.fingerprint !== key.fingerprint) return { conflict: true } as const;
  return { conflict: false, response: JSON.parse(row.response) as ChargeResponse } as const;
}

/** Add to the same batch as the debit, before the wallet changes. The debit
 * eligibility predicate also guards the receipt. A duplicate key rolls back
 * the batch, including any preceding ledger write. */
export function insertChargeReceipt(
  env: Env,
  key: ChargeReceiptKey,
  userId: number,
  currency: CreditCurrency,
  amount: number,
  source?: CreditSource,
  eligible = '1',
  eligibilityArgs: unknown[] = [],
): D1PreparedStatement {
  const balance = `(SELECT COALESCE(wallet.balance, 0) - ?
    FROM users LEFT JOIN credit_wallets wallet ON wallet.user_id = users.id AND wallet.currency = ?
    WHERE users.id = ?)`;
  const response = `json_object('ok', json('true'), 'charged', ?, 'currency', ?, 'balance', ${balance}${source ? ", 'source', ?" : ''})`;
  return env.DB.prepare(
    `INSERT INTO plugin_charge_receipts (plugin_id, charge_id, fingerprint, response)
     SELECT ?, ?, ?, ${response} WHERE ${eligible}`,
  ).bind(key.pluginId, key.chargeId, key.fingerprint, amount, currency,
    source === 'user' ? amount : 0, currency, userId, ...(source ? [source] : []), ...eligibilityArgs);
}

/** After a successful debit, the receipt must reflect the user's current wallet
 * balance even when the plugin or shared wallet paid. */
export function verifyChargeReceipt(env: Env, key: ChargeReceiptKey, userId: number, currency: CreditCurrency,
  amount: number, source?: CreditSource): D1PreparedStatement {
  return abortIf(env, `NOT EXISTS (SELECT 1 FROM plugin_charge_receipts WHERE plugin_id = ? AND charge_id = ?
    AND fingerprint = ? AND json_type(response, '$.ok') = 'true'
    AND json_extract(response, '$.charged') IS ? AND json_extract(response, '$.currency') IS ?
    AND json_type(response, '$.balance') IS NOT NULL AND json_extract(response, '$.balance') IS
      (SELECT COALESCE(w.balance, 0) FROM users u LEFT JOIN credit_wallets w ON w.user_id = u.id AND w.currency = ? WHERE u.id = ?)
    AND (SELECT COUNT(*) FROM json_each(response)) = ${source ? 5 : 4}
    ${source ? "AND json_extract(response, '$.source') IS ?" : ''})`,
  [key.pluginId, key.chargeId, key.fingerprint, amount, currency, currency, userId, ...(source ? [source] : [])]);
}
