// Sala 2: fractales 3D (Mandelbulb / Mandelbox) por raymarching en compute, resolución nativa,
// y un tercer modo 2D: Mandelbrot profundo (zoom sin fondo; ver profundo.js e investigacion/ZOOM-INFINITO.md).
import { makeShader, Counters, U } from '../gpu.js';
import { v3, fmt } from '../util.js';
import Galvanizado, { MODOS_GALV, tiempoColor } from './galvanizado.js';

const CS = /* wgsl */`
// q..q4 solo cambian en el modo grabación (window.__fractalRec); los valores por omisión dan la imagen de siempre.
// q: muestras, índice de muestra, desplazamiento subpíxel · q2: iteraciones bulbo, iteraciones caja, ε por píxel, pasos de referencia del halo
// q3: lente (x, y), distancia de foco, pasos de sombra · q4: radio de la esfera envolvente, forzar bulbo genérico, halo, fondo
struct Uni { pos: vec4f, right: vec4f, up: vec4f, fwd: vec4f, prm: vec4f, res: vec4f, light: vec4f, q: vec4f, q2: vec4f, q3: vec4f, q4: vec4f };
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<storage, read_write> cnt: array<atomic<u32>, 4>;
@group(0) @binding(3) var<storage, read_write> acc: array<vec4f>;
var<workgroup> redA: array<u32, 64>;
var<workgroup> redB: array<u32, 64>;

// potencia 8 polinómica (sin trigonometría): camino rápido
fn deBulb8(p: vec3f) -> vec2f {
  var w = p; var m = dot(w, w); var dz = 1.0; var trap = 1e9;
  let nIt = i32(u.q2.x);
  for (var i = 0; i < nIt; i++) {
    dz = 8.0 * pow(m, 3.5) * dz + 1.0;
    let x = w.x; let x2 = x * x; let x4 = x2 * x2;
    let y = w.y; let y2 = y * y; let y4 = y2 * y2;
    let z = w.z; let z2 = z * z; let z4 = z2 * z2;
    let k3 = max(x2 + z2, 1e-5);
    let k2 = inverseSqrt(k3 * k3 * k3 * k3 * k3 * k3 * k3);
    let k1 = x4 + y4 + z4 - 6.0 * y2 * z2 - 6.0 * x2 * y2 + 2.0 * z2 * x2;
    let k4 = x2 - y2 + z2;
    w = p + vec3f(64.0 * x * y * z * (x2 - z2) * k4 * (x4 - 6.0 * x2 * z2 + z4) * k1 * k2,
                  -16.0 * y2 * k3 * k4 * k4 + k1 * k1,
                  -8.0 * y * k4 * (x4 * x4 - 28.0 * x4 * x2 * z2 + 70.0 * x4 * z4 - 28.0 * x2 * z2 * z4 + z4 * z4) * k1 * k2);
    m = dot(w, w);
    trap = min(trap, m);
    if (m > 4.0) { break; }
  }
  return vec2f(0.25 * log(m) * sqrt(m) / dz, trap);
}

fn deBulb(p: vec3f) -> vec2f {
  if (abs(u.prm.z - 8.0) < 0.001 && u.q4.y < 0.5) { return deBulb8(p); }
  var z = p; var dr = 1.0; var r = length(z); var trap = 1e9;
  let P = u.prm.z;
  let nIt = i32(u.q2.x) + 2;           // la trigonométrica converge más lento: dos más (igual en deBulb de JS)
  for (var i = 0; i < nIt; i++) {
    r = length(z);
    if (r > 2.0) { break; }
    let theta = acos(clamp(z.y / r, -1.0, 1.0)) * P;
    let phi = atan2(z.x, z.z) * P;        // misma convención que deBulb8: con P = 8 dan el mismo fractal
    let rp = pow(r, P - 1.0);
    dr = rp * P * dr + 1.0;
    let zr = rp * r;
    z = zr * vec3f(sin(theta) * sin(phi), cos(theta), sin(theta) * cos(phi)) + p;
    trap = min(trap, dot(z, z));
  }
  return vec2f(0.5 * log(max(r, 1e-6)) * r / dr, trap);
}

fn deBox(p: vec3f) -> vec2f {
  let s = u.res.z;
  var z = p; var dr = 1.0; var trap = 1e9;
  let nIt = i32(u.q2.y);
  for (var i = 0; i < nIt; i++) {
    z = clamp(z, vec3f(-1.0), vec3f(1.0)) * 2.0 - z;
    let r2 = dot(z, z);
    if (r2 < 0.25) { z *= 4.0; dr *= 4.0; }
    else if (r2 < 1.0) { z /= r2; dr /= r2; }
    z = z * s + p;
    dr = dr * abs(s) + 1.0;
    trap = min(trap, r2);
  }
  return vec2f(length(z) / abs(dr), trap);
}

fn map(p: vec3f) -> vec2f {
  if (u.prm.y < 0.5) { return deBulb(p); }
  return deBox(p);
}

fn pal(t: f32) -> vec3f {
  let k = u.res.w;
  if (k > 3.5) { return vec3f(0.55); }
  var a = vec3f(0.6, 0.42, 0.3); var b = vec3f(0.45, 0.35, 0.3); var c = vec3f(1.0); var d = vec3f(0.0, 0.15, 0.35);
  if (k > 0.5 && k < 1.5) { a = vec3f(0.45, 0.6, 0.72); b = vec3f(0.3, 0.3, 0.32); d = vec3f(0.5, 0.55, 0.62); }
  else if (k > 1.5 && k < 2.5) { a = vec3f(0.5); b = vec3f(0.5); d = vec3f(0.0, 0.33, 0.67); }
  else if (k > 2.5) { a = vec3f(0.18, 0.17, 0.22); b = vec3f(0.22, 0.14, 0.3); c = vec3f(2.0, 1.0, 1.0); d = vec3f(0.5, 0.2, 0.25); }
  return a + b * cos(6.2831853 * (c * t + d));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  let W = u32(u.res.x); let H = u32(u.res.y);
  var evals = 0u; var prim = 0u;
  if (gid.x < W && gid.y < H) {
    let isBox = u.prm.y > 0.5;
    let ws = select(1.0, 4.0, isBox);
    let uv = (vec2f(gid.xy) + 0.5 + u.q.zw - 0.5 * u.res.xy) / u.res.y;
    var rd = normalize(u.fwd.xyz * u.pos.w + u.right.xyz * uv.x - u.up.xyz * uv.y);
    var ro = u.pos.xyz;
    // profundidad de campo (solo grabación): el rayo sale de un punto de la lente y pasa por el plano de foco
    if (u.q3.z > 0.0) {
      let fp = ro + rd * (u.q3.z / dot(rd, u.fwd.xyz));
      ro = ro + u.right.xyz * u.q3.x + u.up.xyz * u.q3.y;
      rd = normalize(fp - ro);
    }
    let maxT = select(8.0, 50.0, isBox);
    let maxS = i32(u.prm.w);
    var t = 0.0; var hit = false; var trap = 0.0; var eps = 0.0;
    // recorte con esfera envolvente del Mandelbulb
    if (!isBox) {
      let b = dot(ro, rd); let c = dot(ro, ro) - u.q4.x * u.q4.x; let h = b * b - c;
      if (h > 0.0) { t = max(0.0, -b - sqrt(h)); } else { t = maxT; }
    }
    for (var i = 0; i < maxS; i++) {
      if (t >= maxT) { break; }
      let h = map(ro + rd * t);
      evals++; prim++;
      eps = max(t * u.right.w * u.q2.z, 2e-6);
      if (h.x < eps) { hit = true; trap = h.y; break; }
      t += h.x * select(0.95, 0.85, isBox);
    }
    let L = normalize(u.light.xyz);
    let gl = f32(prim) / u.q2.w;
    var bg = mix(vec3f(0.012, 0.014, 0.03), vec3f(0.05, 0.03, 0.08), clamp(0.5 - uv.y, 0.0, 1.0)) * u.q4.w;
    bg += pal(0.65 + u.prm.x * 0.01) * min(gl * gl, 4.0) * u.q4.z;
    var col = bg;
    if (hit) {
      let p = ro + rd * t;
      let e = eps * 0.5;
      let k = vec2f(1.0, -1.0);
      let n = normalize(k.xyy * map(p + k.xyy * e).x + k.yyx * map(p + k.yyx * e).x + k.yxy * map(p + k.yxy * e).x + k.xxx * map(p + k.xxx * e).x);
      evals += 4u;
      // escala local: de cerca (t chico) la sombra y la oclusión se miden en el tamaño de lo que se ve, no en absoluto
      let sc = clamp(t * 2.0, 2e-4, 1.0) * ws;
      // sombra suave
      var sh = 1.0; var st = 0.004 * sc;
      let p0 = p + n * eps * 3.0;
      let nSh = i32(u.q3.w);
      for (var j = 0; j < nSh; j++) {
        let h = map(p0 + L * st).x; evals++;
        sh = min(sh, 10.0 * h / st);
        st += clamp(h, 0.003 * sc, 0.2 * sc);
        if (sh < 0.002 || st > 2.5 * sc) { break; }
      }
      sh = clamp(sh, 0.0, 1.0);
      // oclusión ambiental
      var ao = 0.0; var wj = 1.0;
      for (var j = 1; j <= 4; j++) {
        let hh = (0.006 + 0.055 * f32(j)) * sc;
        ao += (hh - map(p + n * hh).x) * wj; wj *= 0.7; evals++;
      }
      ao = clamp(1.0 - 2.2 * ao / sc, 0.0, 1.0);
      var tc = sqrt(trap);
      if (isBox) { tc = log(trap + 1.0) * 0.6; }
      let alb = pal(tc * 1.7 + u.prm.x * 0.015);
      let dif = max(dot(n, L), 0.0) * sh;
      let sky = 0.5 + 0.5 * n.y;
      let rfl = reflect(rd, n);
      let spe = pow(max(dot(rfl, L), 0.0), 40.0) * sh;
      let fre = pow(clamp(1.0 + dot(n, rd), 0.0, 1.0), 3.0);
      var lin = dif * vec3f(2.4, 2.0, 1.6);
      lin += sky * vec3f(0.22, 0.3, 0.45) * ao;
      lin += fre * vec3f(0.5, 0.6, 0.9) * ao;
      col = alb * lin * (0.35 + 0.65 * ao) + spe * vec3f(3.0, 2.6, 2.2);
      if (u.res.w > 3.5) {
        // Luminancia lineal de la iluminación, sin colorear por la paleta anterior.
        let lr = dot(lin * (0.35 + 0.65 * ao), vec3f(0.2126, 0.7152, 0.0722)) * 0.32;
        col = vec3f(lr);
      }
      col = mix(col, bg, 1.0 - exp(-t * 0.05 / ws));
    }
    if (!(col.x == col.x && col.y == col.y && col.z == col.z)) { col = bg; }
    var outc = min(col, vec3f(30.0));
    // supermuestreo / desenfoque de movimiento (solo grabación): promedio ponderado 1/(1+máx) contra luciérnagas
    if (u.q.x > 1.5) {
      let ia = gid.y * W + gid.x;
      let w = 1.0 / (1.0 + max(outc.x, max(outc.y, outc.z)));
      var a = vec4f(outc * w, w);
      if (u.q.y > 0.5) { a += acc[ia]; }
      acc[ia] = a;
      outc = a.xyz / a.w;
    }
    textureStore(outTex, gid.xy, vec4f(outc, 1.0));
  }
  redA[li] = evals; redB[li] = prim;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s >>= 1u) {
    if (li < s) { redA[li] += redA[li + s]; redB[li] += redB[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) { atomicAdd(&cnt[0], redA[0]); atomicAdd(&cnt[1], redB[0]); }
}
`;

