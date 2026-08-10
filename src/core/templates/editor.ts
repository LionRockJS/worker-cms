import { adminLayout, escHtml, type BaseTemplateProps } from '../render/layout';
import { renderView } from '../render/liquid';
import type { Page, PageVersion, Tag, Taxonomy } from '../../types';
import {
  getLectBlocks,
  getLectItems,
  getLectLocalizedValue,
  getLectPointer,
  getLectScalar,
} from '../db/lect';
import { publicationStatusForPage, type PagePublicationStatus } from '../db/page-logic';
import type { BlueprintProps, FieldProps, Lect, LectItem } from '../db/lect';
import type { CmsConfig } from '../../cms-config';
import type { UiTranslator } from '../i18n';

interface RenderedLectFields {
  settingsFields: PageFieldRenderModel[];
  contentFields: PageFieldRenderModel[];
  itemGroups: ItemGroupRenderModel[];
  hasSettings: boolean;
  hasContent: boolean;
}

export interface PageFieldRenderModel {
  templatePath: string | null;
  inputName: string;
  label: string;
  value: string;
  type: string;
  placeholder: string;
  data: {
    field: {
      name: string;
      type: string;
      kind: 'attribute' | 'pointer' | 'value';
      prefix: string;
      inputName: string;
      id: string;
      label: string;
      value: string;
      placeholder: string;
      language: string;
      defaultLanguage: string;
    };
    values: Record<string, string>;
    names: Record<string, string>;
  };
}

export interface ItemGroupRenderModel {
  name: string;
  addAction: string;
  rows: Array<{
    label: string;
    weightInputName: string;
    weight: unknown;
    deleteAction: string;
    showDelete: boolean;
    settingsFields: PageFieldRenderModel[];
    contentFields: PageFieldRenderModel[];
    itemGroups: ItemGroupRenderModel[];
    hasSettings: boolean;
    hasContent: boolean;
  }>;
}

const implicitBlockAttributes: FieldProps[] = [
  { name: '_weight', type: 'number' },
  { name: '_name', type: 'text' },
];

const implicitItemAttributes: FieldProps[] = [
  { name: '_weight', type: 'number' },
];

export interface StructuredEditorRenderModel {
  languageOptions: Array<{ value: string; selected: boolean }>;
  hasSettings: boolean;
  hasContent: boolean;
  hasLanguageContent: boolean;
  settingsFields: PageFieldRenderModel[];
  contentFields: PageFieldRenderModel[];
  itemGroups: ItemGroupRenderModel[];
  blockOptions: Array<{ value: string }>;
  hasBlockOptions: boolean;
  hasBlocks: boolean;
  blocks: Array<{
    index: number;
    type: string;
    name: string;
    id: unknown;
    weight: number;
    weightInputName: string;
    weightInputId: string;
    deleteAction: string;
    hasSettings: boolean;
    hasContent: boolean;
    settingsFields: PageFieldRenderModel[];
    contentFields: PageFieldRenderModel[];
    itemGroups: ItemGroupRenderModel[];
  }>;
}

export function renderStructuredEditor(opts: {
  config: CmsConfig;
  language: string;
  lect: Lect;
  blueprintProps: BlueprintProps;
  blockProps: Record<string, BlueprintProps>;
  blockNames: string[];
  versions: PageVersion[];
}): StructuredEditorRenderModel {
  const { config, language, lect, blueprintProps, blockProps, blockNames } = opts;
  const rootFields = renderLectFields('', lect, blueprintProps, language, config.defaultLanguage);
  const blocks = getLectBlocks(lect)
    .map((block, index) => ({ block, index }))
    .sort(
      (left, right) =>
        blockWeight(left.block, left.index) - blockWeight(right.block, right.index) || left.index - right.index,
    )
    .map(({ block, index }) => {
      const type = String(block._type || 'default');
      const blockWithDefaults = withImplicitBlockAttributes(block, type, index);
      const blockFields = renderLectFields(
        `#${index}`,
        blockWithDefaults,
        withImplicitBlockProps(blockProps[type] ?? blockProps.default),
        language,
        config.defaultLanguage,
        { omitWeight: true },
      );
      return {
        index,
        type,
        name: getLectScalar(blockWithDefaults, '_name') || type,
        id: blockWithDefaults._id ?? '',
        weight: blockWeight(blockWithDefaults, index),
        weightInputName: `#${index}@_weight`,
        weightInputId: fieldId(`#${index}@_weight`),
        deleteAction: `block-delete:${index}`,
        hasSettings: blockFields.hasSettings,
        hasContent: blockFields.hasContent,
        settingsFields: blockFields.settingsFields,
        contentFields: blockFields.contentFields,
        itemGroups: blockFields.itemGroups,
      };
    });

  return {
    languageOptions: config.languages.map((lang) => ({
      value: lang,
      selected: lang === language,
    })),
    hasSettings: rootFields.hasSettings,
    hasContent: rootFields.hasContent,
    hasLanguageContent: rootFields.hasContent || blocks.some((block) => block.hasContent),
    settingsFields: rootFields.settingsFields,
    contentFields: rootFields.contentFields,
    itemGroups: rootFields.itemGroups,
    blockOptions: blockNames.map((name) => ({ value: name })),
    hasBlockOptions: blockNames.length > 0,
    hasBlocks: blocks.length > 0,
    blocks,
  };
}

