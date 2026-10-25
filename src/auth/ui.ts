// Ajustes → Cuenta: renders the AuthState and forwards the forms to the client. No auth logic lives here.
import { $ } from '../core/ui.ts';
import { cloudEnabled } from '../hazards/cloud.ts';
import { createAuthClient, type AuthState } from './session.ts';

// src/hazards/cloud.ts keeps its URL and key private, so the same two env vars are read here.
const url = (import.meta.env?.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
const key = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined;

export const auth = createAuthClient({
  config: cloudEnabled && url && key ? { url, key } : null,
  fetch: (...a) => fetch(...a),
  storage: localStorage,
});

type Mode = 'signIn' | 'signUp';

export function initAccount() {
  let mode: Mode = 'signIn';
  const input = (id: string) => $<HTMLInputElement>(id);

  const setMessage = (text: string) => {
    $('acctMsg').textContent = text;
  };

  const renderMode = () => {
    const up = mode === 'signUp';
    $('acctModeIn').setAttribute('aria-pressed', String(!up));
    $('acctModeUp').setAttribute('aria-pressed', String(up));
    $('acctNameRow').hidden = !up;
    $('acctSubmit').textContent = up ? 'Crear cuenta' : 'Entrar';
    input('acctPass').autocomplete = up ? 'new-password' : 'current-password';
    setMessage('');
  };

  const render = (s: AuthState) => {
    const configured = cloudEnabled;
    $('acctOff').hidden = configured;
    $('acctOut').hidden = s.kind === 'needsConfirmation' || s.kind === 'signedIn';
    $('acctWait').hidden = s.kind !== 'needsConfirmation';
    $('acctIn').hidden = s.kind !== 'signedIn';
    const busy = s.kind === 'working';
    const locked = busy || !configured;
    $<HTMLFieldSetElement>('acctFields').disabled = locked;
    $<HTMLButtonElement>('acctSubmit').disabled = locked;
    $('acctSubmit').setAttribute('aria-busy', String(busy));
    $('acctModeIn').toggleAttribute('disabled', locked);
    $('acctModeUp').toggleAttribute('disabled', locked);
    if (busy) $('acctSubmit').textContent = 'Un momento…';
    else $('acctSubmit').textContent = mode === 'signUp' ? 'Crear cuenta' : 'Entrar';
    if (s.kind === 'needsConfirmation') $('acctWaitMail').textContent = s.email;
    if (s.kind === 'signedIn') {
      const { displayName, email } = s.session.user;
      $('acctDisplay').textContent = displayName;
      $('acctMail').textContent = email;
      $('acctAvatar').textContent = displayName.trim().charAt(0).toUpperCase();
    }
  };

  $('acctModeIn').onclick = () => {
    mode = 'signIn';
    renderMode();
  };
  $('acctModeUp').onclick = () => {
    mode = 'signUp';
    renderMode();
  };

  $('acctForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (auth.state().kind === 'working') return;
    setMessage('');
    const email = input('acctEmail').value;
    const password = input('acctPass').value;
    const result =
      mode === 'signUp' ? await auth.signUp({ email, password, displayName: input('acctName').value }) : await auth.signIn({ email, password });
    input('acctPass').value = '';
    if (!result.ok) setMessage(result.message);
    else input('acctEmail').value = input('acctName').value = '';
  });

  $('acctBack').onclick = () => {
    mode = 'signIn';
    auth.dismissConfirmation();
    renderMode();
  };
  $('acctOutBtn').onclick = () => void auth.signOut();

  auth.subscribe(render);
  render(auth.state());
  renderMode();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void auth.ensureFresh();
  });
  void auth.restore();
}
