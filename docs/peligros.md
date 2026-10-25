# Peligros: huecos, policías acostados y su detección

[← Índice](README.md) · Código: [src/hazards/](../src/hazards/), tabla `hazards` en
[supabase/schema.sql](../supabase/schema.sql)

## 1. Modelo

```ts
type HazardType = 'hueco' | 'policia' | 'alcabala';
interface Hazard {
  id: string; type: HazardType; lat: number; lon: number; createdAt: string;
  heading?: number;                       // rumbo al reportar: en el otro sentido no aplica
  source?: 'tap' | 'detected' | 'osm';    // osm: policías acostados de la maqueta, nunca se suben
  confirmed?: boolean;                    // el conductor dijo que fue un hueco
  confirmations?: number; lastSeen?: string;  // los pone la agrupación
}
```

`HazardStore` junta tres listas, en este orden de prioridad por id: los de **OSM** de la ruta actual,
los **compartidos** (Supabase, o su última copia en `ar-nav.shared`) y los **locales** de este teléfono
(`ar-nav.hazards`). `all()` los deduplica por id y los **agrupa** (abajo).

`alcabala` existe en el modelo, el esquema y las etiquetas, pero hoy no hay forma de reportarla.

## 2. Cómo entra un peligro

**Detección automática** (única vía hoy). Con *Detectar huecos y policías acostados* marcado (por
defecto), el acelerómetro reconoce el golpe y lo **guarda solo**, sin preguntar, como `detected` y sin
confirmar. Aparece 8 s el botón redondo de **confirmar hueco** (con un anillo de cuenta atrás): tocarlo
convierte esa detección en `hueco` confirmado. Una detección nueva redirige el botón y reinicia la cuenta.

**Botones de reporte**: ya no existen. Los botones *⚠ Hueco* / *Policía acostado* se quitaron del HTML el
25 oct (commit `e01902c`); el código que los atiende (`[data-report]` en `hazards/ui.ts`) sigue pero no
encuentra botones. Si vuelven, el punto se toma ~1,5 s atrás (se toca después de pasar).

**Policías acostados de OSM**: los `bump`, `hump` y `table` de las teselas de la ruta entran como
`policia` con `source: 'osm'` (`setOsmHazards`), con el sentido de la señal si lo tiene.

**Deshacer**: *Dock de calibración → Más → Deshacer reporte* quita el último reporte local y lo saca de
la cola de subida si todavía no salió.

## 3. Detector de golpes (`hazards/bump.ts`)

Heurística razonada (no ajustada con datos de campo todavía). `BumpWatcher` escucha `devicemotion`
(`accelerationIncludingGravity`, pide permiso en iOS) y alimenta `BumpDetector.feed(t, ax, ay, az, speed)`:

1. **Gravedad** estimada con un paso bajo de τ = 1 s. La aceleración menos la gravedad, proyectada sobre
   la gravedad, es el movimiento **vertical** con signo "arriba positivo" en Android y en iOS.
2. Un **evento** se abre cuando |v| ≥ 2,0 m/s² y se cierra cuando queda bajo 1,5 m/s² durante 120 ms, o al
   llegar a 600 ms (1 500 ms si va a menos de 12 m/s, porque un policía lento dura más).
3. Se registran el lóbulo hacia arriba y hacia abajo. El **contragolpe** es el lóbulo contrario al primero.
4. Es plausible si cumple una de dos formas:
   - **Golpe duro**: pico ≥ 5,5 m/s², velocidad ≥ 4 m/s (~14 km/h) y contragolpe ≥ 2,5 m/s².
   - **Movimiento suave**: velocidad entre 2,5 y 12 m/s (~43 km/h), duración ≥ 250 ms, pico ≥ 2,0 m/s² y
     contragolpe ≥ 1,2 m/s².
   Todo lo demás (ruido de la vía, pasos, asfalto rugoso, un golpe aislado sin rebote) se ignora.
5. **Tipo**: si el primer movimiento fue hacia abajo, `hueco`; hacia arriba, `policia`.
6. **Refractario** de 3 s entre eventos.

El punto se ubica donde estaba el carro hace `duración/2 + 120 ms` (de un rastro de 4 s de posiciones,
`trackPosition`), con el rumbo actual. Requiere el teléfono firme en el soporte. En Simulación se puede
probar sacudiendo el teléfono.

