import type { Env } from '../../types';
import { getSetting, SHOW_CREDITS_SETTING_KEY } from '../../core/db/settings';

/** Display preference only; pricing and charging remain independent. */
export async function loadShowCredits(env: Env): Promise<boolean> {
  return await getSetting(env, SHOW_CREDITS_SETTING_KEY) !== 'false';
}
