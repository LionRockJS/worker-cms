import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import worker from '../src/index';
import type { Env, Variables, JWTPayload } from '../src/types';
import { resolveDataClasses, classificationPolicyGuard } from '../src/core/db/data-classes';
import { registerOAuthUser } from '../src/core/auth/registration';
import { linkOAuthIdentity, updateOAuthProfile } from '../src/core/auth/oauth-account';
import { updateOwnProfileName, disconnectOwnIdentity } from '../src/core/auth/self-profile';
import { createAuthSession, rotateAuthSession, issueAuthTokens, type IssuedAuthTokens } from '../src/core/auth/sessions';
import { hashToken, verifyJWT } from '../src/core/auth/jwt';
import { signJWT } from './auth-fixtures';

const user = { id: 9971, email: 'private@example.invalid', name: 'Private Name', role: 'admin' };
const identity = { provider: 'github', providerUserId: 'private-subject', oauthId: 'github:private-subject', email: 'new@example.invalid', name: 'New Private', avatarUrl: 'private-avatar' };
let issued: IssuedAuthTokens;
let actor: JWTPayload;
let cookie: string;
let count = 0;
const trigger = 'classification_version_test_fault';
async function version() { return (await env.DB.prepare('SELECT version FROM classification_policy_version WHERE id = 1').first<{ version: number }>())!.version; }
async function upgrade() { await env.DB.prepare("INSERT INTO data_class_floors (container_kind, container_key, level) VALUES ('table', 'users', 2) ON CONFLICT(container_kind,container_key) DO UPDATE SET level=2").run(); }
async function events() { return (await env.DB.prepare("SELECT * FROM audit_events WHERE outcome = 'success' AND action IN ('user.create','user.oauth-link','user.oauth-profile','profile.update','auth.login','auth.session.rotate','auth.session.grace','user.roles','user.delete','role.create','role.update','role.delete','data_class.set')").all()).results; }

