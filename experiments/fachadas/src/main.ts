// Experimento: darle a los edificios de la maqueta su aspecto real, comparando enfoques sobre la
// zona San Juan Bosco con las teselas reales de la app. Página aparte: no toca src/ ni las teselas.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { cargarZona, type Zona } from './zona.ts';
import { aplicarTema, contornos, edificiosDe, geometriaEdificios, materialFachadas, PALETA, sueloYCalles, USO_NOMBRE, type Edificio, type Tema } from './edificios.ts';
import { corrimiento, FUENTES_AEREAS, mosaicoAereo, type Aerea } from './aerea.ts';
import { cargarPiloto, type Piloto } from './fotos.ts';
import { crearGoogle, elevRel, type Google } from './google.ts';
import { hornearEdificio, imagenesMapillary, marcadores, type ImgMly } from './mapillary.ts';

type Modo = 'hoy' | 'procedural' | 'aerea' | 'fotos' | 'mapillary' | 'google';
type Vista = 'iso' | 'pajaro' | 'calle';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const ELEV = THREE.MathUtils.degToRad(35); // la vista isométrica de la pantalla Maqueta
const TRAMO = { a: { lat: 10.51031, lon: -66.85181 }, b: { lat: 10.51136, lon: -66.852 } }; // tramo de prueba (MAQUETA.md)
const kB = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);

// ---------- estado ----------
let modo: Modo = (params.get('modo') as Modo) || 'procedural';
let vista: Vista = (params.get('vista') as Vista) || 'iso';
let tema: Tema = (params.get('tema') as Tema) || 'dark';
let zona: Zona;
let eds: Edificio[] = [];
let sel: Edificio | null = null;
let aerea: Aerea | null = null;
let aereaCargando: Promise<Aerea | null> | null = null;
let ajusteAereo: { dx: number; dz: number; mejora: number } | null = null;
let fuenteAerea = params.get('aerea') ?? (import.meta.env.VITE_AEREA as string | undefined) ?? 'oam';
let piloto: Piloto | null = null;
let pilotoCargando: Promise<Piloto | null> | null = null;
let google: Google | null = null;
let googleAjuste: number | null = null;
let mly: { imgs: ImgMly[]; bytes: number; ms: number; marcas: THREE.InstancedMesh } | null = null;
let mlyError = '';
const horneadosMly = new Map<number, THREE.Mesh>();
let ultimoHorneadoMly: Record<string, string> = {};
let bench: Record<string, string> = {};
const opts = { detalle: 1, uso: 0.6, luces: 0.12, sueloAereo: true, corregir: true, clip: true, contornos: true, bloquesGoogle: false, fotosVer: 'paredes' as 'malla' | 'paredes' | 'ambas', lineas: true, errorTarget: 20 };

// ---------- three ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
$('vista').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 8000);
const persp = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 8000);
let camera: THREE.OrthographicCamera | THREE.PerspectiveCamera = ortho;
let controls = new OrbitControls(ortho, renderer.domElement);
let isoScale = 0.35; // metros por píxel CSS, como la pantalla Maqueta al abrir

const grupoZona = new THREE.Group();
const grupoPiloto = new THREE.Group();
scene.add(grupoZona, grupoPiloto);
const material = materialFachadas({ detalle: opts.detalle, uso: opts.uso, tema });
let mallaEdificios: THREE.Mesh;
let suelo: THREE.Mesh;
let calles: THREE.Mesh;
let lineasHuellas: THREE.LineSegments | null = null;

function aviso(t: string | null) {
  const el = $('aviso');
  el.hidden = !t;
  el.textContent = t ?? '';
}

