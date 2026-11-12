// Nombre de la galería: se cambia aquí y en <title> de index.html (todo lo demás lo lee de MARCA).
export const MARCA = { nombre: 'UMBRAL VX', bajada: 'Visual eXperiments · tiempo real en tu navegador', video: 'media/umbral-vx-promo.mp4', autor: 'casiangel333 · HermannPR', repo: 'https://github.com/HermannPR/umbral-vx' };

// Catálogo del laboratorio: orden, nombres, textos, procedencia, color y firma de cada sala.
// El orden está pensado como recorrido: cuatro actos que alternan calma y energía, oscuridad y luz.

export const ACTOS = [
  { n: 'I', nombre: 'Cosmos y caos' },
  { n: 'II', nombre: 'Materia que se ordena' },
  { n: 'III', nombre: 'Flujos' },
  { n: 'IV', nombre: 'Forma, luz y señal' },
];

// firma: parámetros de un harmonógrafo (dos péndulos por eje con amortiguamiento).
// Cada sala tiene la suya; se dibuja en la antesala, en la portada y en la ficha.
export const SALAS = [
  {
    slug: 'colision', carga: 'pesada', requisitos: { mb: 512 }, mod: 'galaxy', acto: 0, nombre: 'Colisión',
    lema: 'Dos galaxias espirales se atraviesan. Ninguna estrella choca con otra: la gravedad de los núcleos lo reordena todo.',
    origen: 'Sala original · N-cuerpos con halos oscuros',
    acento: '#c8d3f0', firma: [2, 3.003, 3, 2, 0.0, 1.6, 0.4, 0.0, 0.0022],
  },
  {
    slug: 'atractores', carga: 'pesada', requisitos: { mb: 192 }, mod: 'atractores', acto: 0, nombre: 'Atractores',
    lema: 'Una regla de tres líneas. Millones de puntos que nunca repiten camino y nunca se escapan.',
    origen: 'Math Visual Lab · Lorenz y compañía',
    acento: '#e2b38a', firma: [1, 3.002, 2, 1, 1.2, 0.0, 0.0, 0.7, 0.0018],
  },
  {
    slug: 'pendulos', carga: 'media', requisitos: { mb: 64 }, mod: 'pendulos', acto: 0, nombre: 'Péndulos',
    lema: 'Miles de péndulos dobles que empiezan casi iguales. A los pocos segundos ya no se parecen en nada.',
    origen: 'Math Visual Lab · doble péndulo, mapa de fases y mapa estándar',
    acento: '#9cc7b4', firma: [3, 2.004, 1, 3, 0.3, 0.0, 1.1, 0.0, 0.0026],
  },
  {
    slug: 'chladni', carga: 'ligera', requisitos: { mb: 48 }, mod: 'chladni', acto: 1, nombre: 'Chladni',
    lema: 'Arena sobre una placa que suena. Se queda quieta donde la placa no se mueve: las líneas nodales.',
    origen: 'Math Visual Lab · figuras de Chladni; voz de spectre-daw',
    acento: '#d9c49a', firma: [4, 5.002, 5, 4, 0.0, 0.0, 1.57, 0.0, 0.0016],
  },
  {
    slug: 'morfogenesis', carga: 'pesada', requisitos: { mb: 64 }, mod: 'reaction', acto: 1, nombre: 'Morfogénesis',
    lema: 'Dos sustancias se difunden y reaccionan. Así propuso Turing las manchas del leopardo.',
    origen: 'Sala original · reacción-difusión de Gray-Scott',
    acento: '#e59a86', firma: [5, 4.003, 3, 5, 0.9, 0.2, 0.0, 0.0, 0.002],
  },
  {
    slug: 'plasmodio', carga: 'pesada', requisitos: { mb: 128 }, mod: 'physarum', acto: 1, nombre: 'Plasmodio',
    lema: 'Agentes ciegos que siguen su propio rastro. La red aparece sin que nadie la dibuje.',
    origen: 'Sala original · Physarum polycephalum',
    acento: '#c6d98c', firma: [2, 5.004, 5, 3, 0.0, 0.5, 0.0, 1.0, 0.0021],
  },
  {
    slug: 'tinta', carga: 'media', requisitos: { mb: 64 }, mod: 'fluid', acto: 2, nombre: 'Tinta',
    lema: 'Navier–Stokes incompresible. La tinta solo viaja con el agua, y el agua solo sabe girar.',
    origen: 'Sala original · fluido estable de Stam con vorticidad',
    acento: '#8fb8de', firma: [1, 2.003, 2, 3, 0.0, 0.8, 1.6, 0.0, 0.0015],
  },
  {
    slug: 'viento', carga: 'media', requisitos: { mb: 64 }, mod: 'viento', acto: 2, nombre: 'Viento urbano',
    lema: 'Viento del oeste entre los edificios de una ciudad sintética. Lattice Boltzmann en vivo; la red neuronal lo reconstruye con 250 sensores.',
    origen: 'wind-pinn / pinn-zonatec · LBM D2Q9 + PINN',
    acento: '#e8743b', firma: [3, 4.002, 4, 3, 0.0, 0.3, 0.0, 1.2, 0.0019],
  },
  {
    slug: 'bulbo', carga: 'extrema', requisitos: { mb: 32 }, mod: 'fractal', acto: 3, nombre: 'Bulbo',
    lema: 'Mandelbulb y Mandelbox: una fórmula iterada, recorrida rayo por rayo.',
    origen: 'Sala original · raymarching de funciones de distancia',
    acento: '#e9c77b', firma: [5, 3.001, 2, 5, 0.0, 0.0, 0.6, 1.2, 0.0017],
  },
  {
    slug: 'luz', carga: 'extrema', requisitos: { mb: 64 }, mod: 'pathtracer', acto: 3, nombre: 'Luz',
    lema: 'Cada píxel promedia rebotes de luz al azar. El ruido es la pregunta; la imagen quieta, la respuesta.',
    origen: 'Sala original · trazado de caminos progresivo',
    acento: '#f1d7b8', firma: [1, 1.004, 3, 2, 0.0, 1.57, 0.0, 0.0, 0.0012],
  },
  {
    slug: 'senal', carga: 'media', requisitos: { mb: 64 }, mod: 'senal', acto: 3, nombre: 'Señal',
    lema: 'Un sintetizador de video que se escribe como código: fuente, transformaciones, color y eco. Lo mueve el ritmo.',
    origen: 'homenaje a Hydra (Olivia Jack) · secuenciador de spectre-daw',
    acento: '#e0553a', firma: [6, 4.001, 4, 6, 0.0, 0.9, 0.3, 0.0, 0.0014],
  },
  {
    slug: 'ensamble', carga: 'extrema', requisitos: { mb: 256 }, mod: 'remix', acto: 3, nombre: 'Ensamble',
    lema: 'Un fractal, un fluido y dos millones de partículas, acoplados en el mismo cuadro.',
    origen: 'Sala original · tres simulaciones a la vez',
    acento: '#d6c08f', firma: [4, 3.002, 2, 5, 0.5, 0.0, 0.0, 0.9, 0.0023],
  },
];
// Salas privadas (`privada: true`): se quitan del catálogo con ?publico, y la exportación pública ni siquiera las incluye.
export const PUBLICO = typeof location !== 'undefined' && new URLSearchParams(location.search).has('publico');
if (PUBLICO) for (let i = SALAS.length - 1; i >= 0; i--) if (SALAS[i].privada) SALAS.splice(i, 1);

