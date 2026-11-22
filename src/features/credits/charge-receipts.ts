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