// ---------- cámara ----------
function focoZona(): THREE.Vector3 {
  const a = zona.local(TRAMO.a);
  const b = zona.local(TRAMO.b);
  return new THREE.Vector3((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
}

function encuadreOrtho() {
  const w = innerWidth;
  const h = innerHeight;
  ortho.left = (-w / 2) * isoScale;
  ortho.right = (w / 2) * isoScale;
  ortho.top = (h / 2) * isoScale;
  ortho.bottom = (-h / 2) * isoScale;
  ortho.updateProjectionMatrix();
}

function usarVista(v: Vista) {
  vista = v;
  controls.dispose();
  const enPiloto = modo === 'fotos';
  const foco = enPiloto && piloto ? piloto.centro.clone() : zona ? focoZona() : new THREE.Vector3();
  const relieve = modo === 'google' && zona ? elevRel(zona) : null;
  if (relieve) foco.y = relieve(foco.x, foco.z);
  if (v === 'iso') {
    camera = ortho;
    isoScale = enPiloto ? 0.06 : 0.3;
    ortho.zoom = 1;
    encuadreOrtho();
    const az = enPiloto ? THREE.MathUtils.degToRad(200) : THREE.MathUtils.degToRad(45);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(ELEV), Math.sin(ELEV), Math.cos(az) * Math.cos(ELEV));
    ortho.position.copy(foco).addScaledVector(dir, 2000);
    controls = new OrbitControls(ortho, renderer.domElement);
    controls.minPolarAngle = controls.maxPolarAngle = Math.PI / 2 - ELEV;
  } else {
    camera = persp;
    persp.fov = v === 'calle' ? 62 : 50;
    persp.aspect = innerWidth / innerHeight;
    persp.updateProjectionMatrix();
    controls = new OrbitControls(persp, renderer.domElement);
    if (v === 'pajaro') {
      const off = enPiloto ? new THREE.Vector3(-14, 16, -20) : new THREE.Vector3(70, 80, 110);
      persp.position.copy(foco).add(off);
    } else if (enPiloto && piloto) {
      const f = piloto.fotos[16];
      persp.position.copy(f.pos);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(f.quat).setY(0).normalize();
      foco.copy(f.pos).addScaledVector(fwd, 12);
    } else {
      const a = zona.local(TRAMO.a);
      const b = zona.local(TRAMO.b);
      // En la calle, 8 m antes del comienzo del tramo de prueba, mirando a lo largo de él.
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const px = a.x - ((b.x - a.x) / len) * 8;
      const pz = a.z - ((b.z - a.z) / len) * 8;
      persp.position.set(px, (relieve ? relieve(px, pz) : 0) + 1.6, pz);
      foco.set(b.x, (relieve ? relieve(b.x, b.z) : 0) + 4, b.z);
    }
  }
  controls.target.copy(foco);
  controls.enableDamping = true;
  controls.screenSpacePanning = true;
  controls.update();
  if (google) google.tiles.setCamera(camera), google.tiles.setResolutionFromRenderer(camera, renderer);
  pintarBotones();
}

// ---------- tema ----------
function aplicarTemaTodo() {
  document.documentElement.dataset.tema = tema;
  const p = PALETA[tema];
  scene.background = new THREE.Color(p.bg);
  aplicarTema(material, tema);
  if (suelo) (suelo.material as THREE.MeshBasicMaterial).color.setHex(p.gnd);
  if (calles) (calles.material as THREE.MeshBasicMaterial).color.setHex(p.street);
  pintarBotones();
}

// ---------- modos ----------
const TEXTO: Record<Modo, { titulo: string; resumen: string }> = {
  hoy: { titulo: 'Hoy: bloques planos', resumen: 'Lo que dibuja hoy la pantalla Maqueta: huellas extruidas con tres tonos planos. Es la base de comparación.' },
  procedural: { titulo: 'Fachadas procedurales', resumen: 'Pisos, ventanas, planta baja y color por uso calculados en el shader desde altura, pisos y huella. No baja nada extra y funciona en toda zona con teselas.' },
  aerea: { titulo: 'Techos con imagen aérea', resumen: 'Paredes procedurales y los techos (y el suelo) con un mosaico de imagen satelital de la zona.' },
  fotos: { titulo: 'Video propio (PRUEBA RENDER)', resumen: 'La calle del video de prueba: la malla de OpenMVS tal cual, o paredes simples (como nuestras huellas) con las fotos del video horneadas encima. Sin GPS: se ve en su propio marco, no sobre la maqueta.' },
  mapillary: { titulo: 'Fotos de calle (Mapillary)', resumen: 'Fotos públicas a pie de calle, proyectadas sobre las paredes del edificio que toques, con la misma técnica que el video propio.' },
  google: { titulo: 'Google Photorealistic 3D Tiles', resumen: 'La malla fotorrealista de Google, recortada a la zona y puesta en el marco de la maqueta, con nuestras huellas encima para ver cuánto calzan.' },
};

async function usarModo(m: Modo) {
  modo = m;
  const enPiloto = m === 'fotos';
  grupoZona.visible = !enPiloto;
  grupoPiloto.visible = enPiloto;
  material.uniforms.uDetail.value = m === 'hoy' ? 0 : opts.detalle;
  material.uniforms.uUso.value = m === 'hoy' ? 0 : opts.uso;
  material.uniforms.uAerialOn.value = 0;
  mallaEdificios.visible = m !== 'google' || opts.bloquesGoogle;
  suelo.visible = true;
  calles.visible = m !== 'google';
  if (aerea) aerea.suelo.visible = false;
  if (google) google.grupo.visible = m === 'google';
  if (mly) mly.marcas.visible = m === 'mapillary';
  horneadosMly.forEach((h) => (h.visible = m === 'mapillary'));
  if (lineasHuellas) lineasHuellas.visible = false;
  $('atrib').textContent = '';
  history.replaceState(null, '', `?modo=${m}&vista=${vista}&tema=${tema}`);
  pintarPanel();
  pintarBotones();

  if (m === 'aerea') {
    const a = await cargarAerea();
    if (a && modo === 'aerea') {
      material.uniforms.uAerial.value = a.textura;
      aplicarAjusteAereo();
      material.uniforms.uAerialOn.value = 1;
      a.suelo.visible = opts.sueloAereo;
      $('atrib').textContent = a.fuente.atribucion;
    }
  }
  if (m === 'fotos') {
    const p = await cargarPilotoUnaVez();
    if (p && modo === 'fotos') {
      aplicarVerFotos();
      usarVista(vista);
    }
  }
  if (m === 'google') iniciarGoogle();
  if (m === 'mapillary') iniciarMapillary();
  if (m !== 'fotos') usarVista(vista);
  pintarPanel();
}

function cargarAerea(): Promise<Aerea | null> {
  aereaCargando ??= (async () => {
    const f = FUENTES_AEREAS[fuenteAerea];
    if (!f) return null;
    aviso('Bajando imagen aérea…');
    try {
      if (aerea) {
        aerea.suelo.removeFromParent();
        aerea.textura.dispose();
      }
      aerea = await mosaicoAereo(zona, f);
      grupoZona.add(aerea.suelo);
      ajusteAereo = corrimiento(aerea, eds.map((e) => e.ring));
      return aerea;
    } catch (e) {
      console.error(e);
      return null;
    } finally {
      aviso(null);
    }
  })();
  return aereaCargando;
}

/** Corre la imagen lo medido para que los techos caigan sobre las huellas (o la deja como viene). */
function aplicarAjusteAereo() {
  if (!aerea) return;
  const r = material.uniforms.uAerialRect.value as THREE.Vector4;
  r.copy(aerea.rect);
  const d = opts.corregir && ajusteAereo ? ajusteAereo : { dx: 0, dz: 0 };
  r.x -= d.dx;
  r.y -= d.dz;
  aerea.suelo.position.set(aerea.rect.x + aerea.rect.z / 2 - d.dx, 0.02, aerea.rect.y + aerea.rect.w / 2 - d.dz);
}

function cargarPilotoUnaVez(): Promise<Piloto | null> {
  pilotoCargando ??= (async () => {
    try {
      piloto = await cargarPiloto(renderer, aviso);
      grupoPiloto.add(piloto.grupo);
      return piloto;
    } catch (e) {
      console.error(e);
      aviso(`No pude cargar la prueba de video: ${(e as Error).message}`);
      return null;
    } finally {
      if (piloto) aviso(null);
    }
  })();
  return pilotoCargando;
}

function aplicarVerFotos() {
  if (!piloto) return;
  piloto.malla.visible = opts.fotosVer !== 'paredes';
  piloto.paredes.visible = opts.fotosVer !== 'malla';
  piloto.suelo.visible = opts.fotosVer === 'paredes';
  piloto.lineas.visible = opts.lineas;
}

function claveGoogle(): string {
  return (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) || localStorage.getItem('fachadas.googleKey') || '';
}
function tokenMapillary(): string {
  return (import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined) || localStorage.getItem('fachadas.mapillaryToken') || '';
}

function iniciarGoogle() {
  const tileset = params.get('tileset') ?? undefined;
  const key = claveGoogle();
  if (!lineasHuellas) {
    lineasHuellas = contornos(eds, 0xff4fa3, true, elevRel(zona));
    lineasHuellas.renderOrder = 10;
    grupoZona.add(lineasHuellas);
  }
  lineasHuellas.visible = opts.contornos;
  if (google || (!key && !tileset)) return;
  google = crearGoogle({ key, tileset, zona, renderer, camera, clip: opts.clip });
  google.tiles.errorTarget = opts.errorTarget;
  grupoZona.add(google.grupo);
  // Cuando termina la primera tanda, se baja/sube para que la calle coincida con el relieve de la maqueta.
  google.tiles.addEventListener('tiles-load-end', () => {
    if (googleAjuste === null && google) {
      googleAjuste = google.ajustarSuelo();
      pintarPanel();
    }
  });
}

async function iniciarMapillary() {
  const token = tokenMapillary();
  if (!token || mly) return;
  aviso('Buscando fotos de Mapillary en la zona…');
  try {
    const r = await imagenesMapillary(token, zona, elevRel(zona));
    const marcas = marcadores(r.imgs);
    grupoZona.add(marcas);
    mly = { ...r, marcas };
    mlyError = '';
  } catch (e) {
    mlyError = (e as Error).message;
  } finally {
    aviso(null);
    pintarPanel();
  }
}

async function hornearMly(ed: Edificio) {
  if (!mly || horneadosMly.has(ed.idx)) return;
  aviso('Horneando fotos de Mapillary sobre el edificio…');
  try {
    const h = await hornearEdificio(renderer, ed, mly.imgs, elevRel(zona));
    horneadosMly.set(ed.idx, h.malla);
    grupoZona.add(h.malla);
    ultimoHorneadoMly = {
      Paredes: String(h.paredes),
      'Fotos usadas': String(h.usadas),
      Atlas: `${h.canvas.width}×${h.canvas.height} · JPEG ${kB(h.bytesJpeg)} · ${(h.cobertura * 100).toFixed(0)} % con foto`,
      Horneado: `${(h.ms / 1000).toFixed(2)} s`,
    };
  } finally {
    aviso(null);
    pintarPanel();
  }
}

// ---------- panel ----------
function control(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild as HTMLElement;
}

function deslizador(etq: string, clave: 'detalle' | 'uso' | 'luces', min: number, max: number, alCambiar: () => void) {
  const el = control(`<label>${etq} <input type="range" min="${min}" max="${max}" step="0.01" value="${opts[clave]}"></label>`);
  el.querySelector('input')!.addEventListener('input', (e) => {
    opts[clave] = Number((e.target as HTMLInputElement).value);
    alCambiar();
  });
  return el;
}
function casilla(etq: string, clave: 'sueloAereo' | 'corregir' | 'clip' | 'contornos' | 'bloquesGoogle' | 'lineas', alCambiar: () => void) {
  const el = control(`<label><input type="checkbox" ${opts[clave] ? 'checked' : ''}> ${etq}</label>`);
  el.querySelector('input')!.addEventListener('change', (e) => {
    opts[clave] = (e.target as HTMLInputElement).checked;
    alCambiar();
  });
  return el;
}
function campoClave(etq: string, storage: string, alUsar: () => void) {
  const el = control(`<label>${etq} <input type="password" autocomplete="off" placeholder="pega aquí"> <button type="button">Usar</button></label>`);
  el.querySelector('button')!.addEventListener('click', () => {
    const v = (el.querySelector('input') as HTMLInputElement).value.trim();
    if (!v) return;
    localStorage.setItem(storage, v); // solo en este navegador; no va al repo
    alUsar();
  });
  return el;
}
const nota = (html: string) => control(`<p class="nota">${html}</p>`);

function pintarPanel() {
  const t = TEXTO[modo];
  $('pTitulo').textContent = t.titulo;
  $('pResumen').textContent = t.resumen;
  const c = $('pControles');
  c.textContent = '';
  if (modo === 'procedural' || modo === 'aerea' || modo === 'mapillary') {
    c.append(
      deslizador('Detalle', 'detalle', 0, 1, () => (material.uniforms.uDetail.value = opts.detalle)),
      deslizador('Color por uso', 'uso', 0, 1, () => (material.uniforms.uUso.value = opts.uso)),
      deslizador('Ventanas encendidas', 'luces', 0, 0.5, () => (material.uniforms.uLitShare.value = opts.luces)),
    );
  }
  if (modo === 'aerea') {
    const sel = control(`<label>Fuente <select>${Object.entries(FUENTES_AEREAS)
      .map(([k, f]) => `<option value="${k}" ${k === fuenteAerea ? 'selected' : ''}>${f.nombre}</option>`)
      .join('')}</select></label>`);
    sel.querySelector('select')!.addEventListener('change', (e) => {
      fuenteAerea = (e.target as HTMLSelectElement).value;
      aereaCargando = null;
      void usarModo('aerea');
    });
    c.append(sel, casilla('Suelo con la imagen', 'sueloAereo', () => aerea && (aerea.suelo.visible = opts.sueloAereo)), casilla('Corregir el corrimiento medido', 'corregir', aplicarAjusteAereo));
    if (fuenteAerea === 'esri')
      c.append(nota('Esri solo sirve para comparar en local: sus términos no dejan hornearla ni usarla sin cuenta de ArcGIS, y excluyen apps de navegación (ver RESULTADOS.md).'));
    else c.append(nota('CC BY-NC 4.0: se puede hornear en las teselas mientras la app no sea comercial, citando a Vantor y OpenAerialMap.'));
  }
  if (modo === 'fotos') {
    const r = control(
      `<div role="radiogroup" style="display:flex;gap:4px">${(['malla', 'paredes', 'ambas'] as const)
        .map((k) => `<button type="button" data-ver="${k}" aria-pressed="${opts.fotosVer === k}">${{ malla: 'Malla OpenMVS', paredes: 'Paredes + fotos', ambas: 'Las dos' }[k]}</button>`)
        .join('')}</div>`,
    );
    r.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        opts.fotosVer = (b as HTMLElement).dataset.ver as typeof opts.fotosVer;
        aplicarVerFotos();
        pintarPanel();
      }),
    );
    c.append(r, casilla('Líneas de fachada y camino', 'lineas', aplicarVerFotos));
    if (piloto) {
      const img = piloto.horneado.canvas;
      img.style.width = '100%';
      img.style.border = '1px solid var(--line)';
      img.title = 'Atlas horneado: una franja por pared';
      c.append(img);
    }
  }
  if (modo === 'google') {
    c.append(nota('Según la tabla de cobertura de Google (oct. 2026), Venezuela solo tiene teselas 2D: es probable que en Caracas no haya malla 3D. Y sus términos no dejan guardarla, hornearla ni mostrarla junto a nuestro mapa (ver RESULTADOS.md).'));
    if (!claveGoogle() && !params.get('tileset')) {
      c.append(
        nota('Falta la clave de Google Maps Platform (API “Map Tiles”). Ponla en <code>experiments/fachadas/.env.local</code> como <code>VITE_GOOGLE_MAPS_KEY=…</code> y reinicia, o pégala aquí (se guarda solo en este navegador).'),
        campoClave('Clave', 'fachadas.googleKey', () => location.reload()),
      );
    } else {
      c.append(
        casilla('Recortar a la zona', 'clip', () => location.reload()),
        casilla('Contornos de nuestras huellas', 'contornos', () => lineasHuellas && (lineasHuellas.visible = opts.contornos)),
        casilla('Bloques de la maqueta', 'bloquesGoogle', () => (mallaEdificios.visible = opts.bloquesGoogle)),
      );
      const er = control(`<label>Calidad (error px) <input type="range" min="4" max="60" step="1" value="${opts.errorTarget}"></label>`);
      er.querySelector('input')!.addEventListener('change', (e) => {
        opts.errorTarget = Number((e.target as HTMLInputElement).value);
        if (google) google.tiles.errorTarget = opts.errorTarget;
      });
      const aj = control('<button type="button">Ajustar al suelo otra vez</button>');
      aj.addEventListener('click', () => {
        if (google) googleAjuste = (googleAjuste ?? 0) + (google.ajustarSuelo() ?? 0);
        pintarPanel();
      });
      c.append(er, aj);
    }
  }
  if (modo === 'mapillary') {
    c.append(nota('Los términos de Mapillary (§5) prohíben usarlo en apps de navegación en tiempo real: hace falta permiso de Meta antes de llevarlo a la app.'));
    if (!tokenMapillary()) {
      c.append(
        nota('Falta el token de Mapillary (gratis, cuenta de desarrollador). Ponlo en <code>experiments/fachadas/.env.local</code> como <code>VITE_MAPILLARY_TOKEN=MLY|…</code> o pégalo aquí.'),
        campoClave('Token', 'fachadas.mapillaryToken', () => location.reload()),
      );
    } else if (mlyError) c.append(nota(`Mapillary respondió: ${mlyError}`));
    else c.append(nota('Toca un edificio para proyectar las fotos que lo ven.'));
  }
  pintarMedidas();
}

