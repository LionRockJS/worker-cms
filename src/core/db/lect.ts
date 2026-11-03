import type { BlueprintEntry } from '../../cms-config';

export type LectScalar = string | number | boolean | null;
export type LectLanguageMap = Record<string, LectScalar>;
export type LectValue = LectScalar | LectLanguageMap | Lect | LectItem[] | Lect[];

export interface Lect {
  [key: string]: LectValue | undefined;
  _type?: string;
  _name?: LectScalar;
  _id?: string;
  _weight?: LectScalar;
  _pointers?: Record<string, LectScalar>;
  _blocks?: Lect[];
  _tags?: Lect[];
}

// These names have special behaviour on ordinary JavaScript objects. Lect keys
// can originate in stored JSON and plugin blueprints, so never copy them into
// application-owned records where they could mutate or shadow prototypes.
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export type LectItem = Lect;

export interface FieldProps {
  name: string;
  type: string;
  renderer?: string;
}

export interface ItemProps {
  name: string;
  attributes: FieldProps[];
  pointers: FieldProps[];
  fields: FieldProps[];
  items?: ItemProps[];
}

export interface BlueprintProps {
  attributes: FieldProps[];
  pointers: FieldProps[];
  fields: FieldProps[];
  items: ItemProps[];
}

export type PrintToken = LectScalar | Record<string, unknown> | PrintItem[];

export interface PrintItem {
  tokens: Record<string, PrintToken>;
  raw: LectItem;
  _key: number;
  _weight: number;
}

export interface PrintLect {
  tokens: Record<string, PrintToken>;
  blocks: PrintLect[];
  raw: Lect;
}

type FormDataEntryValue = string | File;
type FormLike = FormData | Record<string, FormDataEntryValue>;

interface LegacyStructuredLike {
  attributes?: Record<string, unknown>;
  pointers?: Record<string, unknown>;
  values?: Record<string, Record<string, unknown>>;
  items?: Record<string, LegacyStructuredLike[]>;
  blocks?: LegacyStructuredLike[];
  tags?: LegacyStructuredLike[];
}

export function defaultLect(): Lect {
  return {};
}

export function defaultLectItem(): LectItem {
  return {};
}

export function safeParseLect(value: string | null | undefined): Lect {
  if (!value) return defaultLect();
  try {
    return normalizeLect(JSON.parse(value));
  } catch {
    return defaultLect();
  }
}

export function normalizeLect(value: unknown): Lect {
  if (isLegacyStructuredLike(value)) return legacyStructuredToLect(value);
  if (!isPlainObject(value)) return defaultLect();
  return normalizePlainLect(value);
}

export function getBlueprintProps(configBlueprint: BlueprintEntry[]): BlueprintProps {
  const attributes: FieldProps[] = [];
  const pointers: FieldProps[] = [];
  const fields: FieldProps[] = [];
  const items: ItemProps[] = [];

  for (const entry of configBlueprint) {
    if (typeof entry === 'string') {
      if (entry.startsWith('@')) attributes.push(getProps(entry, '@'));
      else if (entry.startsWith('*')) pointers.push(getPointerProps(entry));
      else fields.push(getProps(entry));
      continue;
    }

    for (const [name, definitions] of Object.entries(entry)) {
      if (!isSafeObjectKey(name)) continue;
      items.push(getItemProps(name, definitions));
    }
  }

  return { attributes, pointers, fields, items };
}

export function blueprintToLect(
  pageType: string,
  blueprints: Record<string, BlueprintEntry[]>,
  defaultLanguage: string,
): Lect {
  const lect = defaultLect();
  lect._type = pageType;

  const blueprint = blueprints[pageType] ?? blueprints.default;
  if (!blueprint) return lect;

  for (const entry of blueprint) {
    if (typeof entry === 'string') {
      if (entry.startsWith('@')) {
        setScalarPath(lect, fieldName(entry, '@'), '');
      } else if (entry.startsWith('*')) {
        setPointerValue(lect, fieldName(entry, '*'), '');
      } else {
        setLocalizedValue(lect, fieldName(entry), defaultLanguage, '');
      }
      continue;
    }

    for (const [name, definitions] of Object.entries(entry)) {
      if (!isSafeObjectKey(name)) continue;
      lect[name] = [blueprintItemToLect(definitions, defaultLanguage)];
    }
  }

  return lect;
}

