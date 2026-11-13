// Sala «Señal»: un sintetizador de video encadenable, en homenaje al lenguaje de Hydra (Olivia Jack).
// Implementación propia (Hydra es AGPL; aquí no hay código suyo): un sombreador «uber» que interpreta un
// parche — una fuente, transformaciones de coordenadas, operaciones de color y retroalimentación —.
// La música sale de la máquina de estilos de sonido.js (brostep 2010, synthwave, hyperpop, ambient, techno),
// y la imagen lee su misma línea de tiempo: bombos, cajas, el filtro del bajo y los drops, en el instante
// que se oye. Encima, un osciloscopio con la onda real de la mezcla y chispas que estallan en el drop.
// Calidad adaptativa: si el cuadro se pasa de presupuesto, baja la resolución interna (sin realojar:
// se dibuja en una parte de la textura) y el número de chispas, con suavidad; el HUD muestra el nivel real.
// Con tu canción, el color puede seguir la tonalidad (rueda de quintas) o girar en cada drop o compás, las
// escenas cambian solas (en cada drop, por sección o cada 8/16 compases) fundiéndose por la retroalimentación,
// y hay efectos de composición: líneas de barrido, zoom radial, espejo de pantalla, datamosh y estrobo.
import { makeShader, U } from '../gpu.js';
import { FS_VERT } from '../util.js';
import { SENAL_ESTILOS } from '../sonido.js';
import { Catalogo, NOMBRE_COL } from '../motores/catalogo.js';
import { Oido } from '../motores/oido.js';
import { PRESETS_UMBRAL } from '../motores/presets-umbral.js';

const FUENTES = { osc: 0, noise: 1, voronoi: 2, shape: 3, anillos: 4, rayos: 5, tablero: 6 };
const GEO = { rotate: 1, scale: 2, kaleid: 3, scroll: 4, pixelate: 5, repeat: 6, modulate: 7, modulateRotate: 8, modulateScale: 9, espejo: 10, tunel: 11, ondas: 12, esfera: 13 };
const COL = { posterize: 1, thresh: 2, contrast: 3, invert: 4, brillo: 5, solarizar: 6, bandas: 7 };
const ENTEROS = new Set(['kaleid', 'posterize', 'shape', 'repeat', 'espejo', 'bandas', 'rayos', 'tablero']);
const DUOS = [
  { nombre: 'Tinta y cobre', c: [[0.018, 0.016, 0.013], [0.5, 0.22, 0.09], [0.96, 0.89, 0.76]] },
  { nombre: 'Cianotipia', c: [[0.008, 0.02, 0.06], [0.07, 0.22, 0.52], [0.86, 0.92, 1.0]] },
  { nombre: 'Grafito y bermellón', c: [[0.016, 0.016, 0.016], [0.72, 0.13, 0.06], [0.93, 0.91, 0.87]] },
  { nombre: 'Verdín', c: [[0.012, 0.026, 0.024], [0.13, 0.42, 0.36], [0.92, 0.93, 0.83]] },
  { nombre: 'Fósforo', c: [[0.012, 0.016, 0.01], [0.3, 0.55, 0.16], [0.9, 0.96, 0.78]] },
  { nombre: 'Rosa mexicano', c: [[0.02, 0.008, 0.016], [0.74, 0.1, 0.4], [0.98, 0.9, 0.92]] },
];
// parches: fuente, cadena de geometría, cadena de color, retroalimentación [cantidad, zoom, giro], dúo, cromaticidad
const PARCHES = [
  { nombre: 'Marea', fuente: ['osc', 10, 0.06, 0.9], geo: [['kaleid', 5], ['rotate', 0, 0.04], ['modulate', 0.22, { src: 'noise', f: 2.4 }, 0.35]],
    col: [['contrast', 1.3]], fb: [0.86, 1.012, 0.004], croma: 0.08 },
  { nombre: 'Celdas', fuente: ['voronoi', 7, 0.35, 0.25], geo: [['modulateScale', 0.6, { src: 'osc', f: 3 }, 0.5], ['rotate', 0.3, -0.02]],
    col: [['posterize', 5, 0.8], ['contrast', 1.2]], fb: [0.6, 1.0, 0], croma: 0.05 },
  { nombre: 'Retícula', fuente: ['shape', 4, 0.32, 0.02], geo: [['repeat', 5, 3], ['rotate', 0.785, 0.03], ['modulate', 0.06, { src: 'osc', f: 18 }, 0.25]],
    col: [['contrast', 1.5]], fb: [0.8, 0.995, -0.003], croma: 0.0 },
  { nombre: 'Humo', fuente: ['noise', 2.2, 0.12], geo: [['modulateRotate', 1.2, { src: 'osc', f: 2 }, 0.6], ['scale', 1.2]],
    col: [['contrast', 1.6], ['posterize', 8, 1]], fb: [0.93, 1.006, 0.008], croma: 0.06 },
  { nombre: 'Prisma', fuente: ['osc', 36, 0.12, 0.0], geo: [['rotate', 0.6, 0], ['kaleid', 3], ['modulate', 0.3, { src: 'voronoi', f: 4 }, 0.4], ['pixelate', 64]],
    col: [['contrast', 1.1]], fb: [0.7, 1.0, 0], croma: 0.12 },
  { nombre: 'Túnel', fuente: ['tablero', 6, 0.0], geo: [['rotate', 0, 0.05], ['tunel', 0.45, 0.35], ['ondas', 0.02, 5, 1.5]],
    col: [['contrast', 1.35]], fb: [0.62, 1.0, 0], croma: 0.04 },
  { nombre: 'Sol negro', fuente: ['rayos', 12, 0.05, 0.6], geo: [['esfera', 0.6], ['kaleid', 6], ['modulateRotate', 0.5, { src: 'noise', f: 2 }, 0.4]],
    col: [['contrast', 1.5], ['solarizar', 1.4]], fb: [0.82, 1.01, 0.006], croma: 0.05 },
  { nombre: 'Topografía', fuente: ['noise', 1.8, 0.08], geo: [['modulate', 0.3, { src: 'noise', f: 1.2 }, 0.3], ['scale', 1.1]],
    col: [['bandas', 9], ['contrast', 1.25]], fb: [0.55, 1.0, 0], croma: 0.03 },
  { nombre: 'Espejo', fuente: ['voronoi', 5, 0.5, 0.6], geo: [['espejo', 2], ['ondas', 0.08, 6, 1.2], ['rotate', 0, 0.015]],
    col: [['contrast', 1.3], ['posterize', 6, 1]], fb: [0.75, 1.004, 0.002], croma: 0.06 },
  { nombre: 'Vórtice', fuente: ['osc', 14, 0.1, 0.6], geo: [['tunel', 0.3, 0.12], ['modulateRotate', 0.8, { src: 'osc', f: 2 }, 0.5], ['kaleid', 4]],
    col: [['contrast', 1.2]], fb: [0.88, 0.99, 0.01], croma: 0.1 },
  { nombre: 'Cristal', fuente: ['shape', 6, 0.3, 0.05], geo: [['kaleid', 6], ['esfera', -0.35], ['repeat', 3, 3], ['rotate', 0.2, 0.05]],
    col: [['solarizar', 2], ['contrast', 1.4]], fb: [0.85, 1.015, -0.004], croma: 0.06 },
  { nombre: 'Ondas', fuente: ['anillos', 6, 0.4, 2], geo: [['ondas', 0.12, 4, 0.8], ['modulate', 0.15, { src: 'noise', f: 3 }, 0.5]],
    col: [['contrast', 1.5]], fb: [0.8, 1.008, 0], croma: 0.08 },
  { nombre: 'Latido', fuente: ['anillos', 10, 1.0, 4], geo: [['esfera', 0.8], ['pixelate', 90]],
    col: [['thresh', 0.5, 0.06]], fb: [0.9, 1.02, 0], croma: 0.0 },
];
// opciones del panel
const COLOR = ['fijas', 'tonalidad', 'cada drop', 'cada compás', 'arcoíris'];
const ESCENAS = ['manual', 'en cada drop', 'por sección', 'cada 8 compases', 'cada 16 compases'];
const ESPEJO = ['no', 'horizontal', 'cuatro'];
const FX_BASE = { color: 'tonalidad', escenas: 'manual', osciloscopio: true, capas: true, barrido: 0, zoom: 0.5, espejo: 'no', mosh: 0, estrobo: false };
const CLAVE_FX = 'umbral.senal';
const TAU = Math.PI * 2;
// el osciloscopio y las chispas cambian con cada preset (semilla = su id) y leen su imagen
const FORMAS = ['línea', 'vertical', 'círculo', 'espejo'];
const azarDe = (txt) => {
  let a = 2166136261; for (const ch of String(txt)) { a ^= ch.charCodeAt(0); a = Math.imul(a, 16777619); }
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};
function capasDe(e) {
  const r = azarDe(e ? e.id : 'senal/0');
  // MilkDrop ya dibuja su propia onda: la nuestra va tenue para no duplicarla
  return { forma: Math.floor(r() * FORMAS.length), radio: 0.2 + r() * 0.16, mezcla: 0.6 + r() * 0.35, flujo: 0.4 + r() * 0.9, origen: r() < 0.65 ? 1 : 0, scope: e && e.m === 'md' ? 0.4 : 1 };
}
// gira el matiz conservando la luminancia (rotación en el plano I-Q de YIQ)
const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function girar(c, a) {
  if (!a) return c;
  const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], i = 0.596 * c[0] - 0.274 * c[1] - 0.322 * c[2], q = 0.211 * c[0] - 0.523 * c[1] + 0.312 * c[2];
  const ca = Math.cos(a), sa = Math.sin(a), i2 = i * ca - q * sa, q2 = i * sa + q * ca;
  return [Math.max(0, y + 0.956 * i2 + 0.621 * q2), Math.max(0, y - 0.272 * i2 - 0.647 * q2), Math.max(0, y - 1.106 * i2 + 1.703 * q2)];
}
// cómo se ve cada estilo: su parche, sus tintas y cuánto golpea cada efecto
const VISTA = [
  { parche: 2, duo: 2, golpe: 1.0, glitch: 1.0, croma: 1.0, destello: 1.0, chispas: 1.0, tor: 1.0, inv: true },   // brostep 2010
  { parche: 0, duo: 1, golpe: 0.6, glitch: 0.2, croma: 0.6, destello: 0.55, chispas: 0.55, tor: 0.4, inv: false }, // synthwave
  { parche: 1, duo: 5, golpe: 0.9, glitch: 0.8, croma: 1.3, destello: 0.9, chispas: 1.0, tor: 0.7, inv: true },    // hyperpop
  { parche: 3, duo: 3, golpe: 0.25, glitch: 0.0, croma: 0.3, destello: 0.3, chispas: 0.35, tor: 0.5, inv: false }, // ambient
  { parche: 4, duo: 4, golpe: 0.8, glitch: 0.5, croma: 0.7, destello: 0.7, chispas: 0.7, tor: 0.8, inv: true },    // techno
];
const SEC_NOMBRE = { intro: 'intro', subida: 'subida', drop: 'drop', pausa: 'pausa' };