function medidas(): Record<string, string> {
  const info = renderer.info;
  const base: Record<string, string> = {};
  if (modo !== 'fotos') {
    base['Teselas de la zona'] = `${zona.tiles.length} · ${kB(zona.bytes)} JSON (ya las baja la app)`;
    base['Edificios en la zona'] = `${eds.length} (${eds.filter((e) => e.b.source === 'osm').length} OSM, ${eds.filter((e) => e.b.source === 'ms').length} Microsoft)`;
  }
  if (modo === 'hoy' || modo === 'procedural') base['Descarga extra'] = '0 B';
  if (modo === 'procedural') base['Usos estimados'] = USO_NOMBRE.map((n, i) => `${eds.filter((e) => e.uso === i).length} ${n}`).join(', ');
  if (modo === 'aerea' && aerea) {
    base['Imagen aérea'] = `${aerea.teselas} teselas z${aerea.fuente.zoom} · ${kB(aerea.bytes)} · ${aerea.px} px${aerea.fallidas ? ` · ${aerea.fallidas} fallaron` : ''}`;
    base['Bajada + armado'] = `${(aerea.ms / 1000).toFixed(1)} s (escritorio, wifi)`;
    base['Memoria de textura'] = kB(aerea.textura.image.width * aerea.textura.image.height * 4 * 1.33);
    if (ajusteAereo) base['Corrimiento contra las huellas'] = `${Math.hypot(ajusteAereo.dx, ajusteAereo.dz).toFixed(1)} m (${ajusteAereo.dx >= 0 ? 'este' : 'oeste'} ${Math.abs(ajusteAereo.dx).toFixed(2)}, ${ajusteAereo.dz >= 0 ? 'sur' : 'norte'} ${Math.abs(ajusteAereo.dz).toFixed(2)}) · bordes ×${ajusteAereo.mejora.toFixed(2)}`;
  }
  if (modo === 'fotos' && piloto) Object.assign(base, piloto.stats);
  if (modo === 'google' && google) {
    const s = (google.tiles as unknown as { stats: Record<string, number> }).stats;
    base['Descargado'] = `${kB(google.bytes())} en ${google.requests()} pedidos`;
    base['Primera carga completa'] = google.listoMs() ? `${(google.listoMs()! / 1000).toFixed(1)} s` : 'cargando…';
    base['Teselas'] = `${s.visible ?? '?'} visibles · ${s.loaded ?? s.inCache ?? '?'} cargadas · ${s.downloading ?? 0} bajando`;
    base['Ajuste vertical'] = googleAjuste === null ? '—' : `${googleAjuste.toFixed(1)} m (geoide + modelo de relieve)`;
    $('atrib').textContent = google.atribuciones() ? `Google · ${google.atribuciones()}` : 'Google';
  }
  if (modo === 'mapillary' && mly) {
    base['Fotos en la caja'] = `${mly.imgs.length} (${mly.imgs.filter((i) => i.esferica).length} de 360°) · API ${kB(mly.bytes)} en ${(mly.ms / 1000).toFixed(1)} s`;
    if (mly.imgs.length) base['Fechas'] = `${mly.imgs.map((i) => i.fecha).sort()[0]} a ${mly.imgs.map((i) => i.fecha).sort().at(-1)}`;
    Object.assign(base, ultimoHorneadoMly);
    $('atrib').textContent = 'Fotos: colaboradores de Mapillary, CC BY-SA 4.0';
  }
  base['Cuadros por segundo'] = fpsTxt;
  base['Llamadas de dibujo'] = String(info.render.calls);
  base['Triángulos en pantalla'] = `${Math.round(info.render.triangles / 1000)} k`;
  base['Texturas en GPU'] = String(info.memory.textures);
  Object.assign(base, bench);
  return base;
}

