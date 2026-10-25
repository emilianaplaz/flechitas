// Which device this is: the phone runs the app; an iPad can be the windshield HUD (?role=hud, or chosen once).
export const ROLE_KEY = 'ar-nav.role';

export function isHudRole(): boolean {
  try {
    return new URLSearchParams(location.search).get('role') === 'hud' || localStorage.getItem(ROLE_KEY) === 'hud';
  } catch {
    return false;
  }
}

/** Remembers the role and reloads into it. */
export function setRole(role: 'hud' | 'phone') {
  try {
    localStorage.setItem(ROLE_KEY, role);
  } catch {
    /* ignore */
  }
  location.replace(location.pathname);
}
