import { $ } from '../core/ui.ts';
import { ArScene } from './ar.ts';

/** Null when WebGL is unavailable: the setup screen still loads and Iniciar explains why. */
export let ar: ArScene | null = null;
try {
  ar = new ArScene($<HTMLCanvasElement>('ar'));
} catch {
  /* no WebGL */
}
