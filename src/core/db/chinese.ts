// Simplified/Traditional Chinese conversion, used to widen advanced-search
// queries: a search for 苏玮 should also match 蘇瑋 and vice versa. The maps are
// character-level 1:1 conversions from the OpenCC dictionaries; that is enough
// for substring LIKE matching.
//
// The tables ship as a VIEWS asset (dictionary/chinese-chars.json, copied by
// build-views) rather than a module, keeping 44 kB out of the Worker bundle.
// They are fetched once per isolate, and only for a term containing Han
// characters — any other search never loads them.

import { env } from 'cloudflare:workers';
import type { Env } from '../../types';

interface ChineseMaps { s2t: Map<string, string>; t2s: Map<string, string> }

let maps: Promise<ChineseMaps> | undefined;

const HAN = /\p{Script=Han}/u;

function buildMap([keys, vals]: [string, string]): Map<string, string> {
  const k = [...keys];
  const v = [...vals];
  return new Map(k.map((char, i) => [char, v[i]]));
}

function loadMaps(): Promise<ChineseMaps> {
  maps ??= (async () => {
    const response = await (env as unknown as Env).VIEWS.fetch('https://views.local/data/chinese-chars.json');
    if (!response.ok) throw new Error(`Chinese dictionary unavailable (${response.status})`);
    const tables = await response.json<{ s2t: [string, string]; t2s: [string, string] }>();
    return { s2t: buildMap(tables.s2t), t2s: buildMap(tables.t2s) };
  })().catch((error) => {
    maps = undefined;
    throw error;
  });
  return maps;
}

/** Convert each character through `map`, leaving unmapped characters as-is. */
function convert(value: string, map: Map<string, string>): string {
  let out = '';
  for (const char of value) out += map.get(char) ?? char;
  return out;
}

export async function toTraditional(value: string): Promise<string> {
  return HAN.test(value) ? convert(value, (await loadMaps()).s2t) : value;
}

export async function toSimplified(value: string): Promise<string> {
  return HAN.test(value) ? convert(value, (await loadMaps()).t2s) : value;
}

/**
 * Returns the distinct set of term variants to search for. For non-Chinese
 * input this is just `[term]`, so callers behave exactly as before. For Chinese
 * input it adds the fully-simplified and fully-traditional forms so a query in
 * either script matches content stored in the other.
 */
export async function chineseSearchVariants(term: string): Promise<string[]> {
  if (!HAN.test(term)) return [term];
  const { s2t, t2s } = await loadMaps();
  return [...new Set([term, convert(term, t2s), convert(term, s2t)])];
}
