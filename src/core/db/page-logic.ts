// Lect / page-structure helpers used by the admin editor handlers.

import { cmsConfig } from '../../cms-config';
import type { CmsConfig } from '../../cms-config';
import {
  blockToLect,
  blueprintToLect,
  defaultLectItem,
  getBlueprintProps,
  getLectBlocks,
  getLectItems,
  getLectLocalizedValue,
  mergeLects,
  normalizeLect,
  postToLect,
  safeParseLect,
} from './lect';
import type { Lect, LectItem } from './lect';
import { num, str } from '../http/forms';

export function withDraftMetadata(lect: Lect, modifier: number): Lect {
  return {
    ...normalizeLect(lect),
    _modifier: modifier,
    _updated_at: new Date().toISOString(),
  };
}

export function blueprintPropsFor(config: CmsConfig, pageType: string) {
  return getBlueprintProps(config.blueprint[pageType] ?? config.blueprint.default);
}

export function blockPropsByName(config: CmsConfig): Record<string, ReturnType<typeof getBlueprintProps>> {
  const props: Record<string, ReturnType<typeof getBlueprintProps>> = {};
  for (const [name, blueprint] of Object.entries(config.blocks)) {
    props[name] = getBlueprintProps(blueprint);
  }
  return props;
}

/**
 * Block types offered in the editor's "add block" picker for a page type: the
 * type's own block list when it defines one, otherwise every known block type
 * (config + database + plugin), so a type without an explicit list isn't limited
 * to the defaults.
 */
export function blockNamesFor(config: CmsConfig, pageType: string): string[] {
  return config.blockLists[pageType] ?? Object.keys(config.blocks);
}

export function lectForPage(config: CmsConfig, pageType: string, stored: string | null | undefined): Lect {
  return mergeLects(
    blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
    safeParseLect(stored),
  );
}

export function lectFromForm(config: CmsConfig, pageType: string, existing: Lect, form: FormData, language: string): Lect {
  const jsonLect = safeParseLect(str(form.get('lect_json')));
  const postedLect = postToLect(form, language);
  return mergeLects(
    mergeLects(blueprintToLect(pageType, config.blueprint, config.defaultLanguage), existing),
    mergeLects(jsonLect, postedLect),
  );
}

export function applyStructuredAction(config: CmsConfig, lect: Lect, pageType: string, action: string, form: FormData): Lect {
  const next = normalizeLect(lect);
  const [actionType, actionParam = ''] = action.split(':');
  const actionParams = actionParam.split('|');
  const count = Math.max(1, num(form.get(`count:${actionParam}`), 1));

  if (actionType === 'block-add') {
    const blockName = str(form.get('block-select'));
    if (!blockName || !config.blocks[blockName]) return next;
    const block = blockToLect(blockName, config.blocks, config.defaultLanguage);
    next._blocks ||= [];
    block._weight = getNextWeight(next._blocks);
    next._blocks.push(block);
    return next;
  }

  if (actionType === 'block-delete') {
    next._blocks?.splice(parseInt(actionParam, 10), 1);
    return next;
  }

  if (actionType === 'item-add') {
    addDefaultItem(config, next, pageType, actionParam, count);
    return next;
  }

  if (actionType === 'item-delete') {
    const [itemName, itemIndex] = actionParams;
    getMutableItems(next, itemName).splice(parseInt(itemIndex, 10), 1);
    return next;
  }

  if (actionType === 'block-item-add') {
    const [blockIndex, itemName] = actionParams;
    const block = getLectBlocks(next)[parseInt(blockIndex, 10)];
    if (block) addDefaultBlockItem(config, block, itemName, count);
    next._blocks = replaceBlock(next, parseInt(blockIndex, 10), block);
    return next;
  }

  if (actionType === 'block-item-delete') {
    const [blockIndex, itemName, itemIndex] = actionParams;
    const index = parseInt(blockIndex, 10);
    const block = getLectBlocks(next)[index];
    if (block) {
      getMutableItems(block, itemName).splice(parseInt(itemIndex, 10), 1);
      next._blocks = replaceBlock(next, index, block);
    }
    return next;
  }

  return next;
}

export function addDefaultItem(config: CmsConfig, lect: Lect, pageType: string, itemName: string, count: number): void {
  if (!itemName) return;
  const defaults = blueprintToLect(pageType, config.blueprint, config.defaultLanguage);
  const defaultItem = getLectItems(defaults, itemName)[0] ?? defaultLectItem();
  const items = getMutableItems(lect, itemName);
  for (let index = 0; index < count; index++) {
    const item = cloneItem(defaultItem);
    item._weight = getNextWeight(items);
    items.push(item);
  }
}

