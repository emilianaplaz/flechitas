// Entry on the phone, before the map: the welcome screen (its logo doubles as the loading screen), sign in,
// sign up and password reset over Emiliana's account client (src/auth), then a few questions with a short
// explanation before each permission. The answers stay on this device (src/ui/onboarding.ts) and preset the app.
// Later opens go straight to the map; signing out comes back to the welcome screen.
import { auth, authConfigured } from '../auth/ui.ts';
import { MIN_PASSWORD, parseRedirect, SESSION_KEY, type AuthFailure, type AuthState, type Outcome, type Redirect } from '../auth/session.ts';
import { app } from '../core/state.ts';
import { $, toast } from '../core/ui.ts';
import { ART } from './entryArt.ts';
import { loadEntered, loadOnboarding, PERMS, saveEntered, saveOnboarding, startScreen, stepsFor, type Answers, type Perm, type Step } from './onboarding.ts';
import { needsAsking, requestPerm, type PermResult } from './permissions.ts';

export type Landing = 'destino' | 'dispositivos';
export interface EntryHooks {
  /** The user is in: show this app screen once the app has loaded (rejects if it can't load). */
  onEnter: (to: Landing) => void | Promise<void>;
  /** This device becomes the windshield HUD (the iPad). */
  useAsHud: () => void;
}

type ScreenId = 'enWelcome' | 'enLogin' | 'enSignup' | 'enMail' | 'enReset' | 'enNewPass' | 'enQuiz';
type Nav = 'push' | 'replace' | 'root' | 'back';
const TITLES: Record<ScreenId, string> = {
  enWelcome: 'MapZ',
  enLogin: 'Entrar · MapZ',
  enSignup: 'Crear cuenta · MapZ',
  enMail: 'Revisa tu correo · MapZ',
  enReset: 'Recuperar la contraseña · MapZ',
  enNewPass: 'Contraseña nueva · MapZ',
  enQuiz: 'Preguntas · MapZ',
};
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const RESEND_WAIT_S = 60; // Supabase sends at most one email a minute per address
const TAP_GUARD_MS = 350; // a new step ignores taps this long, so a double tap can't answer what wasn't seen

let hooks: EntryHooks;
let current: ScreenId = 'enWelcome';
const trail: ScreenId[] = []; // back stack of entry screens
const returnFocus = new Map<ScreenId, HTMLElement>(); // what to focus when coming back to a screen
let open = true; // the overlay is in the HTML from the first paint, as the splash
const store = () => localStorage;
const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const visible = (e: Element | null | undefined): e is HTMLElement => !!e && (e as HTMLElement).isConnected && (e as HTMLElement).offsetParent !== null;

// ---------- overlay and screens ----------

/** While the entry is up, the app underneath can't be reached by Tab or a screen reader. */
function setAppInert(on: boolean) {
  for (const id of ['setup', 'find', 'hud']) {
    const node = document.getElementById(id);
    if (node) node.inert = on;
  }
}

function openOverlay() {
  setAppInert(true);
  if (open) return;
  open = true;
  const root = $('entry');
  root.hidden = false;
  root.classList.remove('out');
}

function closeOverlay() {
  open = false;
  (document.activeElement as HTMLElement | null)?.blur(); // nothing in the fading overlay keeps taking keys
  setAppInert(false);
  releaseTrap();
  const root = $('entry');
  root.classList.add('out');
  setTimeout(() => {
    if (!open) root.hidden = true;
  }, 260);
  document.title = 'MapZ';
}

function focusHeading(id: ScreenId) {
  const h = [...$(id).querySelectorAll<HTMLElement>('h1')].find((x) => !x.closest('[hidden]'));
  h?.focus({ preventScroll: true });
}

/** `push`: back returns here. `replace`: swaps the current screen (login ↔ sign up). `root`: back goes to the welcome. */
function goTo(id: ScreenId, how: Nav = 'push') {
  openOverlay();
  if (how === 'root') trail.splice(0, trail.length, ...(id === 'enWelcome' ? [] : (['enWelcome'] as ScreenId[])));
  else if (how === 'push' && current !== id) {
    trail.push(current);
    if (document.activeElement instanceof HTMLElement && $(current).contains(document.activeElement)) returnFocus.set(current, document.activeElement);
  }
  if (current === 'enWelcome' && id !== 'enWelcome') $('enWelcome').dataset.drawn = ''; // the logo draws once
  $('entry').dataset.dir = how === 'back' ? 'back' : 'fwd';
  for (const s of Object.keys(TITLES) as ScreenId[]) $(s).hidden = s !== id;
  current = id;
  $(id).scrollTop = 0;
  document.title = TITLES[id];
  const back = how === 'back' ? returnFocus.get(id) : undefined;
  if (visible(back)) back.focus({ preventScroll: true });
  else focusHeading(id);
  syncTrap();
}

/** Back one screen (or one question). Never while a request is running: its answer would land somewhere else. */
function back() {
  if (!open || $(current).querySelector('[aria-busy="true"]')) return;
  if (current === 'enQuiz') return quizBack();
  const prev = trail.pop();
  if (prev) goTo(prev, 'back');
}

function canGoBack(): boolean {
  if (!open || current === 'enNewPass') return false;
  if (current === 'enQuiz') return at > 0 || auth.state().kind !== 'signedIn';
  return trail.length > 0;
}

