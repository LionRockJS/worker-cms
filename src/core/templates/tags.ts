import { adminLayout, type BaseTemplateProps } from '../render/layout';
import { renderView } from '../render/liquid';
import type { Tag } from '../../types';

export interface TagTaxonomyOption {
  id: string;
  name: string;
  sourceLabel?: string;
}

export async function tagsPage(views: Fetcher, opts: BaseTemplateProps & {
  taxonomies: TagTaxonomyOption[];
  tags: Tag[];
  filterTaxonomy: string;
  search: string;
  canSync: boolean;
  syncedCount: string;
  syncError: string;
}): Promise<string> {
  const { taxonomies, tags, filterTaxonomy, search, canSync, syncedCount, syncError } = opts;
  const taxonomyMap = new Map(taxonomies.map((type) => [type.id, type.name]));
  const taxonomyQuery = filterTaxonomy ? `?${new URLSearchParams({ filter_taxonomy: filterTaxonomy })}` : '';
  const body = await renderView(views, '/templates/tags.json', {
    hasTags: tags.length > 0,
    search,
    clearSearchHref: `/admin/tags${taxonomyQuery}`,
    canSync,
    syncedCount,
    syncError,
    filterOptions: taxonomies.map((type) => ({
      id: type.id,
      name: type.sourceLabel ? `${type.name} (${type.sourceLabel})` : type.name,
      selected: filterTaxonomy === type.id,
    })),
    tags: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      slug: tag.slug,
      weight: tag.weight ?? 5,
      taxonomyName: tag.taxonomy_slug ? taxonomyMap.get(tag.taxonomy_slug) ?? tag.taxonomy_slug : '',
      editHref: `/admin/tags/${tag.id}/edit`,
    })),
  });

  return adminLayout(views, opts, { title: 'Tags', body });
}

export async function tagFormPage(views: Fetcher, opts: BaseTemplateProps & {
  tag?: Tag;
  language: string;
  languages: string[];
  translatedName: string;
  translatedPlaceholder: string;
  taxonomies: TagTaxonomyOption[];
  selectedParent: { id: string; label: string };
}): Promise<string> {
  const {
    tag,
    language,
    languages,
    translatedName,
    translatedPlaceholder,
    taxonomies,
    selectedParent,
  } = opts;
  const body = await renderView(views, '/templates/tag-form.json', {
    isEdit: !!tag,
    headingKey: tag
      ? 'view_strings.sections_tag_form.edit_tag'
      : 'view_strings.sections_tag_form.new_tag',
    action: tag ? `/admin/tags/${tag.id}` : '/admin/tags',
    name: tag?.name ?? '',
    slug: tag?.slug ?? '',
    weight: tag?.weight ?? 5,
    language,
    translatedFieldName: `.name|${language}`,
    translatedName,
    translatedPlaceholder,
    languageOptions: languages.map((lang) => ({
      value: lang,
      selected: lang === language,
    })),
    taxonomyOptions: taxonomies.map((type) => ({
      id: type.id,
      name: type.sourceLabel ? `${type.name} (${type.sourceLabel})` : type.name,
      selected: tag?.taxonomy_slug === type.id,
    })),
    parentExclude: tag?.id ?? '',
    selectedParentId: selectedParent.id,
    selectedParentLabel: selectedParent.label,
    deleteAction: tag ? `/admin/tags/${tag.id}/delete` : '',
  });

  return adminLayout(views, opts, { title: tag ? 'Edit Tag' : 'New Tag', body });
}
