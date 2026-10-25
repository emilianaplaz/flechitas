# Documentación técnica de MapZ / Vía AR

Navegación con flechas 3D sobre la calle real: en la cámara del teléfono o reflejadas en el parabrisas
desde un iPad, con huecos y policías acostados compartidos, una maqueta 3D de la zona para llegar a la
entrada exacta, y ubicación compartida en vivo. Hecho para Platanus Hack 26 (Caracas), track
Tres Dimensiones.

Esta carpeta es para quien entra al proyecto a programar. Qué hace el producto y con qué estado está en
[SPEC.md](../SPEC.md); cómo está hecho, aquí. Todo está verificado contra el código de la rama
`cambios-juando`.

## Por dónde empezar

1. [arquitectura.md](arquitectura.md): los dos roles (teléfono e iPad), las carpetas, el estado
   compartido, el bucle por cuadro, el ciclo de un viaje, los servicios externos y lo que se guarda en el equipo.
2. [desarrollo.md](desarrollo.md): instalar, correr en el teléfono por https, probar sin manejar, tests.
3. [interfaz.md](interfaz.md): las pantallas y los flujos, con los ids del HTML.
4. Después, el subsistema que vayas a tocar.

## Índice

| Página | De qué trata |
|---|---|
| [arquitectura.md](arquitectura.md) | Visión general, flujo de datos, ciclo de vida, `localStorage` |
| [modulos.md](modulos.md) | Cada archivo de `src/`, `api/` y `scripts/`: qué hace y su API |
| [interfaz.md](interfaz.md) | Pantallas, flujos y elementos de la interfaz |
| [navegacion.md](navegacion.md) | Destino (enlaces, geocodificación), rutas OSRM, fuentes de posición, seguimiento, recálculo, modo degradado |
| [render-ar.md](render-ar.md) | La escena Three.js: cámara virtual, cinta, maniobras, destino, peligros, señales, calle 3D, HUD de texto |
| [optica-hud.md](optica-hud.md) | La matemática del HUD del parabrisas: reflexión, cámara espejo, proyección fuera de eje, homografía del texto, preset Fortuner |
| [calibracion.md](calibracion.md) | Valores de calibración, perfiles, calibración manual y automática |
| [enlace-ipad.md](enlace-ipad.md) | Protocolo teléfono ↔ iPad sobre PeerJS/WebRTC |
| [maqueta.md](maqueta.md) | Teselas, script de construcción, fuentes, edificios, overrides, entradas y punto exacto |
| [peligros.md](peligros.md) | Huecos y policías acostados: detección por acelerómetro, agrupación, nube |
| [cuentas-supabase.md](cuentas-supabase.md) | Cuentas (Supabase Auth) y el esquema completo con sus permisos |
| [encontrar.md](encontrar.md) | Compartir la ubicación en vivo: protocolo, aprobación, marcador en la cámara |
| [lugares-guardados.md](lugares-guardados.md) | Lugares guardados y su sincronización con la cuenta |
| [pwa-despliegue.md](pwa-despliegue.md) | PWA, compartir desde Maps/Waze, `/api/expand`, Vercel, plataformas |
| [desarrollo.md](desarrollo.md) | Puesta en marcha, pruebas, tests, convenciones, ramas |
| [limitaciones.md](limitaciones.md) | Limitaciones, defectos encontrados en el código y diferencias con los documentos viejos |
| [glosario.md](glosario.md) | Términos del proyecto |
| [trabajo-en-paralelo.md](trabajo-en-paralelo.md) | Las sesiones de trabajo de esta ronda y su estado |

## Otros documentos del repo

| Documento | Estado |
|---|---|
| [SPEC.md](../SPEC.md) | Especificación del producto, actualizada con esta documentación. |
| [SETUP.md](../SETUP.md) | Guía rápida original en inglés. Algunas partes quedaron viejas (botones de reporte, "¿Qué fue eso?", Encontrar); ver [limitaciones.md §3](limitaciones.md#3-diferencias-con-los-documentos-anteriores). |
| [MAQUETA.md](../MAQUETA.md) | Plan por fases de la maqueta; el detalle actual está en [maqueta.md](maqueta.md). |
| [PLAN-HUD-AR.md](../PLAN-HUD-AR.md) | Plan original del HUD (iPad + iPhone). La óptica y el enlace se hicieron distinto (cálculo exacto, PeerJS). |
| [SPEC-3D-STREETS.md](../SPEC-3D-STREETS.md), [pipeline3d/README.md](../pipeline3d/README.md) | Calles 3D desde video (experimento, no conectado a la app). |
| [TODO.md](../TODO.md) | Lista de pendientes por módulo (algunos ítems viejos, ver limitaciones). |

## Estado por área

| Área | Estado |
|---|---|
| AR sobre la cámara (cinta, maniobras, destino, peligros, señales) | Hecho |
| HUD del parabrisas con óptica exacta en el iPad | Hecho; sin prueba en carro con medidas reales |
| Enlace teléfono ↔ iPad | Hecho |
| Calibración automática (FOV, inclinación, ladeo) | Hecho; sin validar en un viaje real |
| Maqueta (relieve, señales, límites, edificios, punto exacto, calle 3D en Simulación) | Hecho en Chacao (28 teselas, 11 zonas); faltan bordes |
| Peligros (detección automática, agrupación, nube) | Hecho; detector sin ajustar; sin reporte manual |
| Cuentas y lugares guardados sincronizados | Hecho (opcional); onboarding en curso |
| Encontrar (ubicación en vivo con aprobación) | Hecho |
| Caminar con sensores | Parcial: rutas de carro |
| Modo sin conexión | No |
