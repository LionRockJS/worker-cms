// GET /admin/settings/credits — chargeable actions and effective prices
// across installed plugins, plus their creation limits.
//
// Extracted from routes/admin/settings.ts, where it sat between the branding
// and language screens for no reason other than sharing a URL prefix.

import { Hono } from 'hono';
import type { Env, Variables } from '../../../types';
import { renderPage } from '../../../core/render/chrome';
import { userCan } from '../../../core/auth/permissions';
import { coreExtensions, type ContributedLimitSummary } from '../../../core/extensions';
import {
  creditContributors,
  creditUnitLabel,
  currencyLabel,
  currencyUnitKey,
  effectiveCreditsFor,
  type EffectiveCredit,
} from '../service';
import { creditSummaryPage, type CreditSummaryRow, type LimitSummaryRow } from '../template';
import { recordContributorReads } from '../../../core/http/access-log';

export const creditSettingsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

function creditSummaryChargeLabel(credit: EffectiveCredit): string {
  if (credit.def.charge === 'page_create') return `On create: ${credit.def.pageType}`;
  if (credit.def.charge === 'recurring') {
    return `Monthly (${credit.def.billing}) per ${creditUnitLabel(credit.def)}`;
  }
  return `Metered per ${credit.def.unit}`;
}

function creditSummaryChargeKey(credit: EffectiveCredit): string {
  if (credit.def.charge === 'page_create') return 'credits.summary.on_create';
  if (credit.def.charge === 'recurring') {
    return credit.def.billing === 'arrears' ? 'credits.summary.monthly_arrears_per' : 'credits.summary.monthly_advance_per';
  }
  return 'credits.summary.metered_per';
}

function limitSummaryScopeLabel(def: ContributedLimitSummary): string {
  if (def.scope === 'per_second') return 'Per second';
  if (def.scope === 'per_parent') return 'Per parent page';
  if (def.scope === 'per_pointer') return `Per ${def.pointerKey}`;
  return 'Total';
}

function bySummaryOrder(
  a: { pluginLabel: string; label: string; key: string },
  b: { pluginLabel: string; label: string; key: string },
): number {
  return a.pluginLabel.localeCompare(b.pluginLabel)
    || a.label.localeCompare(b.label)
    || a.key.localeCompare(b.key);
}

creditSettingsRoutes.get('/settings/credits', async (c) => {
  const [contributors, limits] = await Promise.all([
    creditContributors(c.env),
    coreExtensions().limitSummaries?.(c.env) ?? [],
  ]);

  const rows: CreditSummaryRow[] = (await Promise.all(contributors.map(async (contributor) => {
    const credits = await effectiveCreditsFor(c.env, contributor);
    const pluginLabel = contributor.name || contributor.id;
    return credits.map((credit) => ({
      pluginLabel,
      pluginId: contributor.id,
      key: credit.def.key,
      label: credit.def.label,
      description: credit.def.description,
      chargeLabel: creditSummaryChargeLabel(credit),
      chargeKey: creditSummaryChargeKey(credit),
      chargeValue: (credit.def.charge === 'page_create' ? credit.def.pageType : creditUnitLabel(credit.def)) ?? '',
      currency: credit.def.currency,
      currencyKey: currencyUnitKey(credit.def.currency),
      effectiveLabel: credit.value === 0 ? 'Free' : `${credit.value} ${currencyLabel(credit.def.currency)}`,
      effectiveFree: credit.value === 0,
      effectiveValue: credit.value,
      manageHref: contributor.manageHref ?? '',
    }));
  }))).flat().sort(bySummaryOrder);

  const limitRows: LimitSummaryRow[] = limits.map((limit) => ({
    pluginLabel: limit.contributorLabel,
    pluginId: limit.contributorId,
    key: limit.key,
    label: limit.label,
    description: limit.description,
    scopeLabel: limitSummaryScopeLabel(limit),
    scopeKey: limit.scope === 'per_second'
      ? 'credits.summary.per_second'
      : limit.scope === 'per_parent'
        ? 'credits.summary.per_parent_page'
        : limit.scope === 'per_pointer'
          ? 'credits.summary.per'
          : 'credits.summary.total',
    scopeValue: limit.scope === 'per_pointer' ? (limit.pointerKey ?? '') : '',
    effectiveLabel: limit.value === null ? 'Unlimited' : `${limit.value}`,
    effectiveUnlimited: limit.value === null,
    effectiveValue: limit.value,
    manageHref: limit.manageHref,
  })).sort(bySummaryOrder);

  const pluginCount = new Set([...rows, ...limitRows].map((row) => row.pluginId)).size;
  recordContributorReads('plugin.credit-metadata-read', rows.map(row => row.pluginId));
  const paidCount = rows.filter((row) => !row.effectiveFree).length;

  return renderPage(c, creditSummaryPage, {
    rows,
    limitRows,
    pluginCount,
    chargeCount: rows.length,
    paidCount,
    // Everyone may view the summary; only plugin managers see the edit links.
    canConfigure: await userCan(c, 'plugin:manage'),
  });
});