function withImplicitBlockProps(props: BlueprintProps): BlueprintProps {
  return {
    ...props,
    attributes: withImplicitAttributes(props.attributes, implicitBlockAttributes),
  };
}

function withImplicitItemProps(props: BlueprintProps): BlueprintProps {
  return {
    ...props,
    attributes: withImplicitAttributes(props.attributes, implicitItemAttributes),
  };
}

function withImplicitAttributes(attributes: FieldProps[], implicitAttributes: FieldProps[]): FieldProps[] {
  const merged = [...implicitAttributes];
  for (const field of attributes) {
    if (!merged.some((implicitField) => implicitField.name === field.name)) merged.push(field);
  }
  return merged;
}

function withImplicitBlockAttributes(block: Lect, type: string, index: number): Lect {
  return {
    ...block,
    _type: type,
    _name: block._name ?? '',
    _weight: block._weight ?? index,
  };
}

function blockWeight(block: Lect, fallback: number): number {
  const weight = Number(block._weight ?? fallback);
  return Number.isFinite(weight) ? weight : fallback;
}

function withImplicitItemAttributes(item: LectItem, index: number): LectItem {
  return {
    ...item,
    _weight: item._weight ?? index,
  };
}

function itemWeight(item: LectItem, fallback: number): number {
  const weight = Number(item._weight ?? fallback);
  return Number.isFinite(weight) ? weight : fallback;
}

function renderLectFields(
  prefix: string,
  lect: Lect | LectItem,
  props: BlueprintProps,
  language: string,
  defaultLanguage: string,
  options: { omitWeight?: boolean } = {},
): RenderedLectFields {
  const attributeFields = props.attributes
    .filter((field) => !options.omitWeight || field.name !== '_weight')
    .map((field) => renderPageField({
    prefix,
    field,
    kind: 'attribute',
    inputName: `${prefix}@${field.name}`,
    label: fieldLabel(field.name),
    value: getLectScalar(lect, field.name),
    language,
    defaultLanguage,
    lect,
  }));
  const pointerFields = props.pointers.map((field) => renderPageField({
    prefix,
    field,
    kind: 'pointer',
    inputName: `${prefix}*${field.name}`,
    label: `${fieldLabel(field.name)} reference`,
    value: getLectPointer(lect, field.name),
    language,
    defaultLanguage,
    lect,
  }));
  const valueFields = props.fields.map((field) => renderPageField({
    prefix,
    field,
    kind: 'value',
    inputName: `${prefix}.${field.name}|${language}`,
    label: fieldLabel(field.name),
    value: getLectLocalizedValue(lect, field.name, language),
    placeholder: language === defaultLanguage ? '' : getLectLocalizedValue(lect, field.name, defaultLanguage),
    language,
    defaultLanguage,
    lect,
  }));
  const itemGroups = props.items.map((item) => renderItemGroup(prefix, item, getLectItems(lect, item.name), language, defaultLanguage));
  const settingsFields = [...attributeFields, ...pointerFields];

  return {
    settingsFields,
    contentFields: valueFields,
    itemGroups,
    hasSettings: settingsFields.length > 0,
    hasContent: valueFields.length > 0 || itemGroups.length > 0,
  };
}

