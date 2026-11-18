// ============================================================
// Reference Worker CMS plugin — "events".
//
// A self-contained Cloudflare Worker that implements the CMS plugin
// contract over the reserved /__plugin/* prefix. It exercises every
// extension point:
//   - content types  : registers an `event` blueprint
//   - fields & blocks : registers an `events-map` field + its snippet
//   - lifecycle hooks : logs publish/unpublish/delete
//   - admin + nav     : an "Events" nav item + a proxied admin page
//   - edit/new views  : renders the whole edit and create forms for `event` pages
//   - read view       : renders the read-only view for `event` pages
//   - publish target  : receives full page snapshots on publish —
//     swap the log lines for an IPFS pin, webhook, search index, …
//
// Deploy it, register its HTTPS URL in Admin -> Plugins, then copy that
// registration's dedicated secret to this Worker. See README.md.
// ============================================================

interface PluginEnv {
  /** This registration's dedicated secret (set via `wrangler secret put`). */
  PLUGIN_SECRET?: string;
}

const MANIFEST = {
  id: 'events',
  name: 'Events',
  version: '1.0.0',
  hooks: ['publish', 'unpublish', 'delete'],
  publishTarget: true,
  nav: [{ label: 'Events', href: 'dashboard', roles: ['admin', 'editor'] }],
  contentTypes: {
    blueprint: {
      event: ['@date', 'venue', 'location:events-map', { speakers: ['name'] }],
    },
    taxonomies: {
      audience: 'Audience',
    },
    taxonomyLists: {
      event: ['audience'],
    },
  },
  fieldTypes: [{ type: 'events-map' }],
  // `event` pages render their edit form here (POST /__plugin/edit) instead
  // of the built-in editor. The form posts back to the CMS's save handler.
  editViews: ['event'],
  // `event` pages render their create/new form through the same endpoint, with
  // ctx.mode === 'new'. Omit this to use the built-in new-page form.
  newViews: ['event'],
  // `event` pages render their read-only view here (POST /__plugin/read)
  // instead of the built-in static view.
  readViews: ['event'],
};

/** Context the CMS POSTs to /__plugin/edit. Mirrors EditViewContext in the CMS. */
interface EditViewContext {
  mode: 'new' | 'edit';
  action: string;
  backHref: string;
  language: string;
  pageType: string;
  page: {
    id: number | string;
    name: string;
    slug: string;
    pageType: string;
    weight: number;
    start: string | null;
    end: string | null;
    timezone: string | null;
    editors: string | null;
    lect: string;
  };
  versions: Array<{ id: number; created_at: string; action: string | null }>;
  flash?: string;
  errors?: string[];
}

/** Context the CMS POSTs to /__plugin/read. Mirrors ReadViewContext in the CMS. */
interface ReadViewContext {
  editHref: string;
  backHref: string;
  language: string;
  pageType: string;
  page: EditViewContext['page'];
  versions: Array<{ id: number; created_at: string; action: string | null }>;
}

// Liquid snippet for the `events-map` field, served to the CMS Liquid engine.
// Receives the same `field`/`values`/`names` data as core pagefield snippets.
const EVENTS_MAP_SNIPPET = `<label for="{{ field.id | escape }}" class="min-w-0 block">
  <span class="block text-sm font-medium text-gray-700 mb-1">{{ field.label | escape }} (lat,lng)</span>
  <input id="{{ field.id | escape }}" type="text" name="{{ field.inputName | escape }}"
         value="{{ field.value | escape }}"
         placeholder="51.5074,-0.1278"
         class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
</label>
`;