const SH = FS_VERT + /* wgsl */`
struct Op { a: vec4f, b: vec4f };   // a: id, p1, p2, p3 · b: p4, fuente2, frecuencia2, reacción
struct Uni {
  r: vec4f,    // ancho y alto internos, t, nº geo
  s: vec4f,    // fuente, p1, p2, p3
  s2: vec4f,   // nº color, cromaticidad, retro cantidad, retro zoom
  fb: vec4f,   // retro giro, pulso, medios, agudos
  d0: vec4f, d1: vec4f, d2: vec4f,
  ex: vec4f,   // golpe del bombo, torsión del bajo, subida, drop
  vp: vec4f,   // fracción del cuadro anterior (x, y), sacudida (x, y)
  fx: vec4f,   // datamosh, _, _, _
  geo: array<Op, 6>,
  col: array<vec4f, 6>,
};
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var previo: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
const TAU = 6.2831853;

fn h2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn h22(p: vec2f) -> vec2f { return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2f(1.0, 0.0)), w.x), mix(h2(i + vec2f(0.0, 1.0)), h2(i + vec2f(1.0, 1.0)), w.x), w.y);
}
fn fbm(p: vec2f) -> f32 { return vnoise(p) * 0.55 + vnoise(p * 2.03 + 7.1) * 0.3 + vnoise(p * 4.1 + 3.3) * 0.15; }
fn rot(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn espejo(x: vec2f) -> vec2f { return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0); }

fn fuente(id: f32, p: vec2f, a: f32, b: f32, c: f32) -> vec3f {
  let t = u.r.z;
  if (id < 0.5) {            // osc: franjas con desfase por canal
    let x = p.x * a + t * b;
    return vec3f(sin(x * TAU), sin(x * TAU + c), sin(x * TAU + 2.0 * c)) * 0.5 + 0.5;
  }
  if (id < 1.5) {            // ruido fractal
    let n = fbm(p * a + vec2f(t * b, -t * b * 0.7));
    return vec3f(n, fbm(p * a * 1.01 + 9.0 + t * b), fbm(p * a * 0.99 + 21.0 - t * b));
  }
  if (id < 2.5) {            // voronoi animado
    let q = p * a; let i = floor(q);
    var d1 = 9.0; var d2 = 9.0;
    for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
      let g = i + vec2f(f32(x), f32(y));
      let o = 0.5 + 0.5 * sin(t * b + TAU * h22(g));
      let d = length(g + o - q);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    } }
    let v = mix(d1, d2 - d1, c);
    return vec3f(v, v * 0.9, v * 0.8);
  }
  if (id < 3.5) {            // shape: polígono regular de a lados, radio b, suavizado c
    let ang = atan2(p.x, p.y) + 3.14159265;
    let r = TAU / max(3.0, a);
    let d = cos(floor(0.5 + ang / r) * r - ang) * length(p);
    return vec3f(1.0 - smoothstep(b, b + c + 0.001, d));
  }
  if (id < 4.5) {            // anillos: frecuencia a, velocidad b, filo c
    let v = 0.5 + 0.5 * sin((length(p) * a - t * b) * TAU);
    let w = pow(v, max(0.2, c));
    return vec3f(w, w * 0.92 + 0.04, w * 0.85 + 0.08);
  }
  if (id < 5.5) {            // rayos: a rayos, velocidad b, espiral c
    let v = 0.5 + 0.5 * sin(atan2(p.y, p.x) * floor(max(1.0, a)) + length(p) * c * TAU - t * b * TAU);
    return vec3f(v, v * v, sqrt(v));
  }
  // tablero: a casillas, desplazamiento b
  let q = floor(p * a + vec2f(t * b, 0.0));
  let v = abs(q.x + q.y) % 2.0;
  return vec3f(v);
}
fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let res = u.r.xy;
  var p = (i.pos.xy - 0.5 * res) / res.y;
  let t = u.r.z;
  let pulso = u.fb.y;
  let golpe = u.ex.x; let tor = u.ex.y; let sub = u.ex.z; let drop = u.ex.w;
  // empujón de cámara en cada bombo (y uno grande en el drop) más la sacudida de la subida
  p = p * (1.0 - golpe * 0.16 - drop * 0.25) + u.vp.zw;
  // torsión: el filtro del bajo (el wobble) dobla el espacio al mismo ritmo
  p += tor * vec2f(sin(p.y * 8.0 + t * 2.1), sin(p.x * 6.5 - t * 1.7)) * 0.07;
  for (var k = 0; k < i32(u.r.w); k++) {
    let o = u.geo[k];
    let id = o.a.x; let p1 = o.a.y + pulso * o.b.w;
    if (id < 1.5) { p = rot(p1 + t * o.a.z) * p; }
    else if (id < 2.5) { p = p / max(0.05, p1); }
    else if (id < 3.5) {
      let n = max(1.0, floor(p1));
      var a = atan2(p.y, p.x); let s = TAU / n;
      a = a - s * floor(a / s); a = abs(a - s * 0.5);
      p = vec2f(cos(a), sin(a)) * length(p);
    }
    else if (id < 4.5) { p += vec2f(p1 + t * o.a.w, o.a.z + t * o.b.x); }
    else if (id < 5.5) { p = floor(p * p1) / p1; }
    else if (id < 6.5) { p = fract(p * vec2f(p1, o.a.z) + 0.5) - 0.5; }
    else if (id < 9.5) {
      let m = fuente(o.b.y, p, o.b.z, 0.1, 0.5);
      if (id < 7.5) { p += (m.xy - 0.5) * p1; }
      else if (id < 8.5) { p = rot((m.x - 0.5) * p1) * p; }
      else { p *= 1.0 + (m.x - 0.5) * p1; }
    }
    else if (id < 10.5) { if (p1 < 1.5) { p.x = abs(p.x); } else { p = abs(p); } }
    else if (id < 11.5) {      // túnel: coordenadas polares, profundidad p1, avance p2 (la subida acelera)
      let r = length(p);
      p = vec2f(atan2(p.y, p.x) / 3.14159265, p1 / (r + 0.03) + t * (o.a.z + sub * 0.8));
    }
    else if (id < 12.5) {      // ondas: amplitud p1 (los medios la doblan), frecuencia p2, velocidad p3
      let amp = p1 * (1.0 + tor * 3.0);
      p += amp * vec2f(sin(p.y * o.a.z + t * o.a.w), sin(p.x * o.a.z * 1.13 - t * o.a.w));
    }
    else {                     // esfera: abombado (p1 > 0) o pellizco (p1 < 0); el bombo lo infla
      let r2 = dot(p, p);
      p = p * (1.0 + (p1 + golpe * 0.5) * r2) / (1.0 + max(0.0, p1) * 0.25);
    }
  }
  var c = fuente(u.s.x, p, u.s.y, u.s.z, u.s.w);
  for (var k = 0; k < i32(u.s2.x); k++) {
    let o = u.col[k];
    if (o.x < 1.5) { c = floor(pow(c, vec3f(o.z)) * o.y) / o.y; }
    else if (o.x < 2.5) { c = vec3f(smoothstep(o.y - o.z, o.y + o.z, lum(c))); }
    else if (o.x < 3.5) { c = (c - 0.5) * o.y + 0.5; }
    else if (o.x < 4.5) { c = mix(c, 1.0 - c, o.y); }
    else if (o.x < 5.5) { c += o.y; }
    else if (o.x < 6.5) { c = 0.5 - 0.5 * cos(c * TAU * o.y * 0.5); }
    else {                     // bandas: curvas de nivel de la luminancia
      let b = abs(fract(lum(c) * o.y) * 2.0 - 1.0);
      c = vec3f(lum(c) * 0.35 + 0.65 * smoothstep(0.78, 0.97, b));
    }
  }
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  // dirección de arte: tres tintas según la luminancia, con un hilo de color original
  let l = pow(lum(c), 1.45);
  var duo = select(mix(u.d1.rgb, u.d2.rgb, (l - 0.5) * 2.0), mix(u.d0.rgb, u.d1.rgb, l * 2.0), l < 0.5);
  duo = mix(duo, c * (u.d1.rgb + u.d2.rgb) * 0.6, u.s2.y);
  // retroalimentación: el cuadro anterior con zoom y giro; la subida lo convierte en túnel
  let q = i.pos.xy / res - 0.5;
  let qa = vec2f(q.x * res.x / res.y, q.y);
  let zoom = u.s2.w + sub * 0.035 + golpe * 0.02;
  var qf = rot(u.fb.x + drop * 0.04) * qa / zoom;
  qf = vec2f(qf.x * res.y / res.x, qf.y) + 0.5;
  // datamosh: el cuadro anterior se arrastra por bloques con vectores al azar que cambian a saltos
  let mosh = u.fx.x;
  if (mosh > 0.001) {
    let bq = floor(qa * 9.0 + 37.0);
    qf += (h22(bq + floor(t * 7.0)) - 0.5) * mosh * 0.05 * step(0.35, h2(bq * 1.7 + floor(t * 3.0)));
  }
  let uvp = clamp(espejo(qf), vec2f(0.002), vec2f(0.998)) * u.vp.xy;
  let prev = textureSampleLevel(previo, smp, uvp, 0.0).rgb;
  return vec4f(max(duo, prev * max(u.s2.z, mosh * 0.9)), 1.0);
}
`;