function renderItemGroup(
  prefix: string,
  props: NonNullable<BlueprintProps['items'][number]>,
  items: LectItem[],
  language: string,
  defaultLanguage: string,
): ItemGroupRenderModel {
  const rows = items.length
    ? items
        .map((item, index) => ({ item, index }))
        .sort((left, right) => itemWeight(left.item, left.index) - itemWeight(right.item, right.index) || left.index - right.index)
    : [];
  const blockMatch = prefix.match(/^#(\d+)/);
  const addAction = blockMatch ? `block-item-add:${blockMatch[1]}|${props.name}` : `item-add:${props.name}`;
  const groupProps = withImplicitItemProps({
    attributes: props.attributes,
    pointers: props.pointers,
    fields: props.fields,
    items: props.items ?? [],
  });
  return {
    name: props.name,
    addAction,
    rows: rows.map(({ item, index }, displayIndex) => {
      const itemPrefix = `${prefix}.${props.name}[${index}]`;
      const deleteAction = blockMatch
        ? `block-item-delete:${blockMatch[1]}|${props.name}|${index}`
        : `item-delete:${props.name}|${index}`;
      const itemWithDefaults = withImplicitItemAttributes(item, index);
      const itemFields = renderLectFields(
        itemPrefix,
        itemWithDefaults,
        groupProps,
        language,
        defaultLanguage,
        { omitWeight: true },
      );
      const weightInputName = `${itemPrefix}@_weight`;
      return {
        label: `Item ${displayIndex + 1}`,
        weightInputName,
        weight: itemWithDefaults._weight,
        deleteAction,
        showDelete: rows.length > 1,
        settingsFields: itemFields.settingsFields,
        contentFields: itemFields.contentFields,
        itemGroups: itemFields.itemGroups,
        hasSettings: itemFields.hasSettings,
        hasContent: itemFields.hasContent,
      };
    }),
  };
}

function renderPageField(opts: {
  prefix: string;
  field: FieldProps;
  kind: 'attribute' | 'pointer' | 'value';
  inputName: string;
  label: string;
  value: string;
  language: string;
  defaultLanguage: string;
  lect: Lect | LectItem;
  placeholder?: string;
}): PageFieldRenderModel {
  const templatePath = opts.field.renderer ? pageFieldTemplatePath(opts.field.renderer) : null;
  return {
    templatePath,
    inputName: opts.inputName,
    label: opts.label,
    value: opts.value,
    type: opts.field.type,
    placeholder: opts.placeholder ?? '',
    data: {
    field: {
      name: opts.field.name,
      type: opts.field.type,
      kind: opts.kind,
      prefix: opts.prefix,
      inputName: opts.inputName,
      id: fieldId(opts.inputName),
      label: opts.label,
      value: opts.value,
      placeholder: opts.placeholder ?? '',
      language: opts.language,
      defaultLanguage: opts.defaultLanguage,
    },
    values: pageFieldValues(opts.lect, opts.field.name, opts.language, opts.defaultLanguage),
    names: pageFieldNames(opts.prefix, opts.field.name, opts.kind, opts.language),
    },
  };
}

function pageFieldTemplatePath(type: string): string | null {
  const trimmed = type.trim();
  if (!trimmed) return null;
  if (!trimmed.split('/').every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const typedPath = trimmed.includes('/') ? trimmed : `${trimmed}/basic`;
  return `/snippets/pagefield/${typedPath}.liquid`;
}

function pageFieldValues(lect: Lect | LectItem, name: string, language: string, defaultLanguage: string): Record<string, string> {
  return {
    value: getLectLocalizedValue(lect, name, language, defaultLanguage) || getLectScalar(lect, name),
    label: getLectLocalizedValue(lect, `${name}__label`, language, defaultLanguage),
    url: getLectLocalizedValue(lect, `${name}__url`, language, defaultLanguage),
    start: getLectLocalizedValue(lect, `${name}__start`, language, defaultLanguage),
    end: getLectLocalizedValue(lect, `${name}__end`, language, defaultLanguage),
    timezone: getLectLocalizedValue(lect, `${name}__timezone`, language, defaultLanguage),
  };
}

function pageFieldNames(prefix: string, name: string, kind: 'attribute' | 'pointer' | 'value', language: string): Record<string, string> {
  if (kind === 'attribute') return { value: `${prefix}@${name}` };
  if (kind === 'pointer') return { value: `${prefix}*${name}` };
  return {
    value: `${prefix}.${name}|${language}`,
    label: `${prefix}.${name}__label|${language}`,
    url: `${prefix}.${name}__url|${language}`,
    start: `${prefix}.${name}__start|${language}`,
    end: `${prefix}.${name}__end|${language}`,
    timezone: `${prefix}.${name}__timezone|${language}`,
  };
}

function fieldId(name: string): string {
  return `field_${Array.from(name)
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.charCodeAt(0).toString(16)}_`))
    .join('')}`;
}

function fieldLabel(name: string): string {
  return name.replace(/__/g, '.').replace(/_/g, ' ').trim();
}

function editorChips(editors: string | null | undefined): string[] {
  return (editors ?? '')
    .split(',')
    .map((editor) => editor.trim())
    .filter(Boolean);
}

function parseUtcTimestamp(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const date = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseUtcOffsetMinutes(timezone: string): number | null {
  const match = timezone.trim().match(/^([+-])(\d{2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const [, sign, hour, minute = '00'] = match;
  const hours = Number(hour);
  const minutes = Number(minute);
  if (hours > 23 || minutes > 59) return null;
  const offset = hours * 60 + minutes;
  return sign === '-' ? -offset : offset;
}

function formatParts(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join('-') + ' ' + [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join(':');
}

function formatVersionDate(createdAt: string, timezone: string): string {
  const date = parseUtcTimestamp(createdAt);
  if (!date) return createdAt;

  const offsetMinutes = parseUtcOffsetMinutes(timezone);
  if (offsetMinutes !== null) {
    return `${formatParts(new Date(date.getTime() + offsetMinutes * 60_000))} ${timezone}`;
  }

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      hour12: false,
    }).formatToParts(date);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
    const formatted = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
    return timezone ? `${formatted} ${timezone}` : formatted;
  } catch {
    return createdAt;
  }
}

// ── Lect JSON version diff ──────────────────────────────────────────────────
// When previewing a saved version, the raw-metadata panel shows a colour-coded
// diff of that version's lect against the current draft instead of the editable
// textarea, so it's obvious what changed.

/** Recursively key-sorted, pretty-printed JSON so a line diff reflects value
 *  changes rather than key-ordering noise. Falls back to the raw input. */
function stablePrettyJson(json: string): string {
  const sortDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  };
  try {
    return JSON.stringify(sortDeep(JSON.parse(json)), null, 2);
  } catch {
    return json;
  }
}

/**
 * Renders an escaped, colour-coded line diff (LCS) of the previewed version's
 * lect against the current draft's lect, as a run of block <span>s for a <pre>:
 * emerald = only in this version, rose = only in the current draft, grey = same.
 * Returns '' when there is no difference (or either side is missing).
 */
function renderLectDiff(draftJson: string, versionJson: string): string {
  const base = stablePrettyJson(draftJson).split('\n');     // current draft
  const target = stablePrettyJson(versionJson).split('\n'); // previewed version
  const n = base.length;
  const m = target.length;
  // Suffix LCS-length table, to walk a minimal diff.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = base[i] === target[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let changed = false;
  const push = (cls: string, gutter: string, text: string) =>
    lines.push(`<span class="block ${cls}"><span class="select-none text-gray-400">${gutter}</span>${escHtml(text)}</span>`);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === target[j]) { push('text-gray-500', '  ', target[j]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('bg-rose-50 text-rose-700', '- ', base[i]); i++; changed = true; }
    else { push('bg-emerald-50 text-emerald-800', '+ ', target[j]); j++; changed = true; }
  }
  while (i < n) { push('bg-rose-50 text-rose-700', '- ', base[i++]); changed = true; }
  while (j < m) { push('bg-emerald-50 text-emerald-800', '+ ', target[j++]); changed = true; }
  return changed ? lines.join('') : '';
}

export async function editorPage(views: Fetcher, opts: BaseTemplateProps & {
  page?: Page;
  creatorName?: string;
  modifierName?: string;
  /** Resolved display names for the page's `editors` ids (for the editors
   *  combobox chips); unresolved ids fall back to the raw id. */
  editorUsers?: Array<{ id: number; name: string }>;
  version?: PageVersion;
  isVersionPreview?: boolean;
  liveVersionId?: number;
  isPublished?: boolean;
  publicationStatus?: PagePublicationStatus;
  isLiveSynced?: boolean;
  parentPages: Page[];
  tags: Tag[];
  taxonomies: Taxonomy[];
  selectedTagIds: number[];
  errors?: string[];
  flash?: string;
  action: string;
  defaultPageType?: string;
  /** Timezone pre-filled into the start/end window when the page has none. */
  defaultTimezone?: string;
  /** Where the back arrow / Cancel button return to (e.g. a plugin dashboard). Defaults to /admin. */
  backHref?: string;
  /** Current draft's lect JSON — when previewing a version, the raw-metadata
   *  panel diffs the version against this instead of showing the editable box. */
  draftLect?: string;
  /** Server-side UI translation for the document title. */
  t?: UiTranslator;
  structured?: {
    config: CmsConfig;
    language: string;
    lect: Lect;
    blueprintProps: BlueprintProps;
    blockProps: Record<string, BlueprintProps>;
    blockNames: string[];
    versions: PageVersion[];
  };
}): Promise<string> {
  const {
    userAvatar,
    currentUserId,
    page,
    creatorName,
    modifierName,
    version,
    isVersionPreview = false,
    liveVersionId,
    isPublished = false,
    isLiveSynced = false,
    parentPages,
    tags,
    taxonomies,
    selectedTagIds,
    errors = [],
    flash,
    action,
    defaultPageType = '',
    defaultTimezone = '',
    backHref = '/admin',
    structured,
  } = opts;

  const isEdit = !!page;
  const publicationStatus: PagePublicationStatus = page
    ? opts.publicationStatus ?? publicationStatusForPage(page, isPublished)
    : 'draft';
  const selectedVersion = isVersionPreview && version ? version : undefined;
  const translate = opts.t ?? ((_key: string, fallback: string) => fallback);
  const pageTitle = isEdit
    ? `${translate('view_strings.sections_editor.edit_prefix', 'Edit: ')}${page.name}`
    : translate('view_strings.sections_editor.new_page', 'New Page');
  const pageType = (structured ? getLectScalar(structured.lect, '_type') : '') || page?.page_type || defaultPageType || 'default';
  const structuredModel = structured ? renderStructuredEditor(structured) : null;
  const versionHrefBase = page ? `/admin/pages/${page.id}/edit` : action;
  const pageEditorChips = opts.editorUsers
    ?? editorChips(page?.editors).map((id) => ({ id, name: `#${id}` }));
  // The DB `taxonomies` table only holds runtime-created taxonomies; config-
  // and plugin-defined ones live in the resolved CmsConfig, so merge both
  // (DB rows win on slug) — otherwise the taxonomy setup shown on the
  // page-type form never surfaces in the editor.
  const allTaxonomies = mergeTaxonomies(taxonomies, structured?.config.taxonomies);
  const parentOptions = parentPages
    .filter((parent) => parent.id !== page?.id)
    .map((parent) => ({
      id: parent.id,
      name: parent.name,
      slug: parent.slug,
      label: `/${parent.slug}`,
      selected: page?.page_id === parent.id || parentPages.length === 1,
    }));
  const selectedParent = parentOptions.find((parent) => parent.selected);
  // When previewing a version, diff its lect against the current draft.
  const lectDiffHtml = selectedVersion && opts.draftLect != null
    ? renderLectDiff(opts.draftLect, page?.lect ?? '')
    : '';
  const versions = structured?.versions.map((version) => ({
    date: formatVersionDate(version.created_at, defaultTimezone),
    createdAt: version.created_at,
    description: version.action ?? '',
    href: `${versionHrefBase}?version=${version.id}`,
    active: selectedVersion?.id === version.id,
    live: version.id === liveVersionId,
    removeAction: `delete-version:${version.id}`,
  })) ?? [];

  const body = await renderView(views, '/templates/editor.json', {
    pageTitle,
    action,
    backHref,
    deleteAction: page ? `/admin/pages/${page.id}/delete` : '',
    unpublishAction: page ? `/admin/pages/${page.id}/unpublish?return_to=${encodeURIComponent(`/admin/pages/${page.id}/edit`)}` : '',
    readHref: page ? `/admin/pages/${page.id}/read` : '',
    isEdit,
    isPublished,
    isLiveSynced,
    isVersionPreview: !!selectedVersion,
    selectedVersion: selectedVersion
      ? {
          date: formatVersionDate(selectedVersion.created_at, defaultTimezone),
          createdAt: selectedVersion.created_at,
          restoreAction: `revert:${selectedVersion.id}`,
          currentHref: page ? `/admin/pages/${page.id}/edit` : action,
        }
      : undefined,
    publicationStatus,
    errors,
    hasErrors: errors.length > 0,
    flash,
    hasFlash: !!flash,
    page: {
      id: page?.id ?? '',
      name: page?.name ?? '',
      slug: page?.slug ?? '',
      pageType: page?.page_type ?? defaultPageType,
      weight: page?.weight ?? 5,
      start: page?.start ? page.start.replace(' ', 'T').slice(0, 16) : '',
      end: page?.end ? page.end.replace(' ', 'T').slice(0, 16) : '',
      timezone: page?.timezone ?? defaultTimezone,
      creator: page?.creator ?? '',
      creatorName: creatorName ?? '',
      hasCreator: !!creatorName,
      editors: page?.editors ?? '',
      editorChips: pageEditorChips,
      hasEditorChips: pageEditorChips.length > 0,
      modifierName: modifierName ?? '',
      hasModifier: !!modifierName,
      lect: page?.lect ?? '',
    },
    lectDiffHtml,
    hasLectDiff: !!lectDiffHtml,
    parentOptions,
    selectedParent: {
      id: selectedParent?.id ?? '',
      label: selectedParent?.label ?? '',
    },
    pageTypeOptions: structured
      ? Object.keys(structured.config.blueprint).map((pageType) => ({ value: pageType }))
      : [],
    structuredBlock: '',
    structuredModel,
    ...editorTagGroups(
      tags,
      allTaxonomies,
      selectedTagIds,
      // Show only the taxonomies checked for this page type; when the page type
      // has none checked, fall back to showing every taxonomy.
      structured?.config.taxonomyLists[pageType] ?? allTaxonomies.map((taxonomy) => taxonomy.slug),
    ),
    versions,
    hasVersions: versions.length > 0,
    currentUserId,
    userAvatar,
  });

  return adminLayout(views, opts, { title: pageTitle, body, editorSync: isEdit });
}

