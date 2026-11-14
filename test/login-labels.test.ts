import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { signJWT } from './auth-fixtures';

let cookie = '';
beforeEach(async () => {
  for (const table of ['audit_mutation_outbox','audit_events','data_classes','locale_messages','sessions','user_oauth_identities','users','roles','role_permissions']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  cookie = `access_token=${await signJWT({sub:'18501',email:'labels@example.invalid',name:'Labels admin',role:'admin',type:'access',exp:Math.floor(Date.now()/1000)+900},env.JWT_SECRET)}`;
});
async function call(path: string, body?: Record<string,string>, authenticated = true) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://cms.example.com${path}`,{method:body?'POST':'GET',headers:{...(authenticated?{Cookie:cookie}:{}),'Sec-Fetch-Site':'same-origin','CF-Connecting-IP':'192.0.2.191'},body:body?new URLSearchParams(body):undefined}),{...env,REGULATED_MODE:undefined,REGULATED_INVENTORY:undefined},ctx);
  await waitOnExecutionContext(ctx);return response;
}
async function data(response: Response) {
  const html = await response.text();
  const match = html.match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error('Missing render data');
  return JSON.parse(match[1]).bodyView.data;
}
it('offers a focused label editor linked from system settings', async () => {
  expect((await data(await call('/admin/settings/system'))).hasI18nFeature).toBe(true);
  const editor = await data(await call('/admin/settings/translations?scope=login&locale=en'));
  expect(editor.loginLabels).toBe(true);
  expect(editor.messages.some((row: {key:string})=>row.key==='login.signup_notice')).toBe(true);
  expect(editor.messages.every((row: {key:string})=>row.key.startsWith('login.')||row.key.startsWith('view_strings.sections_login.'))).toBe(true);
  expect(editor.messages.find((row: {key:string})=>row.key==='login.signup_notice').editValue).toBe('Access is restricted to authorized users.');
});
it('saves, serves publicly, and resets language-specific login labels while preserving editor scope', async () => {
  const saved = await call('/admin/settings/translations',{scope:'login',locale:'en',key:'login.signup_notice',value:'Staff access only. Contact your administrator.'});
  expect(saved.status).toBe(303);
  expect(saved.headers.get('Location')).toContain('scope=login');
  const catalog = await (await call('/auth/i18n/catalog/en',undefined,false)).json<Record<string,string>>();
  expect(catalog['login.signup_notice']).toBe('Staff access only. Contact your administrator.');
  const editor = await data(await call('/admin/settings/translations?scope=login&locale=en'));
  const notice = editor.messages.find((row:{key:string})=>row.key==='login.signup_notice');
  expect(notice.editValue).toBe('Staff access only. Contact your administrator.');
  const reset = await call(notice.deleteAction,{});
  expect(reset.headers.get('Location')).toContain('scope=login');
  expect((await (await call('/auth/i18n/catalog/en',undefined,false)).json<Record<string,string>>())['login.signup_notice']).toBe('Access is restricted to authorized users.');
});
it('preserves scope on validation errors and rejects unauthorized changes', async () => {
  const invalid = await call('/admin/settings/translations',{scope:'login',locale:'en',key:'login.signup_notice',value:'<script>bad</script>'});
  expect(invalid.status).toBe(303);
  expect(invalid.headers.get('Location')).toContain('scope=login&error=');
  expect((await call('/admin/settings/translations',{scope:'login',locale:'en',key:'login.signup_notice',value:'Bad'},false)).status).toBe(302);
  expect((await (await call('/auth/i18n/catalog/en',undefined,false)).json<Record<string,string>>())['login.signup_notice']).toBe('Access is restricted to authorized users.');
});
