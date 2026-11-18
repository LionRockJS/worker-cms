import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleViews } from './build-views.mjs';

test('publishing controls assemble only into publish-enabled shared screens', () => {
  const controls = {
    dashboard: ['action="{{ page.publishAction }}"', 'action="{{ page.pullAction }}"', 'value="unpublish"'],
    editor: ['data-publish-schedule-toggle', 'view_strings.sections_editor.save_and_publish'],
    tags: ['/admin/tags/sync-published'],
  };
  for (const publish of [false, true]) {
    const views = assembleViews({ publish });
    for (const [screen, markers] of Object.entries(controls)) {
      const section = views.get('sections/' + screen + '.liquid').toString();
      assert.ok(!section.includes('feature_fragment'));
      for (const marker of markers) assert.equal(section.includes(marker), publish, marker);
    }
    const strings = JSON.parse(views.get('locales/en.json')).view_strings;
    assert.equal('sections_editor.save_and_publish' in strings, publish);
    assert.ok(![...views.keys()].some(path => path.startsWith('fragments/')));
  }
});
