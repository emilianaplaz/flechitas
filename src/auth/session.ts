// Accounts over the Supabase Auth REST API (GoTrue), email + password. Pure functions plus a small client
// that takes its `fetch` and `storage`, so it runs the same in the browser and in tests. An account is optional.

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  user: { id: string; email: string; displayName: string };
}

export type AuthState =
  | { kind: 'signedOut' }
  | { kind: 'working' }
  | { kind: 'needsConfirmation'; email: string }
  | { kind: 'signedIn'; session: Session };

export type AuthFailure =
  | 'badCredentials'
  | 'emailTaken'
  | 'weakPassword'
  | 'emailNotConfirmed'
  | 'rateLimited'
  | 'network'
  | 'invalidEmail'
  | 'passwordTooShort'
  | 'notConfigured'
  | 'generic';

export type Outcome = { ok: true } | { ok: false; code: AuthFailure; message: string };

export interface AuthConfig {
  url: string;
  key: string;
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SESSION_KEY = 'ar-nav.session';
export const MIN_PASSWORD = 8;
export const REFRESH_MARGIN_MS = 60_000;

export const MESSAGES: Record<AuthFailure, string> = {
  badCredentials: 'Correo o contraseña incorrectos.',
  emailTaken: 'Ese correo ya tiene una cuenta. Prueba a entrar.',
  weakPassword: 'La contraseña es muy débil. Usa al menos 8 caracteres y mezcla letras y números.',
  emailNotConfirmed: 'Aún no confirmaste tu correo. Revisa tu bandeja de entrada.',
  rateLimited: 'Demasiados intentos. Espera un momento y vuelve a probar.',
  network: 'No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.',
  invalidEmail: 'Escribe un correo válido.',
  passwordTooShort: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`,
  notConfigured: 'Las cuentas necesitan el servidor configurado.',
  generic: 'No se pudo completar. Inténtalo de nuevo.',
};

const fail = (code: AuthFailure): Outcome => ({ ok: false, code, message: MESSAGES[code] });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** GoTrue reports errors as `error_code` (newer) or free text in `msg` / `error_description` (older). */
export function classifyError(status: number, body: unknown): AuthFailure {
  const b = isRecord(body) ? body : {};
  const code = String(b.error_code ?? b.code ?? '');
  const text = String(b.msg ?? b.message ?? b.error_description ?? b.error ?? '').toLowerCase();
  if (status === 429 || code.includes('rate_limit')) return 'rateLimited';
  if (code === 'email_not_confirmed' || text.includes('not confirmed')) return 'emailNotConfirmed';
  if (code === 'invalid_credentials' || text.includes('invalid login credentials')) return 'badCredentials';
  if (code === 'user_already_exists' || code === 'email_exists' || text.includes('already registered')) return 'emailTaken';
  if (code === 'weak_password' || text.includes('password should be') || text.includes('weak password')) return 'weakPassword';
  return 'generic';
}

export const emailLocalPart = (email: string) => email.split('@')[0] || email;

export function pickDisplayName(profile: string | null, metadata: string | null, email: string): string {
  return str(profile)?.trim() ?? str(metadata)?.trim() ?? emailLocalPart(email);
}

/** Reads a token response (sign in, refresh, or sign up with auto-confirm). `null` when it carries no session. */
export function parseTokenResponse(body: unknown, now: number): Session | null {
  if (!isRecord(body) || !isRecord(body.user)) return null;
  const accessToken = str(body.access_token);
  const refreshToken = str(body.refresh_token);
  const id = str(body.user.id);
  const email = str(body.user.email);
  const expiresIn = Number(body.expires_in);
  if (!accessToken || !refreshToken || !id || !email || !Number.isFinite(expiresIn)) return null;
  const meta = isRecord(body.user.user_metadata) ? str(body.user.user_metadata.display_name) : null;
  return { accessToken, refreshToken, expiresAt: now + expiresIn * 1000, user: { id, email, displayName: pickDisplayName(null, meta, email) } };
}

/** A stored session, or null when the record is missing or malformed. An expired access token is kept: its refresh token may still work. */
export function parseStoredSession(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const s: unknown = JSON.parse(raw);
    if (!isRecord(s) || !isRecord(s.user)) return null;
    const { accessToken, refreshToken, expiresAt } = s;
    const { id, email, displayName } = s.user;
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string' || !accessToken || !refreshToken) return null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
    if (typeof id !== 'string' || typeof email !== 'string' || typeof displayName !== 'string' || !id || !email) return null;
    return { accessToken, refreshToken, expiresAt, user: { id, email, displayName } };
  } catch {
    return null;
  }
}

export const needsRefresh = (s: Session, now: number) => s.expiresAt - now < REFRESH_MARGIN_MS;

/** Legacy anon keys are JWTs and also go in Authorization. New sb_publishable_ keys are not JWTs: apikey alone. */
export function requestHeaders(config: AuthConfig, accessToken?: string): Record<string, string> {
  const bearer = accessToken ?? (config.key.startsWith('eyJ') ? config.key : undefined);
  return { 'content-type': 'application/json', apikey: config.key, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
}

type Reply = { status: number; body: unknown } | null; // null: the request never got an answer

export interface AuthClient {
  state(): AuthState;
  subscribe(fn: (s: AuthState) => void): () => void;
  restore(): Promise<void>;
  signUp(input: { email: string; password: string; displayName: string }): Promise<Outcome>;
  signIn(input: { email: string; password: string }): Promise<Outcome>;
  signOut(): Promise<void>;
  /** Leaves the "check your email" screen. */
  dismissConfirmation(): void;
  /** Refreshes the access token when it is about to expire. */
  ensureFresh(): Promise<void>;
}

export function createAuthClient(deps: { config: AuthConfig | null; fetch: typeof fetch; storage: StorageLike; now?: () => number }): AuthClient {
  const { config, storage } = deps;
  const now = deps.now ?? Date.now;
  let state: AuthState = { kind: 'signedOut' };
  const listeners = new Set<(s: AuthState) => void>();
  let refreshing: Promise<void> | null = null;

  const set = (s: AuthState) => {
    state = s;
    listeners.forEach((fn) => fn(s));
  };
  const persist = (s: Session) => {
    try {
      storage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable: signed in for this visit only */
    }
  };
  const forget = () => {
    try {
      storage.removeItem(SESSION_KEY);
    } catch {
      /* nothing to clear */
    }
  };
  const adopt = (s: Session) => {
    persist(s);
    set({ kind: 'signedIn', session: s });
  };

  async function call(path: string, init: { method: string; body?: unknown; token?: string }): Promise<Reply> {
    try {
      const res = await deps.fetch(`${config!.url}${path}`, {
        method: init.method,
        headers: requestHeaders(config!, init.token),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return null;
    }
  }
  const ok = (r: Reply): r is { status: number; body: unknown } => r !== null && r.status >= 200 && r.status < 300;
  const rejectedByServer = (r: Reply) => r !== null && [400, 401, 403].includes(r.status);
  const failure = (r: Reply): Outcome => fail(r === null ? 'network' : classifyError(r.status, r.body));

  /** The profile row is the source of truth for the name. Any failure keeps the name from sign-in. */
  async function withProfileName(s: Session): Promise<Session> {
    const r = await call(`/rest/v1/profiles?id=eq.${encodeURIComponent(s.user.id)}&select=display_name`, { method: 'GET', token: s.accessToken });
    const row = ok(r) && Array.isArray(r.body) ? r.body[0] : null;
    const name = isRecord(row) ? str(row.display_name) : null;
    return name ? { ...s, user: { ...s.user, displayName: name.trim() } } : s;
  }

  /** `confirmEmail`: set for sign up, where a reply without a session means the server wants the address confirmed first. */
  async function enter(path: string, body: unknown, confirmEmail?: string): Promise<Outcome> {
    if (!config) return fail('notConfigured');
    if (state.kind === 'working') return fail('generic');
    set({ kind: 'working' });
    const r = await call(path, { method: 'POST', body });
    const session = ok(r) ? parseTokenResponse(r.body, now()) : null;
    if (session) {
      adopt(await withProfileName(session));
      return { ok: true };
    }
    if (ok(r) && confirmEmail) {
      set({ kind: 'needsConfirmation', email: confirmEmail });
      return { ok: true };
    }
    set({ kind: 'signedOut' });
    return ok(r) ? fail('generic') : failure(r);
  }

  const checkCredentials = (email: string, password: string): Outcome | null =>
    !/^\S+@\S+\.\S+$/.test(email) ? fail('invalidEmail') : password.length < MIN_PASSWORD ? fail('passwordTooShort') : null;

  async function doRefresh() {
    if (state.kind !== 'signedIn') return;
    const { session } = state;
    const r = await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refreshToken } });
    if (state.kind !== 'signedIn' || state.session !== session) return; // signed out or replaced while waiting
    if (ok(r)) {
      const next = parseTokenResponse(r.body, now());
      if (next) adopt({ ...next, user: { ...next.user, displayName: session.user.displayName } });
    } else if (rejectedByServer(r)) {
      forget();
      set({ kind: 'signedOut' });
    }
    // offline or server error: keep the session and try again later
  }
  const refresh = () => (refreshing ??= doRefresh().finally(() => (refreshing = null)));

  return {
    state: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    async restore() {
      if (!config || state.kind !== 'signedOut') return;
      let raw: string | null = null;
      try {
        raw = storage.getItem(SESSION_KEY);
      } catch {
        /* storage unavailable */
      }
      const stored = parseStoredSession(raw);
      if (!stored) {
        if (raw !== null) forget();
        return;
      }
      set({ kind: 'signedIn', session: stored });
      await refresh();
    },
    async signUp({ email, password, displayName }) {
      if (!config) return fail('notConfigured');
      const e = email.trim();
      const bad = checkCredentials(e, password);
      if (bad) return bad;
      const name = displayName.trim();
      return enter('/auth/v1/signup', { email: e, password, ...(name ? { data: { display_name: name } } : {}) }, e);
    },
    async signIn({ email, password }) {
      if (!config) return fail('notConfigured');
      const e = email.trim();
      if (!e || !password) return fail('badCredentials');
      return enter('/auth/v1/token?grant_type=password', { email: e, password });
    },
    async signOut() {
      const was = state;
      forget();
      set({ kind: 'signedOut' });
      if (config && was.kind === 'signedIn') await call('/auth/v1/logout', { method: 'POST', token: was.session.accessToken });
    },
    dismissConfirmation() {
      if (state.kind === 'needsConfirmation') set({ kind: 'signedOut' });
    },
    async ensureFresh() {
      if (state.kind === 'signedIn' && needsRefresh(state.session, now())) await refresh();
    },
  };
}
