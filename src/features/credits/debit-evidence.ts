import type { Env } from '../../types';
import { serviceMutationAuditEvidence, type AuditActor } from '../../core/db/audit';
import { classFor, strongestClass, type DataClassMap } from '../../core/db/data-classes';
import { abortIf } from '../../core/db/transaction-guard';
import type { AppContext } from '../../core/http/context';
import type { CreditSource, DebitSettlement } from './balances';
import { insertChargeReceipt, verifyChargeReceipt, type ChargeReceiptKey } from './charge-receipts';
import type { CreditCurrency } from './currencies';

export interface DebitEvidence {
  actor: AuditActor;
  policy: DataClassMap;
  action: 'credit.metered-charge' | 'credit.subscription-settlement';
  target: string;
  detail: Record<string, unknown>;
  checks?: () => D1PreparedStatement[];
  context?: AppContext;
}

const wallets = {
  user: { table: 'credit_wallets', ledger: 'credit_ledger', ownerField: 'user_id' },
  shared: { table: 'shared_credits', ledger: 'shared_credit_ledger', ownerField: null },
  plugin: { table: 'plugin_credits', ledger: 'plugin_credit_ledger', ownerField: 'plugin_id' },
} as const;

export async function debitWithEvidence(env: Env, input: {
  source: CreditSource;
  owner?: string | number;
  userId: number;
  currency: CreditCurrency;
  amount: number;
  action: string;
  createdBy: string;
  entityType?: string;
  entityId?: string;
  pluginId?: string;
  note?: string;
  receipt?: ChargeReceiptKey;
  settlement?: DebitSettlement;
}, evidence: DebitEvidence): Promise<number | null> {
  const { DB: db } = env;
  const { table, ledger, ownerField } = wallets[input.source];
  const where = ownerField ? `${ownerField} = ? AND currency = ?` : 'currency = ?';
  const walletKey = ownerField ? [input.owner!, input.currency] : [input.currency];
  const eligible = `${where} AND balance >= ? AND EXISTS (SELECT 1 FROM users WHERE id = ?)
    ${input.settlement ? `AND (${input.settlement.eligible})` : ''}`;
  const eligibleArgs = [...walletKey, input.amount, input.userId, ...(input.settlement?.bindings ?? [])];
  const wallet = await db.prepare(`SELECT balance FROM ${table} WHERE ${eligible}`).bind(...eligibleArgs).first<{ balance: number }>();
  if (!wallet) return null;
  const balanceAfter = wallet.balance - input.amount;
  const classes = [table, ledger, 'users', ...(input.receipt ? ['plugin_charge_receipts', 'credit_wallets'] : []),
    ...(input.settlement ? ['credit_subscriptions'] : []), ...(evidence.checks ? ['plugins', 'plugin_identity_approvals'] : [])];
  const dataClass = strongestClass([
    ...classes.map(key => classFor(evidence.policy, 'table', key)),
    classFor(evidence.policy, 'plugin', input.pluginId ?? String(input.owner ?? '')),
  ]);
  const receipt = serviceMutationAuditEvidence(env, { action: evidence.action, entityType: 'credit_charge', entityId: evidence.target,
    detail: { ...evidence.detail, billed_user_id: input.userId, amount: input.amount, currency: input.currency,
      source: input.source, balance_after: balanceAfter } }, evidence.actor, dataClass, evidence.policy, evidence.context);
  const ledgerValues = {
    user_id: input.userId, currency: input.currency, delta: -input.amount, balance_after: balanceAfter,
    action: input.action, entity_type: input.entityType ?? null, entity_id: input.entityId ?? null,
    plugin_id: input.source === 'plugin' ? input.owner! : input.pluginId ?? null,
    note: input.note ?? null, created_by: input.createdBy,
  };
  const fields = Object.keys(ledgerValues);
  const values = Object.values(ledgerValues);
  await db.batch([
    ...(evidence.checks?.() ?? []),
    abortIf(env, `NOT EXISTS (SELECT 1 FROM ${table} WHERE ${eligible} AND balance IS ?)`, [...eligibleArgs, wallet.balance]),
    receipt.write, receipt.guard,
    ...(input.receipt ? [
      insertChargeReceipt(env, input.receipt, input.userId, input.currency, input.amount, input.source),
      abortIf(env, 'changes() <> 1'),
    ] : []),
    db.prepare(`UPDATE ${table} SET balance = ? WHERE ${eligible} AND balance IS ?`)
      .bind(balanceAfter, ...eligibleArgs, wallet.balance),
    abortIf(env, 'changes() <> 1'),
    ...(input.settlement ? [input.settlement.advance, abortIf(env, 'changes() <> 1')] : []),
    db.prepare(`INSERT INTO ${ledger} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).bind(...values),
    abortIf(env, `changes() <> 1 OR NOT EXISTS (SELECT 1 FROM ${ledger}
      WHERE id = last_insert_rowid() AND ${fields.map(field => `${field} IS ?`).join(' AND ')})`, values),
    abortIf(env, `NOT EXISTS (SELECT 1 FROM ${table} WHERE ${where} AND balance IS ?)`, [...walletKey, balanceAfter]),
    ...(input.receipt ? [verifyChargeReceipt(env, input.receipt, input.userId, input.currency, input.amount, input.source)] : []),
    ...(input.settlement?.verify ? [input.settlement.verify] : []),
    ...(evidence.checks?.() ?? []),
    receipt.verify(),
  ]);
  return balanceAfter;
}
