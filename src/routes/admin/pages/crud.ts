// Page create / read / edit / update, plus the weight controls.
//
// NOTE on ordering: POST /pages/batch-weight must stay registered ahead of
// POST /pages/:id, or "batch-weight" is read as a page id. Both live here so
// the order is local and visible.

import { Hono } from 'hono';
import { editorPage } from '../../../core/templates/editor';
import { readPage } from '../../../core/templates/read';
import { resolveCmsConfig } from '../../../core/db/content-config';
import { announcePageEvent } from '../../../core/page-events';
import { viewSourceFor } from '../../../core/render/view-source';
import { coreExtensions } from '../../../core/extensions';
import { reservePageCreate, type FeatureReservation } from '../../../features/services';
import { blueprintToLect, safeParseLect, stringifyLect } from '../../../core/db/lect';
import type { Env, Variables, Page, PageVersion } from '../../../types';
import { appendQuery, editorsFromForm, languageFromRequest, nullableStr, num, safeAdminReturnPath, str, userIdFromContext } from '../../../core/http/forms';
import { validatePageBasics } from '../../../core/db/validation';
import { applyStructuredAction, isStructuredEditorAction, lectForPage, lectFromForm, withDraftMetadata } from '../../../core/db/page-logic';
import { editorTaxonomy, ensureUniqueDraftSlug, fetchEditorUsers, fetchUserName, parentPageOption, resolveParentPageId, savePageVersion } from '../../../core/db/admin-queries';
import { publishPageToTargets } from '../../../core/publish';
import { renderPage } from '../../../core/render/chrome';
import { uiTranslator } from '../../../core/i18n';
import { requirePermission } from '../../../core/auth/guards';
import { userCan } from '../../../core/auth/permissions';
import { notifyPageSaved, setDraftPageTags } from '../../../core/db/page-store';
import { publishFlash } from './lifecycle';
import {
  defaultTimezone,
  deletePageVersion,
  editorPageData,
  maybePluginEditView,
  maybePluginReadView,
  pluginPageFromForm,
  preferNativeEditor,
  structuredEditorProps,
  withNativeFlag,
} from './editor';


export const pageCrudRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── New page form ─────────────────────────────────────────────────────────────

pageCrudRoutes.get('/pages/new', requirePermission('content:write'), async (c) => {
  const pageType = c.req.query('page_type') || 'default';
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, undefined, config);
  const lect = blueprintToLect(pageType, config.blueprint, config.defaultLanguage);
  const backHref = safeAdminReturnPath(c.req.query('return_to'));

  const pluginView = await maybePluginEditView(c, {
    mode: 'new',
    action: '/admin/pages',
    backHref,
    language,
    pageType,
    page: {
      id: '',
      name: '',
      slug: '',
      pageType,
      weight: 5,
      start: null,
      end: null,
      timezone: defaultTimezone(c),
      editors: null,
      lect: stringifyLect(lect),
    },
  });
  if (pluginView) return pluginView;

  const taxonomy = await editorTaxonomy(c.env.DB);
  return renderPage(c, editorPage, {
    parentPages: [],
    tags: taxonomy.tags,
    taxonomies: taxonomy.taxonomies,
    selectedTagIds: [],
    action: withNativeFlag(c, '/admin/pages'),
    defaultPageType: pageType,
    defaultTimezone: defaultTimezone(c),
    backHref,
    t: await uiTranslator(c),
    structured: structuredEditorProps(config, language, lect, pageType),
  }, viewSourceFor(c.env));
});

// ── Create page ───────────────────────────────────────────────────────────────

