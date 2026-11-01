// A.8.11. Client-side masking hid personal data from a bystander but shipped
// the cleartext to everyone who loaded the page. These cases pin that the
// value is withheld from the response unless the viewer holds `pii:reveal`,
// and that serving it in clear is recorded as its own disclosure.
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { signJWT } from './auth-fixtures';
import { clearRolePermissionsCache } from '../src/core/auth/roles';
import { clearConfigCache } from '../src/core/db/content-config';
import { maskPrivateValue } from '../src/core/render/privacy';
import type { JWTPayload } from '../src/types';

const worker = (exports as unknown as { default: Fetcher }).default;
let ip = 0;

async function visit(path: string, role: string): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: '1', email: 'admin@example.com', name: 'Admin User', role,
    type: 'access', exp: now + 900, iat: now,
  } as JWTPayload, env.JWT_SECRET);
  ip += 1;
  return worker.fetch(new Request(`http://localhost${path}`, {
    redirect: 'manual',
    headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': `10.8.0.${ip % 250 + 1}` },
  }));
}

/** A role that may administer users but was not granted cleartext PII. */
async function seedRole(name: string, permissions: string[]): Promise<void> {
  await env.DB.prepare('INSERT INTO roles (name, label) VALUES (?1, ?1) ON CONFLICT(name) DO NOTHING').bind(name).run();
  await env.DB.prepare('DELETE FROM role_permissions WHERE role = ?').bind(name).run();
  for (const permission of permissions) {
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind(name, permission).run();
  }
  clearRolePermissionsCache();
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM audit_events').run();
  await env.DB.prepare(
    `INSERT INTO users (id, oauth_id, email, name, role) VALUES (1, 'fixture:1', 'admin@example.com', 'Admin User', 'admin')
     ON CONFLICT(id) DO UPDATE SET role = excluded.role`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO users (id, oauth_id, email, name, role) VALUES (2, 'fixture:2', 'patient.zero@hospital.example', 'Johnathan Smithson', 'viewer')
     ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name`,
  ).run();
  clearRolePermissionsCache();
});

describe('server-side mask', () => {
  it('keeps a value recognisable without disclosing it', () => {
    expect(maskPrivateValue('patient.zero@hospital.example', 'email')).toBe('pa***o@ho***l.example');
    expect(maskPrivateValue('Johnathan Smithson', 'name')).toBe('Jo***n Sm***n');
    expect(maskPrivateValue('+852 9123 4567', 'phone')).toBe('+***7');
    expect(maskPrivateValue('', 'name')).toBe('');
    expect(maskPrivateValue(null, 'email')).toBe('');
  });

  it('masks a short token without revealing its tail', () => {
    expect(maskPrivateValue('Al', 'name')).toBe('A***');
  });
});

describe('users list withholds personal data', () => {
  it('never sends the cleartext to a viewer without pii:reveal', async () => {
    await seedRole('privacy-steward', ['users:manage']);

    const response = await visit('/admin/users', 'privacy-steward');
    const body = await response.text();

    expect(response.status).toBe(200);
    // Sections render in the browser from the embedded render payload, so the
    // question is what the server serialized, not what the cell ends up as.
    expect(body).not.toContain('patient.zero@hospital.example');
    expect(body).not.toContain('Johnathan Smithson');
    expect(body).toContain('pa***o@ho***l.example');
    // No reveal affordance ships, because nothing in the page can be revealed.
    expect(body).toContain('"canRevealPii":false');
  });

  it('sends it to a viewer holding pii:reveal and keeps the client toggle', async () => {
    const response = await visit('/admin/users', 'admin');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('patient.zero@hospital.example');
    // The client toggle masks by default for this viewer; it is now a
    // convenience for someone already authorized, not the control itself.
    expect(body).toContain('"canRevealPii":true');
  });

  it('records cleartext disclosure separately from the list read', async () => {
    await env.DB.prepare(
      "INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'users', 'pii')",
    ).run();
    try {
      await visit('/admin/users', 'admin');

      await expect.poll(async () => {
        const rows = await env.DB.prepare(
          "SELECT action FROM audit_events WHERE action IN ('user.list', 'user.pii-reveal') ORDER BY action",
        ).all<{ action: string }>();
        return rows.results.map(row => row.action);
      }).toEqual(['user.list', 'user.pii-reveal']);
    } finally {
      await env.DB.prepare("DELETE FROM data_classes WHERE container_key = 'users'").run();
    }
  });

  it('records no disclosure when the values were withheld', async () => {
    await seedRole('privacy-steward', ['users:manage']);
    await env.DB.prepare(
      "INSERT INTO data_classes (container_kind, container_key, class) VALUES ('table', 'users', 'pii')",
    ).run();
    try {
      await visit('/admin/users', 'privacy-steward');

      await expect.poll(async () => {
        const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'user.list'")
          .first<{ n: number }>();
        return row?.n ?? 0;
      }).toBeGreaterThan(0);
      const revealed = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'user.pii-reveal'")
        .first<{ n: number }>();
      expect(revealed?.n).toBe(0);
    } finally {
      await env.DB.prepare("DELETE FROM data_classes WHERE container_key = 'users'").run();
    }
  });
});

// The dashboard masks the page name, which for a contact-shaped page type is
// the person. The page type opts in by declaring a PII field in its blueprint.
describe('dashboard list withholds a contact page name', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM pages').run();
    await env.DB.prepare(
      `INSERT INTO page_types (id, slug, name, blueprint) VALUES (8201, 'contact-card', 'Contact card', ?)
       ON CONFLICT(id) DO UPDATE SET blueprint = excluded.blueprint`,
    ).bind(JSON.stringify(['name:text', 'email:text'])).run();
    await env.DB.prepare(
      `INSERT INTO pages (uuid, name, slug, page_type, lect) VALUES ('pii-page-uuid', 'Johnathan Smithson', 'johnathan', 'contact-card', '{}')`,
    ).run();
    clearConfigCache();
  });

  it('masks the name for a viewer without pii:reveal', async () => {
    await seedRole('content-reader', ['content:read']);

    const body = await (await visit('/admin/pages/list/contact-card', 'content-reader')).text();

    expect(body).not.toContain('Johnathan Smithson');
    expect(body).toContain('Jo***n Sm***n');
  });

  it('serves the name to a viewer holding pii:reveal', async () => {
    const body = await (await visit('/admin/pages/list/contact-card', 'admin')).text();

    expect(body).toContain('Johnathan Smithson');
  });
});
