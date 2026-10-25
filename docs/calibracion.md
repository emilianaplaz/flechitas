# Calibración: manual y automática

[← Índice](README.md) · Código: [render/calib.ts](../src/render/calib.ts),
[render/autocalib.ts](../src/render/autocalib.ts) (puro), [render/calibDock.ts](../src/render/calibDock.ts),
[ui/shell.ts](../src/ui/shell.ts) (deslizadores de Ajustes)

La cinta cae sobre la vía solo si la cámara virtual coincide con la real. Eso depende de siete
números (`Calib`) que se guardan **por orientación de pantalla** y **por tipo de pantalla**.
Para el HUD con óptica calculada, la cámara la definen las medidas del carro
([optica-hud.md](optica-hud.md)); de `Calib` solo se usan `lateral`, `ribbonWidth` y `ribbonStart`.

## 1. Los valores

| Clave | Deslizador | Rango | Horizontal / vertical (cámara) | HUD | Qué corrige |
|---|---|---|---|---|---|
| `pitch` | Inclinación (y *Horizonte* en Ajustes) | −10…25° | 5° / 5° | 8° | La guía flota o se hunde. |
| `fov` | Campo de visión | 20…90° | 40° / 65° | 45° / 60° | La guía es más ancha o angosta que el carril al alejarse. |
| `height` | Altura cámara (y *Altura de vista*) | 0,5…3 m | 1,3 m | 1,2 m | Altura de la cámara sobre la vía. |
| `yawOffset` | Giro del soporte | −20…20° | 0 | 0 | La guía se va a un lado en una recta. |
| `lateral` | Posición en el carril | −5…5 m | 1,6 m | 1,6 m | La línea de OSM va por el centro de la calle; el carro va a la derecha. |
| `ribbonWidth` | Ancho de la guía | 1…6 m | 3 m | 3,2 m | |
| `ribbonStart` | Inicio de la guía | 2…20 m | 3 m / 6 m | 2,5 m / 4,5 m | Que la guía no empiece sobre el capó o el tablero. |

En Repetición, el dock suma *Sincronía video/GPS* (−5…5 s, `TrackReplay.syncOffset`), que no se guarda.

### Perfiles

`currentLayout()` es `'portrait'` si la ventana es más alta que ancha. Claves:

- cámara: `ar-nav.calib.landscape`, `ar-nav.calib.portrait` (y el viejo `ar-nav.calib`, leído como
  respaldo del perfil horizontal);
- HUD: `ar-nav.calib.hud.landscape`, `ar-nav.calib.hud.portrait`.

Al girar el teléfono, `calibDock` carga el perfil de la nueva orientación, su ladeo y sus marcas de
"a mano", reinicia la medición de inclinación y avisa *Modo vertical: calibración propia*.
`syncCalibProfile()` recarga el perfil cuando cambia la pantalla (cámara ↔ HUD).

## 2. Calibración manual

- **Dock** (botón de deslizadores en Conducir): un chip por valor, un deslizador con − y +, redondeo
  al paso de cada rango. *Restablecer* vuelve a lo automático (abajo). *Más → Deshacer reporte* borra el
  último peligro reportado en este teléfono.
- **Ajustes → Dispositivos → Calibrar la vista**: *Altura de vista* y *Horizonte* sobre la misma
  calibración (`setCalibValue`), con una vista previa donde la línea del horizonte sube al inclinar
  la cámara hacia abajo (`y = 96 − 4·pitch`, acotado).
- Orden sugerido (de [SETUP.md](../SETUP.md)): inicio de la guía, inclinación, campo de visión,
  posición en el carril, giro del soporte.

## 3. Calibración automática

Sin botón. Corre sola y escribe en la misma calibración que muestran los deslizadores.

### Campo de visión (A1, A2)

`visibleVfov(lensHfov, videoW, videoH, screenW, screenH)`: el FOV **vertical de lo que se ve en
pantalla**, con el video mostrado con `object-fit: cover`:

```
f        = max(videoW, videoH) / 2 / tan(lensHfov / 2)     focal en píxeles del video
cover    = max(screenW / videoW, screenH / videoH)          px de pantalla por px de video
visibleH = screenH / cover                                  filas de video que caben
vfov     = 2 · atan(visibleH / 2 / f)
```

