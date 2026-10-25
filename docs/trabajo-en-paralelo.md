# Trabajo en paralelo (ronda del 25 oct 2026)

[← Índice](README.md)

El trabajo de esta ronda se dividió en seis sesiones, cada una en su rama de worktree cortada de
`cambios-juando` (a292172), que se integran en `cambios-juando`. Esta documentación describe el código
de `cambios-juando`; lo que cada sesión cambie se refleja aquí cuando se integra.

Estado de la última actualización de estos docs (25 oct): integrada la sesión 5 (fachadas); las otras
cuatro seguían en curso, con cambios sin commit en sus ramas.

| # | Sesión | Qué hace | Informe | Estado |
|---|---|---|---|---|
| 1 | Login y onboarding | Pantallas de bienvenida, entrada a la cuenta y permisos al estilo de una app (sobre las cuentas de [cuentas-supabase.md](cuentas-supabase.md)). | — | En curso, sin integrar |
| 2 | Maqueta de todo Chacao | Teselas para todo el municipio Chacao, chequeos de calidad del script. Hoy hay dos zonas ([maqueta.md](maqueta.md#2-zonas-construidas-hoy)). | — | En curso, sin integrar |
| 3 | Pruebas de manejo y calibración | Pruebas de manejo y de calibración del HUD; ajustes a la guía y a la calibración automática. | `docs/pruebas-manejo.md` (al integrarse) | En curso, sin integrar |
| 4 | Pulitura del flujo | Bugs e incongruencias del flujo de la app. | `docs/pulitura.md` (al integrarse) | En curso, sin integrar |
| 5 | Fachadas reales (experimento) | Comparó seis formas de darle aspecto real a los edificios de la maqueta en una página aparte (`npm run fachadas`), con licencias y costos. | [experiments/fachadas/RESULTADOS.md](../experiments/fachadas/RESULTADOS.md), [LICENCIAS.md](../experiments/fachadas/LICENCIAS.md) | **Integrada** (c2227fd) |
| 6 | Documentación | Este `docs/` y el [SPEC.md](../SPEC.md). | — | Esta |

## Fachadas: resultado

El experimento vive en `experiments/fachadas/` (Vite aparte, puerto 5190, sus propias dependencias; no
toca `src/` ni las teselas). Resumen de su recomendación:

1. **Ya**: fachadas **procedurales** (pisos, ventanas, planta baja por uso) en la pantalla Maqueta, con un
   shader sobre una sola malla: 0 bytes extra y +7 % por cuadro. 1–2 días.
2. **Más que la textura, la altura**: los edificios de Microsoft están todos en 9 m. Hay alturas abiertas
   para Caracas (Google Open Buildings 2.5D Temporal y 3D-GloBFP, CC BY 4.0) para traer en
   `scripts/maqueta/build.ts`. 2–3 días.
3. **Después**: techos con imagen satelital de OpenAerialMap horneada por zona (~0,2–0,3 MB), corrigiendo
   un corrimiento medido de 4,5–5,3 m. Licencia **CC BY-NC 4.0**: necesita que el equipo decida si la app
   seguirá siendo no comercial.
4. **Fachadas con fotos** solo con video propio grabado con GPS, calle por calle (~1 semana).
5. **Descartados**: Google Photorealistic 3D Tiles (sin 3D en Venezuela y sus términos prohíben hornear),
   Street View, Mapillary (sus términos prohíben la navegación en tiempo real), Esri, Mapbox, Azure, y la
   malla de OpenMVS tal cual (29 MB).

Nada de esto está en la app todavía; ver [maqueta.md](maqueta.md#8-pendiente).

## Pendientes que tocan estas sesiones

Lo que la documentación ya marca como pendiente y que estas sesiones podrían cambiar:
- La prueba en carro del HUD con medidas reales ([optica-hud.md](optica-hud.md#10-límites-conocidos)) y de
  la calibración automática ([calibracion.md](calibracion.md#5-límites)) → sesión 3.
- Los defectos de [limitaciones.md](limitaciones.md#2-defectos-y-restos-encontrados-en-el-código) → sesión 4.
- Las zonas de la maqueta → sesión 2.
