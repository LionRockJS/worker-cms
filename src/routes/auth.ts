// ============================================================
// OAuth 2.1 routes
//   GET  /auth/login    – show the login page (HTML)
//   GET  /auth/start    – initiate OAuth flow (redirect to provider)
//   GET  /auth/callback – handle provider callback
//   GET  /auth/logout   – clear session
//   POST /auth/refresh  – programmatic token refresh (JSON API)
// ============================================================

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { signJWT, verifyJWT } from '../core/auth/jwt';
import { generateCodeVerifier, generateCodeChallenge, generateState } from '../core/auth/pkce';
import { rateLimitByIP } from '../core/http/rate-limit';
import {
  accessCookieName,
  clearAuthCookie,
  isSecureRequest,
  oauthStateCookieName,
  readAuthCookie,
  refreshCookieName,
  setAuthCookie,
} from '../core/auth/cookies';
import { loadAppBrandingSettings } from '../core/db/settings';
import { viewRevision } from '../core/http/view-revision';
import { buildTranslationCatalog, resolveUiLocale } from '../core/i18n';
import { loginPage } from '../core/templates/login';
import type { Env, Variables, JWTPayload } from '../types';
import type { AppContext } from '../core/http/context';
import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  capUserSessions,
  findRefreshSessionUserId,
  issueAuthTokens,
  purgeExpiredSessions,
  revokeRefreshSession,
  rotateAuthSession,
  storeRefreshSession,
} from '../core/auth/sessions';

// ── OAuth provider config ─────────────────────────────────────────────────────

interface OAuthProvider {
  authUrl: string;
  tokenUrl: string;
  userUrl?: string;
  scope: string;
  responseMode?: 'query' | 'form_post';
  userInfoSource?: 'userinfo' | 'id_token';
  idTokenIssuer?: string;
}

const PROVIDERS: Record<string, OAuthProvider> = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scope: 'openid email profile',
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userUrl: 'https://graph.microsoft.com/oidc/userinfo',
    scope: 'openid email profile',
  },
  apple: {
    authUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    scope: 'name email',
    responseMode: 'form_post',
    userInfoSource: 'id_token',
    idTokenIssuer: 'https://appleid.apple.com',
  },
  eventuai: {
    authUrl: 'https://id.eventuai.com/oauth/authorize',
    tokenUrl: 'https://id.eventuai.com/oauth/token',
    userUrl: 'https://id.eventuai.com/oauth/userinfo',
    scope: 'openid profile email roles',
  },
};

interface NormalizedUser {
  provider: string;
  providerUserId: string;
  oauthId: string;
  email: string;
  name: string;
  avatarUrl: string;
}

interface OAuthStatePayload extends JWTPayload {
  state?: string;
  code_verifier?: string;
  provider?: string;
  link_user_id?: string;
}

interface AuthDbUser {
  id: number;
  email: string;
  name: string;
  role: string;
}

