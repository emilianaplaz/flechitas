// Entry flow state, without the DOM (tests run it in Node): who got past the welcome screen, the onboarding
// answers, and which question and permission steps are left. Everything stays on this device: the answers
// describe this phone's setup (car, iPad, permissions), not the account.
import type { StorageLike } from '../auth/session.ts';

export type Use = 'drive' | 'walk';
export type Car = 'fortuner' | 'other';
export interface Answers {
  use?: Use;
  /** An iPad on the dash shows the windshield HUD. Only asked when driving. */
  ipad?: boolean;
  /** Only asked with an iPad: the HUD optics need the car's measurements. */
  car?: Car;
}
export interface Onboarding {
  v: 1;
  answers: Answers;
  doneAt: number;
}
/** How the user got past the welcome screen. */
export type Entered = 'account' | 'guest';
export type Perm = 'location' | 'camera' | 'motion';
export type Step = 'use' | 'ipad' | 'car' | Perm | 'link';
export type Start = 'welcome' | 'quiz' | 'app';

export const ENTRY_KEY = 'ar-nav.entry';
export const ONBOARDING_KEY = 'ar-nav.onboarding';
export const PERMS: readonly Perm[] = ['location', 'camera', 'motion'];

const read = (s: StorageLike, k: string): string | null => {
  try {
    return s.getItem(k);
  } catch {
    return null;
  }
};
const write = (s: StorageLike, k: string, v: string | null) => {
  try {
    if (v === null) s.removeItem(k);
    else s.setItem(k, v);
  } catch {
    /* storage unavailable: the answers last this visit only */
  }
};

export function loadEntered(s: StorageLike): Entered | null {
  const v = read(s, ENTRY_KEY);
  return v === 'account' || v === 'guest' ? v : null;
}
export const saveEntered = (s: StorageLike, e: Entered | null) => write(s, ENTRY_KEY, e);

/** Keeps only known answers, so a hand-edited or older record never breaks the app. */
export function cleanAnswers(a: unknown): Answers {
  const r = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
  const use = r.use === 'walk' || r.use === 'drive' ? r.use : undefined;
  if (use !== 'drive') return use ? { use } : {};
  const ipad = typeof r.ipad === 'boolean' ? r.ipad : undefined;
  const car = ipad && (r.car === 'fortuner' || r.car === 'other') ? r.car : undefined;
  return { use, ...(ipad !== undefined ? { ipad } : {}), ...(car ? { car } : {}) };
}

export function loadOnboarding(s: StorageLike): Onboarding | null {
  try {
    const o: unknown = JSON.parse(read(s, ONBOARDING_KEY) ?? 'null');
    if (typeof o !== 'object' || o === null) return null;
    const { v, answers, doneAt } = o as Record<string, unknown>;
    if (v !== 1 || typeof doneAt !== 'number') return null;
    return { v: 1, answers: cleanAnswers(answers), doneAt };
  } catch {
    return null;
  }
}
export function saveOnboarding(s: StorageLike, answers: Answers, now: number): Onboarding {
  const o: Onboarding = { v: 1, answers: cleanAnswers(answers), doneAt: now };
  write(s, ONBOARDING_KEY, JSON.stringify(o));
  return o;
}

/**
 * Where the app opens. Signed in, or in as a guest: the questions until they are answered once on this device,
 * then straight to the map. Anyone else (first open, after signing out, a session the server ended) gets the welcome.
 */
export function startScreen(s: { entered: Entered | null; signedIn: boolean; onboarded: boolean }): Start {
  if (s.signedIn || s.entered === 'guest') return s.onboarded ? 'app' : 'quiz';
  return 'welcome';
}

/**
 * The steps for these answers, in order. `ask`: the permissions the browser would still prompt for; one already
 * granted, or one this browser never asks for, has no step. Unanswered questions count their longest branch
 * (driving, with an iPad), so the total only ever shrinks as the person answers.
 */
export function stepsFor(a: Answers, ask: ReadonlySet<Perm>): Step[] {
  const drive = a.use !== 'walk';
  const ipad = drive && a.ipad !== false;
  const steps: Step[] = ['use'];
  if (drive) steps.push('ipad');
  if (ipad) steps.push('car');
  for (const p of PERMS) if (ask.has(p)) steps.push(p);
  if (ipad) steps.push('link');
  return steps;
}
