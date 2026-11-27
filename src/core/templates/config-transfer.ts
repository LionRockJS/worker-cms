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
  /** Sections ticked on the previous apply; omitted on first review, where every importable section is ticked. */
  selected?: readonly string[];
  errorKey?: string;
}): Promise<string> {
  const preview = opts.preview;
  const previewSections = (preview?.sections ?? []).map((section) => ({
    ...section,
    checked: !opts.selected || opts.selected.includes(section.id),
  }));
  const result = opts.result;
  const body = await renderView(views, '/templates/config-transfer.json', {
    exportSections: opts.exportSections.map(section => ({
      ...section, checked: !opts.selected || opts.selected.includes(section.id),
    })),
    hasExportSections: opts.exportSections.length > 0,
    hasPreview: !!preview,
    source: preview?.source ?? '',
    exportedAt: preview?.exportedAt ?? '',
    bundleJson: preview?.bundleJson ?? '',
    previewSections,
    hasChanges: !!preview?.sections.some((section) => !section.unavailableKey && section.changes > 0),
    // Keep importing the same selection after a batch that left changes, unless it stopped on an outage.
    autoContinue: !!result && result.remaining > 0 && !result.stopped
      && previewSections.some((section) => section.checked && !section.unavailableKey && section.changes > 0),
    hasResult: !!opts.result,
    result: opts.result ?? { applied: 0, remaining: 0, failed: [], stopped: '' },
    hasFailures: !!opts.result?.failed.length,
    errorKey: opts.errorKey ?? '',
  });
  return adminLayout(views, opts, { title: 'Export / Import', body });
}