/** True when no allowlist is configured or the email's domain is listed. */
function isEmailAllowed(env: Env, email: string): boolean {
  const allowed = (env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  const domain = email.split('@').pop()?.toLowerCase() ?? '';
  return allowed.includes(domain);
}

/** Returns the enabled providers in declaration order. */
function getEnabledProviders(env: Env): string[] {
  return (env.ENABLED_PROVIDERS ?? '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p in PROVIDERS);
}

const PROVIDER_CREDENTIAL_VARS = {
  github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  microsoft: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  apple: ['APPLE_CLIENT_ID', 'APPLE_CLIENT_SECRET'],
  eventuai: ['EVENTUAI_CLIENT_ID', 'EVENTUAI_CLIENT_SECRET'],
} as const satisfies Record<string, readonly [keyof Env, keyof Env]>;

/** Returns the client ID and secret for the given provider. */
function getProviderCredentials(
  env: Env,
  provider: string,
): { clientId: string; clientSecret: string } | null {
  const vars = PROVIDER_CREDENTIAL_VARS[provider as keyof typeof PROVIDER_CREDENTIAL_VARS];
  if (!vars) return null;
  const [clientId, clientSecret] = [env[vars[0]], env[vars[1]]];
  if (typeof clientId !== 'string' || !clientId) return null;
  if (typeof clientSecret !== 'string' || !clientSecret) return null;
  return { clientId, clientSecret };
}

function getProviderConfig(env: Env, provider: string): OAuthProvider | null {
  if (provider === 'microsoft') {
    const tenant = encodeURIComponent((env.MICROSOFT_TENANT ?? 'common').trim() || 'common');
    return {
      ...PROVIDERS.microsoft,
      authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    };
  }
  return PROVIDERS[provider] ?? null;
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

interface AppleJwk extends JsonWebKey { kid?: string; alg?: string; use?: string }
let appleKeyCache: { keys: AppleJwk[]; expires: number } | null = null;

async function appleSigningKeys(): Promise<AppleJwk[]> {
  if (appleKeyCache && appleKeyCache.expires > Date.now()) return appleKeyCache.keys;
  const response = await fetch('https://appleid.apple.com/auth/keys', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return [];
  const body = await response.json<{ keys?: unknown }>();
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is AppleJwk => !!key && typeof key === 'object')
    : [];
  appleKeyCache = { keys, expires: Date.now() + 60 * 60 * 1000 };
  return keys;
}

async function verifiedAppleIdToken(
  idToken: string,
  opts: { issuer: string; audience: string; nonce: string },
): Promise<Record<string, unknown> | null> {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = decodeBase64UrlJson(encodedHeader);
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;

    const jwk = (await appleSigningKeys()).find((key) => key.kid === header.kid && (!key.alg || key.alg === 'RS256'));
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      decodeBase64UrlBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
    );
    if (!valid) return null;

    const claims = idTokenClaims(idToken, opts);
    if (!claims || claims.nonce !== opts.nonce) return null;
    return claims;
  } catch {
    return null;
  }
}

function idTokenClaims(
  idToken: string,
  opts: { issuer?: string; audience: string },
): Record<string, unknown> | null {
  const [, payload] = idToken.split('.');
  if (!payload) return null;
  const claims = decodeBase64UrlJson(payload);
  if (!claims) return null;

  if (opts.issuer && claims['iss'] !== opts.issuer) return null;
  const aud = claims['aud'];
  if (Array.isArray(aud)) {
    if (!aud.includes(opts.audience)) return null;
  } else if (aud !== opts.audience) {
    return null;
  }
  const exp = claims['exp'];
  if (typeof exp !== 'number' || exp <= Math.floor(Date.now() / 1000)) return null;
  return claims;
}

function normalizeUser(provider: string, data: Record<string, unknown>): NormalizedUser | null {
  if (provider === 'eventuai') {
    const sub = typeof data['sub'] === 'string' ? data['sub'] : '';
    const email = typeof data['email'] === 'string' ? data['email'] : '';
    if (!sub || !email) return null;

    return {
      provider,
      providerUserId: sub,
      oauthId: `eventuai:${sub}`,
      email,
      name: String(data['preferred_username'] ?? sub),
      avatarUrl: '',
    };
  }
  if (provider === 'google') {
    const sub = typeof data['sub'] === 'string' ? data['sub'] : '';
    const email = typeof data['email'] === 'string' ? data['email'] : '';
    if (!sub || !email) return null;

    return {
      provider,
      providerUserId: sub,
      oauthId: `google:${sub}`,
      email,
      name: String(data['name'] ?? ''),
      avatarUrl: String(data['picture'] ?? ''),
    };
  }
  if (provider === 'microsoft') {
    const sub = typeof data['sub'] === 'string' ? data['sub'] : '';
    const email = typeof data['email'] === 'string'
      ? data['email']
      : typeof data['preferred_username'] === 'string'
        ? data['preferred_username']
        : '';
    if (!sub || !email) return null;

    return {
      provider,
      providerUserId: sub,
      oauthId: `microsoft:${sub}`,
      email,
      name: String(data['name'] ?? ''),
      avatarUrl: '',
    };
  }
  if (provider === 'apple') {
    const sub = typeof data['sub'] === 'string' ? data['sub'] : '';
    const email = typeof data['email'] === 'string' ? data['email'] : '';
    if (!sub || !email) return null;

    return {
      provider,
      providerUserId: sub,
      oauthId: `apple:${sub}`,
      email,
      name: String(data['name'] ?? email),
      avatarUrl: '',
    };
  }
  const id = data['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return null;

  // GitHub (default)
  return {
    provider,
    providerUserId: String(id),
    oauthId: `github:${id}`,
    email: String(data['email'] ?? `${data['login']}@github.noreply`),
    name: String(data['name'] ?? data['login'] ?? ''),
    avatarUrl: String(data['avatar_url'] ?? ''),
  };
}

async function currentAuthenticatedUserId(c: AppContext): Promise<number | null> {
  const secret = c.env.JWT_SECRET;
  const accessToken = readAuthCookie(c, accessCookieName);
  if (accessToken) {
    const payload = await verifyJWT(accessToken, secret);
    const id = Number(payload?.type === 'access' ? payload.sub : NaN);
    if (Number.isInteger(id) && id > 0) return id;
  }

  const refreshToken = readAuthCookie(c, refreshCookieName);
  if (!refreshToken) return null;
  const refreshPayload = await verifyJWT(refreshToken, secret);
  if (!refreshPayload || refreshPayload.type !== 'refresh' || !refreshPayload.jti) return null;

  return findRefreshSessionUserId(c.env.DB, refreshPayload.jti);
}

async function findUserByOAuthIdentity(db: D1DatabaseClient, oauthId: string): Promise<AuthDbUser | null> {
  const linked = await db.prepare(
    `SELECT u.id, u.email, u.name, u.role
       FROM user_oauth_identities i
       JOIN users u ON u.id = i.user_id
      WHERE i.oauth_id = ?`,
  )
    .bind(oauthId)
    .first<AuthDbUser>();
  if (linked) return linked;

  // Legacy fallback for databases that have not backfilled identities yet.
  return db.prepare('SELECT id, email, name, role FROM users WHERE oauth_id = ?')
    .bind(oauthId)
    .first<AuthDbUser>();
}

async function insertOAuthIdentity(
  db: D1DatabaseClient,
  userId: number,
  identity: NormalizedUser,
): Promise<boolean> {
  await db.prepare(
    `INSERT OR IGNORE INTO user_oauth_identities
       (user_id, provider, provider_user_id, oauth_id)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(userId, identity.provider, identity.providerUserId, identity.oauthId)
    .run();

  const owner = await db.prepare('SELECT user_id FROM user_oauth_identities WHERE oauth_id = ?')
    .bind(identity.oauthId)
    .first<{ user_id: number }>();
  return owner?.user_id === userId;
}

async function updateUserProfileFromOAuth(
  db: D1DatabaseClient,
  userId: number,
  user: NormalizedUser,
): Promise<AuthDbUser | null> {
  await db.prepare(
    `UPDATE users
        SET email = ?, name = ?, avatar_url = ?
      WHERE id = ?`,
  )
    .bind(user.email, user.name, user.avatarUrl, userId)
    .run();
  return db.prepare('SELECT id, email, name, role FROM users WHERE id = ?')
    .bind(userId)
    .first<AuthDbUser>();
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Throttle the endpoints involved in credential issuance.
const authRateLimit = rateLimitByIP((env) => env.AUTH_RATE_LIMITER);
authRoutes.use('/start', authRateLimit);
authRoutes.use('/callback', authRateLimit);
authRoutes.use('/refresh', authRateLimit);

// The login page is public, so it cannot use the authenticated admin catalog
// endpoint. Translation catalogs contain UI copy only and are safe to expose.
authRoutes.get('/i18n/catalog/:locale', async (c) => {
  try {
    return c.json(await buildTranslationCatalog(c.env, c.req.param('locale')), 200, {
      'Cache-Control': 'private, no-cache',
    });
  } catch {
    return c.json({ error: 'Locale not found' }, 404);
  }
});

// GET /auth/login – show the login page (HTML)
authRoutes.get('/login', async (c) => {
  const providers = getEnabledProviders(c.env);
  const error = c.req.query('error');
  const [branding, uiLocale] = await Promise.all([
    loadAppBrandingSettings(c.env, c.env.SITE_TITLE ?? '0xCMS'),
    resolveUiLocale(c),
  ]);
  return c.html(
    await loginPage(c.env.VIEWS, {
      siteTitle: branding.appName,
      appIcon: branding.appIcon,
      providers: providers.length > 0 ? providers : ['github'],
      error,
      viewRevision: viewRevision(c.env),
      uiLocale: uiLocale.code,
      uiDirection: uiLocale.direction,
      catalogHref: `/auth/i18n/catalog/${encodeURIComponent(uiLocale.code)}`,
    }),
  );
});

// GET /auth/start?provider=<name> – initiate OAuth 2.1 flow with PKCE
authRoutes.get('/start', async (c) => {
  const enabledProviders = getEnabledProviders(c.env);
  // Accept the provider from the query string; fall back to the first enabled one.
  const requested = c.req.query('provider')?.toLowerCase() ?? '';
  const providerName = enabledProviders.includes(requested)
    ? requested
    : enabledProviders[0] ?? 'github';

  const providerConfig = getProviderConfig(c.env, providerName);
  if (!providerConfig) {
    return c.text(`Unsupported OAuth provider: ${providerName}`, 500);
  }

  const credentials = getProviderCredentials(c.env, providerName);
  if (!credentials) {
    return c.text(`OAuth credentials not configured for provider: ${providerName}`, 500);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();
  const linkRequested = c.req.query('link') === '1';
  const linkUserId = linkRequested ? await currentAuthenticatedUserId(c) : null;
  if (linkRequested && !linkUserId) {
    return c.redirect('/auth/login?error=link_session_expired');
  }

  // Store PKCE state (including the chosen provider) in a signed short-lived
  // JWT cookie so we have no server-side storage dependency.
  const statePayload = {
    sub: 'pkce',
    email: '',
    name: '',
    role: 'viewer',
    // Dedicated type so this cookie can never be accepted as an access token:
    // the auth middleware only honors type === 'access'.
    type: 'oauth_state' as const,
    state,
    code_verifier: codeVerifier,
    provider: providerName,
    ...(linkUserId ? { link_user_id: String(linkUserId) } : {}),
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };
  const stateCookie = await signJWT(statePayload, c.env.JWT_SECRET);
  const secureCookie = isSecureRequest(c.req.raw);
  // __Host- requires Path=/; SameSite=None so the cookie is sent on the
  // cross-site top-level redirect back from the OAuth provider.
  setCookie(c, oauthStateCookieName(secureCookie), stateCookie, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? 'None' : 'Lax',
    path: '/',
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: c.env.OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: providerConfig.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  if (providerConfig.responseMode) {
    params.set('response_mode', providerConfig.responseMode);
  }
  if (providerConfig.userInfoSource === 'id_token') {
    params.set('nonce', state);
  }

  return c.redirect(`${providerConfig.authUrl}?${params.toString()}`);
});

type OAuthCallbackParams = { code?: string; state?: string; error?: string };

async function handleOAuthCallback(c: AppContext, params: OAuthCallbackParams): Promise<Response> {
  const { code, state, error } = params;

  if (error) {
    return c.redirect(`/auth/login?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return c.redirect('/auth/login?error=missing_params');
  }

  // Verify PKCE state cookie (legacy unprefixed name accepted for one release)
  const secureCookie = isSecureRequest(c.req.raw);
  const stateCookie = getCookie(c, oauthStateCookieName(secureCookie))
    ?? (secureCookie ? getCookie(c, oauthStateCookieName(false)) : undefined)
    ?? getCookie(c, 'oauth_state');
  deleteCookie(c, oauthStateCookieName(secureCookie), {
    secure: secureCookie,
    sameSite: secureCookie ? 'None' : 'Lax',
    path: '/',
  });
  deleteCookie(c, 'oauth_state', { path: '/auth' });
  if (!stateCookie) {
    return c.redirect('/auth/login?error=missing_state');
  }

  const statePayload = await verifyJWT(stateCookie, c.env.JWT_SECRET) as OAuthStatePayload | null;
  if (!statePayload) {
    return c.redirect('/auth/login?error=invalid_state');
  }

  const storedState = statePayload.state;
  const codeVerifier = statePayload.code_verifier;

  if (!storedState || !codeVerifier || storedState !== state) {
    return c.redirect('/auth/login?error=state_mismatch');
  }

  const providerName = statePayload.provider ?? '';
  const providerConfig = getProviderConfig(c.env, providerName);
  if (!providerConfig) {
    return c.redirect('/auth/login?error=unsupported_provider');
  }

  const credentials = getProviderCredentials(c.env, providerName);
  if (!credentials) {
    return c.redirect('/auth/login?error=provider_not_configured');
  }

  // Exchange code for provider access token
  const tokenRes = await fetch(providerConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      redirect_uri: c.env.OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    return c.redirect('/auth/login?error=token_exchange_failed');
  }

  const tokenData = await tokenRes.json<Record<string, string>>();
  let rawUser: Record<string, unknown> | null = null;
  if (providerConfig.userInfoSource === 'id_token') {
    const idToken = tokenData['id_token'];
    if (!idToken) {
      return c.redirect('/auth/login?error=no_id_token');
    }
    rawUser = providerName === 'apple' && providerConfig.idTokenIssuer
      ? await verifiedAppleIdToken(idToken, {
        issuer: providerConfig.idTokenIssuer,
        audience: credentials.clientId,
        nonce: storedState,
      })
      : idTokenClaims(idToken, {
        issuer: providerConfig.idTokenIssuer,
        audience: credentials.clientId,
      });
    if (!rawUser) {
      return c.redirect('/auth/login?error=invalid_id_token');
    }
  } else {
    const providerAccessToken = tokenData['access_token'];
    if (!providerAccessToken) {
      return c.redirect('/auth/login?error=no_access_token');
    }
    if (!providerConfig.userUrl) {
      return c.redirect('/auth/login?error=userinfo_not_configured');
    }

    // Fetch user info from provider
    const userRes = await fetch(providerConfig.userUrl, {
      headers: {
        Authorization: 'Bearer ' + providerAccessToken,
        Accept: 'application/json',
        'User-Agent': 'worker-cms/1.0',
      },
    });
    if (!userRes.ok) {
      return c.redirect('/auth/login?error=userinfo_failed');
    }

    rawUser = await userRes.json<Record<string, unknown>>();
  }
  const normalized = normalizeUser(providerName, rawUser);
  if (!normalized) {
    return c.redirect('/auth/login?error=invalid_userinfo');
  }

  const linkedUser = await findUserByOAuthIdentity(c.env.DB, normalized.oauthId);
  const linkUserId = Number(statePayload.link_user_id ?? NaN);
  let dbUser: AuthDbUser | null = null;

  if (Number.isInteger(linkUserId) && linkUserId > 0) {
    const currentUserId = await currentAuthenticatedUserId(c);
    if (currentUserId !== linkUserId) {
      return c.redirect('/auth/login?error=link_session_mismatch');
    }
    if (linkedUser && linkedUser.id !== linkUserId) {
      return c.redirect('/auth/login?error=identity_already_linked');
    }
    dbUser = await c.env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?')
      .bind(linkUserId)
      .first<AuthDbUser>();
    if (!dbUser) {
      return c.redirect('/auth/login?error=db_error');
    }
    const linked = await insertOAuthIdentity(c.env.DB, dbUser.id, normalized);
    if (!linked) {
      return c.redirect('/auth/login?error=identity_already_linked');
    }
  } else if (linkedUser) {
    try {
      dbUser = await updateUserProfileFromOAuth(c.env.DB, linkedUser.id, normalized);
    } catch {
      return c.redirect('/auth/login?error=email_in_use');
    }
  } else {
    // Optional registration allowlist: when ALLOWED_EMAIL_DOMAINS is set, only
    // matching emails may create a new account. Existing linked users always
    // pass so a config change can never lock out current accounts.
    if (!isEmailAllowed(c.env, normalized.email)) {
      return c.redirect('/auth/login?error=email_not_allowed');
    }

    const existingEmail = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
      .bind(normalized.email)
      .first<{ id: number }>();
    if (existingEmail) {
      return c.redirect('/auth/login?error=identity_not_linked');
    }

    // New accounts always start as least-privilege viewers. Later logins only
    // refresh profile fields, so role changes made in the Users admin stick.
    await c.env.DB.prepare(
      `INSERT INTO users (oauth_id, email, name, avatar_url, role)
       VALUES (?, ?, ?, ?, 'viewer')`,
    )
      .bind(normalized.oauthId, normalized.email, normalized.name, normalized.avatarUrl)
      .run();

    dbUser = await c.env.DB.prepare(
      'SELECT id, email, name, role FROM users WHERE oauth_id = ?',
    )
      .bind(normalized.oauthId)
      .first<AuthDbUser>();
    if (dbUser) {
      const linked = await insertOAuthIdentity(c.env.DB, dbUser.id, normalized);
      if (!linked) {
        return c.redirect('/auth/login?error=identity_already_linked');
      }
    }
  }

  if (!dbUser) {
    return c.redirect('/auth/login?error=db_error');
  }

  const issued = await issueAuthTokens(dbUser, c.env.JWT_SECRET);
  await storeRefreshSession(c.env.DB, dbUser.id, issued.refreshJti);

  // Session hygiene: cap concurrent sessions per user and purge expired rows.
  c.executionCtx.waitUntil(Promise.all([
    capUserSessions(c.env.DB, dbUser.id),
    purgeExpiredSessions(c.env.DB),
  ]));

  setAuthCookie(c, accessCookieName, issued.accessToken, ACCESS_TOKEN_TTL);
  setAuthCookie(c, refreshCookieName, issued.refreshToken, REFRESH_TOKEN_TTL);

  return c.redirect('/admin');
}

// GET /auth/callback – handle provider redirects that return query params
authRoutes.get('/callback', (c) => handleOAuthCallback(c, c.req.query() as OAuthCallbackParams));

// POST /auth/callback – Apple commonly returns form_post responses.
authRoutes.post('/callback', async (c) => {
  const body = await c.req.parseBody();
  return handleOAuthCallback(c, {
    code: typeof body['code'] === 'string' ? body['code'] : undefined,
    state: typeof body['state'] === 'string' ? body['state'] : undefined,
    error: typeof body['error'] === 'string' ? body['error'] : undefined,
  });
});

// POST /auth/logout – revoke session and clear cookies.
// Logout is a state change: POST only, protected by the global
// cross-site mutation check in index.ts.
authRoutes.post('/logout', async (c) => {
  const refreshToken = readAuthCookie(c, refreshCookieName);
  if (refreshToken) {
    await revokeRefreshSession(c.env.DB, c.env.JWT_SECRET, refreshToken);
  }

  clearAuthCookie(c, accessCookieName);
  clearAuthCookie(c, refreshCookieName);

  return c.redirect('/auth/login');
});

authRoutes.get('/logout', (c) => c.text('Method Not Allowed', 405));

// POST /auth/refresh – programmatic silent refresh (JSON)
authRoutes.post('/refresh', async (c) => {
  const refreshToken = readAuthCookie(c, refreshCookieName);
  if (!refreshToken) {
    return c.json({ error: 'no_refresh_token' }, 401);
  }

  const rotated = await rotateAuthSession(c.env.DB, c.env.JWT_SECRET, refreshToken);
  if (!rotated.ok) {
    return c.json({ error: rotated.error }, 401);
  }

  // Opportunistic hygiene: purge expired sessions without blocking the response.
  c.executionCtx.waitUntil(purgeExpiredSessions(c.env.DB));

  setAuthCookie(c, accessCookieName, rotated.accessToken, ACCESS_TOKEN_TTL);
  if (rotated.refreshToken) {
    setAuthCookie(c, refreshCookieName, rotated.refreshToken, REFRESH_TOKEN_TTL);
  }

  return c.json({ ok: true, expires_in: ACCESS_TOKEN_TTL });
});
