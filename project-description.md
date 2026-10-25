# Vía AR

Navegación paso a paso en realidad aumentada: la ruta se dibuja como gráficos 3D anclados a la calle, no como un mapa en una esquina de la pantalla.

## Qué hace

- **AR con cámara:** el teléfono en el parabrisas, en horizontal. Una cinta guía y chevrons sobre el asfalto, una flecha 3D en el próximo giro y conos rojos sobre huecos y alcabalas. Los policías acostados se dibujan como el bache mismo, con rayas amarillas y negras.
- **AR caminando:** levanta el teléfono hacia la calle; la ruta a pie sigue la brújula y el giroscopio.
- **HUD de parabrisas:** el teléfono plano sobre el tablero, sin video, y la imagen se refleja en el vidrio.
- **Cámara remota:** el teléfono es solo la cámara y una laptop o iPad muestra la vista AR, por ejemplo en un proyector. Se empareja con un código QR.
- **Reporte de peligros** con un toque mientras manejas, compartido en la nube.
- **Sin calibración manual:** el campo de visión, la inclinación y el giro del montaje se miden solos.

## Cómo está hecho

Una cámara virtual a la altura del teléfono, orientada según el rumbo de la ruta, dibuja la geometría de la vía con Three.js sobre el video real. Rutas con OSRM, mapa con MapLibre, emparejamiento con PeerJS (WebRTC) y peligros en Supabase. PWA en Vite y TypeScript que acepta enlaces compartidos desde Google Maps y Waze.

Pensado para ciudades con datos de mapas pobres y mal asfalto, como Caracas.
