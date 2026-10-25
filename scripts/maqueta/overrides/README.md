# Correcciones manuales

Un archivo por tesela: `{x}_{y}.json`. Lo que pongas aquí gana sobre OSM y sobre las estimaciones cada vez que se regenere.

```json
{
  "buildings": { "10.51121,-66.85203": { "floors": 12 } },
  "signs": { "add": [{ "type": "stop", "lat": 10.5101, "lon": -66.8519 }], "remove": ["osm:n123"], "verify": ["osm:n456"] }
}
```

La clave de cada edificio es la latitud y longitud de su centro con 5 decimales. Es la misma que muestra el visor.