function pintarMedidas() {
  const dl = $('pMedidas');
  dl.textContent = '';
  for (const [k, v] of Object.entries(medidas())) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

function pintarBotones() {
  document.querySelectorAll<HTMLElement>('#modos button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.modo === modo)));
  document.querySelectorAll<HTMLElement>('[data-vista]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.vista === vista)));
  document.querySelectorAll<HTMLElement>('[data-tema]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tema === tema)));
}

function pintarSel() {
  const el = $('pSel');
  if (!sel || modo === 'fotos') return void (el.textContent = '');
  const b = sel.b;
  el.innerHTML = `<b>Edificio elegido</b><br>${b.name ?? 'sin nombre'} · ${b.source === 'ms' ? 'Microsoft' : b.source.toUpperCase()} · ${b.height} m${b.levels ? ` · ${b.levels} pisos` : ''}<br>${Math.round(sel.area)} m² · uso estimado: ${USO_NOMBRE[sel.uso]}<br><small>${b.id}</small>`;
}

// ---------- elegir edificio ----------
const ray = new THREE.Raycaster();
function elegir(x: number, y: number) {
  if (modo === 'fotos' || !mallaEdificios.visible) return;
  ray.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
  const hit = ray.intersectObject(mallaEdificios, false)[0];
  const idx = hit?.face ? (mallaEdificios.geometry.getAttribute('aBld') as THREE.BufferAttribute).getX(hit.face.a) : -1;
  sel = idx >= 0 ? eds[idx] : null;
  material.uniforms.uSel.value = sel ? sel.idx : -1;
  pintarSel();
  if (sel && modo === 'mapillary') void hornearMly(sel);
}

// ---------- medición ----------
let fpsTxt = '—';
let cuadros = 0;
let desde = performance.now();

/** Fuerza N cuadros seguidos y espera a la GPU: ms por cuadro de esta vista (comparable entre modos). */
function medirCuadro(n = 120): number {
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  renderer.render(scene, camera);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    if (google && modo === 'google') google.update();
    renderer.render(scene, camera);
  }
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return (performance.now() - t0) / n;
}

async function capturar(nombre: string): Promise<string> {
  controls.update();
  if (google && modo === 'google') google.update();
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/jpeg', 0.86);
  const blob = await (await fetch(url)).blob();
  const res = await fetch(`/__captura?n=${encodeURIComponent(nombre)}.jpg`, { method: 'POST', body: blob });
  return `${res.status} ${kB(blob.size)}`;
}

// ---------- arranque ----------
function bindUi() {
  document.querySelectorAll<HTMLElement>('#modos button').forEach((b) => b.addEventListener('click', () => void usarModo(b.dataset.modo as Modo)));
  document.querySelectorAll<HTMLElement>('[data-vista]').forEach((b) => b.addEventListener('click', () => usarVista(b.dataset.vista as Vista)));
  document.querySelectorAll<HTMLElement>('[data-tema]').forEach((b) =>
    b.addEventListener('click', () => {
      tema = b.dataset.tema as Tema;
      aplicarTemaTodo();
      history.replaceState(null, '', `?modo=${modo}&vista=${vista}&tema=${tema}`);
    }),
  );
  $('capturar').addEventListener('click', async () => {
    const r = await capturar(`${modo}-${vista}-${tema}`);
    aviso(`Captura guardada (${r})`);
    setTimeout(() => aviso(null), 1500);
  });
  let down = { x: 0, y: 0, t: 0 };
  renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && performance.now() - down.t < 500) elegir(e.clientX, e.clientY);
  });
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    persp.aspect = innerWidth / innerHeight;
    persp.updateProjectionMatrix();
    encuadreOrtho();
    if (google) google.tiles.setResolutionFromRenderer(camera, renderer);
  });
}

