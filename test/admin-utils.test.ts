import { describe, expect, it } from 'vitest';
import {
  dashboardPageHref,
  dashboardPageNumber,
  dashboardPageSize,
  dashboardStatusFilter,
  editorsFromForm,
  nullableStr,
  num,
  safeAdminReturnPath,
  slugify,
  str,
  strParam,
} from '../src/core/http/forms';
import { validatePageBasics } from '../src/core/db/validation';
import { planPageReorder, publicationStatusForPage } from '../src/core/db/page-logic';
import {
  advancedSearchCondition,
  advancedSearchOperator,
  advancedSearchOrder,
  advancedSearchSort,
  getPathValue,
  parseAdvancedSearchCriteria,
  sqliteJsonPath,
} from '../src/core/db/search';
import { chineseSearchVariants, toSimplified, toTraditional } from '../src/core/db/chinese';

describe('forms helpers', () => {
  it('coerces form values to trimmed strings', () => {
    expect(str('  hi  ')).toBe('hi');
    expect(str(undefined)).toBe('');
    expect(str(null)).toBe('');
    expect(strParam('  q ')).toBe('q');
    expect(nullableStr('   ')).toBeNull();
    expect(nullableStr(' x ')).toBe('x');
  });

  it('parses numbers with a fallback', () => {
    expect(num('5')).toBe(5);
    expect(num(3)).toBe(3);
    expect(num('not-a-number', 9)).toBe(9);
    expect(num(undefined)).toBe(5); // default fallback
  });

  it('slugifies names', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('  Trim --- Me  ')).toBe('trim-me');
    expect(slugify('Café & Co')).toBe('caf-co');
  });

  it('normalizes editor id lists, deduping and dropping invalid ids', () => {
    const form = new FormData();
    form.set('editors', '1, 2 ,2,abc,3');
    expect(editorsFromForm(form)).toBe('1,2,3');

    const empty = new FormData();
    empty.set('editors', 'abc, ,');
    expect(editorsFromForm(empty)).toBeNull();
  });

  it('clamps dashboard page size and number', () => {
    expect(dashboardPageSize('50')).toBe(50);
    expect(dashboardPageSize('0')).toBe(1);
    expect(dashboardPageSize('9999')).toBe(100);
    expect(dashboardPageSize(undefined)).toBe(100);
    expect(dashboardPageNumber('3')).toBe(3);
    expect(dashboardPageNumber('-2')).toBe(1);
    expect(dashboardPageNumber(undefined)).toBe(1);
  });

  it('builds dashboard page hrefs', () => {
    expect(dashboardPageHref('/admin', 2, 50)).toBe('/admin?page=2&pagesize=50');
    expect(dashboardPageHref('/admin', 2, 50, { status: 'live' })).toBe('/admin?page=2&pagesize=50&status=live');
  });

  it('normalizes dashboard status filters', () => {
    expect(dashboardStatusFilter('draft')).toBe('draft');
    expect(dashboardStatusFilter('scheduled')).toBe('scheduled');
    expect(dashboardStatusFilter('live')).toBe('live');
    expect(dashboardStatusFilter('ended')).toBe('ended');
    expect(dashboardStatusFilter('published')).toBe('');
    expect(dashboardStatusFilter(undefined)).toBe('');
  });

  it('only allows admin-relative return paths', () => {
    expect(safeAdminReturnPath('/admin/pages/list/default')).toBe('/admin/pages/list/default');
    expect(safeAdminReturnPath('https://evil.example/admin')).toBe('/admin');
    expect(safeAdminReturnPath('/somewhere-else')).toBe('/admin');
    expect(safeAdminReturnPath(undefined, '/admin/trash')).toBe('/admin/trash');
  });
});

describe('publicationStatusForPage', () => {
  const now = new Date('2026-08-04T04:00:00.000Z');

  it('uses the published flag before evaluating the schedule window', () => {
    expect(publicationStatusForPage({ start: '2026-08-04T13:00', timezone: '+0800' }, false, now)).toBe('draft');
    expect(publicationStatusForPage({ start: '2026-08-04T13:00', timezone: '+0800' }, true, now)).toBe('scheduled');
    expect(publicationStatusForPage({ end: '2026-08-04T12:00', timezone: '+0800' }, true, now)).toBe('ended');
    expect(publicationStatusForPage({ start: '2026-08-04T11:00', end: '2026-08-04T13:00', timezone: '+0800' }, true, now)).toBe('live');
  });

  it('resolves IANA timezone values for scheduled pages', () => {
    expect(publicationStatusForPage({ start: '2026-08-04T13:00', timezone: 'Asia/Hong_Kong' }, true, now)).toBe('scheduled');
  });
});

describe('validatePageBasics', () => {
  it('flags missing name and slug', () => {
    expect(validatePageBasics('', '')).toEqual([
      'Page name is required.',
      'Slug is required.',
    ]);
  });

  it('flags invalid slug characters only when a slug is present', () => {
    expect(validatePageBasics('Name', 'Bad Slug')).toEqual([
      'Slug may only contain lowercase letters, numbers and hyphens.',
    ]);
  });

  it('accepts a valid name and slug', () => {
    expect(validatePageBasics('Name', 'ok-slug-1')).toEqual([]);
  });
});

