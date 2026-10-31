import type { CmsFeature } from '../../core/feature';
import { getCreditBalances, getSharedCreditBalances } from './service';
import { userIdFromContext } from '../../core/http/forms';
import { loadShowCredits } from '../../core/db/settings';
import { recordWalletReads } from './read-audit';
import {
  CREDIT_CURRENCIES,
  creditCurrencyDefinition,
} from './currencies';

/**
 * Metered billing: balances, the ledger, transfers and the shared pool. The
 * screens that host a credits panel (profile, users) belong to core and to the
 * users-roles feature; this feature contributes their props and owns the forms
 * they post to, so neither has to know credits exist.
 *
 * Dropping it from the registry contributes no sidebar wallets and takes the
 * credits engine out of every admin route's import
 * graph — see tools/check-boundaries.mjs.
 */
export const creditsFeature: CmsFeature = {
  id: 'credits',
  // No `requires`: priced actions arrive through the generated feature-service
  // registry, so this installs alone. With nothing contributing, every action
  // is free and the summary is empty — balances, transfers and the shared pool
  // still work.
  navKeys: ['credits'],
  async baseProps(c) {
    if (!await loadShowCredits(c.env)) return { showCredits: false, sidebarWallets: [] };
    const [balances, shared] = await Promise.all([
      getCreditBalances(c.env, userIdFromContext(c)),
      getSharedCreditBalances(c.env),
    ]);
    recordWalletReads(userIdFromContext(c));
    return {
      showCredits: true,
      sidebarWallets: CREDIT_CURRENCIES.flatMap((currency) => {
        const definition = creditCurrencyDefinition(currency);
        const userBalance = balances?.[currency] ?? 0;
        const sharedBalance = shared[currency];
        if (!definition.showInSidebarWhenEmpty && userBalance === 0 && sharedBalance === 0) return [];
        return [{
          currency,
          userBalance,
          sharedBalance,
          unitKey: `credits.unit.${currency}`,
          icon: definition.sidebarIcon,
          className: definition.sidebarClass,
        }];
      }),
    };
  },
};