El lente por defecto es `DEFAULT_LENS_HFOV = 63°` (cámara principal típica, 16:9 a lo largo del lado
largo). Se puede guardar uno medido en `localStorage['ar-nav.lens'] = '{"hfov": 56}'` (acepta 20–130°;
COLMAP midió 56° en un video de iPhone). Ejemplos de los tests: lente de 63°, video 1080p en pantalla
16:9 horizontal → 38°; vertical con video vertical → 63°; una pantalla 20:9 más alta recorta más.

`applyAutoFov()` corre cuando el video carga metadatos, cuando cambia de tamaño y al girar la pantalla.
No toca un `fov` puesto a mano.

### Inclinación y ladeo del soporte (A3, A4)

Desde la gravedad, con `OrientationSensor` → `poseFromEuler()` → `{pitch, roll}`:

- `TiltWindow(2500 ms, 0,8°)` junta lecturas. Solo cuenta como quieta si la ventana cubre al menos el
  80 % de 2,5 s, **ninguna lectura se tomó con el carro en marcha** (velocidad GPS > 1 m/s en modo
  Real: acelerar y frenar inclinan la gravedad aparente varios grados) y la desviación estándar de
  inclinación y ladeo es ≤ 0,8° con al menos 20 muestras (`steadyMean`).
- Se revisa una vez por segundo. La primera ventana quieta se aplica tal cual; las siguientes se
  mezclan al 50 %, para seguir suave un soporte que se movió. La primera vez avisa
  *Calibrado solo: inclinación X°, ladeo Y°*.
- El **ladeo** no tiene deslizador: se guarda en `ar-nav.mount.<layout>` y se aplica a la cámara
  (`FrameInput.mountRoll`).
- La **inclinación** se escribe en `calib.pitch` salvo que se haya movido a mano.

### Lo puesto a mano gana (A5)

Mover *Inclinación* o *Campo de visión* (en el dock o *Horizonte* en Ajustes) los marca en
`ar-nav.manual.<layout>`; la calibración automática ya no los cambia en esa orientación.
**Restablecer** vuelve el perfil a sus valores por defecto, pone el ladeo en 0, borra las marcas,
vuelve a medir la inclinación y recalcula el FOV.

### Dónde corre (A6)

`startAutoTilt()` se llama dentro del toque de *Conducir* (iOS pide ahí el permiso de movimiento; sin
permiso, la calibración queda manual en silencio):

| Situación | Fuente de la inclinación |
|---|---|
| Teléfono, modo Real o Simulación, cámara | Sus propios sensores |
| Repetición | No corre (el teléfono no está en el soporte) |
| *Caminar* (sensores activos) | No corre (la inclinación ya es en vivo) |
| Un solo equipo con *HUD aquí* | No corre (el equipo está acostado en el tablero) |
| iPad enlazado | La inclinación del teléfono (`remoteTilt`): su reposo es la base de la actitud del carro |

## 4. HUD

- **Óptica calculada** (por defecto): la cámara sale de las medidas del carro y del iPad; la
  calibración fina es mover el ojo supuesto (`eyeDx`, `eyeDy`) en la hoja 📐. Ver
  [optica-hud.md](optica-hud.md#8-la-hoja-de-medidas).
- **Espejo simple**: la cámara de la AR con el perfil `ar-nav.calib.hud.*` y los botones ⇄ ⇅.

## 5. Límites

- En una pendiente, la inclinación medida incluye la pendiente: conviene que la primera parada sea en
  plano, o dejar que paradas posteriores la promedien.
- El giro del soporte, la altura y la posición en el carril siguen siendo manuales (el giro por el
  "foco de expansión" del flujo óptico está en [TODO.md](../TODO.md)).
- No hay compensación dinámica: baches y cambios de pendiente mueven la cinta mientras se maneja
  (salvo la pendiente de la maqueta, que sí se suma).
- El FOV del lente se supone de 63° para todos los teléfonos.
- **Defecto encontrado**: `applyAutoFov()` y `autoTiltTick()` guardan con `saveCalib(calib, layout)`
  sin el tipo de pantalla, o sea siempre en el perfil de **cámara**. En el iPad (pantalla HUD), la
  inclinación de reposo medida del teléfono se escribe en `ar-nav.calib.<layout>` en vez de
  `ar-nav.calib.hud.<layout>`: vale durante la sesión pero no se conserva, y ensucia el perfil de cámara
  del iPad. Ver [limitaciones.md](limitaciones.md).
