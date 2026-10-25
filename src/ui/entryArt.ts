// Line drawings for the onboarding steps, in the logo's language: a thick route in the app blue with miter
// joints, ring nodes at its ends, thin grey context lines, and one yellow hole (never anything else in yellow).
// Static strings only (no user data); colours come from the .ar-* classes in style.css.
import type { Step } from './onboarding.ts';

const svg = (body: string) => `<svg viewBox="0 0 320 180" aria-hidden="true" focusable="false">${body}</svg>`;
// Road in perspective, shared by a few drawings.
const road = '<path class="ar-ctx" d="M92 178 L146 18 M228 178 L174 18" />';

export const ART: Record<Step, string> = {
  // The route on the street dodges the hole: the logo's idea, at street level.
  use: svg(
    `${road}<path class="ar-route" d="M160 150 V122 L136 100 V78 L160 56 V31" />` +
      '<circle class="ar-node" cx="160" cy="160" r="9" /><circle class="ar-node" cx="160" cy="22" r="9" /><circle class="ar-hole" cx="166" cy="89" r="8" />',
  ),
  // Windshield above the dash, the iPad lying on it and the guide reflected in the glass.
  ipad: svg(
    '<path class="ar-ctx" d="M70 22 H250 L300 122 H20 Z M0 148 H320" />' +
      '<path class="ar-ctx ar-dash" d="M160 134 V114" />' +
      '<path class="ar-route" d="M118 148 L132 134 H188 L202 148" />' +
      '<path class="ar-route ar-thin" d="M160 104 V88 L146 76 V64 L160 52 V40" /><circle class="ar-hole" cx="166" cy="70" r="6" />',
  ),
  // An SUV in profile with the two measurements that matter.
  car: svg(
    '<path class="ar-ctx" d="M8 150 H312 M104 38 H216 M104 30 V46 M216 30 V46 M302 70 V132 M294 70 H310 M294 132 H310" />' +
      '<path class="ar-route" d="M64 132 H34 V108 L74 100 L104 70 H216 L250 100 L288 108 V132 H256 M212 132 H108" />' +
      '<circle class="ar-node" cx="86" cy="132" r="17" /><circle class="ar-node" cx="234" cy="132" r="17" />',
  ),
  // You are here: the route starts at your node and the next hole is already on it.
  location: svg(
    '<circle class="ar-ctx" cx="92" cy="128" r="26" /><circle class="ar-ctx" cx="92" cy="128" r="44" />' +
      '<path class="ar-route" d="M102 128 H186 L214 100 V58" />' +
      '<circle class="ar-node" cx="92" cy="128" r="10" /><circle class="ar-node" cx="214" cy="48" r="10" /><circle class="ar-hole" cx="234" cy="84" r="7" />',
  ),
  // The camera's frame on the street, with the arrows drawn over it.
  camera: svg(
    `${road}<path class="ar-ctx ar-frame" d="M40 46 V20 H66 M254 20 H280 V46 M280 134 V160 H254 M66 160 H40 V134" />` +
      '<path class="ar-route" d="M136 150 L160 128 L184 150 M142 112 L160 96 L178 112 M148 80 L160 69 L172 80" /><circle class="ar-hole" cx="181" cy="50" r="5" />',
  ),
  // The phone feels the dip: the route drops into the hole and comes back up.
  motion: svg(
    '<rect class="ar-route ar-thin" x="138" y="12" width="44" height="74" rx="8" />' +
      '<path class="ar-ctx" d="M120 32 C111 44 111 58 120 70 M200 32 C209 44 209 58 200 70" />' +
      '<path class="ar-route" d="M20 136 H128 L148 154 H172 L192 136 H300" /><circle class="ar-hole" cx="160" cy="166" r="7" />',
  ),
  // The iPad shows a six-digit code; the phone types it.
  link: svg(
    '<rect class="ar-route" x="34" y="44" width="124" height="92" rx="12" />' +
      '<path class="ar-ctx ar-code" d="M54 90 H64 M70 90 H80 M86 90 H96 M102 90 H112 M118 90 H128 M134 90 H144" />' +
      '<path class="ar-ctx ar-dash" d="M166 90 H216" />' +
      '<rect class="ar-route" x="226" y="36" width="58" height="108" rx="12" /><circle class="ar-node" cx="255" cy="122" r="7" />',
  ),
};
