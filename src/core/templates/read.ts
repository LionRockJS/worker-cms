// Read-only page view: the same structured content the editor shows, rendered
// as static text instead of form inputs. See routes/admin/pages.ts
// (GET /pages/:id/read). Rendered by sections/read.liquid from the plain view
// model built here — no snippet loading, CRDT, or presence — so it is safe to
// show a page without any risk of accidental edits.

import { publication } from '../../features/services';
import { adminLayout, type BaseTemplateProps } from '../render/layout';
import { renderView } from '../render/liquid';
import {
  renderStructuredEditor,
  type ItemGroupRenderModel,
  type PageFieldRenderModel,
} from './editor';
import type { Page, PageVersion, Tag, Taxonomy } from '../../types';
import type { BlueprintProps, Lect } from '../db/lect';
import type { CmsConfig } from '../../cms-config';
import type { UiTranslator } from '../i18n';

type ItemRowRenderModel = ItemGroupRenderModel['rows'][number];

/** What snippets/read-fieldset.liquid renders; rows nest their own field sets. */
interface ReadFieldSet {
  fields: Array<{ label: string; value: string; extras: Array<{ key: string; value: string }> }>;
  groups: Array<{
    name: string;
    rows: Array<{ label: string; settings: ReadFieldSet | null; content: ReadFieldSet }>;
  }>;
}

/** Link/date fields surface their extra parts (label, url, from/until,
 *  timezone) below the value, unless one just repeats the value. */
function readField(field: PageFieldRenderModel): ReadFieldSet['fields'][number] {
  const value = (field.value ?? '').toString();
  const values = field.data.values;
  const extras: Array<[string, string | undefined]> = [
    ['read.label', values.label],
    ['read.url', values.url],
    ['read.from', values.start],
    ['read.until', values.end],
    ['read.timezone', values.timezone],
  ];
  return {
    label: field.label,
    value,
    extras: extras
      .filter(([, extra]) => extra && extra !== value)
      .map(([key, extra]) => ({ key, value: String(extra) })),
  };
}

function readFieldSet(
  fields: PageFieldRenderModel[],
  itemGroups: ItemGroupRenderModel[],
  includeItems: boolean,
): ReadFieldSet {
  return {
    fields: (fields ?? []).map(readField),
    groups: includeItems
      ? (itemGroups ?? []).map((group) => ({ name: group.name, rows: group.rows.map(readItemRow) }))
      : [],
  };
}

function readItemRow(row: ItemRowRenderModel): ReadFieldSet['groups'][number]['rows'][number] {
  return {
    label: row.label,
    settings: row.hasSettings ? readFieldSet(row.settingsFields, row.itemGroups, false) : null,
    content: readFieldSet(row.contentFields, row.itemGroups, true),
  };
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
  const readBase = `/admin/pages/${page.id}/read`;
  const versionParam = isVersionPreview && version ? `&version=${version.id}` : '';
  const parent = parentPages.find((candidate) => candidate.id === page.page_id);
  const selected = new Set(selectedTagIds);

  const body = await renderView(views, '/templates/read.json', {
    pageName: page.name,
    backHref,
    editHref: opts.canEdit !== false ? `/admin/pages/${page.id}/edit` : '',
    pageAccessHref: opts.pageAccessHref ?? '',
    readBase,
    versionCreatedAt: isVersionPreview && version ? version.created_at : '',
    meta: {
      slug: `/${page.slug}`,
      type: page.page_type ?? 'default',
      weight: String(page.weight),
      parent: parent ? `/${parent.slug}` : '',
      start: displayDate(page.start),
      end: displayDate(page.end),
      timezone: page.timezone ?? '',
      editors: opts.editorUsers?.map((editor) => editor.name) ?? editorChips(page.editors),
      modifier: modifierName ?? '',
    },
    // Language switcher: static links, since there is nothing to submit.
    languages: model.languageOptions.map((option) => ({
      value: option.value,
      selected: option.selected,
      href: `${readBase}?language=${encodeURIComponent(option.value)}${versionParam}`,
    })),
    structured: {
      settings: model.hasSettings ? readFieldSet(model.settingsFields, model.itemGroups, false) : null,
      content: readFieldSet(model.contentFields, model.itemGroups, true),
      blocks: model.hasBlocks
        ? model.blocks.map((block) => ({
            name: block.name,
            settings: block.hasSettings ? readFieldSet(block.settingsFields, block.itemGroups, false) : null,
            content: readFieldSet(block.contentFields, block.itemGroups, true),
          }))
        : [],
    },
    // Selected tags grouped by taxonomy.
    tagGroups: taxonomies
      .map((taxonomy) => ({
        name: taxonomy.name,
        tags: tags.filter((tag) => tag.taxonomy_slug === taxonomy.slug && selected.has(tag.id)).map((tag) => tag.name),
      }))
      .filter((group) => group.tags.length),
    // Version history — links open each version read-only.
    liveBadgeHtml: liveVersionId === undefined ? '' : publication()?.renderLiveVersionBadge(t) ?? '',
    versions: structured.versions.map((entry) => ({
      label: `${entry.created_at}${entry.action ? ` - ${entry.action}` : ''}`,
      href: `${readBase}?version=${entry.id}&language=${encodeURIComponent(language)}`,
      active: version?.id === entry.id,
      live: entry.id === liveVersionId,
    })),
  });

  return adminLayout(views, opts, { title: pageTitle, body });
}