export const num = (i) => String(i + 1).padStart(2, '0');

// Puntos del harmonógrafo normalizados a [-1, 1].
export function firmaPuntos(f, n = 2400, T = 220) {
  const [f1, f2, f3, f4, p1, p2, p3, p4, d] = f;
  const pts = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * T, e = Math.exp(-d * t * 6);
    pts[i * 2] = (Math.sin(f1 * t * 0.1 + p1) * 0.55 + Math.sin(f2 * t * 0.1 + p2) * 0.45) * e;
    pts[i * 2 + 1] = (Math.sin(f3 * t * 0.1 + p3) * 0.55 + Math.sin(f4 * t * 0.1 + p4) * 0.45) * e;
  }
  return pts;
}

// Dibuja la firma en un canvas 2D. progreso ∈ [0,1] permite animar el trazo.
export function dibujarFirma(g, f, { x, y, r, color, ancho = 1, alfa = 1, progreso = 1, n = 2400 }) {
  const pts = firmaPuntos(f, n);
  const m = Math.max(2, Math.floor(n * progreso));
  g.save();
  g.globalAlpha = alfa; g.strokeStyle = color; g.lineWidth = ancho; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i < m; i++) {
    const px = x + pts[i * 2] * r, py = y + pts[i * 2 + 1] * r;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.stroke();
  g.restore();
}

// Versión SVG (para la ficha): un path compacto.
export function firmaSVG(f, size = 40, color = 'currentColor', n = 900) {
  const pts = firmaPuntos(f, n);
  const h = size / 2, r = h * 0.92;
  let d = '';
  for (let i = 0; i < n; i++) d += (i ? 'L' : 'M') + (h + pts[i * 2] * r).toFixed(1) + ' ' + (h + pts[i * 2 + 1] * r).toFixed(1);
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="0.6" stroke-linejoin="round"/></svg>`;
}