export function blockToLect(
  blockType: string,
  blocks: Record<string, BlueprintEntry[]>,
  defaultLanguage: string,
): Lect {
  const lect = blueprintToLect(blockType, blocks, defaultLanguage);
  lect._type = blockType;
  lect._name = '';
  lect._id = Date.now().toString(36);
  lect._weight = 0;
  return lect;
}

export function postToLect(form: FormLike, language: string): Lect {
  const lect = defaultLect();
  const blockPosts: Record<number, Record<string, FormDataEntryValue>> = {};

  for (const [name, value] of formEntries(form).sort(([left], [right]) => left.localeCompare(right))) {
    const scalar = formValueToScalar(value);

    let match = name.match(/^@(\w+)$/);
    if (match) {
      setScalarPath(lect, match[1], scalar);
      continue;
    }

    match = name.match(/^\*(\w+)$/);
    if (match) {
      setPointerValue(lect, match[1], scalar);
      continue;
    }

    match = name.match(/^\.(\w+)\|?([a-z-]+)?$/);
    if (match) {
      setLocalizedValue(lect, match[1], match[2] || language, scalar);
      continue;
    }

    match = name.match(/^\.(\w+)\[(\d+)]\.(\w+)\[(\d+)](@(\w+)$|\.(\w+)\|?([a-z-]+)?$|\*(\w+)$)/);
    if (match) {
      const item = ensureNestedItem(lect, match[1], Number(match[2]), match[3], Number(match[4]));
      if (match[6]) setScalarPath(item, match[6], scalar);
      if (match[7]) setLocalizedValue(item, match[7], match[8] || language, scalar);
      if (match[9]) setPointerValue(item, match[9], scalar);
      continue;
    }

    match = name.match(/^\.(\w+)\[(\d+)](@(\w+)$|\.(\w+)\|?([a-z-]+)?$|\*(\w+)$)/);
    if (match) {
      const item = ensureItem(lect, match[1], Number(match[2]));
      if (match[4]) setScalarPath(item, match[4], scalar);
      if (match[5]) setLocalizedValue(item, match[5], match[6] || language, scalar);
      if (match[7]) setPointerValue(item, match[7], scalar);
      continue;
    }

    match = name.match(/^#(\d+)([.@*][\w+\[\].@*|-]+)$/);
    if (match) {
      const index = Number(match[1]);
      blockPosts[index] ||= {};
      blockPosts[index][match[2]] = value;
    }
  }

  const blocks = Object.keys(blockPosts)
    .map((key) => Number(key))
    .sort((left, right) => left - right)
    .map((index) => postToLect(blockPosts[index], language));
  if (blocks.length) lect._blocks = blocks;

  return lect;
}

export function mergeLects(target: Lect, source: Lect): Lect {
  return deepMergeLect(normalizeLect(target), normalizeLect(source));
}

export function lectToPrint(
  lect: Lect,
  language: string,
  defaultLanguage: string,
): PrintLect {
  const normalized = normalizeLect(lect);
  return {
    tokens: lectTokens(normalized, language, defaultLanguage),
    blocks: sortByWeight(getLectBlocks(normalized)).map((block) => lectToPrint(block, language, defaultLanguage)),
    raw: normalized,
  };
}

export function stringifyLect(lect: Lect): string {
  return JSON.stringify(normalizeLect(lect));
}

export function getLectScalar(lect: Lect, rawName: string): string {
  const value = getPathValue(lect, fieldPath(rawName));
  // A scalar field can hold a localized record when the stored lect drifted from
  // the blueprint (e.g. a page saved with a localized `name` is later viewed under
  // a blueprint that declares `@name`). Coerce to the first language value so the
  // field renders its text instead of "[object Object]".
  if (isScalarRecord(value)) {
    const values = Object.values(value);
    return values.length ? scalarToString(values[0]) : '';
  }
  return scalarToString(value);
}

export function getLectPointer(lect: Lect, rawName: string): string {
  if (!isSafeObjectKey(rawName)) return '';
  return scalarToString(lect._pointers?.[rawName] ?? '');
}

export function getLectLocalizedValue(
  lect: Lect,
  rawName: string,
  language: string,
  defaultLanguage?: string,
): string {
  const value = getPathValue(lect, fieldPath(rawName));
  if (isScalar(value)) return scalarToString(value);
  if (isScalarRecord(value)) {
    return scalarToString(value[language] ?? (defaultLanguage ? value[defaultLanguage] : undefined) ?? '');
  }
  return '';
}

export function getLectItems(lect: Lect, name: string): LectItem[] {
  if (!isSafeObjectKey(name)) return [];
  const value = lect[name];
  return Array.isArray(value) ? value.filter(isPlainObject).map((item) => normalizePlainLect(item)) : [];
}

export function getLectBlocks(lect: Lect): Lect[] {
  return Array.isArray(lect._blocks) ? lect._blocks.map((block) => normalizeLect(block)) : [];
}

function getProps(rawKey: string, prefix = ''): FieldProps {
  const keyParts = rawKey.split(':');
  return {
    name: fieldName(keyParts[0], prefix),
    type: keyParts[1] || 'text',
    renderer: keyParts[1],
  };
}

function getPointerProps(rawKey: string): FieldProps {
  const keyParts = rawKey.split(':');
  const defaultType = /[.@]/.test(keyParts[0]) ? 'text' : 'page/basic';
  return {
    name: fieldName(keyParts[0], '*'),
    type: keyParts[1] || defaultType,
    renderer: keyParts[1] || defaultType,
  };
}

function getItemProps(name: string, definitions: BlueprintEntry[]): ItemProps {
  const attributes: FieldProps[] = [];
  const pointers: FieldProps[] = [];
  const fields: FieldProps[] = [];
  const items: ItemProps[] = [];

  for (const definition of definitions) {
    if (typeof definition === 'string') {
      if (definition.startsWith('@')) attributes.push(getProps(definition, '@'));
      else if (definition.startsWith('*')) pointers.push(getPointerProps(definition));
      else fields.push(getProps(definition));
      continue;
    }
    for (const [nestedName, nestedDefinitions] of Object.entries(definition)) {
      if (!isSafeObjectKey(nestedName)) continue;
      items.push(getItemProps(nestedName, nestedDefinitions));
    }
  }

  return {
    name,
    attributes,
    pointers,
    fields,
    items: items.length ? items : undefined,
  };
}

function blueprintItemToLect(definitions: BlueprintEntry[], defaultLanguage: string): LectItem {
  const item = defaultLectItem();
  item._weight = 0;

  for (const definition of definitions) {
    if (typeof definition === 'string') {
      if (definition.startsWith('@')) setScalarPath(item, fieldName(definition, '@'), '');
      else if (definition.startsWith('*')) setPointerValue(item, fieldName(definition, '*'), '');
      else setLocalizedValue(item, fieldName(definition), defaultLanguage, '');
      continue;
    }

    for (const [nestedName, nestedDefinitions] of Object.entries(definition)) {
      if (!isSafeObjectKey(nestedName)) continue;
      item[nestedName] = [blueprintItemToLect(nestedDefinitions, defaultLanguage)];
    }
  }

  return item;
}

function legacyStructuredToLect(value: LegacyStructuredLike): Lect {
  const lect = defaultLect();

  for (const [key, entry] of Object.entries(value.attributes ?? {})) {
    setScalarPath(lect, key, unknownToScalar(entry));
  }

  const pointers = normalizeScalarRecord(value.pointers);
  if (Object.keys(pointers).length) lect._pointers = pointers;

  for (const [language, values] of Object.entries(value.values ?? {})) {
    for (const [key, entry] of Object.entries(values ?? {})) {
      setLocalizedValue(lect, key, language, unknownToScalar(entry));
    }
  }

  for (const [key, items] of Object.entries(value.items ?? {})) {
    if (!isSafeObjectKey(key)) continue;
    lect[key] = Array.isArray(items) ? items.map((item) => legacyStructuredToLect(item)) : [];
  }

  if (Array.isArray(value.blocks) && value.blocks.length) {
    lect._blocks = value.blocks.map((block, index) => normalizeBlockLect(legacyStructuredToLect(block), index));
  }
  if (Array.isArray(value.tags)) lect._tags = value.tags.map((tag) => legacyStructuredToLect(tag));

  return lect;
}

function normalizePlainLect(value: Record<string, unknown>): Lect {
  const lect: Lect = {};

  for (const [key, entry] of Object.entries(value)) {
    if (!isSafeObjectKey(key)) continue;
    if (key === '_pointers') {
      const pointers = normalizeScalarRecord(entry);
      if (Object.keys(pointers).length) lect._pointers = pointers;
      continue;
    }

    if (key === '_blocks') {
      const blocks = Array.isArray(entry) ? entry.map((block, index) => normalizeBlockLect(block, index)) : [];
      if (blocks.length) lect._blocks = blocks;
      continue;
    }

    if (key === '_tags') {
      lect._tags = Array.isArray(entry) ? entry.map((tag) => normalizeLect(tag)) : [];
      continue;
    }

    if (isScalar(entry)) {
      lect[key] = entry;
      continue;
    }

    if (Array.isArray(entry)) {
      lect[key] = entry.filter(isPlainObject).map((item) => normalizePlainLect(item));
      continue;
    }

    if (isScalarRecord(entry)) {
      lect[key] = normalizeScalarRecord(entry);
      continue;
    }

    if (isPlainObject(entry)) {
      lect[key] = normalizePlainLect(entry);
    }
  }

  return lect;
}

function deepMergeLect(target: Lect, source: Lect): Lect {
  const result: Lect = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!isSafeObjectKey(key)) continue;
    const targetValue = result[key];

    if (Array.isArray(sourceValue)) {
      const targetArray = Array.isArray(targetValue) ? targetValue : [];
      result[key] = sourceValue.map((item, index) => {
        const targetItem = targetArray[index];
        if (isPlainObject(item) && isPlainObject(targetItem)) {
          return deepMergeLect(normalizePlainLect(targetItem), normalizePlainLect(item));
        }
        return item;
      });
      continue;
    }

    if (isPlainObject(sourceValue) && isPlainObject(targetValue)) {
      result[key] = deepMergeLect(normalizePlainLect(targetValue), normalizePlainLect(sourceValue));
      continue;
    }

    result[key] = sourceValue;
  }
  return normalizeLect(result);
}

