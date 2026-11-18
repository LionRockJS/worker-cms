// Read-only page view: the same structured content the editor shows, rendered
// as static text instead of form inputs. See routes/admin/pages.ts
// (GET /pages/:id/read). Server-rendered to a plain HTML string body — no
// client-side snippet loading, CRDT, or presence — so it is safe to show a page
// without any risk of accidental edits.

import { adminLayout, escHtml, type BaseTemplateProps } from '../render/layout';
import {
  renderStructuredEditor,
  type ItemGroupRenderModel,
  type PageFieldRenderModel,
  type StructuredEditorRenderModel,
} from './editor';
import type { Page, PageVersion, Tag, Taxonomy } from '../../types';
import type { BlueprintProps, Lect } from '../db/lect';
import type { CmsConfig } from '../../cms-config';
import type { UiTranslator } from '../i18n';

type ItemRowRenderModel = ItemGroupRenderModel['rows'][number];

/** A value cell: the text, or a muted em dash when empty. Always escaped. */
function textValue(value: string | null | undefined): string {
  const text = (value ?? '').toString();
  if (!text.trim()) return '<span class="text-gray-400">&mdash;</span>';
  return `<span class="whitespace-pre-wrap break-words">${escHtml(text)}</span>`;
}

/** One field rendered as a static label + read-only value box. Link/date fields
 *  surface their extra parts (label, url, from/until, timezone) below the value. */
function readPageField(field: PageFieldRenderModel, t: UiTranslator): string {
  const primary = (field.value ?? '').toString();
  const values = field.data.values;
  const extraDefs: Array<[string, string | undefined]> = [
    [t('read.label', 'Label'), values.label],
    [t('read.url', 'URL'), values.url],
    [t('read.from', 'From'), values.start],
    [t('read.until', 'Until'), values.end],
    [t('read.timezone', 'Timezone'), values.timezone],
  ];
  const extrasHtml = extraDefs
    .filter(([, value]) => value && value !== primary)
    .map(
      ([label, value]) =>
        `<div class="mt-1 text-xs text-gray-500"><span class="font-medium text-gray-400">${escHtml(label)}:</span> ${escHtml(String(value))}</div>`,
    )
    .join('');

  return `<div class="min-w-0">
    <p class="mb-1 text-sm font-medium text-gray-700">${escHtml(field.label)}</p>
    <div class="min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800">${textValue(primary)}${extrasHtml}</div>
  </div>`;
}

function readFieldGrid(fields: PageFieldRenderModel[], t: UiTranslator): string {
  if (!fields.length) return '';
  return `<div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">${fields.map((field) => readPageField(field, t)).join('')}</div>`;
}

function readFieldSet(
  fields: PageFieldRenderModel[],
  itemGroups: ItemGroupRenderModel[],
  includeItems: boolean,
  t: UiTranslator,
): string {
  const fieldsHtml = readFieldGrid(fields ?? [], t);
  if (!includeItems) return fieldsHtml;
  const groups = (itemGroups ?? []).map((group) => readItemGroup(group, t)).join('');
  return fieldsHtml + groups;
}

function readItemGroup(group: ItemGroupRenderModel, t: UiTranslator): string {
  const rows = group.rows.length
    ? group.rows.map((row) => readItemRow(row, t)).join('')
    : `<p class="text-sm text-gray-400">${escHtml(t('read.no_items', 'No items.'))}</p>`;
  return `<div class="mt-4 min-w-0 space-y-4 rounded-lg border border-gray-100 bg-gray-50 p-4">
    <p class="min-w-0 break-words text-sm font-semibold text-gray-700">${escHtml(group.name)}</p>
    ${rows}
  </div>`;
}

function readItemRow(row: ItemRowRenderModel, t: UiTranslator): string {
  const settings = row.hasSettings
    ? `<div class="space-y-3"><p class="text-xs font-semibold uppercase tracking-wide text-gray-400">${escHtml(t('view_strings.snippets_structured_editor.settings', 'Settings'))}</p>${readFieldSet(row.settingsFields, row.itemGroups, false, t)}</div>`
    : '';
  const content = readFieldSet(row.contentFields, row.itemGroups, true, t);
  return `<div class="min-w-0 space-y-3 rounded-lg border border-gray-200 bg-white p-4">
    <span class="min-w-0 text-xs text-gray-400">${escHtml(row.label)}</span>
    ${settings}${content}
  </div>`;
}