// Versión JS de los DE para que la cámara no atraviese la superficie. Tiene que ser EXACTAMENTE el mismo fractal que
// dibuja el sombreador (misma convención de φ, mismas iteraciones): si no, la cámara se mete dentro de la superficie
// dibujada y la imagen se vuelve una mancha plana (así era antes: la versión trigonométrica estaba espejada).
const ITER_BULBO = 6;            // iteraciones del Mandelbulb de lejos; de cerca suben (ver iteracionesBulbo)
const ITER_BULBO_MAX = 12;
function deBulb8(p, nIt) {
  let w = p, m = p[0] * p[0] + p[1] * p[1] + p[2] * p[2], dz = 1;
  for (let i = 0; i < nIt; i++) {
    dz = 8 * Math.pow(m, 3.5) * dz + 1;
    const [x, y, z] = w, x2 = x * x, x4 = x2 * x2, y2 = y * y, y4 = y2 * y2, z2 = z * z, z4 = z2 * z2;
    const k3 = Math.max(x2 + z2, 1e-5), k2 = 1 / Math.sqrt(k3 * k3 * k3 * k3 * k3 * k3 * k3);
    const k1 = x4 + y4 + z4 - 6 * y2 * z2 - 6 * x2 * y2 + 2 * z2 * x2, k4 = x2 - y2 + z2;
    w = [p[0] + 64 * x * y * z * (x2 - z2) * k4 * (x4 - 6 * x2 * z2 + z4) * k1 * k2,
         p[1] - 16 * y2 * k3 * k4 * k4 + k1 * k1,
         p[2] - 8 * y * k4 * (x4 * x4 - 28 * x4 * x2 * z2 + 70 * x4 * z4 - 28 * x2 * z2 * z4 + z4 * z4) * k1 * k2];
    m = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
    if (m > 4) break;
  }
  return 0.25 * Math.log(m) * Math.sqrt(m) / dz;
}
function deBulb(p, P, nIt = ITER_BULBO) {
  if (Math.abs(P - 8) < 0.001) return deBulb8(p, nIt);
  let [x, y, z] = p, dr = 1, r = Math.hypot(x, y, z);
  for (let i = 0; i < nIt + 2; i++) {
    r = Math.hypot(x, y, z); if (r > 2) break;
    const th = Math.acos(Math.max(-1, Math.min(1, y / r))) * P, ph = Math.atan2(x, z) * P, rp = Math.pow(r, P - 1);
    dr = rp * P * dr + 1; const zr = rp * r;
    x = zr * Math.sin(th) * Math.sin(ph) + p[0]; y = zr * Math.cos(th) + p[1]; z = zr * Math.sin(th) * Math.cos(ph) + p[2];
  }
  return 0.5 * Math.log(Math.max(r, 1e-6)) * r / dr;
}
// iteraciones según la cercanía: cada nivel de detalle del bulbo es ~8× más fino; a distancia d hacen falta ~log8(0.05/d) más
// (con histéresis: solo cambia cuando la cuenta ideal se aleja más de un nivel de la actual, para no oscilar)
function iteracionesBulbo(d, actual = ITER_BULBO) {
  const ideal = ITER_BULBO + Math.log(0.05 / Math.max(d, 1e-9)) / Math.log(8);
  let n = actual;
  if (ideal >= actual + 1) n = Math.floor(ideal); else if (ideal <= actual - 1.3) n = Math.ceil(ideal);
  return Math.max(ITER_BULBO, Math.min(ITER_BULBO_MAX, n));
}
function deBox(p, s) {
  let [x, y, z] = p, dr = 1;
  const f = (v) => Math.max(-1, Math.min(1, v)) * 2 - v;
  for (let i = 0; i < 12; i++) {
    x = f(x); y = f(y); z = f(z);
    const r2 = x * x + y * y + z * z;
    if (r2 < 0.25) { x *= 4; y *= 4; z *= 4; dr *= 4; } else if (r2 < 1) { x /= r2; y /= r2; z /= r2; dr /= r2; }
    x = x * s + p[0]; y = y * s + p[1]; z = z * s + p[2]; dr = dr * Math.abs(s) + 1;
  }
  return Math.hypot(x, y, z) / Math.abs(dr);
}

