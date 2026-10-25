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
  | 'missingFields'
  | 'emailTaken'
  | 'weakPassword'
  | 'emailNotConfirmed'
  | 'rateLimited'
  | 'network'
  | 'invalidEmail'
  | 'passwordTooShort'
  | 'notConfigured'
  | 'linkExpired'
  | 'samePassword'
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
/** A request that hangs (a tunnel, weak signal) gives up and reads as "no connection". */
export const REQUEST_TIMEOUT_MS = 15_000;

export const MESSAGES: Record<AuthFailure, string> = {
  badCredentials: 'El correo o la contraseña no coinciden con ninguna cuenta. Revísalos e inténtalo de nuevo.',
  missingFields: 'Escribe tu correo y tu contraseña.',
  emailTaken: 'Ya hay una cuenta con este correo. Toca «Entrar» para usarla.',
  weakPassword: 'Esa contraseña es fácil de adivinar. Usa una más larga que mezcle letras y números.',
  emailNotConfirmed: 'Aún no confirmaste tu correo. Revisa tu bandeja de entrada.',
  rateLimited: 'Hiciste muchos intentos seguidos. Espera unos minutos e inténtalo de nuevo.',
  network: 'No pudimos conectar con el servidor. Revisa tu internet e inténtalo de nuevo.',
  invalidEmail: 'Revisa el correo: debe verse como nombre@correo.com.',
  passwordTooShort: `Usa al menos ${MIN_PASSWORD} caracteres.`,
  notConfigured: 'Las cuentas aún no están disponibles. Puedes usar MapZ sin cuenta.',
  linkExpired: 'Ese enlace ya venció o ya se usó. Entra con tu contraseña o toca «¿Olvidaste tu contraseña?» para recibir otro.',
  samePassword: 'Esa ya es tu contraseña. Escribe una distinta.',
  generic: 'No pudimos terminar. Espera unos segundos e inténtalo de nuevo.',
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
  if (code === 'same_password' || text.includes('different from the old')) return 'samePassword';
  if (code === 'weak_password' || text.includes('password should be') || text.includes('weak password')) return 'weakPassword';
  if (code === 'otp_expired' || code === 'flow_state_expired' || text.includes('expired')) return 'linkExpired';
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

export type Redirect =
  | { kind: 'session'; type: string; accessToken: string; refreshToken: string; expiresIn: number }
  | { kind: 'error'; code: string };

/**
 * The URL fragment a confirmation or password-recovery email link opens the app with
 * (`#access_token=…&refresh_token=…&type=recovery`, or `#error=…&error_code=otp_expired`). Null when it is neither.
 */
export function parseRedirect(hash: string): Redirect | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const err = p.get('error_code') || p.get('error');
  if (err) return { kind: 'error', code: err };
  const accessToken = p.get('access_token');
  const refreshToken = p.get('refresh_token');
  const expiresIn = Number(p.get('expires_in'));
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return { kind: 'session', type: p.get('type') ?? '', accessToken, refreshToken, expiresIn };
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
  /** Emails a link to choose a new password. Succeeds for any well-formed address, so it never tells who has an account. */
  requestPasswordReset(email: string): Promise<Outcome>;
  /** Emails the sign-up confirmation link again. */
  resendConfirmation(email: string): Promise<Outcome>;
  /** Signs in with the tokens a confirmation or recovery link left in the URL. `type` is `recovery` for a password reset. */
  adoptRedirect(redirect: Redirect): Promise<Outcome & { type?: string }>;
  /** New password for the signed-in user, e.g. after a recovery link. */
  updatePassword(password: string): Promise<Outcome>;
}

export function createAuthClient(deps: {
  config: AuthConfig | null;
  fetch: typeof fetch;
  storage: StorageLike;
  now?: () => number;
  /** Where email links (confirm, reset) send the user back to. Without it the server's Site URL is used. */
  redirectTo?: string;
}): AuthClient {
  const { config, storage } = deps;
  const back = deps.redirectTo ? `?redirect_to=${encodeURIComponent(deps.redirectTo)}` : '';
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
        ...(typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) } : {}),
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

  const validEmail = (email: string) => /^\S+@\S+\.\S+$/.test(email);
  const checkCredentials = (email: string, password: string): Outcome | null =>
    !validEmail(email) ? fail('invalidEmail') : password.length < MIN_PASSWORD ? fail('passwordTooShort') : null;

  /** Emails that only need an address: reset and resend. */
  async function mail(path: string, email: string, body: Record<string, unknown>): Promise<Outcome> {
    if (!config) return fail('notConfigured');
    const e = email.trim();
    if (!validEmail(e)) return fail('invalidEmail');
    const r = await call(path, { method: 'POST', body: { email: e, ...body } });
    return ok(r) ? { ok: true } : failure(r);
  }

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
      return enter(`/auth/v1/signup${back}`, { email: e, password, ...(name ? { data: { display_name: name } } : {}) }, e);
    },
    async signIn({ email, password }) {
      if (!config) return fail('notConfigured');
      const e = email.trim();
      if (!e || !password) return fail('missingFields');
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
    requestPasswordReset: (email) => mail(`/auth/v1/recover${back}`, email, {}),
    resendConfirmation: (email) => mail(`/auth/v1/resend${back}`, email, { type: 'signup' }),
    async adoptRedirect(redirect) {
      if (!config) return fail('notConfigured');
      if (redirect.kind === 'error') return fail(classifyError(403, { error_code: redirect.code }) === 'linkExpired' ? 'linkExpired' : 'generic');
      if (state.kind === 'working') return fail('generic');
      set({ kind: 'working' });
      // The fragment carries the tokens but not who they belong to.
      const r = await call('/auth/v1/user', { method: 'GET', token: redirect.accessToken });
      const session = ok(r)
        ? parseTokenResponse({ access_token: redirect.accessToken, refresh_token: redirect.refreshToken, expires_in: redirect.expiresIn, user: r.body }, now())
        : null;
      if (!session) {
        set({ kind: 'signedOut' });
        return r === null ? fail('network') : fail('linkExpired');
      }
      adopt(await withProfileName(session));
      return { ok: true, type: redirect.type };
    },
    async updatePassword(password) {
      if (!config) return fail('notConfigured');
      if (password.length < MIN_PASSWORD) return fail('passwordTooShort');
      if (state.kind === 'signedIn' && needsRefresh(state.session, now())) await refresh();
      if (state.kind !== 'signedIn') return fail('generic');
      const r = await call('/auth/v1/user', { method: 'PUT', body: { password }, token: state.session.accessToken });
      return ok(r) ? { ok: true } : failure(r);
    },
  };
}