// composición a resolución completa: lo barato va aquí (aberración, cortes, destello, osciloscopio)
const COMP = FS_VERT + /* wgsl */`
struct CU {
  a: vec4f,  // ancho, alto de salida, fracción interna x, y
  b: vec4f,  // t, golpe, caja, drop
  c: vec4f,  // destello, inversión, croma, cortes
  d: vec4f,  // tinta clara rgb, amplitud del osciloscopio
  e: vec4f,  // bombeo, apagón (hueco antes del drop), grosor de línea (px), giro de matiz (presets de otros motores)
  f: vec4f,  // barrido (líneas), zoom radial, espejo (0 no, 1 horizontal, 2 cuatro), _
  g: vec4f,  // fracción de la fuente anterior (x, y), mezcla (1 = solo la nueva), _
  h: vec4f,  // forma del osciloscopio (0 línea, 1 vertical, 2 círculo, 3 espejo), radio, color de la imagen (0..1), intensidad
  onda: array<vec4f, 64>,
};
@group(0) @binding(0) var<uniform> cu: CU;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var src2: texture_2d<f32>;
@group(0) @binding(4) var<storage, read> dom: array<vec4f>;   // color dominante del preset: tono puro, fuerza
// la fuente de ahora (parche, GLSL, ISF, MilkDrop o fosfora) y, mientras se funden, la anterior
fn tomar(uv: vec2f) -> vec3f {
  let a = textureSampleLevel(src, smp, uv * cu.a.zw, 0.0).rgb;
  if (cu.g.z >= 0.999) { return a; }
  return mix(textureSampleLevel(src2, smp, uv * cu.g.xy, 0.0).rgb, a, cu.g.z);
}
// gira el matiz conservando la luminancia (YIQ), como girar() en JS
fn matiz(c: vec3f, a: f32) -> vec3f {
  let y = dot(c, vec3f(0.299, 0.587, 0.114)); let i0 = dot(c, vec3f(0.596, -0.274, -0.322)); let q0 = dot(c, vec3f(0.211, -0.523, 0.312));
  let ca = cos(a); let sa = sin(a); let i2 = i0 * ca - q0 * sa; let q2 = i0 * sa + q0 * ca;
  return max(vec3f(0.0), vec3f(y + 0.956 * i2 + 0.621 * q2, y - 0.272 * i2 - 0.647 * q2, y - 1.106 * i2 + 1.703 * q2));
}
fn h1(x: f32) -> f32 { return fract(sin(x * 91.345) * 47453.5453); }
// el tono puro de la imagen (croma) con el brillo de la tinta; en zonas grises se queda la tinta
fn tonoDe(c: vec3f, base: vec3f, k: f32) -> vec3f {
  let mx = max(max(c.r, c.g), c.b); let mn = min(min(c.r, c.g), c.b); let cr = mx - mn;
  let puro = (c - vec3f(mn)) / max(cr, 1e-3);
  return mix(base, puro * max(max(base.r, base.g), base.b), k * smoothstep(0.04, 0.2, cr));
}
fn ondaEn(x: f32) -> f32 {
  let f = clamp(x, 0.0, 1.0) * 255.0; let i = u32(floor(f)); let j = min(i + 1u, 255u);
  return mix(cu.onda[i >> 2u][i & 3u], cu.onda[j >> 2u][j & 3u], fract(f));
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let res = cu.a.xy; var uv = i.pos.xy / res; let t = cu.b.x;
  // cortes: bandas horizontales que se corren tras la caja y en el drop
  let g = cu.c.w;
  if (g > 0.01) {
    let fr = floor(t * 24.0);
    let banda = floor(uv.y * 18.0 + fr * 3.0);
    if (h1(banda + fr * 7.0) < g * 0.55) { uv.x += (h1(banda * 3.7 + fr) - 0.5) * g * 0.16; }
  }
  // espejo de pantalla: la mitad izquierda (o el cuarto superior izquierdo) se refleja
  if (cu.f.z > 0.5) { uv.x = 0.5 - abs(uv.x - 0.5); if (cu.f.z > 1.5) { uv.y = 0.5 - abs(uv.y - 0.5); } }
  uv = (uv - 0.5) * (1.0 - cu.b.y * 0.03 - cu.b.w * 0.07) + 0.5;
  let dir = uv - 0.5; let cr = cu.c.z;
  let lo = vec2f(0.001); let hi = vec2f(0.999);
  let r = tomar(clamp(uv + dir * cr, lo, hi)).r;
  let gg = tomar(clamp(uv, lo, hi)).g;
  let b = tomar(clamp(uv - dir * cr, lo, hi)).b;
  var c = vec3f(r, gg, b);
  // zoom radial: estela hacia el centro en los golpes y el drop
  let zb = cu.f.y;
  if (zb > 0.002) {
    for (var k = 1; k <= 6; k++) {
      let uk = dir * (1.0 - zb * f32(k) / 6.0) + 0.5;
      c += tomar(clamp(uk, lo, hi));
    }
    c /= 7.0;
  }
  if (abs(cu.e.w) > 0.001) { c = matiz(c, cu.e.w); }
  c *= cu.e.x * (1.0 - cu.e.y * 0.88);
  // osciloscopio: la onda real de la mezcla; su forma la elige el preset
  let amp = cu.d.w;
  if (amp > 0.0005) {
    let fm = cu.h.x; let q = i.pos.xy / res; var dpx: f32;
    if (fm < 0.5) { dpx = abs(q.y - 0.5 - ondaEn(q.x) * amp) * res.y; }
    else if (fm < 1.5) { dpx = abs(q.x - 0.5 - ondaEn(q.y) * amp * res.y / res.x) * res.x; }
    else if (fm < 2.5) {
      let pc = (i.pos.xy - 0.5 * res) / res.y; let ang = atan2(pc.y, pc.x) / 6.2831853 + 0.5;
      dpx = abs(length(pc) - cu.h.y - ondaEn(abs(ang * 2.0 - 1.0)) * amp * 0.7) * res.y;
    } else {
      let o = ondaEn(q.x) * amp * 0.7;
      dpx = min(abs(q.y - 0.33 - o), abs(q.y - 0.67 + o)) * res.y;
    }
    // su color es el tono de la imagen que cruza; se mezcla (no solo se suma) para verse también sobre lo claro
    var dc = dom[0].rgb;
    if (abs(cu.e.w) > 0.001) { dc = matiz(dc, cu.e.w); let a0 = min(min(dc.r, dc.g), dc.b); dc = (dc - vec3f(a0)) / max(max(max(dc.r, dc.g), dc.b) - a0, 1e-3); }
    let base = mix(cu.d.rgb, dc * max(max(cu.d.r, cu.d.g), cu.d.b), min(1.0, cu.h.z * dom[0].a * 1.6));
    let tinta = tonoDe(c, base, cu.h.z * 0.5);
    let gl = exp(-dpx * dpx / (cu.e.z * cu.e.z)) * (0.7 + cu.e.y) * cu.h.w;
    if (cu.h.z > 0.001) {
      // sobre lo claro la línea va oscura (mismo tono), sobre lo oscuro, luminosa: siempre se lee
      let k = smoothstep(0.45, 0.75, dot(c, vec3f(0.299, 0.587, 0.114)));
      c = mix(c, mix(tinta * 1.3, tinta * 0.12, k), min(gl, 1.0) * 0.85) + tinta * gl * 0.25 * (1.0 - k);
    } else { c += tinta * gl; }
  }
  // barrido: líneas de monitor y una franja que sube despacio
  let sl = cu.f.x;
  if (sl > 0.001) {
    let y = i.pos.y * (1000.0 / res.y);
    c *= 1.0 - sl * (0.3 * (0.5 + 0.5 * sin(y * 2.0944)) + 0.14 * smoothstep(0.9, 1.0, fract(uv.y * 0.6 - t * 0.11)));
    c += sl * 0.03 * h1(floor(i.pos.y) + floor(t * 60.0) * 0.37);
  }
  c = mix(c, vec3f(1.0) - c, cu.c.y);
  c = mix(c, vec3f(1.6, 1.52, 1.4), cu.c.x);
  return vec4f(c, 1.0);
}
`;