beforeEach(async () => {
  await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
  for (const table of ['audit_mutation_outbox','audit_events','sessions','user_oauth_identities','users','role_permissions','roles','data_classes','data_class_floors']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  cookie = `access_token=${await signJWT({ sub: String(user.id), ...user, type: 'access', exp: Math.floor(Date.now()/1000)+900 }, env.JWT_SECRET)}`;
  actor = (await verifyJWT(cookie.slice('access_token='.length), env.JWT_SECRET))!;
  issued = await issueAuthTokens(user, env.JWT_SECRET, actor.sid);
  await env.DB.prepare('UPDATE sessions SET refresh_token_hash = ? WHERE id = ?').bind(await hashToken(issued.refreshJti), actor.sid!).run();
  await env.DB.prepare('INSERT INTO user_oauth_identities (user_id,provider,provider_user_id,oauth_id) VALUES (?,?,?,?)').bind(user.id, identity.provider, identity.providerUserId, identity.oauthId).run();
  await env.DB.prepare("INSERT INTO users (id,oauth_id,email,name,role) VALUES (9972,'fixture:target','target@example.invalid','Target','care')").run();
  await env.DB.prepare("INSERT INTO roles (name,label,builtin) VALUES ('care','Private Role',0)").run();
  await env.DB.prepare("INSERT INTO role_permissions (role,permission) VALUES ('care','content:read')").run();
});
afterEach(async () => { await env.DB.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run(); });

/** Inject between policy resolution and the actual mutation transaction. */
function race(change: () => Promise<unknown>): Env['DB'] {
  const tracked = new WeakMap<D1PreparedStatement, { sql: string; actual: D1PreparedStatement }>();
  let changed = false;
  function track(actual: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(actual, { get(target,key) {
      if (key === 'bind') return (...values: unknown[]) => track(actual.bind(...values),sql);
      const value = Reflect.get(target,key,target); return typeof value === 'function' ? value.bind(target) : value;
    } }); tracked.set(proxy,{sql,actual}); return proxy;
  }
  const DB = { withSession: () => DB, prepare: (sql: string) => track(env.DB.prepare(sql),sql), batch: async (statements: D1PreparedStatement[]) => {
    if (!changed && statements.some(s => /^(?:INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM) (?:users|user_oauth_identities|sessions|roles|role_permissions|data_classes)\b/.test(tracked.get(s)?.sql ?? ''))) {
      changed = true; await change();
    }
    return env.DB.batch(statements.map(s => tracked.get(s)?.actual ?? s));
  } }; return DB as Env['DB'];
}

const actions = {
  registration: async (c: Parameters<typeof registerOAuthUser>[0]) => registerOAuthUser(c, { ...identity, providerUserId: 'new-subject', oauthId: 'github:new-subject' }),
  link: async (c: Parameters<typeof registerOAuthUser>[0]) => linkOAuthIdentity(c, { ...identity, providerUserId: 'new-subject', oauthId: 'github:new-subject' }, { userId:user.id, sessionId:Number(actor.sid), tokenExpiresAt:actor.exp, refreshHash:null, idleTtl:3600 }),
  oauthProfile: async (c: Parameters<typeof registerOAuthUser>[0]) => updateOAuthProfile(c,user.id,identity),
  ownProfile: async (c: Parameters<typeof registerOAuthUser>[0]) => updateOwnProfileName(c,'New Name'),
  createSession: async (c: Parameters<typeof registerOAuthUser>[0]) => createAuthSession(c.env,user,c),
  rotate: async (c: Parameters<typeof registerOAuthUser>[0]) => { const result=await rotateAuthSession(c.env,issued.refreshToken,3600,c); if (!result.ok) throw new Error('Refused'); },
};
async function invoke(action: keyof typeof actions, DB: Env['DB'] = env.DB) {
  const app = new Hono<{ Bindings:Env; Variables:Variables }>();
  app.post('/run', async c => { c.set('user',actor); try { await actions[action](c); return c.text('done'); } catch { return c.text('unavailable',503); } });
  return app.fetch(new Request('https://cms.example.com/run',{method:'POST'}),{...env, DB, REGULATED_MODE:undefined},createExecutionContext());
}
const changes = {
  upgrade,
  aba: async () => { await env.DB.prepare("INSERT INTO data_classes (container_kind,container_key,class) VALUES ('table','roles','pii')").run(); await env.DB.prepare("DELETE FROM data_classes WHERE container_key='roles'").run(); await env.DB.prepare("DELETE FROM data_class_floors WHERE container_key='roles'").run(); },
};
for (const action of Object.keys(actions) as Array<keyof typeof actions>) {
  it(`records the exact resolved generation for ${action}`, async () => {
    const expected = await version(); expect((await invoke(action)).status).toBe(200);
    expect(await events()).toHaveLength(1);
    expect(JSON.parse(String((await events())[0].detail)).classification_policy_version).toBe(expected);
  });
  for (const [name,change] of Object.entries(changes)) it(`refuses ${action} after ${name} without retaining mutations/evidence`, async () => {
    const before = await env.DB.prepare('SELECT * FROM users ORDER BY id').all();
    const sessions = await env.DB.prepare('SELECT * FROM sessions ORDER BY id').all();
    expect((await invoke(action,race(change))).status).toBe(503);
    expect((await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(before.results);
    expect((await env.DB.prepare('SELECT * FROM sessions ORDER BY id').all()).results).toEqual(sessions.results);
    expect(await events()).toEqual([]);
    expect((await env.DB.prepare('SELECT * FROM user_oauth_identities').all()).results).toHaveLength(1);
  });
}

async function api(path: string, body: Record<string,string>, DB=env.DB) {
  count++; const ctx=createExecutionContext();
  const response=await worker.fetch(new Request(`https://cms.example.com${path}`,{method:'POST',headers:{Cookie:cookie,'Sec-Fetch-Site':'same-origin','CF-Connecting-IP':`10.91.${Math.floor(count/250)}.${count%250+1}`},body:new URLSearchParams(body)}),{...env,DB,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined},ctx);
  await waitOnExecutionContext(ctx); return response;
}
for (const [path,body] of [
  ['/admin/users/9972',{roles:'viewer'}], ['/admin/users/9972/delete',{}],
  ['/admin/roles',{name:'new-role',label:'Private Label'}], ['/admin/roles/care',{permissions:'content:read'}], ['/admin/roles/care/delete',{}],
] as Array<[string,Record<string,string>]>) {
  it(`refuses stale classification for ${path}`,async () => {
    const before=(await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results;
    expect((await api(path,body,race(upgrade))).status).toBe(503);
    expect((await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(before);
    expect(await events()).toEqual([]);
  });
}

it('refuses a stale classification assignment that would lower a newly retained floor',async () => {
  expect((await api('/admin/audit/classes',{container_kind:'table',container_key:'users',class:'pii'},race(upgrade))).status).toBe(503);
  expect(await env.DB.prepare("SELECT class FROM data_classes WHERE container_key='users'").first()).toBeNull();
  expect(await events()).toEqual([]);
});
it('checks the expected new generation after an authorized policy change',async () => {
  const before=await version(); expect((await api('/admin/audit/classes',{container_kind:'table',container_key:'users',class:'phi'})).status).toBe(302);
  expect(await version()).toBe(before+2);
  expect(JSON.parse(String((await events())[0].detail))).toEqual({class:'phi',classification_policy_version_before:before,classification_policy_version_after:before+2});
});
it('rolls back a classification change and its generation if audit evidence changes policy again',async () => {
  const before=await version();
  await env.DB.prepare(`CREATE TRIGGER ${trigger} AFTER INSERT ON audit_events WHEN NEW.action='data_class.set' BEGIN UPDATE data_class_floors SET level=2 WHERE container_key='users'; END`).run();
  expect((await api('/admin/audit/classes',{container_kind:'table',container_key:'users',class:'pii'})).status).toBe(503);
  expect(await version()).toBe(before); expect(await events()).toEqual([]);
});
it.each(['data_classes','data_class_floors'])('increments generation on all writes to %s, including equal-value updates',async table => {
  const before=await version();
  await env.DB.prepare(`INSERT INTO ${table} (container_kind,container_key,${table==='data_classes'?'class':'level'}) VALUES ('table','sessions',?)`).bind(table==='data_classes'?'pii':1).run();
  const inserted=await version(); expect(inserted).toBeGreaterThan(before);
  await env.DB.prepare(`UPDATE ${table} SET container_key=container_key WHERE container_key='sessions'`).run(); expect(await version()).toBeGreaterThan(inserted);
  const updated=await version(); await env.DB.prepare(`DELETE FROM ${table} WHERE container_key='sessions'`).run(); expect(await version()).toBeGreaterThan(updated);
});
it('resolves an empty policy and its generation in one statement',async () => { const policy=await resolveDataClasses(env,true); expect(policy).toMatchObject({ok:true,size:0,version:await version()}); });
it('rolls back business writes when a captured generation changed',async () => {
  const policy=await resolveDataClasses(env,true); await upgrade();
  await expect(env.DB.batch([env.DB.prepare("UPDATE users SET name='Changed' WHERE id=?").bind(user.id),classificationPolicyGuard(env,policy)])).rejects.toThrow();
  expect(await env.DB.prepare('SELECT name FROM users WHERE id=?').bind(user.id).first()).toEqual({name:user.name});
});
it('fails classification closed if a version trigger disappears',async () => {
  const row=await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name='classification_version_data_classes_insert'").first<{sql:string}>();
  await env.DB.prepare('DROP TRIGGER classification_version_data_classes_insert').run();
  try { expect((await resolveDataClasses(env,true,false)).ok).toBe(false); expect((await invoke('ownProfile')).status).toBe(503); }
  finally { await env.DB.prepare(row!.sql).run(); }
});
it('fails classification closed if the singleton generation is missing',async () => {
  const before=await version(); await env.DB.prepare('DELETE FROM classification_policy_version').run();
  try { expect((await resolveDataClasses(env,true,false)).ok).toBe(false); expect((await invoke('createSession')).status).toBe(503); }
  finally { await env.DB.prepare('INSERT INTO classification_policy_version (id,version) VALUES (1,?)').bind(before).run(); }
});

it('refuses access-only refresh grace when policy changes before its evidence transaction',async () => {
  await env.DB.prepare("UPDATE sessions SET previous_refresh_token_hash=refresh_token_hash, refresh_token_hash='rotated-private', rotated_at=CURRENT_TIMESTAMP WHERE id=?").bind(actor.sid!).run();
  let changed=false;
  const DB={withSession:()=>DB,prepare:env.DB.prepare.bind(env.DB),batch:async (statements:D1PreparedStatement[])=>{ if(!changed){changed=true;await upgrade();} return env.DB.batch(statements); }};
  await expect(rotateAuthSession({...env,DB:DB as Env['DB']},issued.refreshToken,3600)).rejects.toThrow();
  expect(await events()).toEqual([]);
  expect(await env.DB.prepare('SELECT refresh_token_hash FROM sessions WHERE id=?').bind(actor.sid!).first()).toEqual({refresh_token_hash:'rotated-private'});
});
it('refuses classification changes if the authorizing session is revoked at batch admission',async () => {
  const before=await version();
  expect((await api('/admin/audit/classes',{container_kind:'table',container_key:'users',class:'phi'},race(async()=>env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(actor.sid!).run()))).status).toBe(503);
  expect(await version()).toBe(before); expect(await events()).toEqual([]);
});
it('preserves conservative identity containment when a known policy becomes stronger before removal',async () => {
  const row=await env.DB.prepare("INSERT INTO user_oauth_identities(user_id,provider,provider_user_id,oauth_id) VALUES (?,'github','second','github:second') RETURNING id").bind(user.id).first<{id:number}>();
  const app=new Hono<{Bindings:Env;Variables:Variables}>();
  app.post('/run',async c=>{c.set('user',actor);expect(await disconnectOwnIdentity(c,row!.id)).toBe('removed');return c.text('done');});
  const ctx=createExecutionContext();
  expect((await app.fetch(new Request('https://cms.example.com/run',{method:'POST'}),{...env,DB:race(upgrade)},ctx)).status).toBe(200);
  await waitOnExecutionContext(ctx);
  expect(await env.DB.prepare("SELECT data_class FROM audit_events WHERE action='user.oauth-disconnect'").first()).toEqual({data_class:'phi'});
});

it.each([
  ['oauthProfile','user.oauth-profile'], ['ownProfile','profile.update'], ['createSession','auth.login'], ['rotate','auth.session.rotate'],
] as const)('rolls back %s and a policy change made by an audit trigger',async (action,event) => {
  const before=await version(); const users=(await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results;
  await env.DB.prepare(`CREATE TRIGGER ${trigger} AFTER INSERT ON audit_events WHEN NEW.action='${event}' BEGIN
    INSERT INTO data_class_floors(container_kind,container_key,level) VALUES ('table','users',2);
  END`).run();
  expect((await invoke(action)).status).toBe(503);
  expect(await version()).toBe(before); expect(await events()).toEqual([]);
  expect((await env.DB.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual(users);
});
