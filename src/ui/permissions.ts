// The three browser permissions the onboarding explains before asking: location, camera and motion.
// A step is shown only when the browser would actually prompt; asking here means the prompt shows up after
// the explanation instead of in the middle of the first drive.
import type { Perm } from './onboarding.ts';

export type PermResult = 'granted' | 'denied' | 'unavailable';

type AskFn = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };
const motionApi = (): AskFn | null => (typeof DeviceMotionEvent === 'undefined' ? null : (DeviceMotionEvent as unknown as AskFn));
const orientationApi = (): AskFn | null => (typeof DeviceOrientationEvent === 'undefined' ? null : (DeviceOrientationEvent as unknown as AskFn));

/** True when asking would show a prompt. Already granted, already denied (a new prompt never shows) or unsupported: false. */
export async function needsAsking(p: Perm): Promise<boolean> {
  // iOS only: other browsers hand out motion events without asking.
  if (p === 'motion') return typeof motionApi()?.requestPermission === 'function';
  if (p === 'location' && !('geolocation' in navigator)) return false;
  if (p === 'camera' && !navigator.mediaDevices?.getUserMedia) return false;
  try {
    const status = await navigator.permissions.query({ name: (p === 'location' ? 'geolocation' : 'camera') as PermissionName });
    return status.state === 'prompt';
  } catch {
    return true; // this browser can't tell (older Safari): explain and ask
  }
}

/** Shows the browser's prompt. Must run inside the tap that asked for it (iOS refuses otherwise). */
export async function requestPerm(p: Perm): Promise<PermResult> {
  if (p === 'location') {
    return new Promise((done) =>
      navigator.geolocation.getCurrentPosition(
        () => done('granted'),
        // No fix yet (indoors, timeout) still means the permission was given.
        (e) => done(e.code === e.PERMISSION_DENIED ? 'denied' : 'granted'),
        { enableHighAccuracy: false, maximumAge: 600_000, timeout: 20_000 },
      ),
    );
  }
  if (p === 'camera') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      stream.getTracks().forEach((t) => t.stop()); // only the permission is needed now
      return 'granted';
    } catch (e) {
      const name = (e as DOMException).name;
      return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable';
    }
  }
  // Motion and orientation share one prompt on iOS; both calls start inside the same tap.
  try {
    const [motion] = await Promise.all([motionApi()?.requestPermission?.(), orientationApi()?.requestPermission?.()]);
    return motion === 'granted' || motion === undefined ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}