/** Merges config/plugin taxonomy definitions with DB rows; DB wins on slug. */
function mergeTaxonomies(
  dbTaxonomies: Taxonomy[],
  configTaxonomies: Record<string, string> | undefined,
): Array<Pick<Taxonomy, 'name' | 'slug'>> {
  const bySlug = new Map<string, Pick<Taxonomy, 'name' | 'slug'>>(
    Object.entries(configTaxonomies ?? {}).map(([slug, name]) => [slug, { slug, name }]),
  );
  for (const taxonomy of dbTaxonomies) bySlug.set(taxonomy.slug, taxonomy);
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

function editorTagGroups(
  tags: Tag[],
  taxonomies: Array<Pick<Taxonomy, 'name' | 'slug'>>,
  selectedTagIds: number[],
  taxonomySlugs: string[],
) {
  const selected = new Set(selectedTagIds);
  const taxonomiesBySlug = new Map(taxonomies.map((taxonomy) => [taxonomy.slug, taxonomy]));
  const renderedTagIds = new Set<number>();
  const tagGroups = taxonomySlugs
    .map((slug) => {
      const taxonomy = taxonomiesBySlug.get(slug);
      if (!taxonomy) return null;
      const groupTags = tags
        .filter((tag) => tag.taxonomy_slug === taxonomy.slug)
        .map((tag) => {
          renderedTagIds.add(tag.id);
          return {
            id: tag.id,
            name: tag.name,
            checked: selected.has(tag.id),
          };
        });
      return {
        name: taxonomy.name,
        slug: taxonomy.slug,
        tags: groupTags,
        hasTags: groupTags.length > 0,
      };
    })
    .filter((group): group is NonNullable<typeof group> => !!group);
  const preservedTagIds = selectedTagIds.filter((id) => !renderedTagIds.has(id));

  return {
    tagGroups,
    hasTagGroups: tagGroups.length > 0,
    preservedTagIds,
    hasPreservedTagIds: preservedTagIds.length > 0,
  };
}