// The phone's back gesture does what the Volver button does: one history entry stands for "inside the entry".
let trapped = false;
let swallowPop = false;
function syncTrap() {
  if (canGoBack() && !trapped) {
    history.pushState({ enTrap: true }, '');
    trapped = true;
  } else if (!canGoBack()) releaseTrap();
}
function releaseTrap() {
  if (!trapped) return;
  trapped = false;
  swallowPop = true;
  history.back();
}
function onPop() {
  if (swallowPop) {
    swallowPop = false;
    return;
  }
  if (!trapped) return;
  trapped = false;
  if (open) back();
  syncTrap();
}

function showWelcome(status = '') {
  const w = $('enWelcome');
  if (w.dataset.revealed !== undefined) w.dataset.seen = ''; // the buttons rise in only the first time
  w.dataset.revealed = '';
  w.removeAttribute('data-loading');
  $('enLoading').hidden = true;
  $('enStatus').textContent = status;
  goTo('enWelcome', 'root');
}

/** A problem with no form to show it in: a message at the top of the screen with a way out. */
function showFatal(text: string) {
  const host = $(current).querySelector<HTMLElement>('.enBody:not([hidden])') ?? $(current);
  host.querySelector('.enFatal')?.remove();
  const box = el('div', { cls: 'enMsg enFatal', aria: { role: 'alert' } });
  setMsg(box, text, 'error', { label: 'Reintentar', run: () => location.reload() });
  host.prepend(box);
}

let entering = false;
/** Into the app. The entry stays up (as the loading screen) until the app behind it has loaded. */
async function enterApp(to: Landing = 'destino', btn?: HTMLButtonElement | null): Promise<boolean> {
  if (entering) return false;
  entering = true;
  const slow = btn ? window.setTimeout(() => setBusy(btn, 'Abriendo el mapa…'), 250) : 0;
  try {
    await hooks.onEnter(to);
  } catch {
    showFatal('No pudimos cargar el mapa. Revisa tu conexión.');
    return false;
  } finally {
    clearTimeout(slow);
    if (btn && isBusy(btn)) setBusy(btn, null);
    entering = false;
  }
  closeOverlay();
  // Land the focus on the new screen, not on <body>.
  const code = document.getElementById('linkCode');
  const target = to === 'dispositivos' ? (visible(code) ? code : document.querySelector<HTMLElement>('#scrDispositivos h1')) : document.getElementById('dcTitle');
  target?.focus({ preventScroll: true });
  return true;
}

/** Signed in from any screen: the questions the first time on this device, the map after that. */
function afterSignIn(btn?: HTMLButtonElement | null) {
  saveEntered(store(), 'account');
  pendingPass = '';
  if (!loadOnboarding(store())) return void startQuiz();
  void enterApp('destino', btn);
}

function guest() {
  saveEntered(store(), 'guest');
  if (loadOnboarding(store())) void enterApp('destino');
  else void startQuiz();
}

// ---------- form helpers ----------

function fieldError(field: HTMLInputElement, text: string) {
  const err = document.getElementById(`${field.id}Err`);
  if (err) err.textContent = text;
  if (text) field.setAttribute('aria-invalid', 'true');
  else field.removeAttribute('aria-invalid');
}

function clearForm(form: HTMLElement) {
  form.querySelectorAll<HTMLInputElement>('input').forEach((f) => fieldError(f, ''));
  form.querySelectorAll<HTMLElement>('.enMsg').forEach((m) => setMsg(m, ''));
}

/** A message in the screen. `action`: one button under the text, e.g. "Entra con este correo". */
function setMsg(box: HTMLElement, text: string, kind: 'error' | 'info' = 'error', action?: { label: string; run: () => void }) {
  box.classList.toggle('info', kind === 'info');
  box.replaceChildren();
  if (!text) return;
  box.append(text);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'enAct';
    b.textContent = action.label;
    b.onclick = action.run;
    box.append(b);
  }
  // With the keyboard up, the message could be under it.
  requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }));
}

/** Working: the button says what is happening and ignores taps; the fields keep their focus but can't change. */
function setBusy(btn: HTMLButtonElement, label: string | null) {
  const form = btn.closest('form') ?? btn.closest('.enBody');
  if (label) {
    btn.dataset.label ??= btn.textContent ?? '';
    btn.textContent = label;
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-disabled', 'true');
  } else {
    btn.textContent = btn.dataset.label ?? btn.textContent;
    delete btn.dataset.label;
    btn.removeAttribute('aria-busy');
    btn.removeAttribute('aria-disabled');
  }
  form?.querySelectorAll<HTMLInputElement>('input').forEach((f) => (f.readOnly = !!label || f.id === 'enNewPassUser'));
}
const isBusy = (btn: HTMLButtonElement) => btn.getAttribute('aria-busy') === 'true';

function emailProblem(value: string): string {
  if (!value) return 'Escribe tu correo.';
  return EMAIL_RE.test(value) ? '' : 'Revisa el correo: debe verse como nombre@correo.com.';
}
/** A new password: how far it is from the minimum. */
function newPassProblem(value: string, empty: string): string {
  const missing = MIN_PASSWORD - value.length;
  if (!value) return empty;
  if (missing <= 0) return '';
  return missing === 1 ? 'Te falta 1 carácter.' : `Te faltan ${missing} caracteres.`;
}
/** The current problem of a field, so a marked field updates (or clears) while it is being fixed. */
function problemOf(f: HTMLInputElement): string {
  switch (f.id) {
    case 'enLoginEmail':
    case 'enSignupEmail':
    case 'enResetEmail':
      return emailProblem(f.value.trim());
    case 'enSignupName':
      return f.value.trim() ? '' : 'Escribe tu nombre.';
    case 'enLoginPass':
      return f.value ? '' : 'Escribe tu contraseña.';
    case 'enSignupPass':
      return newPassProblem(f.value, 'Elige una contraseña.');
    case 'enNewPassInput':
      return newPassProblem(f.value, 'Escribe tu contraseña nueva.');
    default:
      return '';
  }
}