function lectTokens(lect: Lect, language: string, defaultLanguage: string): Record<string, PrintToken> {
  const tokens: Record<string, PrintToken> = {};

  for (const [key, value] of Object.entries(lect)) {
    if (!isSafeObjectKey(key)) continue;
    if (key === '_blocks' || key === '_tags') continue;

    if (key === '_pointers') {
      Object.assign(tokens, value);
      continue;
    }

    if (Array.isArray(value)) {
      tokens[key] = sortByWeight(value.filter(isPlainObject).map((item) => normalizePlainLect(item)))
        .map((item, index) => ({
          tokens: lectTokens(item, language, defaultLanguage),
          raw: item,
          _key: index,
          _weight: weightOf(item),
        }));
      continue;
    }

    if (isScalar(value)) {
      tokens[key] = value;
      continue;
    }

    if (isScalarRecord(value)) {
      tokens[key] = value[language] ?? value[defaultLanguage] ?? '';
      continue;
    }

    if (isPlainObject(value)) {
      tokens[key] = localizedObject(value, language, defaultLanguage);
    }
  }

  return tokens;
}

function localizedObject(value: Record<string, unknown>, language: string, defaultLanguage: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isSafeObjectKey(key)) continue;
    if (isScalar(entry)) {
      result[key] = entry;
    } else if (isScalarRecord(entry)) {
      result[key] = entry[language] ?? entry[defaultLanguage] ?? '';
    } else if (Array.isArray(entry)) {
      result[key] = sortByWeight(entry.filter(isPlainObject).map((item) => normalizePlainLect(item)))
        .map((item, index) => ({
          tokens: lectTokens(item, language, defaultLanguage),
          raw: item,
          _key: index,
          _weight: weightOf(item),
        }));
    } else if (isPlainObject(entry)) {
      result[key] = localizedObject(entry, language, defaultLanguage);
    }
  }
  return result;
}

