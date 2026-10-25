// Dev only: a fake Supabase Auth kept in localStorage, so the entry flow can be tried in a browser without
// creating real accounts. Turn it on with `?mockAuth` on `npm run dev`; production builds drop this file.
// Addresses with a tag force a state: +confirm (needs the email link), +slow (3 s), +offline, +limit (rate limited).
import type { AuthConfig } from './session.ts';

export const MOCK_CONFIG: AuthConfig = { url: 'https://mock-auth.local', key: 'sb_publishable_mock' };

interface MockUser {
  id: string;
  email: string;
  password: string;
  name: string;
  confirmed: boolean;
}
const USERS_KEY = 'ar-nav.mock.users';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reply = (status: number, body?: unknown) =>
  new Response(status === 204 || body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function mockFetch(storage: Storage = localStorage): typeof fetch {
  const load = (): Record<string, MockUser> => {
    try {
      return JSON.parse(storage.getItem(USERS_KEY) ?? '{}');
    } catch {
      return {};
    }
  };
  const save = (u: Record<string, MockUser>) => storage.setItem(USERS_KEY, JSON.stringify(u));
  const userJson = (u: MockUser) => ({ id: u.id, email: u.email, user_metadata: { display_name: u.name } });
  const tokens = (u: MockUser) => ({ access_token: `mock-at.${u.id}.${Date.now()}`, refresh_token: `mock-rt.${u.id}`, expires_in: 3600, user: userJson(u) });
  const byToken = (users: Record<string, MockUser>, token: string | null) => {
    const id = token?.replace(/^Bearer /, '').split('.')[1];
    return Object.values(users).find((u) => u.id === id) ?? null;
  };

  return async (input, init) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const email = String(body.email ?? '').trim().toLowerCase();
    await sleep(email.includes('+slow') ? 3000 : 650);
    if (email.includes('+offline')) throw new TypeError('Failed to fetch');
    if (email.includes('+limit')) return reply(429, { error_code: 'over_email_send_rate_limit', msg: 'rate limit' });
    const users = load();
    const path = url.pathname;
    const method = init?.method ?? 'GET';

    if (path === '/auth/v1/signup') {
      if (users[email]) return reply(422, { error_code: 'user_already_exists', msg: 'User already registered' });
      const password = String(body.password ?? '');
      if (/^(.)\1+$/.test(password) || password === '12345678') return reply(422, { error_code: 'weak_password', msg: 'Password is too weak' });
      const data = (body.data ?? {}) as { display_name?: string };
      const u: MockUser = { id: `u${Date.now().toString(36)}`, email, password, name: data.display_name ?? '', confirmed: !email.includes('+confirm') };
      save({ ...users, [email]: u });
      return reply(200, u.confirmed ? tokens(u) : userJson(u));
    }
    if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = users[email];
      if (!u || u.password !== body.password) return reply(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (!u.confirmed) return reply(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
      return reply(200, tokens(u));
    }
    if (path === '/auth/v1/token') {
      const id = String(body.refresh_token ?? '').split('.')[1];
      const u = Object.values(users).find((x) => x.id === id);
      return u ? reply(200, tokens(u)) : reply(400, { error_code: 'refresh_token_not_found' });
    }
    if (path === '/auth/v1/recover' || path === '/auth/v1/resend') return reply(200, {});
    if (path === '/auth/v1/logout') return reply(204);
    if (path === '/auth/v1/user') {
      const u = byToken(users, headers.authorization ?? null);
      if (!u) return reply(401, { error_code: 'bad_jwt' });
      if (method === 'PUT') {
        if (body.password === u.password) return reply(422, { error_code: 'same_password' });
        save({ ...users, [u.email]: { ...u, password: String(body.password), confirmed: true } });
      }
      return reply(200, userJson(u));
    }
    if (path === '/rest/v1/profiles') {
      const u = byToken(users, headers.authorization ?? null);
      return reply(200, u ? [{ display_name: u.name || null }] : []);
    }
    return reply(404, { msg: 'not mocked' });
  };
}

/** A confirmation or recovery link for a mock user, as the email would carry it. For testing in the browser console. */
export function mockLink(email: string, type: 'signup' | 'recovery', storage: Storage = localStorage): string {
  const users = JSON.parse(storage.getItem(USERS_KEY) ?? '{}') as Record<string, MockUser>;
  const u = users[email.toLowerCase()];
  if (!u) throw new Error('no mock user');
  storage.setItem(USERS_KEY, JSON.stringify({ ...users, [u.email]: { ...u, confirmed: true } }));
  return `#access_token=mock-at.${u.id}.1&refresh_token=mock-rt.${u.id}&expires_in=3600&token_type=bearer&type=${type}`;
}