/** Checks the fields in order, shows each problem under its field and focuses the first one. */
function validate(fields: HTMLInputElement[]): boolean {
  let first: HTMLInputElement | null = null;
  for (const f of fields) {
    const problem = problemOf(f);
    fieldError(f, problem);
    if (problem && !first) first = f;
  }
  first?.focus();
  return !first;
}

/** Back to hidden before submitting, so the browser offers to save the password. */
function hidePasswords(form: HTMLElement) {
  form.querySelectorAll<HTMLButtonElement>('.enEye').forEach((b) => {
    b.setAttribute('aria-pressed', 'false');
    input(b.getAttribute('aria-controls')!).type = 'password';
  });
}

const FIELD_OF: Partial<Record<AuthFailure, 'email' | 'password'>> = {
  invalidEmail: 'email',
  emailTaken: 'email',
  passwordTooShort: 'password',
  weakPassword: 'password',
  samePassword: 'password',
};
/** Without signal there is still a way in: the app works without an account. */
const offlineWayOut = (r: Extract<Outcome, { ok: false }>) => (r.code === 'network' ? { label: 'Seguir sin cuenta por ahora', run: guest } : undefined);

/** Opening a form by tapping: the keyboard comes up on the first empty field. */
function focusFirstEmpty(form: HTMLElement) {
  const f = [...form.querySelectorAll<HTMLInputElement>('input:not([tabindex="-1"])')].find((x) => !x.value);
  f?.focus({ preventScroll: true });
}

// ---------- sign in ----------

function showLogin(opts: { email?: string; message?: string; how?: Nav; focusField?: boolean } = {}) {
  const form = $('enLoginForm');
  clearForm(form);
  if (opts.email !== undefined) input('enLoginEmail').value = opts.email;
  input('enLoginPass').value = '';
  if (current === 'enMail') auth.dismissConfirmation();
  goTo('enLogin', opts.how ?? 'push');
  if (opts.focusField) focusFirstEmpty(form);
  if (opts.message) setMsg($('enLoginMsg'), opts.message, 'info');
}

async function submitLogin(e: Event) {
  e.preventDefault();
  const btn = button('enLoginGo');
  if (isBusy(btn)) return;
  const form = $('enLoginForm');
  clearForm(form);
  const email = input('enLoginEmail');
  const pass = input('enLoginPass');
  email.value = email.value.trim();
  if (!validate([email, pass])) return;
  hidePasswords(form);
  setBusy(btn, 'Entrando…');
  const r = await auth.signIn({ email: email.value, password: pass.value });
  setBusy(btn, null);
  if (r.ok) {
    pass.value = '';
    return afterSignIn(btn);
  }
  if (r.code === 'emailNotConfirmed') {
    pendingPass = pass.value;
    return showMail(email.value, 'push', false);
  }
  if (r.code === 'badCredentials') {
    pass.value = '';
    pass.focus();
  }
  setMsg($('enLoginMsg'), r.message, 'error', offlineWayOut(r));
}

// ---------- sign up ----------

function showSignup(how: Nav = 'push') {
  clearForm($('enSignupForm'));
  if (current === 'enLogin' && input('enLoginEmail').value) input('enSignupEmail').value = input('enLoginEmail').value;
  if (current === 'enMail') auth.dismissConfirmation();
  goTo('enSignup', how);
  focusFirstEmpty($('enSignupForm'));
}

async function submitSignup(e: Event) {
  e.preventDefault();
  const btn = button('enSignupGo');
  if (isBusy(btn)) return;
  const form = $('enSignupForm');
  clearForm(form);
  const name = input('enSignupName');
  const email = input('enSignupEmail');
  const pass = input('enSignupPass');
  name.value = name.value.trim();
  email.value = email.value.trim();
  if (!validate([name, email, pass])) return;
  hidePasswords(form);
  setBusy(btn, 'Creando tu cuenta…');
  const r = await auth.signUp({ email: email.value, password: pass.value, displayName: name.value });
  setBusy(btn, null);
  if (!r.ok) return signupFailed(r);
  const typed = pass.value;
  pass.value = '';
  updateHint(pass, 'enSignupPassHint');
  if (auth.state().kind === 'needsConfirmation') {
    pendingPass = typed; // memory only, so "Ya lo abrí" can sign in without retyping it
    return showMail(email.value, 'push', true);
  }
  afterSignIn(btn);
}

function signupFailed(r: Extract<Outcome, { ok: false }>) {
  const email = input('enSignupEmail');
  if (r.code === 'emailTaken') {
    fieldError(email, 'Ya hay una cuenta con este correo.');
    email.focus();
    return setMsg($('enSignupMsg'), '¿Es tuya?', 'info', { label: 'Entra con este correo', run: () => showLogin({ email: email.value, how: 'replace', focusField: true }) });
  }
  const field = FIELD_OF[r.code];
  if (field) {
    const f = field === 'email' ? email : input('enSignupPass');
    fieldError(f, r.message);
    return f.focus();
  }
  setMsg($('enSignupMsg'), r.message, 'error', offlineWayOut(r));
}

function updateHint(pass: HTMLInputElement, hintId: string) {
  $(hintId).classList.toggle('ok', pass.value.length >= MIN_PASSWORD);
}