describe('advanced search parsing', () => {
  it('parses indexed criteria from a URL, deduping tags', () => {
    const url = 'https://cms.test/admin/advanced-search?search1=hello%20world&path1=name&tags1=1,2&tags1=2&search2=&tags2=5';
    const criteria = parseAdvancedSearchCriteria(url);
    expect(criteria).toEqual([
      { index: 1, term: 'hello world', path: 'name', tags: ['1', '2'] },
      { index: 2, term: '', path: '', tags: ['5'] },
    ]);
  });

  it('omits criteria with neither a term nor tags', () => {
    const url = 'https://cms.test/admin/advanced-search?search1=&path1=name&tags1=';
    expect(parseAdvancedSearchCriteria(url)).toEqual([]);
  });

  it('normalizes operator, sort, and order with safe defaults', () => {
    expect(advancedSearchOperator('or')).toBe('OR');
    expect(advancedSearchOperator('NOT')).toBe('NOT');
    expect(advancedSearchOperator('weird')).toBe('AND');
    expect(advancedSearchSort('name')).toBe('name');
    expect(advancedSearchSort('drop table')).toBe('updated_at');
    expect(advancedSearchOrder('asc')).toBe('ASC');
    expect(advancedSearchOrder('whatever')).toBe('DESC');
  });

  it('builds sqlite json paths and reads nested values', () => {
    expect(sqliteJsonPath('name')).toBe('$.name');
    expect(sqliteJsonPath('link.url')).toBe('$.link.url');
    expect(sqliteJsonPath('')).toBe('$');
    expect(getPathValue({ link: { url: '/x' } }, 'link.url')).toBe('/x');
    expect(getPathValue({ a: 1 }, 'a.b')).toBeUndefined();
  });
});

describe('Chinese Simplified/Traditional search variants', () => {
  it('converts between scripts character by character', () => {
    expect(toTraditional('苏玮')).toBe('蘇瑋');
    expect(toSimplified('蘇瑋')).toBe('苏玮');
    // Unmapped (shared) characters are left untouched.
    expect(toTraditional('中文')).toBe('中文');
  });

  it('adds the opposite-script variant for a Chinese term', () => {
    expect(chineseSearchVariants('苏玮').sort()).toEqual(['苏玮', '蘇瑋'].sort());
    expect(chineseSearchVariants('蘇瑋').sort()).toEqual(['苏玮', '蘇瑋'].sort());
  });

  it('returns a single variant for non-Chinese or shared-character terms', () => {
    expect(chineseSearchVariants('hello')).toEqual(['hello']);
    expect(chineseSearchVariants('')).toEqual(['']);
    // 中文 is identical in both scripts, so no extra variant is produced.
    expect(chineseSearchVariants('中文')).toEqual(['中文']);
  });

  it('ORs a LIKE per variant in the SQL condition for a Chinese term', () => {
    const { conditions, params } = advancedSearchCondition(
      { index: 1, term: '苏玮', path: '', tags: [] },
      'p',
    );
    expect(conditions).toEqual(['(p.lect LIKE ? OR p.lect LIKE ?)']);
    expect(params).toEqual(['%苏玮%', '%蘇瑋%']);
  });

  it('keeps a single LIKE (no OR) for a non-Chinese term', () => {
    const { conditions, params } = advancedSearchCondition(
      { index: 1, term: 'hello world', path: '', tags: [] },
      'p',
    );
    expect(conditions).toEqual(['p.lect LIKE ?']);
    expect(params).toEqual(['%hello%world%']);
  });

  it('ORs variants within a json path condition', () => {
    const { conditions, params } = advancedSearchCondition(
      { index: 1, term: '苏玮', path: 'name', tags: [] },
      'p',
    );
    expect(conditions).toEqual(['(json_extract(p.lect, ?) LIKE ? OR json_extract(p.lect, ?) LIKE ?)']);
    expect(params).toEqual(['$.name', '%苏玮%', '$.name', '%蘇瑋%']);
  });
});

describe('planPageReorder', () => {
  // A never-reordered list: everything sits at the default weight, so the
  // rendered order is really name/id order and any drop has to normalize.
  const flat = [1, 2, 3, 4, 5, 6].map((id) => ({ id, weight: 5 }));
  // The same list once normalized.
  const dense = [1, 2, 3, 4, 5, 6].map((id, index) => ({ id, weight: (index + 1) * 10 }));

  it('renumbers the whole sequence on the first reorder of a window', () => {
    const plan = planPageReorder(flat, 2, [3, 4], [4, 3]);
    expect(plan.stale).toBe(false);
    expect(plan.stale === false && plan.updates).toEqual([
      { id: 1, weight: 10 }, { id: 2, weight: 20 }, { id: 4, weight: 30 },
      { id: 3, weight: 40 }, { id: 5, weight: 50 }, { id: 6, weight: 60 },
    ]);
  });

  it('writes only the rows that move once the sequence is dense', () => {
    // Page 2 of a 2-per-page list: swap ids 3 and 4, leave 1/2/5/6 alone.
    const plan = planPageReorder(dense, 2, [3, 4], [4, 3]);
    expect(plan.stale === false && plan.updates).toEqual([
      { id: 4, weight: 30 }, { id: 3, weight: 40 },
    ]);
  });

  it('never renumbers a windowed drop into rows on another page', () => {
    // Reordering the last window must leave the earlier pages untouched.
    const plan = planPageReorder(dense, 4, [5, 6], [6, 5]);
    expect(plan.stale === false && plan.updates.map((row) => row.id)).toEqual([6, 5]);
  });

  it('rejects a drop whose window no longer matches the stored order', () => {
    expect(planPageReorder(dense, 2, [3, 9], [9, 3]).stale).toBe(true);
    expect(planPageReorder(dense, 2, [4, 3], [3, 4]).stale).toBe(true);
    // Past the end of the sequence — the list shrank under the tab.
    expect(planPageReorder(dense, 6, [7, 8], [8, 7]).stale).toBe(true);
  });

  it('rejects a payload that is not a permutation of the window', () => {
    expect(planPageReorder(dense, 0, [1, 2], [1, 5]).stale).toBe(true);
    expect(planPageReorder(dense, 0, [1, 2], [1]).stale).toBe(true);
  });
});
