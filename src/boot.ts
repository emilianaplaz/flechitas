// First script of the page. The entry flow (welcome, account, questions: src/ui/entry.ts) is small and
// starts at once, while the rest of the app (map, 3D, AR, ~700 KB) loads behind it. The welcome logo is the
// loading screen and only leaves once the app is ready. The iPad (windshield HUD) skips the entry.
import './style.css';
import { auth } from './auth/ui.ts';
import { isHudRole, setRole } from './core/role.ts';
import { initEntry } from './ui/entry.ts';

const app = import('./main.ts');

if (!isHudRole()) {
  void auth.restore(); // a saved session decides the first screen; Ajustes → Cuenta reuses it
  initEntry({
    onEnter: async (to) => {
      await app;
      const { go } = await import('./ui/shell.ts');
      go(to);
    },
    useAsHud: () => setRole('hud'),
  });
}