// ---------- check your email (confirm the account) ----------

let mailTo = '';
let pendingPass = ''; // the password just typed, kept in memory (never stored) while the email is confirmed
let resendTimer = 0;
let resendLeft = 0;

/** `sent`: an email just left, so resending waits the server's minute. */
function showMail(email: string, how: Nav, sent: boolean) {
  mailTo = email;
  $('enMailTo').textContent = email;
  setMsg($('enMailMsg'), '');
  goTo('enMail', how);
  if (sent) startResendWait();
  else stopResendWait();
}

function renderResend() {
  const btn = button('enMailResend');
  const wait = resendLeft > 0;
  btn.toggleAttribute('aria-disabled', wait);
  // The name stays "Reenviar el enlace"; the seconds are only shown, not read every second.
  $('enMailWait').textContent = wait ? ` (${resendLeft} s)` : '';
}
function startResendWait() {
  resendLeft = RESEND_WAIT_S;
  clearInterval(resendTimer);
  renderResend();
  resendTimer = window.setInterval(() => {
    resendLeft--;
    if (resendLeft <= 0) clearInterval(resendTimer);
    renderResend();
  }, 1000);
}
function stopResendWait() {
  resendLeft = 0;
  clearInterval(resendTimer);
  renderResend();
}

async function resend() {
  const btn = button('enMailResend');
  if (btn.getAttribute('aria-disabled') === 'true') return;
  const label = btn.querySelector('.enBtnLabel')!;
  label.textContent = 'Enviando…';
  btn.setAttribute('aria-busy', 'true');
  btn.setAttribute('aria-disabled', 'true');
  const r = await auth.resendConfirmation(mailTo);
  label.textContent = 'Reenviar el enlace';
  btn.removeAttribute('aria-busy');
  btn.removeAttribute('aria-disabled');
  if (!r.ok) return setMsg($('enMailMsg'), r.message, 'error', offlineWayOut(r));
  setMsg($('enMailMsg'), 'Te enviamos otro enlace. Si no lo ves, revisa el spam.', 'info');
  startResendWait();
}

/** "Ya lo abrí, entrar": with the password still in memory, try to sign in right away. */
async function mailDone() {
  const btn = button('enMailLogin');
  if (isBusy(btn)) return;
  if (!pendingPass) return showLogin({ email: mailTo, how: 'root', focusField: true, message: 'Escribe tu contraseña para terminar de entrar.' });
  setBusy(btn, 'Entrando…');
  const r = await auth.signIn({ email: mailTo, password: pendingPass });
  setBusy(btn, null);
  if (r.ok) return afterSignIn(btn);
  if (r.code === 'emailNotConfirmed') return setMsg($('enMailMsg'), 'Tu correo aún no aparece confirmado. Abre el enlace y vuelve a tocar «Ya lo abrí, entrar».', 'info');
  if (r.code === 'network') return setMsg($('enMailMsg'), r.message, 'error', offlineWayOut(r));
  pendingPass = '';
  showLogin({ email: mailTo, how: 'root', focusField: true, message: r.message });
}

/** The link was opened in another tab of this browser: that tab saved the session, so pick it up here. */
async function pickUpSession() {
  if (!open || (current !== 'enMail' && current !== 'enWelcome' && current !== 'enLogin')) return;
  if (auth.state().kind === 'signedIn') return;
  if (auth.state().kind === 'needsConfirmation') auth.dismissConfirmation();
  await auth.restore();
  if (auth.state().kind === 'signedIn') afterSignIn();
}

// ---------- forgot password ----------

function openReset() {
  const form = $('enResetForm');
  clearForm(form);
  form.hidden = false;
  $('enResetSent').hidden = true;
  input('enResetEmail').value = input('enLoginEmail').value.trim();
  goTo('enReset');
}

async function submitReset(e: Event) {
  e.preventDefault();
  const btn = button('enResetGo');
  if (isBusy(btn)) return;
  const email = input('enResetEmail');
  clearForm($('enResetForm'));
  email.value = email.value.trim();
  if (!validate([email])) return;
  setBusy(btn, 'Enviando…');
  const r = await auth.requestPasswordReset(email.value);
  setBusy(btn, null);
  if (!r.ok) {
    if (r.code === 'invalidEmail') {
      fieldError(email, r.message);
      return email.focus();
    }
    return setMsg($('enResetMsg'), r.message);
  }
  $('enResetTo').textContent = email.value;
  $('enResetForm').hidden = true;
  $('enResetSent').hidden = false;
  focusHeading('enReset');
}

// ---------- new password (from the recovery link) ----------

function showNewPass() {
  const s = auth.state();
  const email = s.kind === 'signedIn' ? s.session.user.email : '';
  $('enNewPassMail').textContent = email;
  input('enNewPassUser').value = email;
  clearForm($('enNewPassForm'));
  goTo('enNewPass', 'root');
}

async function submitNewPass(e: Event) {
  e.preventDefault();
  const btn = button('enNewPassGo');
  if (isBusy(btn)) return;
  const form = $('enNewPassForm');
  clearForm(form);
  const pass = input('enNewPassInput');
  if (!validate([pass])) return;
  hidePasswords(form);
  setBusy(btn, 'Guardando…');
  const r = await auth.updatePassword(pass.value);
  setBusy(btn, null);
  if (!r.ok) {
    if (FIELD_OF[r.code] === 'password') {
      fieldError(pass, r.message);
      return pass.focus();
    }
    return setMsg($('enNewPassMsg'), r.message);
  }
  pass.value = '';
  updateHint(pass, 'enNewPassHint');
  if (loadOnboarding(store())) toast('Listo, guardamos tu contraseña nueva');
  afterSignIn(btn);
}