export function addDefaultBlockItem(config: CmsConfig, block: Lect, itemName: string, count: number): void {
  if (!itemName) return;
  const blockType = String(block._type || 'default');
  const defaults = blockToLect(blockType, config.blocks, config.defaultLanguage);
  const defaultItem = getLectItems(defaults, itemName)[0] ?? defaultLectItem();
  const items = getMutableItems(block, itemName);
  for (let index = 0; index < count; index++) {
    const item = cloneItem(defaultItem);
    item._weight = getNextWeight(items);
    items.push(item);
  }
}

export function cloneItem(item: LectItem): LectItem {
  return JSON.parse(JSON.stringify(item)) as LectItem;
}

export function getMutableItems(lect: Lect, itemName: string): LectItem[] {
  if (!Array.isArray(lect[itemName])) lect[itemName] = [];
  return lect[itemName] as LectItem[];
}

export function getNextWeight(items: LectItem[]): number {
  return items.reduce((max, entry) => Math.max(max, num(entry._weight, 0)), -1) + 1;
}

export function replaceBlock(lect: Lect, index: number, block?: Lect): Lect[] {
  const blocks = getLectBlocks(lect);
  if (block) blocks[index] = block;
  return blocks;
}

export function ensureDefaultLectName(lect: Lect, name: string): void {
  if (getLectLocalizedValue(lect, 'name', cmsConfig.defaultLanguage)) return;
  const current = lect.name;
  const languageMap = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, string>
    : {};
  lect.name = {
    ...languageMap,
    [cmsConfig.defaultLanguage]: name,
  };
}

export function isStructuredEditorAction(action: string): boolean {
  return [
    'block-add',
    'block-delete',
    'item-add',
    'item-delete',
    'block-item-add',
    'block-item-delete',
  ].includes(action.split(':')[0] || '');
}

// ── Drag-and-drop reorder across a paginated list ─────────────────────────────
//
// The page list is windowed (LIMIT/OFFSET over `weight ASC, name ASC, id ASC`),
// so a drop can only ever restate the order of the rows on screen. Numbering
// those rows 0..n by their position in the table would collide with every other
// page of the list, and numbering them by their global offset would still lose
// to the untouched rows that sit at the default weight — ties fall back to name.
//
// So the client posts the window it rendered plus the order it wants, and the
// whole sequence is renumbered onto a dense `(index + 1) * step` scale. Only the
// rows whose weight actually moves are written back: the first reorder of a list
// normalizes it, and every reorder after that touches just the rows between the
// dragged row's old and new slot.

/** Gap between adjacent weights after a reorder. Room for manual edits between. */
export const REORDER_WEIGHT_STEP = 10;

export interface ReorderSequenceRow {
  id: number;
  weight: number;
}

export type ReorderPlan =
  /** The rendered window no longer matches the stored order — the caller should
   *  reject the drop and let the client reload rather than write a guess. */
  | { stale: true }
  | {
      stale: false;
      /** Rows to write: only those whose weight actually moves. */
      updates: ReorderSequenceRow[];
      /** Final weights for the rows the client can see, so it can refresh the
       *  weight fields in place instead of reloading the list. */
      window: ReorderSequenceRow[];
    };

/**
 * Splice `after` into `sequence` at `offset` and renumber the result.
 *
 * `before` is the window exactly as the client rendered it; if it no longer
 * matches the stored slice (someone else moved, added or deleted a page) the
 * drop is stale and nothing is written.
 */
export function planPageReorder(
  sequence: ReorderSequenceRow[],
  offset: number,
  before: number[],
  after: number[],
  step = REORDER_WEIGHT_STEP,
): ReorderPlan {
  if (before.length !== after.length) return { stale: true };

  const window = sequence.slice(offset, offset + before.length);
  if (window.length !== before.length) return { stale: true };
  if (window.some((row, index) => row.id !== before[index])) return { stale: true };

  const rowById = new Map(window.map((row) => [row.id, row]));
  const reordered = after.map((id) => rowById.get(id));
  // A permutation of the same window, or the drop is talking about other rows.
  if (reordered.some((row) => !row)) return { stale: true };

  const next = [
    ...sequence.slice(0, offset),
    ...(reordered as ReorderSequenceRow[]),
    ...sequence.slice(offset + before.length),
  ];

  const updates: ReorderSequenceRow[] = [];
  const renumbered = next.map((row, index) => {
    const weight = (index + 1) * step;
    if (row.weight !== weight) updates.push({ id: row.id, weight });
    return { id: row.id, weight };
  });

  return { stale: false, updates, window: renumbered.slice(offset, offset + after.length) };
}