function readStructured(model: StructuredEditorRenderModel, t: UiTranslator): string {
  const settingsLabel = escHtml(t('view_strings.snippets_structured_editor.settings', 'Settings'));
  const settings = model.hasSettings
    ? `<section class="min-w-0 space-y-3">
        <p class="text-sm font-semibold text-gray-700">${settingsLabel}</p>
        ${readFieldSet(model.settingsFields, model.itemGroups, false, t)}
      </section>`
    : '';

  const blocks = model.hasBlocks
    ? model.blocks
        .map(
          (block) => `<div class="min-w-0 space-y-4 rounded-lg border border-gray-200 p-4">
            <p class="min-w-0 break-words text-xs font-semibold uppercase tracking-wide text-gray-500">${escHtml(block.name)}</p>
            ${
              block.hasSettings
                ? `<div class="space-y-3"><p class="text-xs font-semibold uppercase tracking-wide text-gray-400">${settingsLabel}</p>${readFieldSet(block.settingsFields, block.itemGroups, false, t)}</div>`
                : ''
            }
            ${readFieldSet(block.contentFields, block.itemGroups, true, t)}
          </div>`,
        )
        .join('')
    : `<p class="text-sm text-gray-400">${escHtml(t('read.no_blocks', 'No blocks.'))}</p>`;

  return `${settings}
  <div class="min-w-0 space-y-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
    <p class="text-sm font-semibold text-gray-700">${escHtml(t('view_strings.snippets_structured_editor.content', 'Content'))}</p>
    ${readFieldSet(model.contentFields, model.itemGroups, true, t)}
    <div class="space-y-4 border-t border-gray-100 pt-5">
      <p class="text-sm font-semibold text-gray-700">${escHtml(t('view_strings.snippets_structured_editor.blocks', 'Blocks'))}</p>
      ${blocks}
    </div>
  </div>`;
}

/** Trims a stored 'YYYY-MM-DD HH:MM:SS' timestamp to minute precision for display. */
function displayDate(value: string | null | undefined): string {
  const text = (value ?? '').toString().trim();
  return text ? text.slice(0, 16) : '';
}

function editorChips(editors: string | null | undefined): string[] {
  return (editors ?? '')
    .split(',')
    .map((editor) => editor.trim())
    .filter(Boolean);
}

