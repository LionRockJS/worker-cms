import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { clearConfigCache, resolveCmsConfig } from '../src/core/db/content-config';
import {
  PAGE_TYPE_EXTENSIONS_SETTING_KEY,
  applyPageTypeExtensions,
  loadPageTypeExtensions,
} from '../src/core/db/page-type-store';
import { cmsConfig } from '../src/cms-config';
import type { CmsConfig } from '../src/cms-config';
import { saveSetting } from '../src/core/db/settings';

const cmsEnv = env as unknown as Env;

function freshConfig(): CmsConfig {
  return {
    ...cmsConfig,
    blueprint: { ...cmsConfig.blueprint },
    blocks: { ...cmsConfig.blocks },
    blockLists: { ...cmsConfig.blockLists },
    taxonomies: { ...cmsConfig.taxonomies },
    taxonomyLists: { ...cmsConfig.taxonomyLists },
  };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(PAGE_TYPE_EXTENSIONS_SETTING_KEY).run();
  clearConfigCache();
});

describe('applyPageTypeExtensions', () => {
  it('unions extra blocks and taxonomies into an existing type', () => {
    const config = freshConfig();
    const slug = Object.keys(config.blueprint)[0];
    const baseBlocks = config.blockLists[slug] ?? [];
    applyPageTypeExtensions(config, { [slug]: { blocks: ['extra_block', ...baseBlocks], taxonomies: ['extra_taxonomy'] } });
    expect(config.blockLists[slug]).toEqual([...baseBlocks, 'extra_block']);
    expect(config.taxonomyLists[slug]).toEqual(expect.arrayContaining(['extra_taxonomy']));
  });

  it('ignores extensions for unknown page types', () => {
    const config = freshConfig();
    applyPageTypeExtensions(config, { nope: { blocks: ['extra_block'], taxonomies: [] } });
    expect(config.blockLists.nope).toBeUndefined();
  });
});

describe('page-type extension storage', () => {
  it('round-trips through the settings table and resolveCmsConfig', async () => {
    const slug = Object.keys(cmsConfig.blueprint)[0];
    await saveSetting(cmsEnv, PAGE_TYPE_EXTENSIONS_SETTING_KEY, JSON.stringify({
      [slug]: { blocks: ['extra_block'], taxonomies: ['extra_taxonomy'] },
    }));

    const stored = await loadPageTypeExtensions(cmsEnv);
    expect(stored[slug]).toEqual({ blocks: ['extra_block'], taxonomies: ['extra_taxonomy'] });

    clearConfigCache();
    const resolved = await resolveCmsConfig(cmsEnv);
    expect(resolved.blockLists[slug]).toEqual(expect.arrayContaining([...(cmsConfig.blockLists[slug] ?? []), 'extra_block']));
    expect(resolved.taxonomyLists[slug]).toEqual(expect.arrayContaining(['extra_taxonomy']));
  });

  it('drops malformed and unsafe entries on load', async () => {
    const raw = '{'
      + '"__proto__": {"blocks": ["bad"], "taxonomies": []},'
      + '"good": {"blocks": ["ok", 42], "taxonomies": "nope"},'
      + '"empty": {"blocks": [], "taxonomies": []},'
      + '"broken": "not-an-object"'
      + '}';
    await saveSetting(cmsEnv, PAGE_TYPE_EXTENSIONS_SETTING_KEY, raw);
    expect(await loadPageTypeExtensions(cmsEnv)).toEqual({ good: { blocks: ['ok'], taxonomies: [] } });
  });
});

it('resolves compiled types when optional type tables are absent', async () => {
  await env.DB.batch([
    env.DB.prepare('ALTER TABLE page_types RENAME TO saved_page_types'),
    env.DB.prepare('ALTER TABLE block_types RENAME TO saved_block_types'),
  ]);
  try {
    const config = await resolveCmsConfig(cmsEnv);
    expect(config.blueprint).toEqual(cmsConfig.blueprint);
    expect(config.blocks).toEqual(cmsConfig.blocks);
  } finally {
    await env.DB.batch([
      env.DB.prepare('ALTER TABLE saved_page_types RENAME TO page_types'),
      env.DB.prepare('ALTER TABLE saved_block_types RENAME TO block_types'),
    ]);
    clearConfigCache();
  }
});
