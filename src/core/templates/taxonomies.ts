import { adminLayout, type BaseTemplateProps } from '../render/layout';
import { renderView } from '../render/liquid';
import type { Taxonomy } from '../../types';

export interface TaxonomyListItem {
  name: string;
  slug: string;
  source: string;
  pluginName: string;
  editHref: string;
  viewHref: string;
  isDb: boolean;
}

export interface TaxonomyFormData {
  id?: number;
  name: string;
  slug: string;
}

export async function taxonomiesPage(views: Fetcher, opts: BaseTemplateProps & {
  dbTaxonomies: Taxonomy[];
  configTaxonomies: Array<{ slug: string; name: string; source?: string; pluginName?: string }>;
  canWrite: boolean;
}): Promise<string> {
  const { dbTaxonomies, configTaxonomies, canWrite } = opts;
  const taxonomies: TaxonomyListItem[] = [
    ...dbTaxonomies.map((taxonomy) => ({
      name: taxonomy.name,
      slug: taxonomy.slug,
      source: 'db',
      pluginName: '',
      editHref: `/admin/taxonomies/${taxonomy.id}/edit`,
      viewHref: '',
      isDb: true,
    })),
    ...configTaxonomies.map((taxonomy) => ({
      name: taxonomy.name,
      slug: taxonomy.slug,
      source: taxonomy.source ?? 'config',
      pluginName: taxonomy.pluginName ?? '',
      editHref: '',
      viewHref: `/admin/taxonomies/view/${encodeURIComponent(taxonomy.slug)}`,
      isDb: false,
    })),
  ];

  const body = await renderView(views, '/templates/taxonomies.json', {
    hasTaxonomies: taxonomies.length > 0,
    canWrite,
    taxonomies,
  });

  return adminLayout(views, opts, { title: 'Taxonomies', body });
}

export async function taxonomyFormPage(views: Fetcher, opts: BaseTemplateProps & {
  taxonomy?: TaxonomyFormData;
  readOnly?: boolean;
  fromConfig?: boolean;
}): Promise<string> {
  const { taxonomy, readOnly = false, fromConfig = false } = opts;
  const heading = readOnly ? 'View Taxonomy' : taxonomy ? 'Edit Taxonomy' : 'New Taxonomy';
  const body = await renderView(views, '/templates/taxonomy-form.json', {
    isEdit: !!taxonomy,
    readOnly,
    fromConfig,
    heading,
    action: taxonomy ? `/admin/taxonomies/${taxonomy.id}` : '/admin/taxonomies',
    name: taxonomy?.name ?? '',
    slug: taxonomy?.slug ?? '',
    deleteAction: taxonomy ? `/admin/taxonomies/${taxonomy.id}/delete` : '',
  });

  return adminLayout(views, opts, { title: heading, body });
}
