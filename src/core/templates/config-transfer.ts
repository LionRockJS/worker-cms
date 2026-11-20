import { adminLayout, type BaseTemplateProps } from '../render/layout';
import { renderView } from '../render/liquid';

export interface ConfigTransferSectionOption {
  id: string;
  labelKey: string;
}

export interface ConfigTransferPreviewItem {
  label: string;
  actionKey: string;
  action: string;
  note: string;
}

export interface ConfigTransferPreviewSection {
  id: string;
  labelKey: string;
  /** Empty when the section can be imported; otherwise why it cannot. */
  unavailableKey: string;
  noteKey: string;
  changes: number;
  counts: { create: number; update: number; unchanged: number; skip: number };
  items: ConfigTransferPreviewItem[];
}

export interface ConfigTransferResult {
  applied: number;
  remaining: number;
  failed: Array<{ sectionLabelKey: string; label: string; message: string }>;
  stopped: string;
}

export async function configTransferPage(views: Fetcher, opts: BaseTemplateProps & {
  exportSections: ConfigTransferSectionOption[];
  preview?: { source: string; exportedAt: string; bundleJson: string; sections: ConfigTransferPreviewSection[] };
  result?: ConfigTransferResult;
  errorKey?: string;
}): Promise<string> {
  const preview = opts.preview;
  const body = await renderView(views, '/templates/config-transfer.json', {
    exportSections: opts.exportSections,
    hasExportSections: opts.exportSections.length > 0,
    hasPreview: !!preview,
    source: preview?.source ?? '',
    exportedAt: preview?.exportedAt ?? '',
    bundleJson: preview?.bundleJson ?? '',
    previewSections: preview?.sections ?? [],
    hasChanges: !!preview?.sections.some((section) => !section.unavailableKey && section.changes > 0),
    hasResult: !!opts.result,
    result: opts.result ?? { applied: 0, remaining: 0, failed: [], stopped: '' },
    hasFailures: !!opts.result?.failed.length,
    errorKey: opts.errorKey ?? '',
  });
  return adminLayout(views, opts, { title: 'Export / Import', body });
}