export default {
  async fetch(request: Request, env: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Hooks, publish, and user-context views fail closed unless this plugin's
    // dedicated secret is configured and matches the CMS request header.
    // The manifest and static view files are intentionally public discovery assets.
    const secretRequired = path.startsWith('/__plugin/hooks/')
      || path.startsWith('/__plugin/publish/')
      || path.startsWith('/__plugin/admin')
      || path === '/__plugin/edit'
      || path === '/__plugin/read';
    if (secretRequired && (!env.PLUGIN_SECRET || request.headers.get('x-plugin-secret') !== env.PLUGIN_SECRET)) {
      return new Response('forbidden', { status: 403 });
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    if (path === '/__plugin/views/snippets/pagefield/events-map/basic.liquid') {
      return new Response(EVENTS_MAP_SNIPPET, { headers: { 'content-type': 'text/plain' } });
    }

    // Publish target: the CMS awaits these calls and treats non-2xx responses
    // as a failed target, so do the real work (pin to IPFS, push to a search
    // index, call a webhook) before returning.
    if (path === '/__plugin/publish/page') {
      const snapshot = await request.json().catch(() => null);
      console.log('[events plugin] publish page:', JSON.stringify(snapshot));
      return new Response('ok');
    }
    if (path === '/__plugin/publish/remove') {
      const body = await request.json().catch(() => null);
      console.log('[events plugin] unpublish:', JSON.stringify(body));
      return new Response('ok');
    }
    if (path === '/__plugin/publish/remove-tag') {
      const body = await request.json().catch(() => null);
      console.log('[events plugin] remove tag:', JSON.stringify(body));
      return new Response('ok');
    }

    if (path.startsWith('/__plugin/hooks/')) {
      const event = path.split('/').pop();
      const payload = await request.json().catch(() => ({}));
      console.log(`[events plugin] hook ${event}:`, JSON.stringify(payload));
      return new Response('ok');
    }

    // Edit view: the CMS hands `event` pages to us. We return an HTML *fragment*
    // (the CMS wraps it in admin chrome) whose form posts back to ctx.action —
    // the CMS's normal save handler — using the standard field-name conventions.
    if (path === '/__plugin/edit' && request.method === 'POST') {
      const ctx = (await request.json().catch(() => null)) as EditViewContext | null;
      if (!ctx) return new Response('bad request', { status: 400 });
      const title = ctx.mode === 'edit' ? `Edit: ${ctx.page.name}` : 'New event';
      return new Response(eventEditForm(ctx), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-cms-chrome': '1',
          'x-cms-title': encodeURIComponent(title),
        },
      });
    }

    // Read view: the CMS hands `event` pages to us for a read-only render. We
    // return an HTML *fragment* (the CMS wraps it in admin chrome) — no form,
    // just static fields plus a link back to the CMS editor (ctx.editHref).
    if (path === '/__plugin/read' && request.method === 'POST') {
      const ctx = (await request.json().catch(() => null)) as ReadViewContext | null;
      if (!ctx) return new Response('bad request', { status: 400 });
      return new Response(eventReadView(ctx), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'x-cms-chrome': '1',
          'x-cms-title': encodeURIComponent(`View: ${ctx.page.name}`),
        },
      });
    }

    if (path.startsWith('/__plugin/admin')) {
      const user = parseUser(request.headers.get('x-cms-user'));
      return new Response(adminDashboard(user), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    return new Response('not found', { status: 404 });
  },
};

// Reads a possibly-localized lect value for the active language, falling back
// to a bare scalar. The lect stores value fields as { <lang>: "..." } maps and
// attributes as plain scalars.
function lectValue(lect: Record<string, unknown>, name: string, language: string): string {
  const raw = lect[name];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const map = raw as Record<string, unknown>;
    return String(map[language] ?? map.mis ?? Object.values(map)[0] ?? '');
  }
  return raw == null ? '' : String(raw);
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string));
}

