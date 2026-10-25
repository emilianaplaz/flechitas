# Experimento: fachadas reales en la maqueta

Página aparte para probar cómo darle a los edificios de la maqueta su aspecto real. Usa las teselas reales
de `public/maqueta/` y el video de `PRUEBA RENDER/`. No es parte de la app ni toca `src/`.

```bash
npm run fachadas
```

Después abre <http://localhost:5190>. Tiene sus propias dependencias (`three`, `3d-tiles-renderer`,
`vite`) en esta carpeta; el comando las instala la primera vez.

- Resultados, comparación y recomendación: [RESULTADOS.md](RESULTADOS.md)
- Licencias, costos y cobertura de cada fuente: [LICENCIAS.md](LICENCIAS.md)
- Claves opcionales (Google, Mapillary): copia `.env.example` a `.env.local`
- URL directa a un enfoque: `?modo=hoy|procedural|aerea|fotos|mapillary|google&vista=iso|pajaro|calle&tema=dark|light`
