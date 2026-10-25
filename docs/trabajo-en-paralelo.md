# Trabajo en paralelo (ronda del 25 oct 2026)

[← Índice](README.md)

El trabajo de esta ronda se dividió en seis sesiones, cada una en su rama de worktree cortada de
`cambios-juando` (a292172), que se integran en `cambios-juando`. Esta documentación describe el código
de `cambios-juando`; lo que cada sesión cambie se refleja aquí cuando se integra.

Estado al escribir esto (25 oct, ~09:00): **ninguna de las otras cinco sesiones se había integrado
todavía**; todas tenían cambios sin commit en sus ramas.

| # | Sesión | Qué hace | Informe | Estado |
|---|---|---|---|---|
| 1 | Login y onboarding | Pantallas de bienvenida, entrada a la cuenta y permisos al estilo de una app (sobre las cuentas de [cuentas-supabase.md](cuentas-supabase.md)). | — | En curso, sin integrar |
| 2 | Maqueta de todo Chacao | Teselas para todo el municipio Chacao, chequeos de calidad del script. Hoy hay dos zonas ([maqueta.md](maqueta.md#2-zonas-construidas-hoy)). | — | En curso, sin integrar |
| 3 | Pruebas de manejo y calibración | Pruebas de manejo y de calibración del HUD; ajustes a la guía y a la calibración automática. | `docs/pruebas-manejo.md` (al integrarse) | En curso, sin integrar |
| 4 | Pulitura del flujo | Bugs e incongruencias del flujo de la app. | `docs/pulitura.md` (al integrarse) | En curso, sin integrar |
| 5 | Fachadas reales (experimento) | Probar visuales reales de los edificios en la maqueta. | `experiments/fachadas/RESULTADOS.md` (al integrarse) | En curso, sin integrar |
| 6 | Documentación | Este `docs/` y el [SPEC.md](../SPEC.md). | — | Esta |

Lo que la documentación ya marca como pendiente y que estas sesiones podrían cambiar:
- La prueba en carro del HUD con medidas reales ([optica-hud.md](optica-hud.md#10-límites-conocidos)) y de
  la calibración automática ([calibracion.md](calibracion.md#5-límites)) → sesión 3.
- Los defectos de [limitaciones.md](limitaciones.md#2-defectos-y-restos-encontrados-en-el-código) → sesión 4.
- Las zonas de la maqueta → sesión 2.