export default class Fractal {
  static palettes = ['Ámbar', 'Glaciar', 'Neón', 'Obsidiana', ...MODOS_GALV];
  static paletaInicial = 4;          // ciclico-A, k=1.3; las demás siguen con X
  static CONTROLES_3D = { ls: 'volar (avanzar / lateral)', rs: 'mirar', trig: '− / + potencia del fractal', a: 'cambiar Mandelbulb ⇄ Mandelbox' };
  static CONTROLES_2D = { ls: 'desplazar · arrastrar', rs: '↕ acercar / alejar · rueda', trig: '− / + zoom (exponencial)', a: 'autopiloto: bucear sin fin', y: 'siguiente marcador · G guarda · R inicio · clic vuela' };
  static activa = null;
  static get controls() { return Fractal.activa && Fractal.activa.mode === 2 && !Fractal.activa.switching ? Fractal.CONTROLES_2D : Fractal.CONTROLES_3D; }
  static MODOS = ['Mandelbulb', 'Mandelbox', 'Mandelbrot profundo'];
  static info = {
    title: 'Fractal 3D en tiempo real',
    short: 'Raymarching de Mandelbulb y Mandelbox',
    desc: 'Raymarching por píxel a resolución nativa: cada rayo evalúa la función de distancia del fractal cientos de veces, más sombras suaves y oclusión ambiental.',
  };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.0, bloom: 0.35, vignette: 0.7 }; }
  async init() {
    const { device: d, report } = this.ctx;
    this.ub = U.uniform(d, 176);
    this.accBuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE }); this.accN = 0;
    this.cnt = new Counters(d, 4, 8);
    const m = makeShader(d, CS, 'fractal', report);
    this.pipe = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
    this.grado = new Galvanizado(this.ctx); await this.grado.init();
    this.hacerBG();
    this.mode = 0; this.power = 8; this.boxScale = 2.0; this.fade = 1; this.switching = 0;
    this.pos = [0, 0.3, 2.4]; this.fwd = v3.norm(v3.mul(this.pos, -1));
    this.lastInput = -1e9; this.tt = 0; this.colorT = 0; this.maxSteps = Math.round(180 * (0.45 + 0.55 * (this.ctx.calidad ? this.ctx.calidad.carga : 1)));
    if (this.distScale) this.pos = v3.mul(this.pos, this.distScale);
    // el modo profundo solo en la sala propia (no dentro de Ensamble) y con WebGPU
    this.conProfundo = !!this.sala && this.ctx.api === 'webgpu';
    this.destino = 0; this.prof = null; this.profCarga = null;
    window.__fractal = this;             // gancho de pruebas (herramientas/probar-bulbo.mjs)
    if (this.conProfundo) {
      Fractal.activa = this;
      if (new URLSearchParams(location.search).has('profundo') && await this.cargarProfundo()) { this.mode = 2; this.destino = 2; }
    }
  }
  hacerBG() {
    this.bg = this.ctx.device.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: this.grado.rawView }, { binding: 2, resource: { buffer: this.cnt.buf } },
      { binding: 3, resource: { buffer: this.accBuf } }] });
  }
  // carga perezosa: la versión pública puede no traer profundo.js; entonces el modo no aparece
  cargarProfundo() {
    if (!this.profCarga) {
      this.profCarga = import('./profundo.js').then(async ({ default: Profundo }) => {
        const p = new Profundo(this.ctx, this); await p.init(); this.prof = p; return true;
      }).catch((e) => { this.ctx.report('profundo: ' + (e.message || e)); this.conProfundo = false; return false; });
    }
    return this.profCarga;
  }
  get nModos() { return this.conProfundo ? 3 : 2; }
  // el profundo regula su propia carga (refinamiento con presupuesto): el gobernador de calidad no lo toca
  get autoRegula() { return this.mode === 2 || this.destino === 2; }
  // para rehacer la sala (cambio de tamaño, GPU perdida, gobernador) sin perder el lugar
  guardarVista() {
    return { mode: this.switching ? this.destino : this.mode, pos: this.pos, fwd: this.fwd, power: this.power, boxScale: this.boxScale,
      palette: this.palette, chaos: this.chaos, lastInput: this.lastInput, tt: this.tt, colorT: this.colorT, prof: this.prof ? this.prof.guardarVista() : null };
  }
  async restaurarVista(v) {
    if (!v) return;
    Object.assign(this, { pos: v.pos, fwd: v.fwd, power: v.power, boxScale: v.boxScale, palette: v.palette, chaos: v.chaos, lastInput: v.lastInput, tt: v.tt, colorT: v.colorT || 0 });
    if (v.mode === 2 && this.conProfundo && await this.cargarProfundo()) { this.mode = this.destino = 2; this.prof.restaurarVista(v.prof); }
    else if (v.mode !== 2) { this.mode = this.destino = v.mode; }
    this.switching = 0; this.fade = 1;
  }
  pedirModo(m) {
    if (this.switching || m === this.mode) return;
    if (m === 2) this.cargarProfundo();
    this.destino = m; this.switching = 1;
  }
  de(p) { return this.mode === 0 ? deBulb(p, this.power, this.iter || ITER_BULBO) : deBox(p, this.boxScale); }
  autopilot(t) {
    if (this.mode === 0) {
      const a = t * 0.11, R = (1.75 + 0.55 * Math.sin(t * 0.07)) * (this.distScale || 1), el = 0.45 * Math.sin(t * 0.05);
      const pos = [Math.cos(a) * R * Math.cos(el), Math.sin(el) * R + 0.1, Math.sin(a) * R * Math.cos(el)];
      const look = [0.25 * Math.sin(t * 0.13), 0.15 * Math.cos(t * 0.09), 0.25 * Math.cos(t * 0.11)];
      return [pos, v3.norm(v3.sub(look, pos))];
    }
    const a = t * 0.06, R = 9.0 + 3.0 * Math.sin(t * 0.05), el = 0.35 + 0.3 * Math.sin(t * 0.037);
    const pos = [Math.cos(a) * R * Math.cos(el), Math.sin(el) * R, Math.sin(a) * R * Math.cos(el)];
    const look = [2.5 * Math.sin(t * 0.08), 1.5 * Math.sin(t * 0.06), 2.5 * Math.cos(t * 0.07)];
    return [pos, v3.norm(v3.sub(look, pos))];
  }
  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, W = this.ctx.W, H = this.ctx.H;
    if (window.__fractalRec && window.__fractalRec.estado && this.mode !== 2 && !this.switching) { this.frameRec(enc, window.__fractalRec); return; }
    this.tt += dt * (this.chaos ? 2.5 : 1);
    this.colorT += dt;
    // cambio de fractal con fundido (A alterna los dos 3D; ↑ ↓ recorren los tres)
    if (inp.pressed.a && !this.switching && this.mode !== 2) this.pedirModo(this.mode ^ 1);
    if (this.switching) {
      this.fade = Math.max(0, this.fade - dt / 0.35);
      const listo = this.destino !== 2 || this.prof || (this.profCarga && !this.conProfundo);
      if (this.fade <= 0 && listo) {
        if (this.destino === 2 && !this.prof) this.destino = 0;          // no cargó: de vuelta al Mandelbulb
        if (this.mode === 2 && this.prof) this.prof.ocultar();
        this.switching = 0; this.mode = this.destino;
        if (this.mode !== 2) { [this.pos, this.fwd] = this.autopilot(this.tt); this.lastInput = -1e9; }
        this.fadeIn = true;
      }
    } else if (this.fade < 1) this.fade = Math.min(1, this.fade + dt / 0.5);
    this.post.exposure = this.fade;
    if (this.mode === 2 && this.prof) {
      this.post.bloom = 0.22; this.post.vignette = 0.55;
      if (!this.switching) this.prof.frame(enc, dt, t);
      else this.prof.frame(enc, 0, t);
      return;
    }
    this.post.bloom = 0.35; this.post.vignette = 0.7;
    // parámetro del fractal
    const trig = inp.r2 - inp.l2;
    if (this.mode === 0) {
      this.power = Math.max(2, Math.min(14, this.power + trig * dt * 2.5));
      if (this.chaos) this.power = 8 + 3.5 * Math.sin(this.tt * 0.6);
    } else {
      this.boxScale = Math.max(1.5, Math.min(3.2, this.boxScale + trig * dt * 0.5));
      if (this.chaos) this.boxScale = 2.3 + 0.7 * Math.sin(this.tt * 0.4);
    }
    // cámara: autopiloto o vuelo manual
    const active = Math.abs(inp.lx) + Math.abs(inp.ly) + Math.abs(inp.rx) + Math.abs(inp.ry) > 0.05;
    if (active) this.lastInput = t;
    const ws = this.mode === 0 ? 1 : 4;
    const minD = 2e-4 * ws;                               // lo más cerca que llega la cámara (antes 0.012: una pared)
    // el autopiloto solo retoma lejos de la superficie y tras un rato largo sin tocar nada; de cerca, la vista nunca
    // se va sola (antes, a los 6 s arrastraba la cámara a su órbita: «la vista se resetea»)
    const dCam = this.de(this.pos);
    const manual = t - this.lastInput < 30 || dCam < 0.25 * ws;
    if (manual) {
      const up = [0, 1, 0];
      let yaw = Math.atan2(this.fwd[2], this.fwd[0]), pitch = Math.asin(Math.max(-1, Math.min(1, this.fwd[1])));
      yaw += inp.rx * 1.6 * dt; pitch = Math.max(-1.45, Math.min(1.45, pitch - inp.ry * 1.3 * dt));
      this.fwd = [Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)];
      const right = v3.norm(v3.cross(this.fwd, up));
      const speed = Math.max(minD * 0.5, Math.min(1.2 * ws, dCam * 1.6)) * (this.chaos ? 2 : 1);
      // por cuadro nunca se avanza más de media holgura (un dt largo, p. ej. al volver a la pestaña, no mete la cámara dentro)
      const paso = Math.min(speed * dt, Math.max(dCam * 0.5, minD * 0.25));
      this.pos = v3.add(this.pos, v3.mul(v3.add(v3.mul(this.fwd, -inp.ly), v3.mul(right, inp.lx)), paso));
    } else {
      const [pA, fA] = this.autopilot(this.tt);
      const k = 1 - Math.exp(-dt * 0.9);
      this.pos = v3.mix(this.pos, pA, k); this.fwd = v3.norm(v3.mix(this.fwd, fA, 1 - Math.exp(-dt * 1.2)));
    }
    // iteraciones del bulbo según la cercanía (las mismas en la cámara y en el sombreador)
    if (this.mode === 0) this.iter = iteracionesBulbo(this.de(this.pos), this.iter || ITER_BULBO);
    // evitar atravesar la superficie (con el DE exacto del sombreador)
    for (let i = 0; i < 4; i++) {
      const dd = this.de(this.pos); if (dd >= minD) break;
      const e = minD * 0.1, g = v3.norm([this.de(v3.add(this.pos, [e, 0, 0])) - dd, this.de(v3.add(this.pos, [0, e, 0])) - dd, this.de(v3.add(this.pos, [0, 0, e])) - dd]);
      this.pos = v3.add(this.pos, v3.mul(g, minD - dd + minD * 0.01));
    }
    const fwd = this.fwd, right = v3.norm(v3.cross(fwd, [0, 1, 0])), up = v3.cross(right, fwd);
    const fs = 1.25;
    const la = this.tt * (this.chaos ? 0.5 : 0.12);
    const light = v3.norm([Math.cos(la) * 0.7 + 0.2, 0.75, Math.sin(la) * 0.7 - 0.3]);
    const f = new Float32Array(44);
    f.set([...this.pos, fs, ...right, 1 / (H * fs), ...up, 0, ...fwd, 0,
      this.tt, this.mode, this.power, this.maxSteps, W, H, this.boxScale, this.palette || 0, ...light, this.chaos ? 1 : 0,
      1, 0, 0, 0, this.iter || ITER_BULBO, 12, 0.7, this.maxSteps, 0, 0, 0, 32, 1.35, 0, 1.4, 1]);
    d.queue.writeBuffer(this.ub, 0, f);
    this.cnt.clear(enc);
    const p = this.ctx.cpass(enc); p.setPipeline(this.pipe); p.setBindGroup(0, this.bg);
    p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
    this.cnt.copy(enc);
    this.grado.run(enc, this.palette || 0, this.colorT);
  }
  // ---------- modo grabación (herramientas/showcase/tomas-v3.mjs) ----------
  // Solo existe si la página define window.__fractalRec; en uso normal nunca se toca. La cámara la dicta el guion:
  //   __fractalRec = { estado(dt) → { modo, pos, mira | fwd, up?, focal?, potencia?, escala?, luz?, paleta?, tt? },
  //     muestras (supermuestreo + desenfoque de movimiento, acumulación en float), obturador (fracción de cuadro, 0.5 = 180°),
  //     apertura (radio de la lente / distancia de foco), foco (distancia), pasos, iterBulbo, iterCaja, epsK, sombra, radio,
  //     halo (pasos de referencia), halo2 (intensidad), fondo (multiplicador del degradado), exposicion, bloom, vineta, grano (0), negros ([0,0,0]) }
  // estado(dt) se evalúa en cada submuestra con dt = desplazamiento en segundos dentro del obturador.
  frameRec(enc, R) {
    const d = this.ctx.device, W = this.ctx.W, H = this.ctx.H;
    const N = Math.max(1, R.muestras | 0), obt = R.obturador != null ? R.obturador : 0.5;
    Object.assign(this.post, { exposure: R.exposicion != null ? R.exposicion : 1, bloom: R.bloom != null ? R.bloom : 0.35,
      vignette: R.vineta != null ? R.vineta : 0.7, grain: R.grano || 0, lift: R.negros || [0, 0, 0] });
    if (N > 1 && this.accN !== W * H) {
      this.accBuf.destroy(); this.accBuf = d.createBuffer({ size: W * H * 16, usage: GPUBufferUsage.STORAGE }); this.accN = W * H; this.hacerBG();
    }
    const pasos = R.pasos || this.maxSteps;
    for (let k = 0; k < N; k++) {
      const st = R.estado(N > 1 ? ((k + 0.5) / N - 0.5) * obt / 60 : 0);
      this.mode = this.destino = st.modo || 0;
      if (st.potencia != null) this.power = st.potencia;
      if (st.escala != null) this.boxScale = st.escala;
      if (st.paleta != null) this.palette = st.paleta;
      if (st.tt != null) this.tt = st.tt;
      const pos = st.pos, fwd = v3.norm(st.fwd || v3.sub(st.mira, pos));
      const right = v3.norm(v3.cross(fwd, st.up || [0, 1, 0])), up = v3.cross(right, fwd);
      const fs = st.focal || 1.25;
      // subpíxel (secuencia R2) y lente (espiral de oro) por muestra
      const jx = N > 1 ? ((0.5 + k * 0.7548776662) % 1) - 0.5 : 0, jy = N > 1 ? ((0.5 + k * 0.5698402910) % 1) - 0.5 : 0;
      const foco = st.foco || R.foco || 0, ap = (st.apertura != null ? st.apertura : R.apertura || 0) * foco;
      const rl = ap * Math.sqrt((k + 0.5) / N), al = k * 2.39996323;
      const light = v3.norm(st.luz || [0.5, 0.75, -0.3]);
      this.pos = pos; this.fwd = fwd;
      const f = new Float32Array(44);
      f.set([...pos, fs, ...right, 1 / (H * fs), ...up, 0, ...fwd, 0,
        this.tt, this.mode, this.power, pasos, W, H, this.boxScale, this.palette || 0, ...light, 0,
        N, k, jx * (R.filtro || 1), jy * (R.filtro || 1), R.iterBulbo || ITER_BULBO, R.iterCaja || 12, R.epsK || 0.7, R.halo || 180,
        foco > 0 ? rl * Math.cos(al) : 0, foco > 0 ? rl * Math.sin(al) : 0, foco > 0 ? foco : 0, R.sombra || 32,
        R.radio || 1.35, st.generico || R.generico ? 1 : 0, R.halo2 != null ? R.halo2 : 1.4, R.fondo != null ? R.fondo : 1]);
      d.queue.writeBuffer(this.ub, 0, f);
      const e = k < N - 1 ? d.createCommandEncoder() : enc;
      if (e === enc) this.cnt.clear(enc);
      const p = e === enc ? this.ctx.cpass(enc) : e.beginComputePass();
      p.setPipeline(this.pipe); p.setBindGroup(0, this.bg);
      p.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p.end();
      this.grado.run(e, this.palette || 0, tiempoColor(st.colorT ?? this.tt, R.entradaCancion ?? 2));
      if (e === enc) this.cnt.copy(enc); else d.queue.submit([e.finish()]);
    }
  }
  after() { if (this.mode === 2 && this.prof) this.prof.after(); else this.cnt.after(); }
  onKey(k) {
    if (k === 'f') this.pedirModo((this.mode + 1) % this.nModos);
    if (this.mode !== 2 || !this.prof || this.switching) return;
    if (k === 'g') this.prof.avisar(this.prof.guardarMarcador());
    else if (k === 'r') { this.prof.reiniciar(); this.prof.avisar('De vuelta al inicio'); }
  }
  // C / Y: en el profundo recorre los marcadores; en los 3D, el modo caos de siempre
  accionY() {
    if (this.mode === 2 && this.prof && !this.switching) { const m = this.prof.siguienteMarcador(); this.prof.avisar(m); return m; }
    this.chaos = !this.chaos; return this.chaos ? 'Modo caos' : 'Modo sereno';
  }
  nombreModo() { return Fractal.MODOS[this.switching ? this.destino : this.mode]; }
  cambiarModo(dir = 1) { if (!this.switching) this.pedirModo((this.mode + (dir < 0 ? -1 : 1) + this.nModos) % this.nModos); return this.nombreModo(); }
  lectura() {
    if (this.mode === 2 && this.prof) return this.prof.lectura();
    const big = this.stats().find((r) => r !== '-' && r[2]);
    return big ? `${big[1]} ${big[0]}` : '';
  }
  stats() {
    if (this.mode === 2 && this.prof) return this.prof.stats();
    const W = this.ctx.W, H = this.ctx.H, fps = this.ctx.perf.fps, v = this.cnt.values;
    const evals = v ? v[0] : 0, prim = v ? v[1] : 0;
    const flopsPerEval = this.mode === 0 ? 8 * 48 : 12 * 26;
    return [
      ['fractal', this.mode === 0 ? `Mandelbulb  p=${this.power.toFixed(2)}` : `Mandelbox  s=${this.boxScale.toFixed(2)}`],
      ['píxeles trazados', fmt.int(W * H), true],
      ['pasos de rayo / píxel', (prim / (W * H)).toFixed(1)],
      ['evaluaciones DE / frame', fmt.si(evals)],
      ['evaluaciones DE / s', fmt.si(evals * fps)],
      ['≈ cómputo', fmt.si(evals * fps * flopsPerEval, 'FLOP/s')],
    ];
  }
  destroy() {
    this.ub.destroy(); this.cnt.destroy(); this.accBuf.destroy(); this.grado.destroy();
    if (this.prof) { this.prof.ocultar(); this.prof.destroy(); }
    if (Fractal.activa === this) Fractal.activa = null;
    if (window.__fractal === this) delete window.__fractal;
  }
}
