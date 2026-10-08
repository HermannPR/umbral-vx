// Sala «Señal»: un sintetizador de video encadenable, en homenaje al lenguaje de Hydra (Olivia Jack).
// Implementación propia (Hydra es AGPL; aquí no hay código suyo): un sombreador «uber» que interpreta un
// parche — una fuente, transformaciones de coordenadas, operaciones de color y retroalimentación —.
// La música sale de la máquina de estilos de sonido.js (brostep 2010, synthwave, hyperpop, ambient, techno),
// y la imagen lee su misma línea de tiempo: bombos, cajas, el filtro del bajo y los drops, en el instante
// que se oye. Encima, un osciloscopio con la onda real de la mezcla y chispas que estallan en el drop.
// Calidad adaptativa: si el cuadro se pasa de presupuesto, baja la resolución interna (sin realojar:
// se dibuja en una parte de la textura) y el número de chispas, con suavidad; el HUD muestra el nivel real.
import { makeShader, U } from '../gpu.js';
import { FS_VERT } from '../util.js';
import { SENAL_ESTILOS } from '../sonido.js';

const FUENTES = { osc: 0, noise: 1, voronoi: 2, shape: 3 };
const GEO = { rotate: 1, scale: 2, kaleid: 3, scroll: 4, pixelate: 5, repeat: 6, modulate: 7, modulateRotate: 8, modulateScale: 9 };
const COL = { posterize: 1, thresh: 2, contrast: 3, invert: 4, brillo: 5 };
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
];
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
  // shape: polígono regular de a lados, radio b, suavizado c
  let ang = atan2(p.x, p.y) + 3.14159265;
  let r = TAU / max(3.0, a);
  let d = cos(floor(0.5 + ang / r) * r - ang) * length(p);
  return vec3f(1.0 - smoothstep(b, b + c + 0.001, d));
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
    else {
      let m = fuente(o.b.y, p, o.b.z, 0.1, 0.5);
      if (id < 7.5) { p += (m.xy - 0.5) * p1; }
      else if (id < 8.5) { p = rot((m.x - 0.5) * p1) * p; }
      else { p *= 1.0 + (m.x - 0.5) * p1; }
    }
  }
  var c = fuente(u.s.x, p, u.s.y, u.s.z, u.s.w);
  for (var k = 0; k < i32(u.s2.x); k++) {
    let o = u.col[k];
    if (o.x < 1.5) { c = floor(pow(c, vec3f(o.z)) * o.y) / o.y; }
    else if (o.x < 2.5) { c = vec3f(smoothstep(o.y - o.z, o.y + o.z, lum(c))); }
    else if (o.x < 3.5) { c = (c - 0.5) * o.y + 0.5; }
    else if (o.x < 4.5) { c = mix(c, 1.0 - c, o.y); }
    else { c += o.y; }
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
  let uvp = clamp(espejo(qf), vec2f(0.002), vec2f(0.998)) * u.vp.xy;
  let prev = textureSampleLevel(previo, smp, uvp, 0.0).rgb;
  return vec4f(max(duo, prev * u.s2.z), 1.0);
}
`;

// composición a resolución completa: lo barato va aquí (aberración, cortes, destello, osciloscopio)
const COMP = FS_VERT + /* wgsl */`
struct CU {
  a: vec4f,  // ancho, alto de salida, fracción interna x, y
  b: vec4f,  // t, golpe, caja, drop
  c: vec4f,  // destello, inversión, croma, cortes
  d: vec4f,  // tinta clara rgb, amplitud del osciloscopio
  e: vec4f,  // bombeo, apagón (hueco antes del drop), grosor de línea (px), _
  onda: array<vec4f, 64>,
};
@group(0) @binding(0) var<uniform> cu: CU;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
fn h1(x: f32) -> f32 { return fract(sin(x * 91.345) * 47453.5453); }
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
  uv = (uv - 0.5) * (1.0 - cu.b.y * 0.03 - cu.b.w * 0.07) + 0.5;
  let fr2 = cu.a.zw; let dir = uv - 0.5; let cr = cu.c.z;
  let lo = vec2f(0.001); let hi = vec2f(0.999);
  let r = textureSampleLevel(src, smp, clamp(uv + dir * cr, lo, hi) * fr2, 0.0).r;
  let gg = textureSampleLevel(src, smp, clamp(uv, lo, hi) * fr2, 0.0).g;
  let b = textureSampleLevel(src, smp, clamp(uv - dir * cr, lo, hi) * fr2, 0.0).b;
  var c = vec3f(r, gg, b) * cu.e.x * (1.0 - cu.e.y * 0.88);
  // osciloscopio: la onda real de la mezcla cruzando la lámina
  let amp = cu.d.w;
  if (amp > 0.0005) {
    let y = 0.5 + ondaEn(i.pos.x / res.x) * amp;
    let dpx = abs(i.pos.y / res.y - y) * res.y;
    c += cu.d.rgb * exp(-dpx * dpx / (cu.e.z * cu.e.z)) * (0.7 + cu.e.y);
  }
  c = mix(c, vec3f(1.0) - c, cu.c.y);
  c = mix(c, vec3f(1.6, 1.52, 1.4), cu.c.x);
  return vec4f(c, 1.0);
}
`;

// chispas: anillo de cada bombo, implosión durante la subida y estallido del drop
const PART = /* wgsl */`
struct P { a: vec4f, b: vec4f };   // a: posición, velocidad · b: vida, vida inicial, tamaño, tipo
struct PU { a: vec4f, b: vec4f, c: vec4f };   // a: n, dt, t, aspecto · b: cabeza, implosión, anillo, estallido · c: wob, subida, semilla, _
@group(0) @binding(0) var<storage, read_write> ps: array<P>;
@group(0) @binding(1) var<uniform> pu: PU;
fn hs(n: f32) -> f32 { return fract(sin(n) * 43758.5453); }
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
    p.a = vec4f(d * 0.05, d * (0.9 + r2 * 1.0));
    p.b = vec4f(0.55, 0.55, 0.5 + r3 * 0.5, 1.0);
  } else if (rel < c0 + c1 + c2) {
    p.a = vec4f(d * r3 * 0.06, d * (0.4 + sqrt(r2) * 3.0));
    p.b = vec4f(1.4 + r3, 1.4 + r3, 0.6 + r1 * 0.8, 2.0);
  } else if (p.b.x > 0.0) {
    let dt = pu.a.y; let q = p.a.xy; let w = pu.c.x;
    let giro = vec2f(-q.y, q.x) * w * 1.4;
    let ola = vec2f(sin(q.y * 7.0 + pu.a.z * 3.0), cos(q.x * 6.0 - pu.a.z * 2.0)) * w * 0.9;
    var v = p.a.zw + (giro + ola) * dt;
    v *= exp(-dt * select(2.0, 0.4, p.b.w < 0.5));
    p.a = vec4f(q + v * dt, v);
    p.b.x -= dt;
  }
  ps[i] = p;
}
`;
const PART_R = /* wgsl */`
struct P { a: vec4f, b: vec4f };
struct RU { a: vec4f, c: vec4f, d: vec4f };   // a: aspecto, ancho, intensidad · c, d: tintas
@group(0) @binding(0) var<storage, read> ps: array<P>;
@group(0) @binding(1) var<uniform> ru: RU;
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) a: f32, @location(2) k: f32 };
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
  o.k = p.b.w;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  let s = (1.0 - i.uv.y * i.uv.y) * (1.0 - smoothstep(0.2, 1.0, abs(i.uv.x)));
  let col = mix(ru.c.rgb, ru.d.rgb, clamp(i.k * 0.5, 0.0, 1.0));
  return vec4f(col * s * i.a * ru.a.z, 0.0);
}
`;

const fmtN = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, '');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const U_GEN = 144 + 6 * 32 + 6 * 16, U_COMP = 80 + 64 * 16;

export default class Senal {
  static palettes = DUOS.map((d) => d.nombre);
  static controls = { ls: '↕ elegir línea · ↔ ajustar su valor', trig: '− / + cuánto golpean los visuales', a: 'saltar al drop (o salir de él)', y: 'siguiente parche' };
  static info = { title: 'Señal', desc: '' };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 0.92, bloom: 0.14, vignette: 0.5, lift: [0.02, 0.018, 0.015], grain: 0.04 }; this.sonido = {}; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    // texturas internas del tamaño de la salida; la escala adaptativa dibuja solo una parte (no se realoja)
    this.tex = [0, 1].map(() => d.createTexture({ size: [W, H], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    this.vistas = this.tex.map((t) => t.createView());
    this.u = U.uniform(d, U_GEN); this.uc = U.uniform(d, U_COMP); this.up = U.uniform(d, 48); this.ur = U.uniform(d, 48);
    this.fu = new Float32Array(U_GEN / 4); this.fc = new Float32Array(U_COMP / 4); this.fp = new Float32Array(12); this.fr = new Float32Array(12);
    this.smp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const m = makeShader(d, SH, 'senal', report), mc = makeShader(d, COMP, 'senal-comp', report);
    const mp = makeShader(d, PART, 'senal-chispas', report), mr = makeShader(d, PART_R, 'senal-chispas-r', report);
    const suma = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
    [this.pS, this.pC, this.pP, this.pR] = await Promise.all([
      d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } }),
      d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mc, entryPoint: 'vs' }, fragment: { module: mc, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } }),
      d.createComputePipelineAsync({ layout: 'auto', compute: { module: mp, entryPoint: 'cs' } }),
      d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mr, entryPoint: 'vs' }, fragment: { module: mr, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: suma }] } }),
    ]);
    // chispas: el máximo depende del preset de calidad; el gobernador usa una fracción
    this.nMax = Math.max(4096, Math.round((32768 * (this.ctx.calidad ? this.ctx.calidad.carga : 1)) / 256) * 256);
    this.ps = U.storage(d, this.nMax * 32);
    this.bgS = [0, 1].map((k) => d.createBindGroup({ layout: this.pS.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.u } }, { binding: 1, resource: this.vistas[1 - k] }, { binding: 2, resource: this.smp }] }));
    this.bgC = [0, 1].map((k) => d.createBindGroup({ layout: this.pC.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uc } }, { binding: 1, resource: this.vistas[k] }, { binding: 2, resource: this.smp }] }));
    this.bgP = d.createBindGroup({ layout: this.pP.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ps } }, { binding: 1, resource: { buffer: this.up } }] });
    this.bgR = d.createBindGroup({ layout: this.pR.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ps } }, { binding: 1, resource: { buffer: this.ur } }] });
    this.lado = 0; this.reac = 1; this.linea = 0; this.ultNav = 0; this.t0 = performance.now(); this.edad = 0;
    // gobernador: nivel 0..1 → resolución interna 42..100 % y chispas 15..100 %
    this.nivel = 0.85; this.nivelObj = 0.85; this.sobre = 0; this.holgura = 0; this.enfr = 0; this.lento = 0;
    this.fracPrev = [this.esc, this.esc]; this.cabeza = 0; this.ultKick = -1; this.ultDrop = -1; this.semilla = 0;
    this.onda = new Float32Array(256); this.tdom = new Float32Array(1024);
    this.chaosPrev = this.chaos; this.vivoTxt = ''; this.calTxt = ''; this.calT = 0;
    this.estiloI = 0; this.i = 0;
    this.ponerEstilo(0);
    const yo = this;
    window.__senal = {
      estilos: SENAL_ESTILOS.map((e) => e.nombre),
      estado: () => { const A = yo.A || {}; return { estilo: SENAL_ESTILOS[yo.estiloI].nombre, parche: yo.P.nombre, audio: { real: !!A.real, estilo: A.estilo, seccion: A.seccion, adelanto: A.adelanto, tKick: A.tKick, tv: A.tv }, nivel: yo.nivel, esc: yo.esc, chispas: yo.nAct, frac: yo.fracPrev }; },
      lento: (ms) => { yo.lento = ms; },
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
  }
  partitura() { const S = this.ctx.sonido, p = S && S.actual; return p && p.estado && !p.muerto && S.ac && S.ac.state === 'running' ? p : null; }
  saltar() { const p = this.partitura(); if (p) p.saltarAlDrop(); }
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
  codigo() {
    const L = this.lineas(), E = SENAL_ESTILOS[this.estiloI];
    this.nLineas = L.length;
    this.ctx.capa.innerHTML = `<div style="position:absolute;left:44px;top:38px;font:400 13px/1.75 var(--mono);color:var(--papel-2);
      padding:14px 18px 14px 16px;background:rgba(12,11,9,.72);border-left:1px solid var(--acento)">
      <div class="rotulo-t" style="margin-bottom:6px">estilo ${this.estiloI + 1} / ${SENAL_ESTILOS.length} · parche ${this.i + 1} / ${PARCHES.length} · ${this.P.nombre}</div>
      <div style="white-space:pre;color:var(--papel)"><span style="display:inline-block;width:14px"></span>musica('${E.nombre}', ${E.bpm})</div>
      <div id="senal-vivo" style="white-space:pre;color:var(--acento);margin-bottom:4px"><span style="display:inline-block;width:14px"></span>  ${this.vivoTxt}</div>
      ${L.map((l, k) => `<div style="white-space:pre;${k === this.linea ? 'color:var(--papel)' : ''}"><span style="display:inline-block;width:14px;color:var(--acento)">${k === this.linea ? '›' : ''}</span>${k ? '  ' : ''}${l.txt}</div>`).join('')}
      <div class="rotulo" style="margin-top:10px;color:var(--papel-3)">inspirado en Hydra (hydra.ojack.xyz) · implementación propia</div></div>`;
    this.vivoEl = document.getElementById('senal-vivo');
  }
  ajustar(dir) {
    const l = this.lineas()[this.linea];
    if (!l || !l.ref) { this.palette = (this.palette + dir + DUOS.length) % DUOS.length; this.palPrev = this.palette; this.codigo(); return; }
    const r = l.ref, k = l.idx, v = r[k];
    if (r === this.P.fb) r[0] = Math.min(0.97, Math.max(0, v + dir * 0.03));
    else if (r[0] === 'kaleid' || r[0] === 'posterize' || r[0] === 'shape' || r[0] === 'repeat') r[k] = Math.max(1, v + dir);
    else r[k] = v * (dir > 0 ? 1.12 : 1 / 1.12);
    this.codigo();
  }
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
    if (this.chaos !== this.chaosPrev) {   // Y / C: siguiente parche (main.js lo anuncia como alternancia; aquí se corrige el aviso)
      this.chaosPrev = this.chaos; this.cargar(this.i + 1); this.codigo();
      const av = document.getElementById('aviso'); if (av) av.textContent = 'Parche · ' + this.P.nombre;
    }
    if (this.palette !== this.palPrev) { this.palPrev = this.palette; this.codigo(); }
    if (now - this.ultNav > 170) {
      if (inp.ly < -0.6) { this.linea = (this.linea - 1 + this.nLineas) % this.nLineas; this.ultNav = now; this.codigo(); }
      else if (inp.ly > 0.6) { this.linea = (this.linea + 1) % this.nLineas; this.ultNav = now; this.codigo(); }
      else if (inp.lx > 0.6) { this.ajustar(1); this.ultNav = now; }
      else if (inp.lx < -0.6) { this.ajustar(-1); this.ultNav = now; }
    }
    this.reac = clamp(this.reac + (inp.r2 - inp.l2) * dt, 0, 2);

    // ---- envolventes a partir de la música que se oye ----
    const A = this.A = this.audio(), tv = A.tv, V = VISTA[this.estiloI], R = this.reac;
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

    // ---- generador a resolución interna ----
    const esc = this.esc, iw = Math.max(32, Math.round(W * esc)), ih = Math.max(32, Math.round(H * esc));
    const P = this.P, f = this.fu;
    const sh = (sub * sub * 0.012 + dropG * 0.03 + kick * 0.005 * V.golpe) * R;
    f.set([iw, ih, t, P.geo.length], 0);
    f.set([FUENTES[P.fuente[0]], P.fuente[1], P.fuente[2] || 0, P.fuente[3] || 0], 4);
    f.set([P.col.length, P.croma, Math.min(0.93, P.fb[0] + drop * 0.03), P.fb[1] + kick * 0.004 * R], 8);
    f.set([P.fb[2], kick * R, wob, 0], 12);
    const D = DUOS[this.palette].c;
    f.set([...D[0], 0], 16); f.set([...D[1], 0], 20); f.set([...D[2], 0], 24);
    f.set([kick * V.golpe * R, wob * V.tor * R * (0.4 + enDrop * 0.6), sub * R, dropG * V.golpe * R], 28);
    f.set([this.fracPrev[0], this.fracPrev[1], (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh], 32);
    f.fill(0, 36);
    P.geo.forEach((g, k) => {
      const o = 36 + k * 8, mod = g.find((x) => x && typeof x === 'object');
      const nums = g.slice(1).filter((x) => typeof x === 'number');
      if (mod) f.set([GEO[g[0]], nums[0], 0, 0, 0, FUENTES[mod.src], mod.f, nums[1] || 0], o);
      else f.set([GEO[g[0]], nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0, 0, 0, 0], o);
    });
    P.col.forEach((c, k) => f.set([COL[c[0]], c[1] ?? 0, c[2] ?? 1, 0], 84 + k * 4));
    d.queue.writeBuffer(this.u, 0, f);

    // ---- composición ----
    const amp = this.leerOnda();
    const fc = this.fc, frac = [iw / W, ih / H];
    fc.set([W, H, frac[0], frac[1]], 0);
    fc.set([t, kick * V.golpe * R, caja, dropG * R], 4);
    fc.set([clamp((dropG * dropG * 0.9 + caja * sub * 0.2) * V.destello * R, 0, 1), inv, (0.0015 + kick * 0.007 + dropG * 0.02 + wob * enDrop * 0.004) * V.croma * R, clamp((caja * 0.8 + dropG) * V.glitch * R, 0, 1.5)], 8);
    fc.set([...D[2], (0.05 + 0.1 * enDrop + 0.04 * sub) / Math.max(0.25, amp) * 0.5], 12);
    fc.set([1 + kick * 0.22 * V.golpe * R, hueco, (1.1 + dropG * 3 + kick) * (H / 1000), 0], 16);
    fc.set(this.onda, 20);
    d.queue.writeBuffer(this.uc, 0, fc);

    // ---- chispas ----
    const fp = this.fp;
    fp.set([n, dt, t, W / H, this.cabeza % n, c0, c1, c2, wob * (0.3 + enDrop), sub, (this.semilla = (this.semilla + 17.31) % 1000), 0]);
    d.queue.writeBuffer(this.up, 0, fp);
    this.cabeza = (this.cabeza + c0 + c1 + c2) % n;
    const fr = this.fr;
    fr.set([W / H, 0.0024, 0.55 * (0.6 + R * 0.4), 0, ...D[1], 0, ...D[2], 0]);
    d.queue.writeBuffer(this.ur, 0, fr);

    const cp = this.ctx.cpass(enc); cp.setPipeline(this.pP); cp.setBindGroup(0, this.bgP); cp.dispatchWorkgroups(Math.ceil(n / 256)); cp.end();
    const k = this.lado; this.lado ^= 1;
    const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.vistas[k], loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rp.setViewport(0, 0, iw, ih, 0, 1); rp.setScissorRect(0, 0, iw, ih);
    rp.setPipeline(this.pS); rp.setBindGroup(0, this.bgS[k]); rp.draw(3); rp.end();
    const rc = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rc.setPipeline(this.pC); rc.setBindGroup(0, this.bgC[k]); rc.draw(3);
    rc.setPipeline(this.pR); rc.setBindGroup(0, this.bgR); rc.draw(6, n); rc.end();
    this.fracPrev = frac;

    this.post.bloom = 0.14 + kick * 0.12 * V.golpe + drop * 0.3 * V.destello;
    this.post.exposure = 0.92 + dropG * 0.15;
    this.pulso = kick;
    this.hud(A, dt);
  }
  // HUD: línea viva de la música y nivel real de calidad (sin rehacer el DOM cada cuadro)
  hud(A, dt) {
    let txt;
    if (A.real && A.seccion) {
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
  lectura() { const A = this.A || {}; return `${SENAL_ESTILOS[this.estiloI].nombre}${A.seccion ? ' · ' + A.seccion : ''} · nivel real ${Math.round(this.nivel * 100)} %`; }
  stats() {
    const W = this.ctx.W, H = this.ctx.H, iw = Math.round(W * this.esc), ih = Math.round(H * this.esc);
    return [['píxeles generados / frame', (iw * ih).toLocaleString('es-ES'), true], ['nivel real', Math.round(this.nivel * 100) + ' %'], ['resolución interna', `${iw} × ${ih}`],
      ['chispas', (this.nAct || 0).toLocaleString('es-ES')], ['estilo', SENAL_ESTILOS[this.estiloI].nombre], ['sección', (this.A && this.A.seccion) || '—'], ['parche', this.P.nombre], ['pulso', (this.pulso || 0).toFixed(2)]];
  }
  destroy() {
    this.tex.forEach((t) => t.destroy()); [this.u, this.uc, this.up, this.ur, this.ps].forEach((b) => b.destroy());
    this.ctx.capa.innerHTML = '';
    if (window.__senal && window.__senal._yo === this) delete window.__senal;
  }
}