export async function readPage(
  views: Fetcher,
  opts: BaseTemplateProps & {
    page: Page;
    modifierName?: string;
    version?: PageVersion;
    isVersionPreview?: boolean;
    liveVersionId?: number;
    parentPages: Page[];
    tags: Tag[];
    taxonomies: Taxonomy[];
    selectedTagIds: number[];
    /** Where the back arrow returns to (e.g. a plugin dashboard). Defaults to /admin. */
    backHref?: string;
    /** Server-side UI-string lookup (see uiTranslator); labels fall back to English. */
    t: UiTranslator;
    /** Resolved editor display names (see fetchEditorUsers); falls back to raw ids. */
    pageAccessHref?: string;
    canEdit?: boolean;
    editorUsers?: Array<{ id: number; name: string }>;
    structured: {
      config: CmsConfig;
      language: string;
      lect: Lect;
      blueprintProps: BlueprintProps;
      blockProps: Record<string, BlueprintProps>;
      blockNames: string[];
      versions: PageVersion[];
    };
  },
): Promise<string> {
  const {
    page,
    modifierName,
    version,
    isVersionPreview = false,
    liveVersionId,
    parentPages,
    tags,
    taxonomies,
    selectedTagIds,
    backHref = '/admin',
    structured,
    t,
  } = opts;

  const model = renderStructuredEditor(structured);
  const language = structured.language;
  const pageTitle = `View: ${page.name}`;
  const editHref = `/admin/pages/${page.id}/edit`;
  const readBase = `/admin/pages/${page.id}/read`;
  const versionParam = isVersionPreview && version ? `&version=${version.id}` : '';

  // Language switcher: static links, since there is nothing to submit.
  const languageLinks = model.languageOptions
    .map(
      (option) =>
        `<a href="${escHtml(`${readBase}?language=${encodeURIComponent(option.value)}${versionParam}`)}"
           class="inline-flex items-center rounded-lg border px-2.5 py-1 text-xs ${
             option.selected
               ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
               : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
           }">${escHtml(option.value)}</a>`,
    )
    .join('');

  // Header metadata.
  const parent = parentPages.find((candidate) => candidate.id === page.page_id);
  const parentLabel = parent ? `/${parent.slug}` : '';
  const chips = opts.editorUsers?.map((editor) => editor.name) ?? editorChips(page.editors);
  const editorsHtml = chips.length
    ? chips
        .map(
          (editor) =>
            `<span class="inline-flex items-center rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">${escHtml(editor)}</span>`,
        )
        .join(' ')
    : '<span class="text-gray-400">&mdash;</span>';

  const metaItem = (label: string, valueHtml: string) =>
    `<div class="min-w-0">
      <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">${escHtml(label)}</dt>
      <dd class="mt-0.5 min-w-0 break-words text-sm text-gray-800">${valueHtml}</dd>
    </div>`;

  const metaGrid = [
    metaItem(t('view_strings.sections_editor.slug', 'Slug'), textValue(`/${page.slug}`)),
    metaItem(t('read.type', 'Type'), textValue(page.page_type ?? 'default')),
    metaItem(t('read.weight', 'Weight'), textValue(String(page.weight))),
    metaItem(t('read.parent', 'Parent'), textValue(parentLabel)),
    metaItem(t('read.from', 'From'), textValue(displayDate(page.start))),
    metaItem(t('read.until', 'Until'), textValue(displayDate(page.end))),
    metaItem(t('read.timezone', 'Timezone'), textValue(page.timezone)),
    metaItem(t('view_strings.sections_editor.editors', 'Editors'), `<div class="flex flex-wrap gap-1.5">${editorsHtml}</div>`),
    metaItem(t('view_strings.sections_editor.last_modified_by', 'Last modified by'), textValue(modifierName ?? '')),
  ].join('');

  // Selected tags grouped by taxonomy.
  const selected = new Set(selectedTagIds);
  const tagGroups = taxonomies
    .map((taxonomy) => {
      const groupTags = tags.filter((tag) => tag.taxonomy_slug === taxonomy.slug && selected.has(tag.id));
      if (!groupTags.length) return '';
      const chipsHtml = groupTags
        .map(
          (tag) =>
            `<span class="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-sm text-gray-700">${escHtml(tag.name)}</span>`,
        )
        .join(' ');
      return `<div class="min-w-0 space-y-2">
        <p class="min-w-0 break-words text-xs font-semibold uppercase tracking-wide text-gray-400">${escHtml(taxonomy.name)}</p>
        <div class="flex flex-wrap gap-2">${chipsHtml}</div>
      </div>`;
    })
    .filter(Boolean)
    .join('');
  const tagsSection = tagGroups
    ? `<div class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
        <p class="mb-3 text-sm font-medium text-gray-700">${escHtml(t('view_strings.sections_editor.tags', 'Tags'))}</p>
        <div class="space-y-4">${tagGroups}</div>
      </div>`
    : '';

  // Version history — links open each version read-only.
  const versionsHtml = structured.versions
    .map((entry) => {
      const label = `${entry.created_at}${entry.action ? ` - ${entry.action}` : ''}`;
      const href = `${readBase}?version=${entry.id}&language=${encodeURIComponent(language)}`;
      const active = version?.id === entry.id;
      const live = entry.id === liveVersionId;
      return `<a href="${escHtml(href)}"
         class="min-w-0 break-words rounded-lg border px-3 py-1.5 text-xs ${
           active
             ? 'border-amber-400 bg-amber-50 text-amber-800'
             : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
         }">${escHtml(label)}${
        live
          ? ` <span class="ml-1 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-green-700">${escHtml(t('view_strings.sections_editor.live', 'Live'))}</span>`
          : ''
      }</a>`;
    })
    .join('');
  const versionsSection = versionsHtml
    ? `<div class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
        <p class="mb-3 text-sm font-semibold text-gray-700">${escHtml(t('view_strings.sections_editor.versions', 'Versions'))}</p>
        <div class="flex flex-wrap gap-2">${versionsHtml}</div>
      </div>`
    : '';

  const versionBanner = isVersionPreview && version
    ? `<div class="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#clock"></use></svg>
        ${escHtml(t('read.viewing_version_prefix', 'Viewing version from'))} ${escHtml(version.created_at)} ${escHtml(t('read.viewing_version_suffix', '(read-only).'))}
        <a href="${escHtml(readBase)}" class="font-semibold underline">${escHtml(t('read.view_current', 'View current'))}</a>
      </div>`
    : '';

  const body = `<div class="min-w-0 max-w-4xl my-4 px-4 sm:px-6 lg:px-8">
    <div class="mb-6 flex items-center gap-3">
      <a href="${escHtml(backHref)}" class="shrink-0 text-gray-400 transition-colors hover:text-gray-600" aria-label="${escHtml(t('common.back', 'Back'))}">
        <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><use href="/assets/icons.svg#arrow-left"></use></svg>
      </a>
      <h2 class="min-w-0 break-words text-2xl font-bold text-gray-900">${escHtml(page.name)}</h2>
      <span class="ml-1 shrink-0 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-gray-500">${escHtml(t('read.read_only', 'Read-only'))}</span>
      ${opts.canEdit !== false ? `<a href="${escHtml(editHref)}"
         class="ml-auto inline-flex shrink-0 items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#pencil-square"></use></svg>
        ${escHtml(t('common.edit', 'Edit'))}
      </a>` : ''}
      ${opts.pageAccessHref ? `<a class="text-indigo-600" href="${escHtml(opts.pageAccessHref)}">${escHtml(t('page_access.title', 'Page access'))}</a>` : ''}
    </div>

    ${versionBanner}

    <div class="space-y-6">
      <div class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
        <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">${metaGrid}</dl>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-gray-400">${escHtml(t('view_strings.snippets_structured_editor.language', 'Language'))}</span>
        ${languageLinks}
      </div>

      ${readStructured(model, t)}

      ${tagsSection}

      ${versionsSection}

      <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
        ${opts.canEdit !== false ? `<a href="${escHtml(editHref)}" class="w-full rounded-lg bg-indigo-600 px-6 py-2 text-center text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 sm:w-auto">${escHtml(t('common.edit', 'Edit'))}</a>` : ''}
        <a href="${escHtml(backHref)}" class="w-full rounded-lg border border-gray-300 bg-white px-6 py-2 text-center text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 sm:w-auto">${escHtml(t('common.back', 'Back'))}</a>
      </div>
    </div>
  </div>`;

  return adminLayout(views, opts, { title: pageTitle, body });
}