function loop() {
  requestAnimationFrame(loop);
  controls.update();
  const e = camera.matrixWorld.elements;
  (material.uniforms.uCamRight.value as THREE.Vector2).set(e[0], e[2]).normalize();
  if (google && modo === 'google') google.update();
  renderer.render(scene, camera);
  cuadros++;
  const now = performance.now();
  if (now - desde > 500) {
    fpsTxt = `${Math.round((cuadros * 1000) / (now - desde))}`;
    cuadros = 0;
    desde = now;
    pintarMedidas();
  }
}

async function main() {
  aviso('Cargando teselas de la maqueta…');
  zona = await cargarZona('san-juan-bosco');
  eds = edificiosDe(zona);
  const g = geometriaEdificios(eds);
  mallaEdificios = new THREE.Mesh(g, material);
  ({ suelo, calles } = sueloYCalles(zona, tema));
  grupoZona.add(suelo, calles, mallaEdificios);
  aviso(null);
  bindUi();
  aplicarTemaTodo();
  await usarModo(modo);
  loop();
  // Para las capturas y las mediciones desde la consola.
  Object.assign(window, {
    __fachadas: {
      modo: (m: Modo) => usarModo(m),
      vista: (v: Vista) => usarVista(v),
      tema: (t: Tema) => ((tema = t), aplicarTemaTodo()),
      capturar,
      elegir: (idx: number) => {
        sel = eds[idx] ?? null;
        material.uniforms.uSel.value = sel ? sel.idx : -1;
        pintarSel();
        if (sel && modo === 'mapillary') return hornearMly(sel);
      },
      medir: (n?: number) => {
        const ms = medirCuadro(n);
        bench = { 'ms por cuadro (medido)': `${ms.toFixed(2)} ms · ${innerWidth}×${innerHeight} × ${renderer.getPixelRatio()}` };
        return ms;
      },
      estado: () => ({ modo, vista, tema, medidas: medidas(), sel: sel?.b.id }),
      camara: () => ({ pos: camera.position.toArray(), target: controls.target.toArray(), zoom: camera.zoom }),
      fijarCamara: (pos: number[], target: number[], zoom = 1) => {
        camera.position.fromArray(pos);
        controls.target.fromArray(target);
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
        controls.update();
      },
      eds: () => eds.map((e) => ({ idx: e.idx, id: e.b.id, h: e.height, area: Math.round(e.area), uso: e.uso, c: e.center })),
      google: () => google,
      piloto: () => piloto,
      fuenteAerea: async (id: string) => {
        fuenteAerea = id;
        aereaCargando = null;
        await usarModo('aerea');
        return { fuente: id, ajuste: ajusteAereo, medidas: medidas() };
      },
      corregir: (on: boolean) => ((opts.corregir = on), aplicarAjusteAereo()),
      THREE,
      renderer,
    },
  });
}

void main();