## 4. Agrupación (`hazards/cluster.ts`)

El mismo hueco se reporta muchas veces, cada una a unos metros (GPS, retraso del toque). Al leer la
lista (la app no puede editar filas de la base), los reportes se agrupan:

- **Grupos**: huecos y policías comparten grupo (el detector puede confundirlos); las alcabalas van aparte.
  Un reporte entra al primer grupo a ≤ 15 m (12 m para alcabalas) cuyo rumbo no difiera más de 60°.
  La posición del grupo es la **mediana** de sus miembros.
- **Pesos**: OSM 3 · toque o confirmado 1 · detección sin confirmar 0,5 · filas viejas sin `source` 1.
- **Tipo**: el de mayor peso sumado; un empate gana el reporte más nuevo.
- **Se muestra** solo con peso total ≥ 1: una detección sola sin confirmar se guarda pero no aparece.
- **Vence** a los 90 días del último reporte para huecos y a 1 año para policías; un policía de OSM no
  vence y fija la posición del grupo.
- Resultado: un `Hazard` por grupo con `confirmations` = cantidad de reportes y `lastSeen`.

## 5. Nube (Supabase) y cola sin conexión (`hazards/cloud.ts`)

- Sin `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`, `cloudEnabled = false` y todo queda local.
- **Subida**: cada reporte entra a una cola persistente (`ar-nav.outbox`) con `due = ahora + 60 s`
  (ventana para deshacer). `flush()` sube por `POST /rest/v1/hazards` lo vencido, en orden, y se detiene
  en el primer fallo (sin señal: el resto espera). Un 409 (ese `client_id` ya está) cuenta como subido.
  Se intenta al empezar el viaje, cada 20 s, al volver la conexión (`online`), al volver a la app y al
  **terminar** el viaje (forzado, sin esperar la ventana). `amend()` cambia una fila aún en cola sin
  alargar su ventana (confirmar hueco); `cancel()` la saca (deshacer).
- **Fila subida**: `client_id`, `type`, `lat`, `lon`, `heading`, `source`, `confirmed`.
- **Lectura**: al empezar cada viaje (y al abrir el mapa),
  `GET /rest/v1/hazards?select=…&order=created_at.desc&limit=5000` con 4 s de tiempo máximo; si falla,
  la última copia guardada.
- **Claves**: las anon viejas (JWT, `eyJ…`) van también en `Authorization: Bearer`; las nuevas
  `sb_publishable_…` solo en `apikey`.
- Permisos (RLS): cualquiera con la clave pública puede **leer y agregar**; nadie puede editar ni borrar
  desde la app. Ver [cuentas-supabase.md](cuentas-supabase.md#5-esquema-completo).

## 6. En la ruta

`indexOnRoute(all, route)` (al cambiar la ruta o los peligros): proyecta cada peligro sobre la ruta y
descarta los que están a ≥ 20 m de la línea o cuyo rumbo difiere más de 100° del de la ruta (están en el
otro canal). `hazardsAhead(list, along)` (por cuadro) devuelve los que están entre 8 m atrás y 220 m
adelante, más el más cercano entre 0 y 150 m (`nearest`, hoy sin uso en la interfaz).

## 7. Cómo se ven

- **AR y HUD**: cono rojo para huecos (y alcabalas), la joroba a rayas amarillas y negras cruzando el
  carril para policías acostados, anillos pulsantes, etiqueta de texto (oculta con la óptica del HUD).
  Ver [render-ar.md](render-ar.md#7-peligros-updatehazards).
- **Mapa**: círculos amarillos para huecos y barras rosadas para policías acostados (los reportados, y
  los de OSM de las teselas a la vista, que se cargan al acercarse desde zoom 14,5), cada barra girada
  para cruzar la calle (el sentido de la señal o el de la vía más cercana).

## 8. Pendiente

- Ajustar los umbrales del detector con un viaje real (falsos positivos en vías rotas).
- Detección por cámara (más fiable combinada con un golpe del acelerómetro).
- Cargar solo los peligros cerca de la ruta en vez de los últimos 5 000.
- La tabla `detections` y las columnas `confirmations`/`last_seen` del esquema ya no se escriben (eran
  del viejo "¿Qué fue eso?" y de una agrupación en la base).
- Sin aviso de texto de peligros cercanos desde que se quitó el banner.
