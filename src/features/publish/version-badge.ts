import type { UiTranslator } from '../../core/i18n';
import { escHtml } from '../../core/render/layout';

/** The read-only history is rendered on the server. */
export function renderLiveVersionBadge(t: UiTranslator): string {
  return ` <span class="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-green-700">${escHtml(t('view_strings.sections_editor.live', 'Live'))}</span>`;
}