function normalizeBlockLect(value: unknown, fallbackWeight: number): Lect {
  const block = normalizeLect(value);
  const type = String(block._type || 'default');
  block._type = type;
  block._name = block._name ?? '';
  block._weight = block._weight ?? fallbackWeight;
  return block;
}

function ensureItem(lect: Lect, name: string, index: number): LectItem {
  if (!isSafeObjectKey(name)) return defaultLectItem();
  const items = Array.isArray(lect[name]) ? lect[name] as LectItem[] : [];
  lect[name] = items;
  items[index] = normalizeLect(items[index] ?? defaultLectItem());
  return items[index];
}

function ensureNestedItem(
  lect: Lect,
  parentName: string,
  parentIndex: number,
  nestedName: string,
  nestedIndex: number,
): LectItem {
  const parent = ensureItem(lect, parentName, parentIndex);
  return ensureItem(parent, nestedName, nestedIndex);
}

function setPointerValue(lect: Lect, rawName: string, value: LectScalar): void {
  if (!isSafeObjectKey(rawName)) return;
  lect._pointers ||= {};
  lect._pointers[rawName] = value;
}

function setLocalizedValue(lect: Lect, rawName: string, language: string, value: LectScalar): void {
  const path = fieldPath(rawName);
  if (!path.length || !isSafeObjectKey(language)) return;
  const parent = ensurePathParent(lect, path);
  const key = path[path.length - 1];
  const current = parent[key];
  const map = isScalarRecord(current) ? normalizeScalarRecord(current) : {};
  map[language] = value;
  parent[key] = map;
}