// chispas: anillo de cada bombo, implosión durante la subida y estallido del drop
const PART = /* wgsl */`
struct P { a: vec4f, b: vec4f };   // a: posición, velocidad · b: vida, vida inicial, tamaño, tipo
struct PU { a: vec4f, b: vec4f, c: vec4f, d: vec4f };   // a: n, dt, t, aspecto · b: cabeza, implosión, anillo, estallido · c: wob, subida, semilla, flujo · d: fracción de la fuente (x, y), origen (0 centro, 1 lo más brillante), _
@group(0) @binding(0) var<storage, read_write> ps: array<P>;
@group(0) @binding(1) var<uniform> pu: PU;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var<storage, read_write> dom: array<vec4f>;
fn hs(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
// color dominante del preset: histograma de 12 tonos con 256 muestras (pesadas por saturación y brillo);
// gana el tono que más pesa (un promedio mezclaría tonos opuestos en gris). Se suaviza entre cuadros.
var<workgroup> bins: array<atomic<u32>, 12>;
fn binDe(c: vec3f, mx: f32, cr: f32) -> u32 {
  var h: f32;
  if (mx == c.r) { h = (c.g - c.b) / cr; } else if (mx == c.g) { h = 2.0 + (c.b - c.r) / cr; } else { h = 4.0 + (c.r - c.g) / cr; }
  return min(u32(fract(h / 6.0 + 1.0) * 12.0), 11u);
}
@compute @workgroup_size(64) fn dominante(@builtin(local_invocation_index) li: u32) {
  if (li < 12u) { atomicStore(&bins[li], 0u); }
  workgroupBarrier();
  let dim = vec2f(textureDimensions(src));
  for (var k = 0u; k < 16u; k++) {
    let j = li * 16u + k;
    let uv = (vec2f(f32(j % 32u), f32(j / 32u)) + 0.5) / 32.0;
    let c = textureLoad(src, vec2i(uv * pu.d.xy * (dim - 1.0)), 0).rgb;
    let mx = max(max(c.r, c.g), c.b); let cr = mx - min(min(c.r, c.g), c.b);
    let w = smoothstep(0.1, 0.3, cr) * min(cr, 1.0);   // los grises y blancos cálidos no cuentan; lo tenue con color sí
    if (w > 0.0) { atomicAdd(&bins[binDe(c, mx, cr)], u32(w * 1000.0)); }
  }
  workgroupBarrier();
  if (li == 0u) {
    var mejor = 0u; var bm = 0u;
    for (var b = 0u; b < 12u; b++) { let v = atomicLoad(&bins[b]); if (v > bm) { bm = v; mejor = b; } }
    // histéresis: el tono de ahora se queda mientras no lo supere otro por un 30 %
    let act = u32(dom[1].x);
    if (dom[1].y > 0.5 && act < 12u && f32(atomicLoad(&bins[act])) * 1.3 >= f32(bm)) { mejor = act; bm = atomicLoad(&bins[act]); }
    dom[1] = vec4f(f32(mejor), 1.0, 0.0, 0.0);
    let h = (f32(mejor) + 0.5) / 12.0;
    let puro = clamp(abs(fract(vec3f(h) + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
    let fuerza = clamp(f32(bm) / 1000.0 * 0.12, 0.0, 1.0);   // con unos pocos contornos de color ya manda
    var m = select(mix(dom[0], vec4f(puro, fuerza), 0.08), vec4f(puro, fuerza), dom[0].a < 0.001 && fuerza > 0.0);
    // al pasar de un tono a otro no se ensucia: se vuelve a saturar
    let mn = min(min(m.r, m.g), m.b); let mx = max(max(m.r, m.g), m.b);
    if (mx - mn > 0.05) { m = vec4f((m.rgb - vec3f(mn)) / (mx - mn), m.a); }
    dom[0] = m;
  }
}
// brillo del preset en un punto (x en ±aspecto, y en ±1)
fn lum(q: vec2f) -> f32 {
  let uv = vec2f(q.x / pu.a.w * 0.5 + 0.5, 0.5 - q.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return 0.0; }
  let dim = vec2f(textureDimensions(src));
  return dot(textureLoad(src, vec2i(min(uv * pu.d.xy * dim, dim - 1.0)), 0).rgb, vec3f(0.299, 0.587, 0.114));
}
// el punto más brillante entre unos cuantos al azar (las chispas de un mismo golpe comparten la semilla)
fn foco() -> vec2f {
  var mejor = vec2f(0.0); var bl = -1.0;
  for (var k = 0; k < 12; k++) {
    let s = pu.c.z * 0.731 + f32(k) * 17.13;
    let q = vec2f((hs(s) * 2.0 - 1.0) * pu.a.w * 0.8, (hs(s + 5.3) * 2.0 - 1.0) * 0.8);
    let l = lum(q); if (l > bl) { bl = l; mejor = q; }
  }
  return mejor;
}
@compute @workgroup_size(256) fn cs(@builtin(global_invocation_id) g: vec3u) {
  let n = u32(pu.a.x); let i = g.x;
  if (i >= n) { return; }
  var p = ps[i];
  let rel = (i + n - (u32(pu.b.x) % n)) % n;
  let c0 = u32(pu.b.y); let c1 = u32(pu.b.z); let c2 = u32(pu.b.w);
  let sd = f32(i) * 1.618 + pu.c.z;
  let r1 = hs(sd); let r2 = hs(sd + 3.1); let r3 = hs(sd + 7.7);
  let d = vec2f(cos(r1 * 6.2831853), sin(r1 * 6.2831853));
  let asp = pu.a.w;
  if (rel < c0) {
    p.a = vec4f(d * vec2f(asp, 1.0) * (1.05 + r2 * 0.4), -d * (0.5 + r3 * 0.9));
    p.b = vec4f(1.3, 1.3, 0.5 + r2 * 0.6, 0.0);
  } else if (rel < c0 + c1) {
    let o = select(vec2f(0.0), foco(), pu.d.z > 0.5);
    p.a = vec4f(o + d * 0.05, d * (0.9 + r2 * 1.0));
    p.b = vec4f(0.55, 0.55, 0.5 + r3 * 0.5, 1.0);
  } else if (rel < c0 + c1 + c2) {
    p.a = vec4f(d * r3 * 0.06, d * (0.4 + sqrt(r2) * 3.0));
    p.b = vec4f(1.4 + r3, 1.4 + r3, 0.6 + r1 * 0.8, 2.0);
  } else if (p.b.x > 0.0) {
    let dt = pu.a.y; let q = p.a.xy; let w = pu.c.x;
    let giro = vec2f(-q.y, q.x) * w * 1.4;
    let ola = vec2f(sin(q.y * 7.0 + pu.a.z * 3.0), cos(q.x * 6.0 - pu.a.z * 2.0)) * w * 0.9;
    var v = p.a.zw + (giro + ola) * dt;
    // flujo: las chispas corren a lo largo de los contornos del preset (curl de su brillo) y se pegan a lo claro
    if (pu.c.w > 0.001) {
      let e = 0.015;
      let gx = lum(q + vec2f(e, 0.0)) - lum(q - vec2f(e, 0.0));
      let gy = lum(q + vec2f(0.0, e)) - lum(q - vec2f(0.0, e));
      v += (vec2f(-gy, gx) * 0.9 + vec2f(gx, gy) * 0.25) * (pu.c.w / e) * dt;
    }
    v *= exp(-dt * select(2.0, 0.4, p.b.w < 0.5));
    p.a = vec4f(q + v * dt, v);
    p.b.x -= dt;
  }
  ps[i] = p;
}
`;
const PART_R = /* wgsl */`
struct P { a: vec4f, b: vec4f };
struct RU { a: vec4f, c: vec4f, d: vec4f, b: vec4f };   // a: aspecto, ancho, intensidad, color de la imagen · c, d: tintas rgb + fracción x / y de la fuente · b: giro de matiz, _
fn matiz(c: vec3f, a: f32) -> vec3f {
  let y = dot(c, vec3f(0.299, 0.587, 0.114)); let i0 = dot(c, vec3f(0.596, -0.274, -0.322)); let q0 = dot(c, vec3f(0.211, -0.523, 0.312));
  let ca = cos(a); let sa = sin(a); let i2 = i0 * ca - q0 * sa; let q2 = i0 * sa + q0 * ca;
  return max(vec3f(0.0), vec3f(y + 0.956 * i2 + 0.621 * q2, y - 0.272 * i2 - 0.647 * q2, y - 1.106 * i2 + 1.703 * q2));
}
@group(0) @binding(0) var<storage, read> ps: array<P>;
@group(0) @binding(1) var<uniform> ru: RU;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> dom: array<vec4f>;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) a: f32, @location(2) col: vec3f };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let p = ps[ii];
  if (p.b.x <= 0.0) { o.pos = vec4f(9.0, 9.0, 0.0, 1.0); return o; }
  var C = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let cc = C[vi];
  let v = p.a.zw; let sp = length(v) + 1e-5; let dir = v / sp; let nrm = vec2f(-dir.y, dir.x);
  let w = ru.a.y * p.b.z;
  let q = p.a.xy + dir * cc.x * (w + min(sp, 2.0) * 0.016) + nrm * cc.y * w;
  o.pos = vec4f(q.x / ru.a.x, q.y, 0.0, 1.0);
  o.uv = cc;
  let vida = clamp(p.b.x / p.b.y, 0.0, 1.0);
  o.a = vida * vida;
  var col = mix(ru.c.rgb, ru.d.rgb, clamp(p.b.w * 0.5, 0.0, 1.0));
  if (ru.a.w > 0.001) {
    var dc = dom[0].rgb;
    if (abs(ru.b.x) > 0.001) { dc = matiz(dc, ru.b.x); let a0 = min(min(dc.r, dc.g), dc.b); dc = (dc - vec3f(a0)) / max(max(max(dc.r, dc.g), dc.b) - a0, 1e-3); }
    col = mix(col, dc * max(max(col.r, col.g), col.b), min(1.0, ru.a.w * dom[0].a * 1.6));
    let uv = clamp(vec2f(p.a.x / ru.a.x * 0.5 + 0.5, 0.5 - p.a.y * 0.5), vec2f(0.0), vec2f(1.0));
    let dim = vec2f(textureDimensions(src));
    var s = textureLoad(src, vec2i(uv * vec2f(ru.c.w, ru.d.w) * (dim - 1.0)), 0).rgb;
    if (abs(ru.b.x) > 0.001) { s = matiz(s, ru.b.x); }
    let mx = max(max(s.r, s.g), s.b); let mn = min(min(s.r, s.g), s.b); let cr = mx - mn;
    let puro = (s - vec3f(mn)) / max(cr, 1e-3);
    col = mix(col, puro * max(max(col.r, col.g), col.b), ru.a.w * smoothstep(0.04, 0.2, cr));
  }
  o.col = col;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let s = (1.0 - i.uv.y * i.uv.y) * (1.0 - smoothstep(0.2, 1.0, abs(i.uv.x)));
  return vec4f(i.col * s * i.a * ru.a.z, 0.0);
}
`;

const fmtN = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, '');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const U_GEN = 160 + 6 * 32 + 6 * 16, U_COMP = 128 + 64 * 16;