pageCrudRoutes.post('/pages', requirePermission('content:write'), async (c) => {
  const form = await c.req.formData();
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, form, config);

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors = validatePageBasics(name, slug);
  const backHref = safeAdminReturnPath(form.get('return_to'));

  // Plugin-declared quotas bind the admin editor too — otherwise a "max
  // events" limit would only gate the /__cms API while the built-in create
  // form (which plugin newViews post to) walked straight past it.
  {
    const pageType = nullableStr(form.get('page_type')) ?? 'default';
    const parentRaw = nullableStr(form.get('page_id'));
    const lect = lectFromForm(
      config,
      pageType,
      blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
      form,
      language,
    );
    const violation = await coreExtensions().checkCreateLimits?.(c.env, [
      { pageType, parentId: parentRaw ? parseInt(parentRaw, 10) : null, lect },
    ]);
    if (violation) errors.push(violation);
  }

  // Page-create costs charge the signed-in editor. Deducted only when the
  // request is otherwise valid (a validation re-render must never cost
  // credits); a failed insert below refunds.
  let createReservation: FeatureReservation | null = null;
  if (!errors.length) {
    const pageType = nullableStr(form.get('page_type')) ?? 'default';
    createReservation = await reservePageCreate(c, pageType);
    if (!createReservation.ok) errors.push(createReservation.message);
  }

  if (errors.length) {
    const pageType = nullableStr(form.get('page_type')) ?? 'default';
    const lect = lectFromForm(
      config,
      pageType,
      blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
      form,
      language,
    );

    const pluginView = await maybePluginEditView(c, {
      mode: 'new',
      action: '/admin/pages',
      backHref,
      language,
      pageType,
      page: pluginPageFromForm(form, { id: '', name, slug, pageType }, lect, defaultTimezone(c)),
      errors,
    });
    if (pluginView) return pluginView;

    const [parentPages, taxonomy] = await Promise.all([
      parentPageOption(c.env.DB, nullableStr(form.get('page_id'))),
      editorTaxonomy(c.env.DB),
    ]);
    return renderPage(c, editorPage, {
      parentPages,
      tags: taxonomy.tags,
      taxonomies: taxonomy.taxonomies,
      selectedTagIds: [],
      errors,
      action: withNativeFlag(c, '/admin/pages'),
      defaultPageType: pageType,
      defaultTimezone: defaultTimezone(c),
      backHref,
      t: await uiTranslator(c),
      structured: structuredEditorProps(config, language, lect, pageType),
    }, viewSourceFor(c.env), 422);
  }

  const pageTypeVal = nullableStr(form.get('page_type')) ?? 'default';
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const timezoneVal = nullableStr(form.get('timezone')) ?? defaultTimezone(c);
  const pageIdVal = nullableStr(form.get('page_id'));
  const weightVal = num(form.get('weight'));
  const creator = userIdFromContext(c);
  const editorsVal = editorsFromForm(form);
  const lectVal = stringifyLect(
    withDraftMetadata(
      lectFromForm(
        config,
        pageTypeVal,
        blueprintToLect(pageTypeVal, config.blueprint, config.defaultLanguage),
        form,
        language,
      ),
      userIdFromContext(c),
    ),
  );

  try {
  // Insert page
  const uniqueSlug = await ensureUniqueDraftSlug(c.env.DB, slug);
  const pageResult = await c.env.DB.prepare(
    `INSERT INTO pages (name, slug, weight, start, end, timezone, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      name,
      uniqueSlug,
      weightVal,
      startVal,
      endVal,
      timezoneVal,
      pageTypeVal,
      lectVal,
      await resolveParentPageId(c.env.DB, pageIdVal),
      creator || null,
      editorsVal,
    )
    .run();

  // The schema uses a custom DEFAULT id expression (not INTEGER PRIMARY KEY),
  // so last_row_id is the internal rowid — we must SELECT the actual id back.
  const pageRow = await c.env.DB.prepare('SELECT id FROM pages WHERE rowid = ?')
    .bind(pageResult.meta.last_row_id)
    .first<{ id: number }>();
  const pageId = pageRow!.id;

  // Insert page version
  await savePageVersion(c.env.DB, pageId, lectVal, 'create');
  await setDraftPageTags(c.env.DB, pageId, form.getAll('tag_ids'), false);

  announcePageEvent(c, 'create', { id: pageId, page_type: pageTypeVal, name, slug: uniqueSlug });

  return c.redirect(appendQuery(backHref, 'flash=Page+created+successfully'));
  } catch (error) {
    if (createReservation?.ok) await createReservation.refund();
    throw error;
  }
});

pageCrudRoutes.post('/pages/batch-weight', requirePermission('content:write'), async (c) => {
  const body = await c.req.json<{ updates: { id: number; weight: number }[] }>();
  const { updates } = body;

  if (!Array.isArray(updates)) return c.json({ error: 'Invalid input' }, 400);

  const statements = [];
  for (const update of updates) {
    const id = Number(update?.id);
    const weight = Number(update?.weight);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(weight)) {
      return c.json({ error: 'Invalid input' }, 400);
    }
    statements.push(c.env.DB.prepare('UPDATE pages SET weight = ? WHERE id = ?').bind(weight, id));
  }

  if (!statements.length) return c.json({ success: true });

  const results = await c.env.DB.batch(statements);
  if (results.some((r) => !r.success)) {
    return c.json({ error: 'Some updates failed' }, 500);
  }

  return c.json({ success: true });
});

// ── Read page (read-only view) ────────────────────────────────────────────────
// Same structured content as the editor, rendered as static text instead of
// inputs. Always uses the built-in read view (plugin edit views are for editing).

pageCrudRoutes.get('/pages/:id/read', requirePermission('content:read'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, undefined, config);
  const requestedVersionId = parseInt(c.req.query('version') ?? '', 10);
  const backHref = safeAdminReturnPath(c.req.query('return_to'));

  const page = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(pageId).first<Page>();
  if (!page) return c.notFound();

  const data = await editorPageData(c, page, page.page_id, requestedVersionId);
  const pageType = page.page_type ?? 'default';
  const lect = lectForPage(config, pageType, data.version?.lect ?? page.lect);

  // A plugin that owns this page type's read view renders it (unless ?native=1).
  const pluginView = await maybePluginReadView(c, {
    editHref: `/admin/pages/${pageId}/edit`,
    backHref,
    language,
    pageType,
    page: {
      id: page.id,
      name: page.name,
      slug: page.slug,
      pageType,
      weight: page.weight,
      start: page.start,
      end: page.end,
      timezone: page.timezone,
      editors: page.editors,
      lect: stringifyLect(lect),
    },
    versions: data.versions,
  });
  if (pluginView) return pluginView;

  const [modifierName, editorUsers] = await Promise.all([
    fetchUserName(c.env.DB, num(lect._modifier, 0)),
    fetchEditorUsers(c.env.DB, page.editors),
  ]);

  return renderPage(c, readPage, {
    page: { ...page, lect: stringifyLect(lect) },
    modifierName: modifierName ?? undefined,
    editorUsers,
    version: data.version ?? data.currentVersion ?? undefined,
    isVersionPreview: !!data.version,
    liveVersionId: data.liveVersionId,
    parentPages: data.parentPages,
    tags: data.taxonomy.tags,
    taxonomies: data.taxonomy.taxonomies,
    selectedTagIds: data.selectedTagIds,
    backHref,
    structured: structuredEditorProps(config, language, lect, pageType, data.versions),
    t: await uiTranslator(c),
  });
});

// ── Edit page form ────────────────────────────────────────────────────────────

pageCrudRoutes.get('/pages/:id/edit', requirePermission('content:read'), async (c) => {
  // Read-only users may follow edit links from shared URLs or plugin views, but
  // must never receive an editable form (or its collaboration client). Keep the
  // complete query string so language, version previews, native views, and the
  // caller's return path survive the redirect.
  if (!(await userCan(c, 'content:write'))) {
    const query = new URL(c.req.url).search;
    return c.redirect(`/admin/pages/${encodeURIComponent(c.req.param('id'))}/read${query}`);
  }

  const pageId = parseInt(c.req.param('id'), 10);
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, undefined, config);
  const requestedVersionId = parseInt(c.req.query('version') ?? '', 10);
  const flash = c.req.query('flash') ?? '';
  const backHref = safeAdminReturnPath(c.req.query('return_to'));

  const page = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?').bind(pageId).first<Page>();
  if (!page) return c.notFound();

  const data = await editorPageData(c, page, page.page_id, requestedVersionId);
  const pageType = page.page_type ?? 'default';
  const lect = lectForPage(config, pageType, data.version?.lect ?? page.lect);

  const pluginView = await maybePluginEditView(c, {
    mode: 'edit',
    action: `/admin/pages/${pageId}`,
    backHref,
    language,
    pageType,
    page: {
      id: page.id,
      name: page.name,
      slug: page.slug,
      pageType,
      weight: page.weight,
      start: page.start,
      end: page.end,
      timezone: page.timezone,
      editors: page.editors,
      lect: stringifyLect(lect),
    },
    versions: data.versions,
    flash: flash || undefined,
  });
  if (pluginView) return pluginView;

  const [creatorName, modifierName, editorUsers] = await Promise.all([
    fetchUserName(c.env.DB, page.creator),
    fetchUserName(c.env.DB, num(lect._modifier, 0)),
    fetchEditorUsers(c.env.DB, page.editors),
  ]);

  return renderPage(c, editorPage, {
    page: { ...page, lect: stringifyLect(lect) },
    creatorName: creatorName ?? undefined,
    modifierName: modifierName ?? undefined,
    editorUsers,
    version: data.version ?? data.currentVersion ?? undefined,
    isVersionPreview: !!data.version,
    liveVersionId: data.liveVersionId,
    isPublished: data.isPublished,
    isLiveSynced: data.isLiveSynced,
    parentPages: data.parentPages,
    tags: data.taxonomy.tags,
    taxonomies: data.taxonomy.taxonomies,
    selectedTagIds: data.selectedTagIds,
    flash: flash || undefined,
    action: withNativeFlag(c, `/admin/pages/${pageId}`),
    backHref,
    defaultTimezone: defaultTimezone(c),
    t: await uiTranslator(c),
    // Current draft lect, so a version preview can diff against it.
    draftLect: stringifyLect(lectForPage(config, pageType, page.lect)),
    structured: structuredEditorProps(config, language, lect, pageType, data.versions),
  }, viewSourceFor(c.env));
});

pageCrudRoutes.post('/pages/:id/weight', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const weight = num(form.get('weight'));
  const returnPath = safeAdminReturnPath(form.get('return_to'));

  const result = await c.env.DB.prepare('UPDATE pages SET weight = ? WHERE id = ?')
    .bind(weight, pageId)
    .run();

  const flash = result.success ? 'flash=Draft+weight+updated' : 'flash=Weight+update+failed';
  return c.redirect(appendQuery(returnPath, flash));
});

// ── Update page ───────────────────────────────────────────────────────────────

pageCrudRoutes.post('/pages/:id', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, form, config);
  const action = str(form.get('action'));
  const backHref = safeAdminReturnPath(form.get('return_to'));

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors = validatePageBasics(name, slug);

  const page = await c.env.DB.prepare('SELECT * FROM pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  if (action.startsWith('delete-version:')) {
    const versionId = parseInt(action.split(':')[1], 10);
    if (!Number.isFinite(versionId)) return c.notFound();
    const deleted = await deletePageVersion(c.env.DB, page, versionId);
    if (!deleted) return c.notFound();
    return c.redirect(`/admin/pages/${pageId}/edit?flash=Version+removed`);
  }

  if (action === 'delete-versions') {
    // History only — the page's own lect is what gets edited and published.
    await c.env.DB.prepare('DELETE FROM page_versions WHERE page_id = ?')
      .bind(pageId)
      .run();
    return c.redirect(`/admin/pages/${pageId}/edit?flash=Versions+cleaned`);
  }


  if (action.startsWith('revert:')) {
    const versionId = parseInt(action.split(':')[1], 10);
    const version = await c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? AND id = ?')
      .bind(pageId, versionId)
      .first<PageVersion>();
    if (!version) return c.notFound();
    const revertedLect = stringifyLect(
      withDraftMetadata(safeParseLect(version.lect ?? page.lect), userIdFromContext(c)),
    );
    // Restoring is an ordinary edit: the old snapshot becomes the working copy
    // and is appended to history. The pre-revert content stays in history as
    // the snapshot written by the save before this one, so the revert itself
    // is reversible and visible in the version list.
    await c.env.DB.prepare('UPDATE pages SET lect = ? WHERE id = ?')
      .bind(revertedLect, pageId)
      .run();
    await savePageVersion(c.env.DB, pageId, revertedLect, 'restore');
    return c.redirect(`/admin/pages/${pageId}/edit?flash=Version+restored`);
  }

  if (errors.length) {
    const data = await editorPageData(c, page, nullableStr(form.get('page_id')) ?? page.page_id);
    const pageType = nullableStr(form.get('page_type')) ?? page.page_type ?? 'default';
    const lect = lectFromForm(config, pageType, lectForPage(config, pageType, page.lect), form, language);

    const pluginView = await maybePluginEditView(c, {
      mode: 'edit',
      action: `/admin/pages/${pageId}`,
      backHref,
      language,
      pageType,
      page: pluginPageFromForm(form, { id: pageId, name, slug, pageType }, lect, page.timezone),
      versions: data.versions,
      errors,
    });
    if (pluginView) return pluginView;

    // Keep the editors the user picked in the form (not the stored row) so a
    // validation error doesn't silently revert their selection.
    const formEditors = editorsFromForm(form);
    return renderPage(c, editorPage, {
      page: { ...page, editors: formEditors },
      editorUsers: await fetchEditorUsers(c.env.DB, formEditors),
      version: data.version ?? data.currentVersion ?? undefined,
      liveVersionId: data.liveVersionId,
      isPublished: data.isPublished,
      isLiveSynced: data.isLiveSynced,
      parentPages: data.parentPages,
      tags: data.taxonomy.tags,
      taxonomies: data.taxonomy.taxonomies,
      selectedTagIds: data.selectedTagIds,
      errors,
      action: withNativeFlag(c, `/admin/pages/${pageId}`),
      backHref,
      defaultTimezone: defaultTimezone(c),
      t: await uiTranslator(c),
      structured: structuredEditorProps(config, language, lect, pageType, data.versions),
    }, viewSourceFor(c.env), 422);
  }

  const pageTypeVal = nullableStr(form.get('page_type')) ?? page.page_type ?? 'default';
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const timezoneVal = nullableStr(form.get('timezone'));
  const pageIdVal = nullableStr(form.get('page_id'));
  const weightVal = num(form.get('weight'));
  const editorsVal = editorsFromForm(form);
  const lect = applyStructuredAction(
    config,
    lectFromForm(config, pageTypeVal, lectForPage(config, pageTypeVal, page.lect), form, language),
    pageTypeVal,
    action,
    form,
  );
  const lectVal = stringifyLect(withDraftMetadata(lect, userIdFromContext(c)));

  // Update page metadata
  const uniqueSlug = await ensureUniqueDraftSlug(c.env.DB, slug, pageId);
  await c.env.DB.prepare(
    `UPDATE pages SET name=?, slug=?, weight=?, start=?, end=?, timezone=?, page_type=?, lect=?, page_id=?, editors=? WHERE id=?`,
  )
    .bind(
      name,
      uniqueSlug,
      weightVal,
      startVal,
      endVal,
      timezoneVal,
      pageTypeVal,
      lectVal,
      await resolveParentPageId(c.env.DB, pageIdVal),
      editorsVal,
      pageId,
    )
    .run();

  await savePageVersion(
    c.env.DB,
    pageId,
    lectVal,
    action || 'update',
  );

  // Commit the live collaboration overlay: clears uncommitted ops so save-then-leave
  // doesn't revert, and pushes the saved values as everyone's new baseline.
  await notifyPageSaved(c.env, pageId);

  await setDraftPageTags(c.env.DB, pageId, form.getAll('tag_ids'), true);

  // Preserve where the editor returns to (e.g. a plugin dashboard) across saves,
  // so the back arrow / Cancel button still point there after a save reload.
  const returnToParam = backHref !== '/admin' ? `&return_to=${encodeURIComponent(backHref)}` : '';
  // Keep the built-in-editor override across the post-save reload.
  const nativeParam = preferNativeEditor(c) ? '&native=1' : '';

  const autoRepublish = action !== 'publish'
    && await (coreExtensions().autoPublishesPageType?.(c.env, pageTypeVal) ?? false)
    && !!await c.env.PUBLISHED_DB.prepare('SELECT 1 FROM pages WHERE uuid = ?')
      .bind(page.uuid)
      .first();

  if (action === 'publish' || autoRepublish) {
    const outcome = await publishPageToTargets(c.env, pageId);
    if (!outcome) return c.notFound();
    if (!outcome.refused) announcePageEvent(c, 'publish', { id: pageId, uuid: page.uuid, page_type: pageTypeVal, name, slug: uniqueSlug });
    if (action === 'publish') {
      return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}&flash=${publishFlash(outcome)}${returnToParam}${nativeParam}`);
    }
  }

  if (isStructuredEditorAction(action)) {
    return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}${returnToParam}${nativeParam}`);
  }

  if (!autoRepublish) announcePageEvent(c, 'update', { id: pageId, uuid: page.uuid, page_type: pageTypeVal, name, slug: uniqueSlug });

  const savedFlash = autoRepublish ? 'Page+updated+and+published+successfully' : 'Page+updated+successfully';
  return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}&flash=${savedFlash}${returnToParam}${nativeParam}`);
});