// ---------- links from email ----------

async function openFromLink(r: Redirect) {
  if (!authConfigured) return showWelcome();
  $('enStatus').textContent = 'Abriendo tu cuenta…';
  const out = await auth.adoptRedirect(r);
  $('enStatus').textContent = '';
  if (!out.ok) {
    showWelcome();
    return showLogin({ message: out.message });
  }
  if (out.type === 'recovery') return showNewPass();
  afterSignIn();
}

// ---------- the questions ----------

let answers: Answers = {};
let ask = new Set<Perm>();
let at = 0;
let shownAt = 0; // when the current step was drawn (double-tap guard)
let picking = false; // an answer was tapped and the next step is on its way
const results: Partial<Record<Perm, PermResult>> = {};
const tooSoon = () => picking || performance.now() - shownAt < TAP_GUARD_MS;

// One family: 24-unit grid, 2-unit outline strokes, no fills.
const icon = (body: string) => `<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  // A car seen from the front: windshield, body, mirrors and wheels.
  drive: icon('<path d="M6.5 11 L8 6.5 H16 L17.5 11" /><rect x="4" y="11" width="16" height="6" rx="1.5" /><path d="M6.5 17 V19.5 M17.5 17 V19.5 M2.5 10.5 H4 M20 10.5 H21.5" /><path d="M7.5 14 H8.5 M15.5 14 H16.5" />'),
  walk: icon('<circle cx="13" cy="4.5" r="1.8" /><path d="M13 8 L11 13.5 L8 20 M11 13.5 L14.5 16 L15.5 20.5 M12.6 8.5 L8.5 10.5 V13 M13 9 L16 12 H18" />'),
  ipad: icon('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M11 16.5 H13" />'),
  phone: icon('<rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5 H13" />'),
  ruler: icon('<rect x="2.5" y="8" width="19" height="8" rx="1.5" /><path d="M6.5 8 V11 M10 8 V12.5 M13.5 8 V11 M17 8 V12.5" />'),
  chev: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5 L16 12 L9 19" /></svg>',
  check: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5" /><path d="M7.8 12.3 L10.6 15 L16.4 9.2" /></svg>',
};

interface Choice {
  label: string;
  hint: string;
  icon: string;
  pressed: boolean;
  pick: () => void;
}
const QUESTIONS: Record<'use' | 'ipad' | 'car', { title: string; lead: string; choices: () => Choice[] }> = {
  use: {
    title: '¿Cómo vas a usar MapZ?',
    lead: 'Lo puedes cambiar en el mapa cuando quieras.',
    choices: () => [
      { label: 'Manejar', hint: 'El teléfono va fijo en el tablero, mirando la calle.', icon: ICONS.drive, pressed: answers.use === 'drive', pick: () => (answers.use = 'drive') },
      { label: 'Caminar', hint: 'Llevas el teléfono en la mano.', icon: ICONS.walk, pressed: answers.use === 'walk', pick: () => (answers.use = 'walk') },
    ],
  },
  ipad: {
    title: '¿Vas a usar un iPad en el parabrisas?',
    lead: 'El iPad va sobre el tablero y la guía se refleja en el vidrio, frente a tus ojos.',
    choices: () => [
      { label: 'Sí, voy a usar un iPad', hint: 'Lo conectas con un código de 6 dígitos.', icon: ICONS.ipad, pressed: answers.ipad === true, pick: () => (answers.ipad = true) },
      { label: 'No, solo el teléfono', hint: 'Ves la guía en la cámara del teléfono.', icon: ICONS.phone, pressed: answers.ipad === false, pick: () => (answers.ipad = false) },
    ],
  },
  car: {
    title: '¿Qué carro manejas?',
    lead: 'Con las medidas de tu carro, la guía se alinea con la calle.',
    choices: () => [
      { label: 'Toyota Fortuner 2015', hint: 'Ya traemos sus medidas aproximadas.', icon: ICONS.drive, pressed: answers.car === 'fortuner', pick: () => (answers.car = 'fortuner') },
      { label: 'Otro carro', hint: 'Lo mides con una cinta métrica y anotas las medidas en el iPad.', icon: ICONS.ruler, pressed: answers.car === 'other', pick: () => (answers.car = 'other') },
    ],
  },
};

const walking = () => answers.use === 'walk';
const PERM_COPY: Record<Perm, { title: string; lead: () => string; why: () => string[]; allow: string; skip: string; denied: () => string; unavailable: string }> = {
  location: {
    title: 'Tu ubicación',
    lead: () => 'La usamos para trazar la ruta desde donde estás y avisarte de los huecos que vienen.',
    why: () => [
      'Solo mientras tienes MapZ en pantalla.',
      'Otra persona solo la ve si tú se la compartes en Encontrar.',
      'Cuando detectamos un hueco, subimos solo ese punto al mapa de todos, sin tu nombre ni tu cuenta.',
    ],
    allow: 'Permitir ubicación',
    skip: 'Seguir sin ubicación',
    denied: () => 'Sin tu ubicación no podemos guiarte en vivo. Actívala cuando quieras en los ajustes del navegador.',
    unavailable: 'Este teléfono no da su ubicación. Puedes seguir y elegir el destino en el mapa.',
  },
  camera: {
    title: 'La cámara',
    lead: () => 'La usamos para dibujar las flechas sobre la calle que tienes enfrente.',
    why: () => ['Solo se enciende cuando empiezas una ruta o abres Encontrar.', 'Las imágenes no salen de tu teléfono.'],
    allow: 'Permitir cámara',
    skip: 'Seguir sin cámara',
    denied: () => 'Sin la cámara no verás las flechas sobre la calle. Actívala cuando quieras en los ajustes del navegador.',
    unavailable: 'No pudimos abrir la cámara. Si otra app la está usando, ciérrala. Puedes seguir y usar el mapa.',
  },
  motion: {
    title: 'Los sensores de movimiento',
    lead: () =>
      walking() ? 'Los usamos para mover la vista cuando giras el teléfono.' : 'Los usamos para detectar los huecos por los que pasas y mantener la guía alineada con la calle.',
    why: () => ['Solo mientras tienes MapZ en pantalla.'],
    allow: 'Permitir sensores',
    skip: 'Seguir sin sensores',
    denied: () =>
      walking()
        ? 'Sin los sensores, la vista no seguirá el giro del teléfono. Puedes seguir y usar el mapa.'
        : 'Sin los sensores no podemos detectar huecos por nuestra cuenta. Igual te avisamos de los que ya están en el mapa.',
    unavailable: 'Este teléfono no tiene sensores de movimiento. Puedes seguir.',
  },
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { cls?: string; html?: string; aria?: Record<string, string> } = {},
  ...kids: (Node | string)[]
) {
  const { cls, html, aria, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (cls) node.className = cls;
  for (const [k, v] of Object.entries(aria ?? {})) node.setAttribute(k, v);
  if (html) node.innerHTML = html; // only the static drawings and icons in this repo, never user text
  node.append(...kids);
  return node;
}

function head(stepNo: number, total: number, title: string, lead: string) {
  const h = el('h1', { tabIndex: -1, id: 'enStepTitle' }, el('span', { cls: 'vh', textContent: `Paso ${stepNo} de ${total}: ` }), title);
  return el('div', { cls: 'enHead' }, h, el('p', { cls: 'enLead', textContent: lead }));
}

const art = (step: Step) => el('div', { cls: 'enArt', html: ART[step] });

function whyList(lines: string[]) {
  return el('ul', { cls: 'enWhy', aria: { role: 'list' } }, ...lines.map((t) => el('li', {}, el('span', { html: ICONS.check }), t)));
}

async function startQuiz() {
  openOverlay();
  answers = { ...(loadOnboarding(store())?.answers ?? {}) };
  at = 0;
  const need = await Promise.all(PERMS.map(async (p) => ((await needsAsking(p)) ? p : null)));
  ask = new Set(need.filter((p): p is Perm => p !== null));
  goTo('enQuiz', 'root');
  renderStep();
  // Shown once: from here on this device opens the map, even if the questions were left half answered.
  saveOnboarding(store(), answers, Date.now());
}

/** The progress drawn as a route: one ring per step, filled up to here. Nodes are reused so the fill animates. */
function renderRoute(total: number) {
  const route = $('enBars');
  if (route.childElementCount !== total * 2 - 1) {
    const parts: HTMLElement[] = [];
    for (let i = 0; i < total; i++) {
      if (i) parts.push(el('span', { cls: 's' }));
      parts.push(el('span', { cls: 'n' }));
    }
    route.replaceChildren(...parts);
  }
  [...route.children].forEach((part, k) => {
    const i = Math.floor(k / 2);
    if (part.classList.contains('n')) {
      part.classList.toggle('done', i < at);
      part.classList.toggle('cur', i === at);
    } else part.classList.toggle('done', i < at);
  });
}

function renderStep(dir: 'fwd' | 'back' = 'fwd') {
  const steps = stepsFor(answers, ask);
  at = Math.max(0, Math.min(at, steps.length - 1));
  const step = steps[at];
  const total = steps.length;
  renderRoute(total);
  $('enCount').textContent = `${at + 1} de ${total}`;
  // Signed in, the first question has nothing behind it; as a guest it goes back to the welcome.
  $('enQBack').hidden = at === 0 && auth.state().kind === 'signedIn';
  $('entry').dataset.dir = dir;
  const body = $('enStep');
  body.dataset.step = step;
  body.replaceChildren(...buildStep(step, at + 1, total));
  $('enQuiz').scrollTop = 0;
  focusHeading('enQuiz');
  shownAt = performance.now();
  picking = false;
  syncTrap();
}

function buildStep(step: Step, n: number, total: number): Node[] {
  if (step === 'use' || step === 'ipad' || step === 'car') {
    const q = QUESTIONS[step];
    const opts = el('div', { cls: 'enOpts', aria: { role: 'group', 'aria-labelledby': 'enStepTitle' } });
    q.choices().forEach((c, i) => {
      const id = `enOpt-${step}-${i}`;
      const b = el(
        'button',
        { type: 'button', cls: 'enOpt', aria: { 'aria-pressed': String(c.pressed), 'aria-labelledby': `${id}-l`, 'aria-describedby': `${id}-d` } },
        el('span', { cls: 'ico', html: c.icon }),
        el('span', { cls: 'txt' }, el('b', { id: `${id}-l`, textContent: c.label }), el('small', { id: `${id}-d`, textContent: c.hint })),
        el('span', { cls: 'chev', html: ICONS.chev }),
      );
      b.onclick = () => {
        if (tooSoon()) return;
        picking = true;
        c.pick();
        opts.querySelectorAll('.enOpt').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
        setTimeout(next, 140); // long enough to see what was chosen
      };
      opts.append(b);
    });
    // Arrow keys move between the choices.
    opts.addEventListener('keydown', (e) => {
      const all = [...opts.querySelectorAll<HTMLButtonElement>('.enOpt')];
      const i = all.indexOf(document.activeElement as HTMLButtonElement);
      const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
      if (to === undefined || i < 0) return;
      e.preventDefault();
      all[(to + all.length) % all.length].focus();
    });
    return [art(step), head(n, total, q.title, q.lead), opts];
  }
  if (step === 'link') return linkStep(n, total);
  return permStep(step, n, total);
}

function permStep(p: Perm, n: number, total: number): Node[] {
  const copy = PERM_COPY[p];
  const msg = el('div', { cls: 'enMsg', id: 'enPermMsg', aria: { role: 'status' } });
  const allow = el('button', { type: 'button', cls: 'primary', textContent: copy.allow });
  const later = el('button', { type: 'button', cls: 'enText', textContent: 'Ahora no' });
  const settled = (r: PermResult, moveFocus: boolean) => {
    results[p] = r;
    if (r === 'granted') return next();
    setMsg(msg, r === 'denied' ? copy.denied() : copy.unavailable, 'info');
    allow.textContent = copy.skip;
    allow.setAttribute('aria-describedby', 'enPermMsg');
    allow.onclick = () => !tooSoon() && next();
    later.style.visibility = 'hidden'; // keeps its place, so the main button doesn't move under the thumb
    if (moveFocus) allow.focus();
  };
  allow.onclick = async () => {
    if (isBusy(allow) || tooSoon()) return;
    setBusy(allow, 'Esperando tu respuesta…');
    const r = await requestPerm(p);
    setBusy(allow, null);
    if (stepsFor(answers, ask)[at] === p) settled(r, true); // still on this step (not skipped meanwhile)
  };
  later.onclick = () => !tooSoon() && next();
  // Coming back to a permission already answered: show how it went, without stealing the focus from the title.
  if (results[p] && results[p] !== 'granted') queueMicrotask(() => settled(results[p]!, false));
  return [art(p), head(n, total, copy.title, copy.lead()), whyList(copy.why()), msg, el('div', { cls: 'enFoot' }, allow, later)];
}

function linkStep(n: number, total: number): Node[] {
  const car =
    answers.car === 'other'
      ? 'Antes de manejar, en el iPad toca «Medidas del carro y del iPad» y escribe las de tu carro.'
      : 'El iPad ya trae medidas aproximadas de la Toyota Fortuner 2015. Si la guía no cae sobre la calle, afínalas en «Medidas del carro y del iPad».';
  const go = el('button', { type: 'button', cls: 'primary', textContent: 'Escribir el código' });
  const later = el('button', { type: 'button', cls: 'enText', textContent: 'Más tarde' });
  go.onclick = () => !tooSoon() && void finish('dispositivos', go);
  later.onclick = () => !tooSoon() && void finish('destino', later);
  const steps = el(
    'ol',
    { cls: 'enSteps', aria: { role: 'list' } },
    el('li', { textContent: 'En el iPad, abre MapZ y toca «Usar esta pantalla como HUD del parabrisas».' }),
    el('li', { textContent: 'El iPad te mostrará un código de 6 dígitos.' }),
    el('li', { textContent: 'Escríbelo en este teléfono, en Ajustes → Dispositivos.' }),
  );
  return [
    art('link'),
    head(n, total, 'Conecta el iPad', 'Así la guía sale en el vidrio en cada ruta que empieces en este teléfono.'),
    steps,
    el('p', { cls: 'enNote', textContent: car }),
    el('div', { cls: 'enFoot' }, go, later),
  ];
}

function next() {
  at++;
  if (at >= stepsFor(answers, ask).length) return void finish('destino');
  renderStep('fwd');
}

function quizBack() {
  if (at > 0) {
    at--;
    return renderStep('back');
  }
  if (auth.state().kind === 'signedIn') return;
  saveEntered(store(), null);
  showWelcome();
}

/** Saves the answers, presets the app with them and opens it. */
async function finish(to: Landing, btn?: HTMLButtonElement) {
  const done = saveOnboarding(store(), answers, Date.now());
  if (!(await enterApp(to, btn))) return;
  // Walk or drive is the Caminar / Manejar switch on the map; clicking it also remembers the choice.
  document.getElementById(done.answers.use === 'walk' ? 'goWalk' : 'goDrive')?.click();
}

// ---------- auth changes from elsewhere (Ajustes → Cuenta, another tab, the server) ----------

let lastKind: AuthState['kind'] = 'signedOut';
let leaving = false; // "Cerrar sesión" was tapped, so the session did not just expire

function onAuth(s: AuthState) {
  const was = lastKind;
  lastKind = s.kind;
  if (s.kind === 'signedIn' && loadEntered(store()) !== 'account') saveEntered(store(), 'account');
  if (s.kind !== 'signedOut' || was !== 'signedIn' || loadEntered(store()) !== 'account') return;
  saveEntered(store(), null);
  const byUser = leaving;
  leaving = false;
  if (app.running) return; // never cover a drive: the welcome shows on the next open
  showWelcome();
  if (!byUser) showLogin({ message: 'Tu sesión se cerró. Entra de nuevo para seguir con tus lugares guardados.' });
}

// ---------- wiring ----------

function wire() {
  button('enToSignup').onclick = () => showSignup();
  button('enToLogin').onclick = () => showLogin({ focusField: true });
  button('enGuest').onclick = guest;
  button('enStart').onclick = guest;
  button('enMailGuest').onclick = guest;
  button('enHud').onclick = () => hooks.useAsHud();
  if (!authConfigured) {
    // No account server in this build: one way in.
    for (const id of ['enToSignup', 'enToLogin', 'enGuest']) $(id).hidden = true;
    $('enStart').hidden = false;
  }

  document.querySelectorAll<HTMLElement>('#entry [data-en-back]').forEach((b) => (b.onclick = back));
  button('enQBack').onclick = back;
  document.querySelectorAll<HTMLElement>('#entry [data-en-to]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.enTo !== 'enSignup') return showLogin({ how: 'replace', focusField: true });
      // "Usar otro correo": back to the form it came from, with what was typed.
      if (current === 'enMail' && trail.at(-1) === 'enSignup') {
        auth.dismissConfirmation();
        pendingPass = '';
        return back();
      }
      showSignup('replace');
    };
  });

  $('enLoginForm').addEventListener('submit', (e) => void submitLogin(e));
  $('enSignupForm').addEventListener('submit', (e) => void submitSignup(e));
  $('enResetForm').addEventListener('submit', (e) => void submitReset(e));
  $('enNewPassForm').addEventListener('submit', (e) => void submitNewPass(e));
  button('enNewPassLater').onclick = () => afterSignIn(button('enNewPassLater'));
  button('enForgot').onclick = openReset;
  button('enResetDone').onclick = () => {
    const email = input('enResetEmail').value;
    if (trail.at(-1) === 'enLogin') {
      input('enLoginEmail').value = email;
      return back();
    }
    showLogin({ email, how: 'root', focusField: true });
  };
  button('enMailLogin').onclick = () => void mailDone();
  button('enMailResend').onclick = () => void resend();

  // Show / hide the password, without taking the focus (and the keyboard) away from the field.
  document.querySelectorAll<HTMLButtonElement>('#entry .enEye').forEach((b) => {
    const target = input(b.getAttribute('aria-controls')!);
    b.addEventListener('pointerdown', (e) => {
      if (document.activeElement === target) e.preventDefault();
    });
    b.onclick = () => {
      const show = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(show));
      target.type = show ? 'text' : 'password';
    };
  });
  // Live check of the password length while typing a new one.
  input('enSignupPass').addEventListener('input', () => updateHint(input('enSignupPass'), 'enSignupPassHint'));
  input('enNewPassInput').addEventListener('input', () => updateHint(input('enNewPassInput'), 'enNewPassHint'));

  const root = $('entry');
  // A field marked wrong follows the typing: the message updates and clears once it is fixed.
  root.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.getAttribute('aria-invalid') === 'true') fieldError(t, problemOf(t));
  });
  document.addEventListener('keydown', (e) => {
    if (!open || e.defaultPrevented || e.isComposing) return;
    // "Next" on the keyboard moves to the next field instead of sending a half-filled form.
    const t = e.target as HTMLInputElement;
    if (e.key === 'Enter' && t.tagName === 'INPUT' && t.enterKeyHint === 'next' && root.contains(t)) {
      const fields = [...(t.form?.querySelectorAll<HTMLInputElement>('input:not([tabindex="-1"])') ?? [])];
      const following = fields[fields.indexOf(t) + 1];
      if (following) {
        e.preventDefault();
        following.focus();
      }
    }
    if (e.key === 'Escape' && !e.repeat && canGoBack()) {
      e.preventDefault();
      back();
    }
  });
  addEventListener('popstate', onPop);

  // The on-screen keyboard covers the bottom: leave room to scroll the form above it.
  const vv = window.visualViewport;
  const syncKeyboard = () => {
    const kb = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
    root.style.setProperty('--kb', `${Math.round(kb)}px`);
  };
  vv?.addEventListener('resize', syncKeyboard);
  vv?.addEventListener('scroll', syncKeyboard);

  // The logo draws once; coming back to the welcome shows it drawn.
  root.querySelector('.lgN2')?.addEventListener('animationend', () => ($('enWelcome').dataset.drawn = ''), { once: true });

  // Picking up a confirmation opened in another tab.
  addEventListener('storage', (e) => {
    if (e.key === SESSION_KEY && e.newValue) void pickUpSession();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current === 'enMail') void pickUpSession();
  });
  document.getElementById('acctOutBtn')?.addEventListener('click', () => (leaving = true), true);
}

/** Runs once at launch (src/boot.ts), after the saved session was read. */
export function initEntry(h: EntryHooks) {
  hooks = h;
  wire();
  lastKind = auth.state().kind;
  auth.subscribe(onAuth);
  // An email link opened in a tab that already has the app: only the fragment changes, nothing reloads.
  addEventListener('hashchange', () => {
    const r = parseRedirect(location.hash);
    if (!r || app.running) return;
    history.replaceState(null, '', location.pathname + location.search);
    showWelcome();
    void openFromLink(r);
  });
  const redirect = parseRedirect(location.hash);
  if (redirect) {
    history.replaceState(null, '', location.pathname + location.search);
    setAppInert(true);
    return void openFromLink(redirect);
  }
  const start = startScreen({ entered: loadEntered(store()), signedIn: auth.state().kind === 'signedIn', onboarded: !!loadOnboarding(store()) });
  if (start === 'app') return void enterApp('destino');
  setAppInert(true);
  if (start === 'quiz') return void startQuiz();
  showWelcome();
}