// The plugin-owned edit/new form for an `event` page. Returns an HTML fragment;
// the CMS wraps it in admin chrome. Field names follow the CMS conventions:
//   @name  → attribute        .name|<lang> → localized value        page basics by name.
function eventEditForm(ctx: EditViewContext): string {
  const lect = (() => {
    try { return JSON.parse(ctx.page.lect || '{}') as Record<string, unknown>; }
    catch { return {}; }
  })();
  const lang = ctx.language;
  const errors = (ctx.errors ?? []).map((e) => `<li>${esc(e)}</li>`).join('');
  const field = (label: string, name: string, value: string, type = 'text') => `
    <label class="block">
      <span class="block text-sm font-medium text-gray-700 mb-1">${esc(label)}</span>
      <input type="${type}" name="${esc(name)}" value="${esc(value)}"
             class="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
    </label>`;

  return `<form method="post" action="${esc(ctx.action)}" class="max-w-2xl mx-auto space-y-5 p-2">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">${ctx.mode === 'edit' ? `Edit event: ${esc(ctx.page.name)}` : 'New event'}</h1>
      <a href="${esc(ctx.backHref)}" class="text-sm text-gray-500 hover:text-gray-700">Cancel</a>
    </div>
    ${ctx.flash ? `<p class="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">${esc(ctx.flash)}</p>` : ''}
    ${errors ? `<ul class="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700 list-disc list-inside">${errors}</ul>` : ''}

    <input type="hidden" name="page_type" value="${esc(ctx.pageType)}">
    <input type="hidden" name="language" value="${esc(lang)}">
    <input type="hidden" name="return_to" value="${esc(ctx.backHref)}">

    ${field('Name', 'name', ctx.page.name)}
    ${field('Slug', 'slug', ctx.page.slug)}
    ${field('Date', '@date', lectValue(lect, 'date', lang), 'date')}
    ${field('Venue', `.venue|${lang}`, lectValue(lect, 'venue', lang))}
    ${field('Location (lat,lng)', `.location|${lang}`, lectValue(lect, 'location', lang))}
    ${field('Weight', 'weight', String(ctx.page.weight), 'number')}

    <div class="flex gap-3 pt-2">
      <button type="submit" name="action" value="update"
              class="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold">Save</button>
      <button type="submit" name="action" value="publish"
              class="px-4 py-2 rounded-lg bg-gray-800 text-white text-sm font-semibold">Save &amp; Publish</button>
    </div>
  </form>`;
}

// The plugin-owned read-only view for an `event` page. Returns an HTML fragment
// the CMS wraps in admin chrome. Pure static display — no inputs — with an Edit
// link back to the CMS editor (ctx.editHref).
function eventReadView(ctx: ReadViewContext): string {
  const lect = (() => {
    try { return JSON.parse(ctx.page.lect || '{}') as Record<string, unknown>; }
    catch { return {}; }
  })();
  const lang = ctx.language;
  const row = (label: string, value: string) => `
    <div class="min-w-0">
      <dt class="text-xs font-semibold uppercase tracking-wide text-gray-400">${esc(label)}</dt>
      <dd class="mt-0.5 min-w-0 break-words text-sm text-gray-800">${value ? esc(value) : '<span class="text-gray-400">&mdash;</span>'}</dd>
    </div>`;

  return `<div class="max-w-2xl mx-auto space-y-5 p-2">
    <div class="flex items-center justify-between gap-3">
      <h1 class="min-w-0 break-words text-xl font-bold text-gray-900">${esc(ctx.page.name)}</h1>
      <div class="flex shrink-0 items-center gap-3">
        <a href="${esc(ctx.editHref)}" class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">Edit</a>
        <a href="${esc(ctx.backHref)}" class="text-sm text-gray-500 hover:text-gray-700">Back</a>
      </div>
    </div>

    <dl class="grid grid-cols-1 gap-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:grid-cols-2 sm:p-6">
      ${row('Slug', `/${ctx.page.slug}`)}
      ${row('Weight', String(ctx.page.weight))}
      ${row('Date', lectValue(lect, 'date', lang))}
      ${row('Venue', lectValue(lect, 'venue', lang))}
      ${row('Location', lectValue(lect, 'location', lang))}
    </dl>
  </div>`;
}

function parseUser(header: string | null): { name?: string; role?: string } {
  if (!header) return {};
  try {
    return JSON.parse(header) as { name?: string; role?: string };
  } catch {
    return {};
  }
}

function adminDashboard(user: { name?: string; role?: string }): string {
  const name = (user.name ?? 'there').replace(/</g, '&lt;');
  const role = (user.role ?? '').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Events</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 p-8">
  <div class="max-w-2xl mx-auto bg-white rounded-xl shadow p-6">
    <h1 class="text-2xl font-bold text-gray-900 mb-2">Events plugin</h1>
    <p class="text-gray-600">Hello, ${name}${role ? ` (${role})` : ''}.</p>
    <p class="text-gray-600 mt-4">This page is served by the <code>events</code> plugin Worker and
    proxied through the CMS at <code>/admin/plugins/events/dashboard</code>.</p>
  </div>
</body>
</html>`;
}
