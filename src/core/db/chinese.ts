// Character-level Simplified/Traditional conversion and regional variants
// from OpenCC, used for substring searches across Chinese writing conventions.
//
// The tables ship as a VIEWS asset (dictionary/chinese-chars.json, copied by
// build-views) rather than a module, keeping the data out of the Worker bundle.
// They are fetched once per isolate, and only for a term containing Han
// characters — any other search never loads them.

import { env } from 'cloudflare:workers';
import type { Env } from '../../types';

interface ChineseMaps {
  s2t: Map<string, string>;
  t2s: Map<string, string>;
  regional: Map<string, string[]>;
}

let maps: Promise<ChineseMaps> | undefined;

const HAN = /\p{Script=Han}/u;
const GLOB_CHARACTERS = new Map([
  [' ', '*'], ['%', '*'], ['_', '?'], ['*', '[*]'], ['?', '[?]'], ['[', '[[]'],
]);

function buildMap([keys, vals]: [string, string]): Map<string, string> {
  const k = [...keys];
  const v = [...vals];
  return new Map(k.map((char, i) => [char, v[i]]));
}

function loadMaps(): Promise<ChineseMaps> {
  maps ??= (async () => {
    const response = await (env as unknown as Env).VIEWS.fetch('https://views.local/data/chinese-chars.json');
    if (!response.ok) throw new Error(`Chinese dictionary unavailable (${response.status})`);
    const tables = await response.json<{ s2t: [string, string]; t2s: [string, string]; variantGroups?: string[] }>();
    const regional = new Map<string, string[]>();
    for (const group of tables.variantGroups ?? []) {
      const forms = [...group];
      for (const char of forms) regional.set(char, forms);
    }
    return { s2t: buildMap(tables.s2t), t2s: buildMap(tables.t2s), regional };
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

/** A SQLite substring pattern with one character class per Chinese variant group. */
export async function chineseSearchPattern(term: string): Promise<{ operator: 'LIKE' | 'GLOB'; pattern: string }> {
  const like = `%${term.replaceAll(' ', '%')}%`;
  if (!HAN.test(term)) return { operator: 'LIKE', pattern: like };

  const { s2t, t2s, regional } = await loadMaps();
  let hasVariants = false;
  let glob = '*';
  for (const char of term) {
    const regionalForms = regional.get(char) ?? [char];
    const forms = new Set(regionalForms);
    for (const form of regionalForms) {
      // Use direct script mappings. Following them transitively would join
      // otherwise unrelated traditional characters such as 發 and 髮.
      for (const converted of [s2t.get(form), t2s.get(form)]) {
        if (!converted) continue;
        for (const variant of regional.get(converted) ?? [converted]) forms.add(variant);
      }
    }
    if (forms.size > 1) {
      hasVariants = true;
      glob += `[${[...forms].join('')}]`;
    } else if (/[A-Za-z]/.test(char)) {
      // Match LIKE's ASCII case folding without transforming stored content.
      glob += `[${char.toLowerCase()}${char.toUpperCase()}]`;
    } else {
      glob += GLOB_CHARACTERS.get(char) ?? char;
    }
  }
  return hasVariants ? { operator: 'GLOB', pattern: `${glob}*` } : { operator: 'LIKE', pattern: like };
}