export default class Senal {
  static palettes = DUOS.map((d) => d.nombre);
  static teclas = [['Y', 'preset al azar']];
  static controls = { ls: '↕ elegir línea · ↔ ajustar su valor', trig: '− / + cuánto golpean los visuales', a: 'saltar al drop (o salir de él)', y: 'siguiente parche' };
  static info = { title: 'Señal', desc: '' };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 0.92, bloom: 0.14, vignette: 0.5, lift: [0.02, 0.018, 0.015], grain: 0.04 }; this.sonido = {}; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    // texturas internas del tamaño de la salida; la escala adaptativa dibuja solo una parte (no se realoja)
    this.tex = [0, 1].map(() => d.createTexture({ size: [W, H], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    this.vistas = this.tex.map((t) => t.createView());
    this.u = U.uniform(d, U_GEN); this.uc = U.uniform(d, U_COMP); this.up = U.uniform(d, 64); this.ur = U.uniform(d, 64);
    this.fu = new Float32Array(U_GEN / 4); this.fc = new Float32Array(U_COMP / 4); this.fp = new Float32Array(16); this.fr = new Float32Array(16);
    this.smp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const m = makeShader(d, SH, 'senal', report), mc = makeShader(d, COMP, 'senal-comp', report);
    const mp = makeShader(d, PART, 'senal-chispas', report), mr = makeShader(d, PART_R, 'senal-chispas-r', report);
    const suma = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
    [this.pS, this.pC, this.pP, this.pR, this.pD] = await Promise.all([
      d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } }),
      d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mc, entryPoint: 'vs' }, fragment: { module: mc, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } }),
      d.createComputePipelineAsync({ layout: 'auto', compute: { module: mp, entryPoint: 'cs' } }),
      d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mr, entryPoint: 'vs' }, fragment: { module: mr, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: suma }] } }),
      d.createComputePipelineAsync({ layout: 'auto', compute: { module: mp, entryPoint: 'dominante' } }),
    ]);
    this.dom = U.storage(d, 32, GPUBufferUsage.COPY_SRC);   // color dominante del preset (lo escribe la GPU)
    // chispas: el máximo depende del preset de calidad; el gobernador usa una fracción
    this.nMax = Math.max(4096, Math.round((32768 * (this.ctx.calidad ? this.ctx.calidad.carga : 1)) / 256) * 256);
    this.ps = U.storage(d, this.nMax * 32);
    this.bgS = [0, 1].map((k) => d.createBindGroup({ layout: this.pS.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.u } }, { binding: 1, resource: this.vistas[1 - k] }, { binding: 2, resource: this.smp }] }));
    this.grupos = new Map();
    this.gruposP = new Map();   // chispas: un par de grupos (simular, dibujar) por cada vista de fuente
    this.lado = 0; this.reac = 1; this.linea = 0; this.ultNav = 0; this.t0 = performance.now(); this.edad = 0;
    // gobernador: nivel 0..1 → resolución interna 42..100 % y chispas 15..100 %
    this.nivel = 0.85; this.nivelObj = 0.85; this.sobre = 0; this.holgura = 0; this.enfr = 0; this.lento = 0;
    this.fracPrev = [this.esc, this.esc]; this.cabeza = 0; this.ultKick = -1; this.ultDrop = -1; this.semilla = 0;
    this.onda = new Float32Array(256); this.tdom = new Float32Array(1024);
    this.vivoTxt = ''; this.calTxt = ''; this.calT = 0;
    this.estiloI = 0; this.i = 0;
    // catálogo de todos los motores (parches propios, GLSL, MilkDrop, ISF, fosfora) y el oído que los alimenta
    this.oido = new Oido(); this.motores = {}; this.motoresP = {}; this.ext = {}; this.tokSel = 0;
    this.cat = new Catalogo({ base: 'presets', parches: PARCHES.map((p) => p.nombre), propios: PRESETS_UMBRAL });
    this.motorAct = 'senal'; this.fuente = null; this.fuenteAnt = null; this.mezclaF = 1; this.hue0 = 0; this.capaSel = null;
    // color y escenas: matiz actual y objetivo (radianes), compases contados y transición entre parches
    this.fx = { ...FX_BASE };
    try { Object.assign(this.fx, JSON.parse(localStorage.getItem(CLAVE_FX) || '{}')); } catch {}
    this.hue = 0; this.hueObj = 0; this.ultCompas = null; this.nCompases = 0; this.ultSec = ''; this.dropVisto = -1; this.trans = 0;
    this.ponerEstilo(0);
    const guardado = this.cat.estado.id;
    if (guardado && guardado.startsWith('senal/')) this.cargar(+guardado.slice(6));
    this.cat.cargar().then(() => {
      if (this.muerta) return;
      const e = guardado && this.cat.porId.get(guardado);
      if (e && e.m !== 'senal') this.elegir(e, 0);
      if (this.cat.estado.fx) this.capa(this.cat.estado.fx);
    });
    // «tu música»: si hay una canción propia (o el micrófono), la sala la escucha a ella en vez de la máquina
    this.pista = this.ctx.sonido && this.ctx.sonido.pista;
    if (this.pista) this.quitarOyente = this.pista.alCambiar(() => this.codigo());
    const yo = this;
    window.__senal = {
      estilos: SENAL_ESTILOS.map((e) => e.nombre),
      estado: () => { const A = yo.A || {}; return { estilo: SENAL_ESTILOS[yo.estiloI].nombre, parche: yo.P.nombre, audio: { real: !!A.real, estilo: A.estilo, seccion: A.seccion, adelanto: A.adelanto, tKick: A.tKick, tv: A.tv }, nivel: yo.nivel, esc: yo.esc, chispas: yo.nAct, frac: yo.fracPrev, capas: { ...yo.capas, forma: FORMAS[yo.capas.forma] } }; },
      lento: (ms) => { yo.lento = ms; },
      // color dominante que calculó la GPU (para pruebas)
      dominante: async () => { const dv = yo.ctx.device, b = dv.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); const e = dv.createCommandEncoder(); e.copyBufferToBuffer(yo.dom, 0, b, 0, 16); dv.queue.submit([e.finish()]); await b.mapAsync(GPUMapMode.READ); const v = [...new Float32Array(b.getMappedRange())]; b.destroy(); return v; },
      _yo: yo,
    };
  }
  get esc() { return 0.42 + 0.58 * this.nivel; }
  get fPart() { return 0.15 + 0.85 * this.nivel * this.nivel; }

  ponerEstilo(i) {
    this.estiloI = (i + SENAL_ESTILOS.length) % SENAL_ESTILOS.length;
    const V = VISTA[this.estiloI];
    this.cargar(V.parche); this.palette = V.duo; this.palPrev = V.duo;
    this.codigo();
  }
  cargar(i) {
    this.i = (i + PARCHES.length) % PARCHES.length;
    this.P = JSON.parse(JSON.stringify(PARCHES[this.i]));
    this.linea = 0;
    if (this.cat && this.motorAct === 'senal') { this.sel = this.cat.porId.get('senal/' + this.i); this.cat.estado.id = this.sel.id; this.cat.guardar(); this.cat.avisar(); }
  }
  // ---- motores de presets: se cargan la primera vez que hacen falta ----
  motor(m) {
    const k = m === 'isf' ? 'gl' : m;
    if (this.motores[k]) return Promise.resolve(this.motores[k]);
    if (this.motoresP[k]) return this.motoresP[k];
    const avisar = (x) => console.warn('[señal]', x);
    return (this.motoresP[k] = (async () => {
      const { device: d, W, H } = this.ctx;
      const destino = () => d.createTexture({ size: [W, H], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
      let M;
      if (k === 'gl') { const { MotorGL } = await import('../motores/glsl.js'); M = new MotorGL({ report: avisar }); }
      else if (k === 'md') {
        const { MotorMilkdrop } = await import('../motores/milkdrop.js');
        const S = this.ctx.sonido; if (!S.ac) S.iniciar(true);
        if (!S.ac) throw new Error('MilkDrop necesita el audio: toca una tecla primero');
        M = new MotorMilkdrop({ report: avisar, base: 'presets/milkdrop', presets: 'presets/milkdrop/p' });
        await M.iniciar(S.ac);
      } else if (k === 'wgsl') { const { MotorWGSL } = await import('../motores/wgsl.js'); M = new MotorWGSL(d, { report: avisar, base: 'presets/fosfora' }); }
      if (this.muerta) { M.destroy(); return null; }
      if (k === 'gl' || k === 'md') { this.ext[k] = destino(); this.ext[k + 'V'] = this.ext[k].createView(); }
      return (this.motores[k] = M);
    })().catch((e) => { this.motoresP[k] = null; throw e; }));
  }
  // elige un preset del catálogo (de cualquier motor); devuelve false si no se pudo
  async elegir(e, seg = 1.2) {
    if (!e) return false;
    const tok = ++this.tokSel, antes = this.fuente, k = e.m === 'isf' ? 'gl' : e.m;
    if (e.m === 'senal') { this.cargar(e.i); this.trans = 1; }
    else {
      let ok = false;
      try {
        const M = await this.motor(e.m);
        if (!M || tok !== this.tokSel) return false;
        const mismo = this.motorAct === k;
        if (e.m === 'gl') ok = M.usar(e.preset, mismo ? seg : 0);
        else if (e.m === 'isf') {
          if (!e.fuente) e.fuente = await fetch(`presets/${e.f}`).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); });
          if (tok !== this.tokSel) return false;
          ok = M.usar({ id: e.id, tipo: 'isf', fuente: e.fuente }, mismo ? seg : 0);
        } else if (e.m === 'md') ok = await M.usar(e, mismo && seg > 0 ? 2.7 : 0);
        else if (e.m === 'wgsl') ok = await M.usar({ id: e.id, archivo: e.f.slice(e.f.indexOf('/') + 1), pfx: e.pfx });
      } catch (err) { console.warn('[señal]', e.id, err); if (/audio/.test(err.message)) return false; }
      if (tok !== this.tokSel) return false;
      if (!ok) { this.cat.marcarMalo(e.id); return false; }
    }
    // entre motores distintos (o entre efectos de fosfora) la imagen anterior se queda quieta y se desvanece
    if (antes && seg > 0 && (k !== this.motorAct || k === 'wgsl')) { this.fuenteAnt = antes; this.mezclaF = 0; }
    this.motorAct = k; this.sel = e; this.hue0 = this.hue;
    this.cat.estado.id = e.id; this.cat.guardar();
    this.linea = 0; this.codigo(); this.cat.avisar();
    return true;
  }
  // si un preset falla, el siguiente en la misma dirección
  async saltarA(dir, azar = false) {
    let id = this.sel && this.sel.id;
    for (let n = 0; n < 6; n++) {
      const e = azar ? this.cat.azar(id) : this.cat.vecino(id, dir);
      if (!e) return null;
      if (await this.elegir(e)) return e;
      if (!azar) id = e.id;
    }
    return null;
  }
  // capa de efecto ISF sobre el preset (motores GLSL/ISF y MilkDrop); null la quita
  async capa(id) {
    const e = id ? this.cat.porId.get(id) : null;
    this.capaSel = e || null; this.cat.estado.fx = e ? e.id : null; this.cat.guardar();
    try {
      if (!e) { if (this.motores.gl) this.motores.gl.ponerFiltro(null); }
      else {
        const M = await this.motor('gl');
        if (!e.fuente) e.fuente = await fetch(`presets/${e.f}`).then((r) => r.text());
        if (this.capaSel !== e) return false;
        if (!M.ponerFiltro({ id: e.id, tipo: 'isf', fuente: e.fuente })) { this.capaSel = null; this.cat.estado.fx = null; this.cat.guardar(); }
      }
    } catch (err) { console.warn('[señal] capa', err); this.capaSel = null; }
    this.codigo(); this.cat.avisar();
    return !!this.capaSel === !!e;
  }
  get capaAplica() { return this.motorAct === 'gl' || this.motorAct === 'md'; }
  grupoC(a, b) {
    let m = this.grupos.get(a); if (!m) this.grupos.set(a, (m = new Map()));
    let g = m.get(b);
    if (!g) { g = this.ctx.device.createBindGroup({ layout: this.pC.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uc } }, { binding: 1, resource: a }, { binding: 2, resource: this.smp }, { binding: 3, resource: b }, { binding: 4, resource: { buffer: this.dom } }] }); m.set(b, g); }
    return g;
  }
  // las chispas leen la imagen del preset: sus grupos dependen de la vista de la fuente
  grupoP(v) {
    let g = this.gruposP.get(v);
    if (!g) {
      const d = this.ctx.device;
      if (this.gruposP.size > 24) this.gruposP.clear();
      g = [d.createBindGroup({ layout: this.pP.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ps } }, { binding: 1, resource: { buffer: this.up } }, { binding: 2, resource: v }] }),
        d.createBindGroup({ layout: this.pR.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ps } }, { binding: 1, resource: { buffer: this.ur } }, { binding: 2, resource: v }, { binding: 3, resource: { buffer: this.dom } }] }),
        d.createBindGroup({ layout: this.pD.getBindGroupLayout(0), entries: [{ binding: 1, resource: { buffer: this.up } }, { binding: 2, resource: v }, { binding: 3, resource: { buffer: this.dom } }] })];
      this.gruposP.set(v, g);
    }
    return g;
  }
  // forma, color y flujo de las capas para el preset de ahora (fijas si el panel lo pide)
  get capas() {
    if (!this.fx.capas) return { forma: 0, radio: 0.28, mezcla: 0, flujo: 0, origen: 0, scope: 1 };
    if (this.capasSel !== this.sel || !this.capasC) { this.capasSel = this.sel; this.capasC = capasDe(this.sel); }
    return this.capasC;
  }
  get conPista() { return !!(this.pista && this.pista.activa); }
  // lo que el panel puede elegir: carácter (cómo golpea), parche y tintas
  opciones() {
    return { looks: SENAL_ESTILOS.map((e) => e.nombre), look: this.estiloI, parches: PARCHES.map((p) => p.nombre), parche: this.i, tintas: DUOS.map((d) => d.nombre), tinta: this.palette,
      colores: COLOR, escenas: ESCENAS, espejos: ESPEJO, fx: this.fx };
  }
  // efectos y modos (los guarda para la próxima vez)
  efecto(k, v) {
    this.fx[k] = v;
    try { localStorage.setItem(CLAVE_FX, JSON.stringify(this.fx)); } catch {}
    if (k === 'color' && v === 'fijas') this.hueObj = Math.round(this.hue / TAU) * TAU;
    this.codigo();
  }
  onKey(k) { if (k === 'y') this.saltarA(1, true); }
  // cambio de escena: otro parche al azar; la retroalimentación funde el viejo con el nuevo
  cambiarEscena() { this.saltarA(1, true); }
  fijar(k, i) {
    if (i < 0) return;
    if (k === 'look') { const pal = this.palette, par = this.i; this.ponerEstilo(i); if (this.conPista) { this.cargar(par); this.palette = this.palPrev = pal; } }
    else if (k === 'parche') { this.elegir(this.cat.porId.get('senal/' + i)); return; }
    else if (k === 'tintas') { this.palette = this.palPrev = i; }
    this.codigo();
  }
  partitura() { const S = this.ctx.sonido, p = S && S.actual; return p && p.estado && !p.muerto && S.ac && S.ac.state === 'running' ? p : null; }
  saltar() { if (this.conPista) { this.pista.r.tDrop = performance.now() / 1000; return; } const p = this.partitura(); if (p) p.saltarAlDrop(); }
  // el parche como código: lo que se ve es exactamente lo que interpreta el sombreador
  lineas() {
    const P = this.P, L = [];
    L.push({ txt: `${P.fuente[0]}(${P.fuente.slice(1).map(fmtN).join(', ')})`, ref: P.fuente, idx: 1 });
    for (const g of P.geo) {
      const args = g.slice(1).filter((x) => typeof x === 'number');
      const mod = g.find((x) => x && typeof x === 'object');
      let s = `.${g[0]}(` + (mod ? `${mod.src}(${fmtN(mod.f)}), ` : '') + fmtN(args[0]) + (args.length > 1 && !mod ? ', ' + args.slice(1).map(fmtN).join(', ') : '') + ')';
      if (mod && args[1]) s += `  ← ritmo × ${fmtN(args[1])}`;
      L.push({ txt: s, ref: g, idx: 1 });
    }
    for (const c of P.col) L.push({ txt: `.${c[0]}(${c.slice(1).map(fmtN).join(', ')})`, ref: c, idx: 1 });
    L.push({ txt: `.retro(${fmtN(P.fb[0])}, zoom ${P.fb[1].toFixed(3)}, giro ${P.fb[2].toFixed(3)})`, ref: P.fb, idx: 0 });
    L.push({ txt: `.tintas('${DUOS[this.palette].nombre}')`, ref: null });
    return L;
  }
  // un preset de otro motor, también como código: qué es, de quién y con qué licencia
  lineasExt() {
    const e = this.sel, L = [{ txt: `preset('${escH(e.n)}')`, ref: null }, { txt: `  .de('${escH(e.a)}')  · ${escH(e.l)}`, ref: null },
      { txt: `  .coleccion('${escH(NOMBRE_COL[e.c] || e.c)}')`, ref: null }];
    if (this.capaSel) L.push({ txt: `  .capa('${escH(this.capaSel.n)}')${this.capaAplica ? '' : '  // no aplica a este motor'}`, ref: null });
    return L;
  }
  codigo() {
    if (this.motorAct !== 'senal' && this.sel) return this.codigoExt();
    const L = this.lineas(), E = SENAL_ESTILOS[this.estiloI], Pi = this.conPista ? this.pista : null;
    this.nLineas = L.length;
    const tono = Pi && Pi.tono ? `, '${Pi.tono}'` : '';
    const cab = Pi ? `escuchar('${(Pi.nombre || '').replace(/'/g, '’').slice(0, 34)}'${Pi.bpm ? ', ~' + Pi.bpm : ''}${tono})` : `musica('${E.nombre}', ${E.bpm})`;
    const F = this.fx, extra = [];
    if (F.color !== 'fijas') extra.push(`.color('${F.color}')`);
    if (F.escenas !== 'manual') extra.push(`.escenas('${F.escenas}')`);
    const fxs = [F.barrido > 0 && `barrido(${fmtN(F.barrido)})`, F.zoom > 0 && `zoom(${fmtN(F.zoom)})`, F.espejo !== 'no' && `espejo('${F.espejo}')`, F.mosh > 0 && `mosh(${fmtN(F.mosh)})`, F.estrobo && 'estrobo()'].filter(Boolean);
    if (fxs.length) extra.push('.' + fxs.join('.'));
    this.ctx.capa.innerHTML = `<div style="position:absolute;left:44px;top:38px;font:400 13px/1.75 var(--mono);color:var(--papel-2);
      padding:14px 18px 14px 16px;background:rgba(12,11,9,.72);border-left:1px solid var(--acento)">
      <div class="rotulo-t" style="margin-bottom:6px">estilo ${this.estiloI + 1} / ${SENAL_ESTILOS.length} · parche ${this.i + 1} / ${PARCHES.length} · ${this.P.nombre}</div>
      <div style="white-space:pre;color:var(--papel)"><span style="display:inline-block;width:14px"></span>${cab}</div>
      <div id="senal-vivo" style="white-space:pre;color:var(--acento);margin-bottom:4px"><span style="display:inline-block;width:14px"></span>  ${this.vivoTxt}</div>
      ${L.map((l, k) => `<div style="white-space:pre;${k === this.linea ? 'color:var(--papel)' : ''}"><span style="display:inline-block;width:14px;color:var(--acento)">${k === this.linea ? '›' : ''}</span>${k ? '  ' : ''}${l.txt}</div>`).join('')}
      ${extra.map((x) => `<div style="white-space:pre;color:var(--papel-3)"><span style="display:inline-block;width:14px"></span>  ${x}</div>`).join('')}
      <div class="rotulo" style="margin-top:10px;color:var(--papel-3)">${Pi ? 'carácter · ' + E.nombre + ' · ↑ ↓ lo cambian' : 'suelta aquí tu canción · o ábrela en el panel (?)'}</div>
      <div class="rotulo" style="margin-top:2px;color:var(--papel-3)">inspirado en Hydra (hydra.ojack.xyz) · implementación propia</div></div>`;
    this.vivoEl = document.getElementById('senal-vivo');
  }
  codigoExt() {
    const L = this.lineasExt(), E = SENAL_ESTILOS[this.estiloI], Pi = this.conPista ? this.pista : null, e = this.sel;
    this.nLineas = L.length;
    const tono = Pi && Pi.tono ? `, '${escH(Pi.tono)}'` : '';
    const cab = Pi ? `escuchar('${escH((Pi.nombre || '').replace(/'/g, '’').slice(0, 34))}'${Pi.bpm ? ', ~' + Pi.bpm : ''}${tono})` : `musica('${E.nombre}', ${E.bpm})`;
    const pos = this.cat.posicion(e.id), tot = this.cat.lista.length;
    const F = this.fx, fxs = [F.barrido > 0 && `barrido(${fmtN(F.barrido)})`, F.zoom > 0 && `zoom(${fmtN(F.zoom)})`, F.espejo !== 'no' && `espejo('${F.espejo}')`, F.estrobo && 'estrobo()'].filter(Boolean);
    const extra = [];
    if (F.color !== 'fijas') extra.push(`.color('${F.color}')`);
    if (F.escenas !== 'manual') extra.push(`.escenas('${F.escenas}')`);
    if (fxs.length) extra.push('.' + fxs.join('.'));
    this.ctx.capa.innerHTML = `<div style="position:absolute;left:44px;top:38px;max-width:min(560px,calc(100% - 88px));font:400 13px/1.75 var(--mono);color:var(--papel-2);
      padding:14px 18px 14px 16px;background:rgba(12,11,9,.72);border-left:1px solid var(--acento)">
      <div class="rotulo-t" style="margin-bottom:6px">estilo ${this.estiloI + 1} / ${SENAL_ESTILOS.length} · preset ${pos ? pos.toLocaleString('es-ES') + ' / ' + tot.toLocaleString('es-ES') : '—'}${this.cat.favs.has(e.id) ? ' · ★' : ''}</div>
      <div style="white-space:pre;color:var(--papel)"><span style="display:inline-block;width:14px"></span>${cab}</div>
      <div id="senal-vivo" style="white-space:pre;color:var(--acento);margin-bottom:4px"><span style="display:inline-block;width:14px"></span>  ${this.vivoTxt}</div>
      ${L.map((l, k) => `<div style="white-space:pre;overflow:hidden;text-overflow:ellipsis;${k ? '' : 'color:var(--papel)'}"><span style="display:inline-block;width:14px;color:var(--acento)">${k ? '' : '›'}</span>${k ? '' : '  '}${l.txt}</div>`).join('')}
      ${extra.map((x) => `<div style="white-space:pre;color:var(--papel-3)"><span style="display:inline-block;width:14px"></span>  ${x}</div>`).join('')}
      <div class="rotulo" style="margin-top:10px;color:var(--papel-3)">← → otro preset · C el siguiente · el panel (?) busca entre ${this.cat.todos.length.toLocaleString('es-ES')}</div></div>`;
    this.vivoEl = document.getElementById('senal-vivo');
  }
  ajustar(dir) {
    if (this.motorAct !== 'senal') { this.saltarA(dir); return; }
    const l = this.lineas()[this.linea];
    if (!l || !l.ref) { this.palette = (this.palette + dir + DUOS.length) % DUOS.length; this.palPrev = this.palette; this.codigo(); return; }
    const r = l.ref, k = l.idx, v = r[k];
    if (r === this.P.fb) r[0] = Math.min(0.97, Math.max(0, v + dir * 0.03));
    else if (ENTEROS.has(r[0])) r[k] = Math.max(1, v + dir);
    else r[k] = v * (dir > 0 ? 1.12 : 1 / 1.12);
    this.codigo();
  }
  // C / Y: siguiente parche (main.js anuncia lo que devuelve)
  accionY() { const e = this.cat.vecino(this.sel && this.sel.id, 1); this.saltarA(1); return e ? 'Preset · ' + e.n : ''; }
  // ↑ ↓ cambian de estilo musical; la música cambia en el siguiente tiempo
  nombreModo() { return SENAL_ESTILOS[this.estiloI].nombre; }
  cambiarModo(dir) { this.ponerEstilo(this.estiloI + dir); this.ultNav = performance.now(); return this.nombreModo(); }

  // gobernador: si el cuadro se pasa de presupuesto, baja el nivel; si sobra, lo sube despacio
  gobernar(dt) {
    const P = this.ctx.perf || {};
    const frame = (P.frameMs || 16.7) + this.lento, gpu = P.gpuMs == null ? null : P.gpuMs + this.lento * 0.7;
    this.enfr = Math.max(0, this.enfr - dt);
    if (this.edad > 1.2) {
      const pres = 1000 / 60;
      // si la GPU va holgada, un cuadro lento es de la CPU (u otra app): bajar resolución no ayudaría
      const pasado = gpu != null ? gpu > pres * 0.62 || (frame > pres * 1.1 && gpu > pres * 0.35) : frame > pres * 1.1;
      const holgado = frame < pres * 1.05 && (gpu == null || gpu < pres * 0.4);
      if (pasado) { this.sobre += dt; this.holgura = 0; }
      else if (holgado) { this.holgura += dt; this.sobre = Math.max(0, this.sobre - dt); }
      else { this.sobre = Math.max(0, this.sobre - dt * 0.5); this.holgura = 0; }
      if (this.sobre > 0.35 && this.enfr <= 0) { this.nivelObj = Math.max(0, this.nivelObj - 0.15); this.sobre = 0; this.enfr = 0.7; }
      if (this.holgura > 2.5 && this.enfr <= 0) { this.nivelObj = Math.min(1, this.nivelObj + 0.06); this.holgura = 0; this.enfr = 1; }
    }
    this.nivel += (this.nivelObj - this.nivel) * Math.min(1, dt * 2.5);
  }
  // la línea de tiempo de la música (o un pulso de reloj si todavía no hay audio)
  audio() {
    if (this.conPista) return this.pista.estado();
    const p = this.partitura();
    if (p) { p.estilo(this.estiloI); const tv = p.ahora(), e = p.estado(tv); e.tv = tv; e.real = true; return e; }
    const E = SENAL_ESTILOS[this.estiloI], tv = (performance.now() - this.t0) / 1000, beat = 60 / E.bpm;
    return { real: false, tv, estilo: E.nombre, bpm: E.bpm, seccion: '', prog: 0, compas: 0, compases: 0, tKick: Math.floor(tv / beat) * beat, kick: 0.7, tCaja: -99, tDrop: -99, tHueco: -99, wob: 0.3 + 0.3 * Math.sin(tv * 3) };
  }
  leerOnda() {
    const an = this.ctx.sonido && this.ctx.sonido.analizador;
    if (!an || !this.A.real) { this.onda.fill(0); return 0; }
    an.getFloatTimeDomainData(this.tdom);
    // disparo como en un osciloscopio: el primer cruce por cero hacia arriba
    let k0 = 0; for (let k = 1; k < 256; k++) if (this.tdom[k - 1] < 0 && this.tdom[k] >= 0) { k0 = k; break; }
    let pico = 0.05;
    for (let k = 0; k < 256; k++) { const v = this.tdom[Math.min(1023, k0 + k * 3)]; pico = Math.max(pico, Math.abs(v)); this.onda[k] += (v - this.onda[k]) * 0.6; }
    return pico;
  }

  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, W = this.ctx.W, H = this.ctx.H, now = performance.now();
    this.edad += dt;
    this.gobernar(dt);
    if (inp.pressed.a) this.saltar();
    if (this.palette !== this.palPrev) { this.palPrev = this.palette; this.codigo(); }
    const ext = this.motorAct !== 'senal' ? this.motores[this.motorAct] : null;
    if (now - this.ultNav > (ext ? 380 : 170)) {
      if (ext) { if (inp.lx > 0.6 || inp.ly > 0.6) { this.ajustar(1); this.ultNav = now; } else if (inp.lx < -0.6 || inp.ly < -0.6) { this.ajustar(-1); this.ultNav = now; } }
      else if (inp.ly < -0.6) { this.linea = (this.linea - 1 + this.nLineas) % this.nLineas; this.ultNav = now; this.codigo(); }
      else if (inp.ly > 0.6) { this.linea = (this.linea + 1) % this.nLineas; this.ultNav = now; this.codigo(); }
      else if (inp.lx > 0.6) { this.ajustar(1); this.ultNav = now; }
      else if (inp.lx < -0.6) { this.ajustar(-1); this.ultNav = now; }
    }
    this.reac = clamp(this.reac + (inp.r2 - inp.l2) * dt, 0, 2);

    // ---- envolventes a partir de la música que se oye ----
    const A = this.A = this.audio(), tv = A.tv, R = this.reac;
    // con tu música, el panel decide cuánto pesa cada banda; «destellos» apaga negativos y fogonazos
    const aj = this.pista ? this.pista.ajustes : null, V0 = VISTA[this.estiloI];
    const V = aj ? { ...V0, golpe: V0.golpe * (A.pista ? aj.graves : 1), tor: V0.tor * (A.pista ? aj.medios : 1), chispas: V0.chispas * (A.pista ? aj.agudos : 1),
      destello: V0.destello * (aj.destellos ? 1 : 0.15), glitch: V0.glitch * (aj.destellos ? 1 : 0.3), inv: V0.inv && aj.destellos } : V0;
    const env = (t0, k) => (t0 > -90 && tv >= t0 ? Math.exp(-(tv - t0) * k) : 0);
    const kick = env(A.tKick, 9) * Math.min(1, (A.kick || 0.8) * 1.1), caja = env(A.tCaja, 8);
    const drop = env(A.tDrop, 1.1), dropG = env(A.tDrop, 6);
    const sub = A.seccion === 'subida' ? A.prog : 0;
    const hueco = A.tHueco > A.tDrop && tv >= A.tHueco ? 1 : 0;
    const enDrop = A.seccion === 'drop' ? 1 : 0;
    const beat = 60 / (A.bpm || 120);
    const inv = V.inv && A.tDrop > -90 && tv >= A.tDrop && tv - A.tDrop < beat * 0.5 ? 1 : 0;
    const wob = clamp(A.wob || 0, 0, 1);
    // chispas que nacen este cuadro
    let c0 = 0, c1 = 0, c2 = 0;
    const fP = this.fPart * V.chispas;
    if (A.tKick !== this.ultKick && A.tKick > -90 && tv >= A.tKick) { this.ultKick = A.tKick; c1 = Math.round(700 * fP * (0.4 + enDrop * 0.6)); }
    if (A.tDrop !== this.ultDrop && A.tDrop > -90 && tv >= A.tDrop) { this.ultDrop = A.tDrop; c2 = Math.round(6000 * fP); }
    if (sub > 0 && !hueco) c0 = Math.round(sub * sub * 9000 * dt * fP);
    const n = this.nAct = Math.max(256, Math.round((this.nMax * this.fPart) / 256) * 256);
    c2 = Math.min(c2, n >> 1); c1 = Math.min(c1, n >> 3); c0 = Math.min(c0, n >> 3);

    // ---- escenas y color que siguen la música ----
    const F = this.fx, nuevoDrop = A.tDrop > -90 && tv >= A.tDrop && A.tDrop !== this.dropVisto;
    if (nuevoDrop) this.dropVisto = A.tDrop;
    const nuevoCompas = this.ultCompas !== null && A.compas !== this.ultCompas;
    this.ultCompas = A.compas;
    if (nuevoCompas) this.nCompases++;
    const nuevaSec = A.seccion && A.seccion !== this.ultSec && this.ultSec !== '';
    this.ultSec = A.seccion || this.ultSec;
    if (A.real && this.edad > 1.5) {
      const E = F.escenas;
      if ((E === 'en cada drop' && nuevoDrop) || (E === 'por sección' && nuevaSec) || (E === 'cada 8 compases' && nuevoCompas && this.nCompases % 8 === 0) || (E === 'cada 16 compases' && nuevoCompas && this.nCompases % 16 === 0)) this.cambiarEscena();
    }
    const M = F.color;
    let rapidez = 2.5;
    if (M === 'tonalidad' && A.tono != null && A.tono >= 0) { const o = (A.tono * TAU) / 12; this.hueObj = this.hue + (((o - this.hue) % TAU) + TAU * 1.5) % TAU - TAU / 2; rapidez = 1.6; }
    else if (M === 'cada drop') { if (nuevoDrop) this.hueObj += 2.4; rapidez = 7; }
    else if (M === 'cada compás' || (M === 'tonalidad' && nuevoCompas && this.nCompases % 4 === 0)) { if (nuevoCompas) this.hueObj += M === 'tonalidad' ? TAU / 4 : TAU / 12; rapidez = 4; }
    else if (M === 'arcoíris') this.hueObj += dt * (0.22 + kick * 0.9 * R);
    this.hue += (this.hueObj - this.hue) * Math.min(1, dt * rapidez);
    if (Math.abs(this.hue) > TAU * 64) { const k = Math.round(this.hue / TAU) * TAU; this.hue -= k; this.hueObj -= k; }
    this.trans = Math.max(0, this.trans - dt * 1.3);
    const permite = !aj || aj.destellos;

    // ---- generador a resolución interna ----
    const esc = this.esc, iw = Math.max(32, Math.round(W * esc)), ih = Math.max(32, Math.round(H * esc));
    const P = this.P, f = this.fu;
    const sh = (sub * sub * 0.012 + dropG * 0.03 + kick * 0.005 * V.golpe) * R;
    f.set([iw, ih, t, P.geo.length], 0);
    f.set([FUENTES[P.fuente[0]], P.fuente[1], P.fuente[2] || 0, P.fuente[3] || 0], 4);
    const tr = this.trans * this.trans * (3 - 2 * this.trans);
    f.set([P.col.length, P.croma, Math.min(0.96, Math.max(P.fb[0] + drop * 0.03, 0.95 * tr)), P.fb[1] + kick * 0.004 * R + tr * 0.025], 8);
    f.set([P.fb[2], kick * R, wob, 0], 12);
    const D = DUOS[this.palette].c.map((c) => girar(c, this.hue));
    f.set([...D[0], 0], 16); f.set([...D[1], 0], 20); f.set([...D[2], 0], 24);
    f.set([kick * V.golpe * R, wob * V.tor * R * (0.4 + enDrop * 0.6), sub * R, dropG * V.golpe * R], 28);
    f.set([this.fracPrev[0], this.fracPrev[1], (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh], 32);
    f.fill(0, 36);
    f[36] = clamp(F.mosh * (0.35 + 0.65 * Math.max(caja, dropG)) * (0.5 + 0.5 * R), 0, 1);
    P.geo.forEach((g, k) => {
      const o = 40 + k * 8, mod = g.find((x) => x && typeof x === 'object');
      const nums = g.slice(1).filter((x) => typeof x === 'number');
      if (mod) f.set([GEO[g[0]], nums[0], 0, 0, 0, FUENTES[mod.src], mod.f, nums[1] || 0], o);
      else f.set([GEO[g[0]], nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0, 0, 0, 0], o);
    });
    P.col.forEach((c, k) => f.set([COL[c[0]], c[1] ?? 0, c[2] ?? 1, 0], 88 + k * 4));
    d.queue.writeBuffer(this.u, 0, f);

    // ---- composición ----
    const amp = this.leerOnda();
    const fc = this.fc, frac = [iw / W, ih / H];
    const estrobo = F.estrobo && permite ? kick * (0.25 + enDrop * 0.45) * R : 0;
    fc.set([W, H, frac[0], frac[1]], 0);
    fc.set([t, kick * V.golpe * R, caja, dropG * R], 4);
    fc.set([clamp(Math.max((dropG * dropG * 0.9 + caja * sub * 0.2) * V.destello * R, estrobo), 0, 1), inv, (0.0015 + kick * 0.007 + dropG * 0.02 + wob * enDrop * 0.004) * V.croma * R, clamp((caja * 0.8 + dropG) * V.glitch * R, 0, 1.5)], 8);
    fc.set([...D[2], F.osciloscopio ? (0.05 + 0.1 * enDrop + 0.04 * sub) / Math.max(0.25, amp) * 0.5 : 0], 12);
    fc.set([1 + kick * 0.22 * V.golpe * R, hueco, ((F.capas ? 1.6 : 1.1) + dropG * 3 + kick) * (H / 1000), 0], 16);
    fc.set([F.barrido, clamp(F.zoom * (kick * 0.12 * V.golpe + dropG * 0.3 + sub * sub * 0.08) * R, 0, 0.5), ESPEJO.indexOf(F.espejo), 0], 20);
    const CP = this.capas;
    fc.set([CP.forma, CP.radio, CP.mezcla, CP.scope], 28);
    fc.set(this.onda, 32);

    let fuente;
    if (ext) fuente = this.dibujarMotor(enc, ext, { kick: Math.min(1.5, kick * R), caja, drop, sub, hue: this.hue }, A, dt, iw, ih);
    if (!fuente) {
      const k = this.lado; this.lado ^= 1;
      const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.vistas[k], loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
      rp.setViewport(0, 0, iw, ih, 0, 1); rp.setScissorRect(0, 0, iw, ih);
      rp.setPipeline(this.pS); rp.setBindGroup(0, this.bgS[k]); rp.draw(3); rp.end();
      this.fracPrev = frac;
      fuente = { vista: this.vistas[k], frac };
    }
    this.fuente = fuente;
    // ---- chispas: después de la fuente, porque leen su imagen ----
    const [gP, gR, gD] = this.grupoP(fuente.vista), ff = fuente.frac;
    const fp = this.fp;
    fp.set([n, dt, t, W / H, this.cabeza % n, c0, c1, c2, wob * (0.3 + enDrop), sub, (this.semilla = (this.semilla + 17.31) % 1000), CP.flujo, ff[0], ff[1], CP.origen, 0]);
    d.queue.writeBuffer(this.up, 0, fp);
    this.cabeza = (this.cabeza + c0 + c1 + c2) % n;
    const fr = this.fr;
    fr.set([W / H, 0.0024, 0.55 * (0.6 + R * 0.4), CP.mezcla, ...D[1], ff[0], ...D[2], ff[1], 0, 0, 0, 0]);
    const cp = this.ctx.cpass(enc);
    cp.setPipeline(this.pD); cp.setBindGroup(0, gD); cp.dispatchWorkgroups(1);
    cp.setPipeline(this.pP); cp.setBindGroup(0, gP); cp.dispatchWorkgroups(Math.ceil(n / 256)); cp.end();
    // fundido desde la fuente anterior (otro motor): se queda quieta y se desvanece
    if (this.fuenteAnt) { this.mezclaF = Math.min(1, this.mezclaF + dt / 1.1); if (this.mezclaF >= 1) this.fuenteAnt = null; }
    const ant = this.fuenteAnt, mz = this.mezclaF * this.mezclaF * (3 - 2 * this.mezclaF);
    fc.set([fuente.frac[0], fuente.frac[1]], 2);
    fc.set(ant ? [ant.frac[0], ant.frac[1], mz, 0] : [1, 1, 1, 0], 24);
    // el color de los presets ajenos gira desde su color original cuando la sala cambia de matiz (salvo los que ya leen uHue)
    fc[19] = ext && this.motorAct !== 'gl' && F.color !== 'fijas' ? this.hue - this.hue0 : ext && this.motorAct === 'gl' && this.sel && this.sel.m === 'isf' && F.color !== 'fijas' ? this.hue - this.hue0 : 0;
    d.queue.writeBuffer(this.uc, 0, fc);
    this.fr[12] = fc[19]; d.queue.writeBuffer(this.ur, 0, this.fr);
    const rc = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rc.setPipeline(this.pC); rc.setBindGroup(0, this.grupoC(fuente.vista, ant ? ant.vista : fuente.vista)); rc.draw(3);
    rc.setPipeline(this.pR); rc.setBindGroup(0, gR); rc.draw(6, n); rc.end();

    this.post.bloom = 0.14 + kick * 0.12 * V.golpe + drop * 0.3 * V.destello;
    this.post.exposure = 0.92 + dropG * 0.15;
    this.pulso = kick;
    this.hud(A, dt);
  }
  // dibuja el preset del motor activo a resolución interna y devuelve { vista, frac } para la composición
  dibujarMotor(enc, M, env, A, dt, iw0, ih0) {
    const d = this.ctx.device, W = this.ctx.W, H = this.ctx.H, S = this.ctx.sonido;
    // los motores externos cambian de tamaño solo por escalones de 1/8: cada cambio les borra el eco (feedback),
    // y el gobernador mueve la resolución interna casi en cada cuadro
    const e = iw0 / W;
    if (!this.escM || Math.abs(e - this.escM) > 0.15 || e > this.escM + 0.07) this.escM = Math.min(1, Math.ceil(e * 8 - 0.01) / 8);
    const iw = Math.max(16, Math.round(W * this.escM)), ih = Math.max(16, Math.round(H * this.escM));
    const E = this.oido.leer(S && S.analizador, A, env, dt);
    E.espectro = this.oido.espectro;
    try {
      if (this.motorAct === 'gl') {
        M.tam(iw, ih); M.ponerAudio(this.oido.espectro, this.oido.onda); M.dibujar(E, dt);
        d.queue.copyExternalImageToTexture({ source: M.canvas }, { texture: this.ext.gl }, [M.w, M.h]);
        return { vista: this.ext.glV, frac: [M.w / W, M.h / H] };
      }
      if (this.motorAct === 'md') {
        if (!M.actual) return null;
        M.conectar(S && S.analizador); M.tam(iw, ih); M.dibujar();
        // capa de efecto encima: el motor GL filtra el canvas de MilkDrop
        const G = this.capaSel && this.motores.gl;
        if (G && G.filtro) { G.ponerAudio(this.oido.espectro, this.oido.onda); G.filtrarFuente(M.canvas, E, dt); d.queue.copyExternalImageToTexture({ source: G.canvas }, { texture: this.ext.md }, [G.w, G.h]); }
        else d.queue.copyExternalImageToTexture({ source: M.canvas }, { texture: this.ext.md }, [M.w, M.h]);
        return { vista: this.ext.mdV, frac: [M.w / W, M.h / H] };
      }
      if (this.motorAct === 'wgsl') {
        M.tam(W, H, iw, ih); M.dibujar(enc, E, dt, this.oido.onda);
        return M.vista ? { vista: M.vista, frac: [M.w / W, M.h / H] } : null;
      }
    } catch (e) {
      console.warn('[señal] motor', this.motorAct, e);
      if (this.sel) this.cat.marcarMalo(this.sel.id);
      this.motorAct = 'senal'; this.cargar(this.i); this.codigo();
    }
    return null;
  }
  // HUD: línea viva de la música y nivel real de calidad (sin rehacer el DOM cada cuadro)
  hud(A, dt) {
    let txt;
    if (A.pista) {
      const Pi = this.pista, b = A.bandas || [0, 0, 0], bar = (v) => '▁▂▃▄▅▆▇█'[Math.max(0, Math.min(7, Math.round(v * 7)))];
      const t = Pi.fuente === 'archivo' ? `${Math.floor(Pi.pos() / 60)}:${String(Math.floor(Pi.pos() % 60)).padStart(2, '0')}` : 'en vivo';
      const extra = Pi.analizando != null ? ` · escuchando la canción ${Math.round(Pi.analizando * 100)} %` : Pi.tono ? ' · ' + Pi.tono : '';
      txt = `.${SEC_NOMBRE[A.seccion] || A.seccion}  ${bar(b[0])}${bar(b[1])}${bar(b[2])}  ${Pi.fuente === 'archivo' && !Pi.sonando ? 'en pausa · ' : ''}${t}${extra}`;
    } else if (A.real && A.seccion) {
      const cel = 16, llenas = Math.round(A.prog * cel);
      txt = `.${SEC_NOMBRE[A.seccion] || A.seccion}  ${'▮'.repeat(llenas)}${'▯'.repeat(cel - llenas)}  ${A.compas + 1} / ${A.compases}`;
    } else txt = '.pulso()  (el audio arranca con la primera tecla)';
    if (txt !== this.vivoTxt) { this.vivoTxt = txt; if (this.vivoEl) this.vivoEl.lastChild.textContent = '  ' + txt; }
    this.calT += dt;
    if (this.calT > 0.5) {
      this.calT = 0;
      const el = document.getElementById('f-calidad');
      const c = this.ctx.calidad, s = `calidad ${c ? c.nombre : ''} · real ${Math.round(this.nivel * 100)} % · carga ${this.sala ? this.sala.carga : 'media'}`;
      if (el && s !== this.calTxt) { this.calTxt = s; el.textContent = s; }
    }
  }
  lectura() { const A = this.A || {}; if (A.pista) return `tu música · ${this.pista.nombre}${A.seccion ? ' · ' + A.seccion : ''}`; return `${SENAL_ESTILOS[this.estiloI].nombre}${A.seccion ? ' · ' + A.seccion : ''} · nivel real ${Math.round(this.nivel * 100)} %`; }
  stats() {
    const W = this.ctx.W, H = this.ctx.H, iw = Math.round(W * this.esc), ih = Math.round(H * this.esc);
    return [['píxeles generados / frame', (iw * ih).toLocaleString('es-ES'), true], ['nivel real', Math.round(this.nivel * 100) + ' %'], ['resolución interna', `${iw} × ${ih}`],
      ['chispas', (this.nAct || 0).toLocaleString('es-ES')], ['estilo', SENAL_ESTILOS[this.estiloI].nombre], ['sección', (this.A && this.A.seccion) || '—'], ['preset', this.sel ? this.sel.n : this.P.nombre], ['motor', this.motorAct], ['pulso', (this.pulso || 0).toFixed(2)]];
  }
  destroy() {
    this.muerta = true;
    for (const k in this.motores) { try { this.motores[k].destroy(); } catch {} }
    for (const k of ['gl', 'md']) if (this.ext[k]) this.ext[k].destroy();
    this.tex.forEach((t) => t.destroy()); [this.u, this.uc, this.up, this.ur, this.ps].forEach((b) => b.destroy());
    this.ctx.capa.innerHTML = '';
    if (this.quitarOyente) this.quitarOyente();
    if (window.__senal && window.__senal._yo === this) delete window.__senal;
  }
}
