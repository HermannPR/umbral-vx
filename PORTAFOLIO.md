# Umbral en el portafolio

No hay un proyecto de portafolio en este Mac. El portafolio vive en el repo `best-works` (GitHub Pages; tarjetas en `assets/data.js`, destacados con captura en `assets/img/`). Abajo va la tarjeta lista para pegar, en el mismo formato que las tarjetas destacadas que ya tiene, más una versión en texto para el CV o el perfil.

Antes de pegar, cambia `TODO-usuario` y `TODO-enlace-al-video` (ver `PUBLICAR.md`).

## 1 · Tarjeta destacada para `best-works/assets/data.js`

Pégala como **primer** elemento de `window.PROJECTS` para que salga destacada. Copia `media/mosaico.jpg` como `assets/img/umbral.jpg` y sube el `?v=` de `index.html` (caché).

```js
  {
    id: "umbral",
    name: "Umbral",
    tagline: "A heavy-compute gallery: twelve real-time GPU simulations in the browser.",
    desc: "Twelve rooms, each a live WebGPU simulation with its own generative soundtrack: colliding galaxies (N-body), chaotic attractors with millions of points, Gray-Scott reaction–diffusion, Physarum, Navier–Stokes ink, a Lattice Boltzmann wind tunnel checked live against a physics-informed neural network, Mandelbulb raymarching and a progressive path tracer. On first load it benchmarks the GPU (FP32, bandwidth, a 1080p frame test) and picks a quality per room; a governor adapts it live. Falls back to WebGL2 when WebGPU is missing. No build step and no dependencies: hand-written WGSL and Web Audio.",
    stack: ["WebGPU", "WGSL", "WebGL2", "Web Audio", "JavaScript", "GPU compute", "Simulation"],
    accent: "#C8323C",
    demo: "screenshot",
    image: "assets/img/umbral.jpg",
    imageAlt: "Mosaic of Umbral's twelve rooms: galaxies, attractors, fluids, fractals and a path-traced scene",
    repo: "https://github.com/TODO-usuario/umbral",
    demoUrl: "https://TODO-usuario.github.io/umbral/"
  },
```

## 2 · Tarjeta en texto (CV, perfil de GitHub, LinkedIn)

**Umbral: galería de cómputo pesado**
*Doce simulaciones en tiempo real en la GPU, en el navegador, cada una con música generativa.*

- Escribí 12 simulaciones en WebGPU/WGSL sin librerías: N-cuerpos, atractores caóticos, reacción-difusión, Physarum, Navier–Stokes, Lattice Boltzmann contra una PINN, raymarching de fractales y trazado de caminos.
- Se adapta al equipo: mide la GPU en unos 3 s (FP32, ancho de banda y cuadro a 1080p), elige la calidad de cada sala y la ajusta en vivo con un gobernador. Tiene respaldo WebGL2 y una página amable cuando no hay GPU.
- El audio generativo con Web Audio sale de la propia simulación, por ejemplo una nota en cada cruce de la sección de Poincaré. A 60 fps en un Apple M5, las 12 salas en calidad máxima.

**Tecnología:** WebGPU · WGSL · WebGL2 · Web Audio · JavaScript (módulos ES, sin compilación)
**Enlaces:** [demo](https://TODO-usuario.github.io/umbral/) · [código](https://github.com/TODO-usuario/umbral) · [video](TODO-enlace-al-video)

English, one line: *Umbral: twelve real-time GPU simulations (WebGPU/WGSL) with generative audio, auto-tuned to the visitor's hardware.*

## 3 · Página de presentación opcional

`portafolio.html`, en esta carpeta, es una página única en negro y rojo #C8323C con el GIF, el mosaico, las 12 salas y los enlaces. Sirve para mandar un solo enlace o para pegarla como subpágina del portafolio (`best-works/umbral.html`). Lee las imágenes de `media/` y `capturas/`, así que funciona tal cual dentro de este repo en GitHub Pages: `https://TODO-usuario.github.io/umbral/portafolio.html`.
