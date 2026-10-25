// Wires saved-places sync to the account: who is signed in, when to pull and when to flush the outbox.
import { auth } from '../auth/ui.ts';
import { cloudEnabled } from '../hazards/cloud.ts';
import { onPinChange, setPinOwner } from '../find/pins.ts';
import { createPinsSync, type SyncStatus } from '../find/pinsSync.ts';

const url = (import.meta.env?.VITE_SUPABASE_URL as string | undefined)?.replace(/\/$/, '');
const key = import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined;

const userId = () => {
  const s = auth.state();
  return s.kind === 'signedIn' ? s.session.user.id : null;
};

let status: () => SyncStatus = () => (cloudEnabled ? 'signedOut' : 'off');
export const syncStatus = () => status();

/** `onPins`: the local list changed under the UI. `onStatus`: only the sync line needs redrawing. */
export function initPinsSync(onPins: () => void, onStatus: () => void) {
  if (!cloudEnabled || !url || !key) return;
  const sync = createPinsSync({
    config: { url, key },
    fetch: (...a) => fetch(...a),
    storage: localStorage,
    user: userId,
    refresh: () => auth.ensureFresh(),
    token: async () => {
      await auth.ensureFresh();
      const s = auth.state();
      return s.kind === 'signedIn' ? s.session.accessToken : null;
    },
    onStatus,
    onPins,
  });
  status = sync.status;
  onPinChange(sync.change);

  let current: string | null = null;
  const onAuth = (s: ReturnType<typeof auth.state>) => {
    if (s.kind === 'working' || s.kind === 'needsConfirmation') return;
    const id = s.kind === 'signedIn' ? s.session.user.id : null;
    if (id === current) {
      // A token refresh re-emits signedIn: the user did not change, so only retry the queue.
      if (id) void sync.flush();
      return;
    }
    current = id;
    setPinOwner(id);
    onPins();
    if (id) void sync.signedIn();
  };
  auth.subscribe(onAuth);
  onAuth(auth.state());
  const retry = () => void sync.flush();
  addEventListener('online', retry);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retry();
  });
}