function setScalarPath(lect: Lect, rawName: string, value: LectScalar): void {
  const path = fieldPath(rawName);
  if (!path.length) return;
  const parent = ensurePathParent(lect, path);
  parent[path[path.length - 1]] = value;
}

function getPathValue(lect: Lect, path: string[]): LectValue | undefined {
  if (!path.length) return undefined;
  let current: LectValue | undefined = lect;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key] as LectValue | undefined;
  }
  return current;
}

function ensurePathParent(lect: Lect, path: string[]): Lect {
  let current = lect;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (!isPlainObject(next) || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Lect;
  }
  return current;
}

function fieldName(raw: string, prefix = ''): string {
  return raw.replace(prefix, '').split(':')[0];
}

function fieldPath(raw: string): string[] {
  const path = raw.split('__').filter(Boolean);
  return path.every(isSafeObjectKey) ? path : [];
}

function formEntries(form: FormLike): Array<[string, FormDataEntryValue]> {
  if (form instanceof FormData) return Array.from(form.entries());
  return Object.entries(form);
}

function formValueToScalar(value: FormDataEntryValue): LectScalar {
  return typeof value === 'string' ? value.trim() : '';
}

function unknownToScalar(value: unknown): LectScalar {
  if (isScalar(value)) return value;
  return String(value ?? '');
}

function normalizeScalarRecord(value: unknown): Record<string, LectScalar> {
  if (!isPlainObject(value)) return {};
  const result: Record<string, LectScalar> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isSafeObjectKey(key)) continue;
    result[key] = unknownToScalar(item);
  }
  return result;
}

function scalarToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  // Never stringify objects/arrays into "[object Object]"; callers that can hold a
  // structured value (e.g. getLectScalar) unwrap it first, so anything left here
  // that is non-scalar has no meaningful text form.
  if (typeof value === 'object') return '';
  return String(value);
}

const LEGACY_STRUCTURED_KEYS = new Set(['attributes', 'pointers', 'values', 'items', 'blocks', 'tags']);

// Legacy original JSON has only these keys; a flat lect may merely share one
// (a plugin's `values` field) and must not be converted, which drops the rest.
function isLegacyStructuredLike(value: unknown): value is LegacyStructuredLike {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.some((key) => key !== 'items' && LEGACY_STRUCTURED_KEYS.has(key))
    && keys.every((key) => LEGACY_STRUCTURED_KEYS.has(key));
}

function isScalar(value: unknown): value is LectScalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isScalarRecord(value: unknown): value is Record<string, LectScalar> {
  return isPlainObject(value) && Object.values(value).every(isScalar);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSafeObjectKey(key: string): boolean {
  return !UNSAFE_OBJECT_KEYS.has(key);
}

function sortByWeight<T extends Lect>(items: T[]): T[] {
  return [...items].sort((left, right) => weightOf(left) - weightOf(right));
}

function weightOf(item: Lect): number {
  const weight = Number(item._weight ?? 0);
  return Number.isFinite(weight) ? weight : 0;
}
