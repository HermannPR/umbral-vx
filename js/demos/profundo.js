// Mandelbrot profundo: el zoom que no se acaba (tercer modo de la sala 09 · Bulbo).
// Perturbación + rebasing de Zhuoran + BLA + floatexp en la GPU; órbita de referencia en BigInt dentro de un Worker.
// Navegación con zoom exponencial (velocidad percibida constante), refinamiento progresivo con presupuesto por cuadro,
// vuelo con frenado suave, autopiloto que bucea sin fin (iteración máxima + minibrots por periodo y Newton) y marcadores.
// Teoría y fuentes: investigacion/ZOOM-INFINITO.md
import { makeShader } from '../gpu.js';
import * as M from './profundo-mat.js';
import { MARCADORES } from './profundo-marcadores.js';

const LZ_DIRECTO = -11;          // radio > 2^-11 (~5e-4): iteración directa en f32 (el modo de siempre)
const LZ_SIN_REF = -14;          // sin Worker o sin referencia todavía, no se baja de aquí
const LZ_MIN = -40000;           // ~1e-12000: el floatexp da para mucho más; esto solo pone un piso
const LOG10_2 = 0.30102999566398;

const KERNEL = /* wgsl */`
struct U { dim: vec4f, band: vec4f, off: vec4f, pix: vec4f, dir: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> orb: array<vec4f>;
@group(0) @binding(2) var<storage, read> bla: array<vec4f>;
@group(0) @binding(3) var<storage, read> tabla: array<u32, 64>;
@group(0) @binding(4) var outT: texture_storage_2d<r32float, write>;
@group(0) @binding(5) var<storage, read_write> st: array<atomic<u32>, 16>;
var<workgroup> ws: array<atomic<u32>, 10>;
var<workgroup> wloc: vec2u;

const ZE = -1e6;
const BAIL = 65536.0;

fn cm(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn p2(e: f32) -> f32 { return ldexp(1.0, i32(clamp(e, -160.0, 160.0))); }
// floatexp complejo: (x, y)·2^z con max(|x|,|y|) en [0.5, 1)
fn xn(a: vec3f) -> vec3f {
  let m = max(abs(a.x), abs(a.y));
  if (m == 0.0 || a.z < -9e5) { return vec3f(0.0, 0.0, ZE); }
  let f = frexp(m);
  return vec3f(a.xy * ldexp(1.0, -f.exp), a.z + f32(f.exp));
}
fn xadd(a: vec3f, b: vec3f) -> vec3f { let e = max(a.z, b.z); return xn(vec3f(a.xy * p2(a.z - e) + b.xy * p2(b.z - e), e)); }
fn xmul(a: vec3f, b: vec3f) -> vec3f { return xn(vec3f(cm(a.xy, b.xy), a.z + b.z)); }
fn xf(a: vec3f) -> vec2f { return a.xy * p2(a.z); }
fn xl(a: vec3f) -> f32 { let h = length(a.xy); if (h == 0.0 || a.z < -9e5) { return -1e30; } return a.z + log2(h); }
fn xde(v: vec2f) -> vec3f { return xn(vec3f(v, 0.0)); }
fn suave(n: u32, r2: f32) -> f32 { return max(0.0, f32(n) + 1.0 - log2(0.5 * log(r2))); }

struct R { mu: f32, n: u32, steps: u32, reb: u32, bj: u32 };

fn calc(px: u32, py: u32) -> R {
  var r: R; r.mu = -1.0; r.n = 0u; r.steps = 0u; r.reb = 0u; r.bj = 0u;
  let uv = vec2f(f32(px) + 0.5 - 0.5 * u.dim.x, 0.5 * u.dim.y - f32(py) - 0.5);
  let MI = u32(u.band.z);
  if (u.off.w < 0.5) {
    // iteración directa en f32: la de siempre, para zooms poco profundos
    let c = u.dir.xy + uv * u.dir.z;
    var z = vec2f(0.0); var n = 0u;
    loop {
      if (n >= MI) { break; }
      let r2 = dot(z, z);
      if (r2 > BAIL) { r.mu = suave(n, r2); break; }
      z = cm(z, z) + c; n++;
    }
    r.n = n; r.steps = n;
    return r;
  }
  // perturbación: z = Z_m + δ, δ ← 2 Z_m δ + δ² + δc
  let N = u32(u.band.w);
  let dc = xadd(u.off.xyz, xn(vec3f(uv * u.pix.x, u.pix.y)));
  let dc32 = xf(dc);
  let nL = max(u32(u.pix.z), 1u);
  let usarB = (u32(u.pix.w) & 1u) != 0u;
  // referencia periódica (núcleo): al cerrar cada vuelta se compara con la anterior; si el píxel ya no se mueve,
  // cayó en el ciclo atractor (interior) y se deja de iterar
  let periodica = (u32(u.pix.w) & 2u) != 0u;
  var zant = vec3f(0.0, 0.0, ZE);
  var d = vec3f(0.0, 0.0, ZE); var d32 = vec2f(0.0); var m32 = false;
  var m = 0u; var n = 0u; var pasos = 0u;
  let tope = 2u * MI + 256u;
  loop {
    if (n >= MI || pasos >= tope) { break; }
    pasos++;
    // BLA: salta 2^L iteraciones de golpe si |δ| < R (el δ² es despreciable a precisión f32)
    if (usarB && m > 0u) {
      var ld = xl(d);
      if (m32) { ld = log2(max(length(d32), 1e-37)); }
      if (ld < -20.0) {
        var L = min(countTrailingZeros(m), nL - 1u);
        var hecho = false;
        loop {
          let k = m >> L;
          if (k < tabla[32u + L] && n + (1u << L) <= MI) {
            let i = tabla[L] + k;
            let e0 = bla[2u * i];
            if (ld < e0.w) {
              let e1 = bla[2u * i + 1u];
              var dd = d;
              if (m32) { dd = xde(d32); }
              d = xadd(xmul(e0.xyz, dd), xmul(e1.xyz, dc)); m32 = false;
              m += 1u << L; n += 1u << L; r.bj++; hecho = true;
              break;
            }
          }
          if (L == 0u) { break; }
          L--;
        }
        if (hecho) { continue; }
      }
    }
    if (m32) {
      // camino rápido: δ cabe en f32
      let z = xf(orb[m].xyz) + d32;
      let r2 = dot(z, z);
      if (r2 > BAIL) { r.mu = suave(n, r2); break; }
      // rebasing (Zhuoran): si la órbita del píxel pasa más cerca de 0 que su δ, se vuelve al inicio de la referencia
      if (r2 < dot(d32, d32) || m + 1u >= N) {
        if (periodica && m + 1u >= N) {
          let zz = xde(z);
          if (xl(xadd(zz, vec3f(-zant.xy, zant.z))) < xl(zz) - 20.0) { break; }
          zant = zz;
        }
        d32 = z; m = 0u; r.reb++;
      }
      if (max(abs(d32.x), abs(d32.y)) < 8.5e-22) { m32 = false; d = xde(d32); continue; }
      let Zm = xf(orb[m].xyz);
      d32 = 2.0 * cm(Zm, d32) + cm(d32, d32) + dc32;
      m++; n++;
    } else {
      // floatexp: δ diminuto (por debajo de 2^-60), sin piso de exponente
      let Z = orb[m].xyz;
      let z = xadd(Z, d);
      if (xl(z) < xl(d) || m + 1u >= N) {
        if (periodica && m + 1u >= N) {
          if (xl(xadd(z, vec3f(-zant.xy, zant.z))) < xl(z) - 20.0) { break; }
          zant = z;
        }
        d = z; m = 0u; r.reb++;
      }
      if (d.z > -60.0) { m32 = true; d32 = xf(d); continue; }
      let Zm = orb[m];
      d = xadd(xadd(xmul(vec3f(Zm.xy, Zm.z + 1.0), d), xmul(d, d)), dc);
      m++; n++;
    }
  }
  r.n = n; r.steps = pasos;
  return r;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_index) li: u32) {
  if (li < 10u) { atomicStore(&ws[li], 0u); }
  workgroupBarrier();
  let W = u32(u.dim.x); let H = u32(u.dim.y); let s = u32(u.dim.z);
  let px = gid.x * s; let py = u32(u.band.x) + gid.y * s;
  var act = px < W && py < min(u32(u.band.y), H);
  // en un nivel de refinamiento, la esquina de cada bloque ya la calculó el nivel anterior
  if (act && u.dim.w > 0.5 && (px % (2u * s)) == 0u && (py % (2u * s)) == 0u) { act = false; }
  if (act) {
    let r = calc(px, py);
    for (var j = 0u; j < s; j++) {
      for (var i = 0u; i < s; i++) {
        if (px + i < W && py + j < H) { textureStore(outT, vec2u(px + i, py + j), vec4f(r.mu, 0.0, 0.0, 1.0)); }
      }
    }
    atomicAdd(&ws[0], r.steps);
    atomicAdd(&ws[5], r.reb);
    atomicAdd(&ws[6], r.bj);
    if (r.mu >= 0.0) {
      atomicAdd(&ws[1], 1u);
      atomicMax(&ws[3], 0xffffffffu - bitcast<u32>(r.mu));
      atomicMax(&ws[4], bitcast<u32>(r.mu));
      let old = atomicMax(&ws[7], r.n);
      if (r.n > old) { wloc = vec2u(px, py); }
      if (2u * r.n > u32(u.band.z)) { atomicAdd(&ws[8], 1u); }                  // escapes tardíos: piden más iteraciones
      atomicAdd(&ws[9], u32(clamp(log(1.0 + max(r.mu - u.dir.w, 0.0)) * 64.0, 0.0, 1e6)));   // para normalizar el color
    } else { atomicAdd(&ws[2], 1u); }
  }
  workgroupBarrier();
  if (li == 0u) {
    atomicAdd(&st[0], (atomicLoad(&ws[0]) + 32u) / 64u);
    atomicAdd(&st[1], atomicLoad(&ws[1]));
    atomicAdd(&st[2], atomicLoad(&ws[2]));
    atomicMax(&st[3], atomicLoad(&ws[3]));
    atomicMax(&st[4], atomicLoad(&ws[4]));
    atomicAdd(&st[8], atomicLoad(&ws[5]));
    atomicAdd(&st[9], atomicLoad(&ws[6]));
    atomicAdd(&st[10], atomicLoad(&ws[8]));
    atomicAdd(&st[11], (atomicLoad(&ws[9]) + 32u) / 64u);
    let nm = atomicLoad(&ws[7]);
    if (nm > 0u) {
      let old = atomicMax(&st[5], nm);
      if (nm > old) { atomicStore(&st[6], wloc.x); atomicStore(&st[7], wloc.y); }
    }
  }
}
`;

// Color: paleta coseno de la sala sobre μ normalizado al rango de la vista (estable a cualquier profundidad),
// más relieve con el gradiente de log μ en pantalla.
const PINTAR = /* wgsl */`
struct D { a: vec4f, b: vec4f, c: vec4f };
@group(0) @binding(0) var<uniform> u: D;
@group(0) @binding(1) var res: texture_2d<f32>;
@group(0) @binding(2) var outT: texture_storage_2d<rgba16float, write>;
fn pal(t: f32) -> vec3f {
  let k = u.b.x;
  var a = vec3f(0.6, 0.42, 0.3); var b = vec3f(0.45, 0.35, 0.3); var c = vec3f(1.0); var d = vec3f(0.0, 0.15, 0.35);
  if (k > 0.5 && k < 1.5) { a = vec3f(0.45, 0.6, 0.72); b = vec3f(0.3, 0.3, 0.32); d = vec3f(0.5, 0.55, 0.62); }
  else if (k > 1.5 && k < 2.5) { a = vec3f(0.5); b = vec3f(0.5); d = vec3f(0.0, 0.33, 0.67); }
  else if (k > 2.5) { a = vec3f(0.18, 0.17, 0.22); b = vec3f(0.22, 0.14, 0.3); c = vec3f(2.0, 1.0, 1.0); d = vec3f(0.5, 0.2, 0.25); }
  return a + b * cos(6.2831853 * (c * t + d));
}
fn alto(p: vec2i) -> f32 {
  let W = i32(u.a.x); let H = i32(u.a.y);
  let mu = textureLoad(res, clamp(p, vec2i(0), vec2i(W - 1, H - 1)), 0).x;
  if (mu < 0.0) { return -1.0; }
  return log(1.0 + max(mu - u.a.z, 0.0));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let W = u32(u.a.x); let H = u32(u.a.y);
  if (gid.x >= W || gid.y >= H) { return; }
  let p = vec2i(gid.xy);
  let h = alto(p);
  let HH = max(u.a.w, 0.5);
  var col: vec3f;
  if (h < 0.0) {
    // interior: casi negro, teñido por la paleta
    col = pal(0.62 + u.b.y) * 0.012 + vec3f(0.002, 0.0018, 0.003);
  } else {
    var hx = alto(p + vec2i(1, 0)); var hy = alto(p + vec2i(0, 1));
    if (hx < 0.0) { hx = h; } if (hy < 0.0) { hy = h; }
    let t = min(h / HH, 1.6);
    let k = u.c.w / HH;
    let nrm = normalize(vec3f(-(hx - h) * k, (hy - h) * k, 1.0));
    let L = normalize(u.c.xyz);
    let lam = 0.5 + 0.62 * dot(nrm, L);
    // lejos del conjunto, oscuro; cerca del borde se enciende
    col = pal(t * u.b.z + u.b.y) * lam * (0.03 + 1.05 * pow(min(t, 1.0), 1.5));
    col += pal(0.55 + u.b.y) * pow(min(t, 1.0), 9.0) * 1.2;
  }
  textureStore(outT, gid.xy, vec4f(col * u.b.w, 1.0));
}
`;

const aBig = M.aBig;
const pot2 = (v) => { let k = 1; while (k < v) k <<= 1; return k; };
const sup = (n) => String(n).replace(/^-0(\.0)?$/, '0').replace(/[-0-9.]/g, (c) => '⁻⁰¹²³⁴⁵⁶⁷⁸⁹·'['-0123456789.'.indexOf(c)]);

export default class Profundo {
  constructor(ctx, host) { this.ctx = ctx; this.host = host || {}; }

  async init() {
    const c = this.ctx, d = c.device, W = c.W, H = c.H;
    this.W = W; this.H = H;
    this.res = d.createTexture({ size: [W, H], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    this.ub = d.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.ud = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.st = d.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.meta = d.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.lect = [0, 1, 2, 3].map(() => ({ buf: d.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), libre: true, tag: null, copiado: false }));
    const mk = makeShader(d, KERNEL, 'profundo', c.report), mp = makeShader(d, PINTAR, 'profundo-color', c.report);
    [this.pK, this.pP] = await Promise.all([
      d.createComputePipelineAsync({ layout: 'auto', compute: { module: mk, entryPoint: 'main' } }),
      d.createComputePipelineAsync({ layout: 'auto', compute: { module: mp, entryPoint: 'main' } })]);
    this.capOrb = 0; this.capBla = 0; this.asegurar(1 << 14, 1 << 15);
    this.bgP = d.createBindGroup({ layout: this.pP.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.ud } }, { binding: 1, resource: this.res.createView() }, { binding: 2, resource: c.post.hdrView }] });
    // Worker de precisión arbitraria; sin él queda el modo superficial (f32 directo, hasta ~1e-4)
    this.worker = null; this.reqId = 0; this.esperas = new Map();
    try {
      if (typeof BigInt === 'undefined') throw new Error('sin BigInt');
      this.worker = new Worker(new URL('./profundo-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.recibir(e.data);
      this.worker.onerror = (e) => { c.report('profundo worker: ' + (e.message || 'error')); this.worker = null; };
    } catch (e) { this.worker = null; }
    this.cargarMarcadores();
    this.reiniciar();
    this.B = 400000; this.hudT = 0; this.tt = 0;
    this.ptr = { abajo: false, x0: 0, y0: 0, lx: 0, ly: 0, arrastre: 0 };
    this.rueda = 0; this.ruedaUV = [0, 0];
    this.onWheel = (e) => {
      if (!this.activo) return;
      const dpr = c.W / Math.max(1, innerWidth);
      this.rueda += -Math.max(-120, Math.min(120, e.deltaY)) * 0.01;
      this.ruedaUV = this.uvDe(e.clientX * dpr, e.clientY * dpr);
      this.tomarControl();
    };
    addEventListener('wheel', this.onWheel, { passive: true });
    window.__profundo = this;          // gancho de pruebas (herramientas/probar-zoom.mjs)
  }

  // ---------------------------------------------------------------- estado de la vista
  reiniciar() {
    this.P = 96;
    this.cx = M.numToFix(-0.6, this.P); this.cy = 0n; this.lz = Math.log2(1.35);
    this.vz = 0; this.vx = 0; this.vy = 0; this.vuelo = null; this.ap = null;
    this.ref = null; this.blaT = null; this.pend = { ref: 0, bla: 0, mini: 0 }; this.refT = -1e9;
    this.boost = 1; this.maxIter = 0; this.actualizarIter();
    this.clave = ''; this.epoca = 0; this.s = 8; this.y0 = 0; this.skip = false; this.completo = false;
    this.lo = 0; this.hi = 50; this.rlo = 0; this.rhi = 50; this.h = 3; this.rh = 3; this.rangoEpoca = -1; this.saltar = true;
    this.est = null; this.ultStats = null;
  }
  // bits de fracción del centro: siempre de sobra para la profundidad actual
  asegurarBits() {
    const need = M.bitsPara(this.lz, 72);
    if (need > this.P) { const s = BigInt(need - this.P); this.cx <<= s; this.cy <<= s; this.P = need; }
  }
  mover(du, dv) {          // en radios de la vista
    if (!du && !dv) return;
    const sh = this.lz + this.P;
    if (du) this.cx += aBig(du, sh); if (dv) this.cy += aBig(dv, sh);
  }
  zoomEn(a, uv) {          // a > 0: acerca 2^a veces, dejando quieto el punto uv (en radios)
    const f = 1 - 2 ** -a;
    this.mover(uv[0] * f, uv[1] * f);
    this.lz -= a;
  }
  uvDe(x, y) { return [(x - this.W / 2) / (this.H / 2), (this.H / 2 - y) / (this.H / 2)]; }
  puntoDe(uv) { const sh = this.lz + this.P; return [this.cx + aBig(uv[0], sh), this.cy + aBig(uv[1], sh), this.P]; }
  // (punto − centro) en radios de la vista (double, recortado)
  offsetA(x, y, P) {
    const Pm = Math.max(P, this.P);
    const f = M.fixToFE(M.cambiaP(x, P, Pm) - M.cambiaP(this.cx, this.P, Pm), M.cambiaP(y, P, Pm) - M.cambiaP(this.cy, this.P, Pm), Pm);
    const sh = f.e - this.lz;
    if (sh > 40) return [Math.sign(f.x) * 1e12, Math.sign(f.y) * 1e12];
    return [M.ldexp(f.x, Math.round(sh)) * 2 ** (sh - Math.round(sh)), M.ldexp(f.y, Math.round(sh)) * 2 ** (sh - Math.round(sh))];
  }
  actualizarIter() {
    const dig = Math.max(0, -this.lz * LOG10_2);
    const base = Math.round(320 + 90 * dig + 0.0 * dig * dig);
    const q = this.ctx.calidad ? Math.max(0.5, this.ctx.calidad.carga) : 1;
    const nuevo = Math.min(1 << 20, Math.round(base * this.boost * (0.6 + 0.4 * q)));
    if (!this.maxIter || Math.abs(nuevo - this.maxIter) > 0.08 * this.maxIter) this.maxIter = nuevo;
  }
  get profundidad() { return -this.lz * LOG10_2; }      // N de 10^-N (radio de la vista)
  get directo() { return this.lz > LZ_DIRECTO; }
  // la referencia alcanza para esta profundidad (si no, se espera a la nueva sin pintar basura)
  get refOK() { return !!this.ref && this.ref.P >= M.bitsPara(this.lz, 24); }

  // ---------------------------------------------------------------- Worker
  enviar(q, transfer) {
    if (!this.worker) return null;
    q.id = ++this.reqId; this.worker.postMessage(q, transfer || []); return q.id;
  }
  pedir(q) { return new Promise((res) => { const id = this.enviar(q); if (!id) return res(null); this.esperas.set(id, res); }); }
  recibir(r) {
    if (this.esperas.has(r.id)) { const f = this.esperas.get(r.id); this.esperas.delete(r.id); f(r); return; }
    if (r.error) { this.ctx.report('profundo: ' + r.error.split('\n')[0]); if (r.tipo === 'ref') this.pend.ref = 0; if (r.tipo === 'bla') this.pend.bla = 0; if (r.tipo === 'mini') this.pend.mini = 0; return; }
    if (r.tipo === 'ref' && r.id === this.pend.ref) {
      this.pend.ref = 0;
      this.asegurar(r.N, r.bla.total);
      const q = this.ctx.device.queue;
      q.writeBuffer(this.orb, 0, r.Z);
      q.writeBuffer(this.bla, 0, r.bla.datos);
      q.writeBuffer(this.meta, 0, r.bla.meta);
      this.ref = { id: r.id, rx: r.rx, ry: r.ry, P: r.P, N: r.N, periodo: r.periodo, nucleo: r.nucleo, escapo: r.escapo, lz: this.pedidoLz, ms: r.ms, maxIter: this.pedidoIter };
      this.blaT = { ldc: r.ldc, niveles: r.bla.niveles, total: r.bla.total, refId: r.id };
    } else if (r.tipo === 'bla' && r.id === this.pend.bla) {
      this.pend.bla = 0;
      if (!this.ref || this.pend.blaRef !== this.ref.id || r.N !== this.ref.N) return;
      this.asegurar(this.ref.N, r.bla.total);
      const q = this.ctx.device.queue;
      q.writeBuffer(this.bla, 0, r.bla.datos); q.writeBuffer(this.meta, 0, r.bla.meta);
      this.blaT = { ldc: r.ldc, niveles: r.bla.niveles, total: r.bla.total, refId: this.ref.id };
    } else if (r.tipo === 'mini' && r.id === this.pend.mini) {
      this.pend.mini = 0;
      if (this.ap) this.apMinibrot(r.r);
    }
  }
  asegurar(nOrb, nBla) {
    const d = this.ctx.device;
    let cambio = false;
    if (nOrb > this.capOrb) { if (this.orb) this.orb.destroy(); this.capOrb = pot2(nOrb); this.orb = d.createBuffer({ size: this.capOrb * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); cambio = true; }
    if (nBla > this.capBla) { if (this.bla) this.bla.destroy(); this.capBla = pot2(nBla); this.bla = d.createBuffer({ size: this.capBla * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); cambio = true; }
    if (cambio || !this.bgK) {
      this.bgK = d.createBindGroup({ layout: this.pK.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: { buffer: this.orb } }, { binding: 2, resource: { buffer: this.bla } },
        { binding: 3, resource: { buffer: this.meta } }, { binding: 4, resource: this.res.createView() }, { binding: 5, resource: { buffer: this.st } }] });
    }
  }
  // ¿hace falta otra referencia? (precisión, iteraciones, distancia al centro)
  gestionarRef(now) {
    if (!this.worker || this.pend.ref || this.lz > LZ_DIRECTO + 3) return;
    const ref = this.ref;
    let motivo = null;
    if (!ref) motivo = 'primera';
    else {
      const loff = this.loff();
      if (ref.P < M.bitsPara(this.lz, 48)) motivo = 'precisión';
      else if (!ref.nucleo && !ref.escapo && ref.N < this.maxIter) motivo = 'iteraciones';
      else if (loff > this.lz + 2.5) motivo = 'lejos';
      else if (ref.escapo && ref.N < this.maxIter && (Math.abs(this.lz - ref.lz) > 3 || loff > this.lz - 1) && now - this.refT > 1500) motivo = 'escapó';
      else if (ref.nucleo && this.lz < ref.lz - 6 && now - this.refT > 1500) motivo = 'más hondo';
    }
    if (!motivo || now - this.refT < 200) return;
    this.refT = now;
    const P = Math.max(M.bitsPara(this.lz, 120), this.P);
    this.pedidoLz = this.lz; this.pedidoIter = this.maxIter;
    this.pend.ref = this.enviar({ tipo: 'ref', cx: M.cambiaP(this.cx, this.P, P), cy: M.cambiaP(this.cy, this.P, P), P, maxIter: Math.round(this.maxIter * 1.5),
      lr: this.lz, ldiag: Math.log2(Math.hypot(this.W / this.H, 1)) });
    this.motivoRef = motivo;
  }
  offFE() {
    const r = this.ref, Pm = Math.max(r.P, this.P);
    return M.fixToFE(M.cambiaP(this.cx, this.P, Pm) - M.cambiaP(r.rx, r.P, Pm), M.cambiaP(this.cy, this.P, Pm) - M.cambiaP(r.ry, r.P, Pm), Pm);
  }
  loff() { return this.ref ? M.fe.l2(this.offFE()) : -Infinity; }
  // la tabla BLA vale mientras |δc| máximo no supere el que se usó para armarla
  blaValida() {
    if (!this.ref || !this.blaT || this.blaT.refId !== this.ref.id) return false;
    const need = M.logadd(this.loff(), this.lz + Math.log2(Math.hypot(this.W / this.H, 1)));
    const ok = need <= this.blaT.ldc;
    if ((!ok || need < this.blaT.ldc - 10) && !this.pend.bla && this.worker) {
      this.pend.blaRef = this.ref.id;
      this.pend.bla = this.enviar({ tipo: 'bla', ldc: need + 1 });
    }
    return ok;
  }

  // ---------------------------------------------------------------- navegación
  avisar(m) { if (m) this.msj = { txt: m, t: performance.now() }; }
  tomarControl() { if (this.ap) this.avisar('Autopiloto · apagado'); this.ap = null; this.vuelo = null; }
  volar(x, y, P, lz, rapidez = 1, alLlegar = null) { this.vuelo = { x, y, P, lz, rapidez, alLlegar }; }
  navegar(dt, inp) {
    const ptr = this.ctx.pointer, lz0 = this.lz;
    // entrada manual: palancas, gatillos, rueda, arrastre y clic
    const zin = (inp.r2 || 0) - (inp.l2 || 0) - (inp.ry || 0);
    const ax = inp.lx || 0, ay = -(inp.ly || 0);
    const manual = Math.abs(zin) + Math.abs(ax) + Math.abs(ay) > 0.05;
    if (manual) this.tomarControl();
    if (ptr) {
      if (ptr.down && !this.ptr.abajo) { this.ptr.abajo = true; this.ptr.x0 = this.ptr.lx = ptr.x; this.ptr.y0 = this.ptr.ly = ptr.y; this.ptr.arrastre = 0; }
      else if (ptr.down && this.ptr.abajo) {
        const dx = ptr.x - this.ptr.lx, dy = ptr.y - this.ptr.ly;
        this.ptr.arrastre += Math.abs(dx) + Math.abs(dy);
        if (this.ptr.arrastre > 6) { this.tomarControl(); this.mover(-dx / (this.H / 2), dy / (this.H / 2)); }
        this.ptr.lx = ptr.x; this.ptr.ly = ptr.y;
      } else if (!ptr.down && this.ptr.abajo) {
        this.ptr.abajo = false;
        if (this.ptr.arrastre <= 6) {           // clic: volar hacia ahí y acercar ×8, frenando suave
          this.tomarControl();
          const [x, y, P] = this.puntoDe(this.uvDe(this.ptr.x0, this.ptr.y0));
          this.volar(x, y, P, this.lz - 3);
        }
      }
    }
    // rueda: zoom hacia el cursor, repartido en unos cuadros
    if (this.rueda) { const a = this.rueda * (1 - Math.exp(-dt * 14)); this.zoomEn(a, this.ruedaUV); this.rueda -= a; if (Math.abs(this.rueda) < 1e-3) this.rueda = 0; }
    const lisa = (v, obj, k) => v + (obj - v) * (1 - Math.exp(-dt * k));
    if (this.vuelo) {
      const v = this.vuelo, [ox, oy] = this.offsetA(v.x, v.y, v.P);
      const lejos = Math.hypot(ox, oy);
      const k = 1 - Math.exp(-dt * 2.6 * v.rapidez);
      this.mover(ox * k, oy * k);
      const dz = v.lz - this.lz;
      let obj = Math.max(-2.2, Math.min(2.2, dz * 1.3)) * v.rapidez;     // frena al acercarse a la profundidad meta
      if (lejos > 0.7 && obj < 0) obj = Math.max(obj, 0.6);              // no acercar con el objetivo fuera de cuadro
      this.vz = lisa(this.vz, -obj, 4);
      this.vx = lisa(this.vx, 0, 6); this.vy = lisa(this.vy, 0, 6);
      if (Math.abs(dz) < 0.04 && lejos < 0.004) { this.vuelo = null; this.vz = 0; if (v.alLlegar) v.alLlegar(); }
    } else if (this.ap) {
      this.autopiloto(dt);
    } else {
      // zoom exponencial: escala × e^(k·dt) → la velocidad percibida es la misma a cualquier profundidad
      this.vz = lisa(this.vz, zin * 2.4, 4.5);
      this.vx = lisa(this.vx, ax * 1.1, 6); this.vy = lisa(this.vy, ay * 1.1, 6);
    }
    this.lz -= this.vz * dt;
    this.mover(this.vx * dt, this.vy * dt);
    // pisos: sin referencia no se baja de la iteración directa; con referencia, no más hondo de lo que aguanta
    let piso = LZ_MIN;
    if (!this.worker) piso = LZ_SIN_REF;
    else if (!this.ref || this.ref.P < M.bitsPara(this.lz, 24)) piso = Math.max(LZ_SIN_REF, this.ref ? -(this.ref.P - 40) : LZ_SIN_REF);
    // (un salto de marcador puede dejar la vista más honda que el piso: ahí solo se impide seguir bajando)
    if (this.lz < piso && this.lz < lz0) { this.lz = Math.min(lz0, piso); this.vz = Math.min(this.vz, 0); }
    if (this.lz > 1.6) { this.lz = 1.6; this.vz = Math.max(this.vz, 0); }
    // el centro no se va del dibujo
    const L = 4n << BigInt(this.P);
    if (this.cx > L) this.cx = L; if (this.cx < -L) this.cx = -L; if (this.cy > L) this.cy = L; if (this.cy < -L) this.cy = -L;
  }

  // ---------------------------------------------------------------- autopiloto
  // Bucea sin fin: apunta al píxel escapado con más iteraciones (los valles y espirales), acerca a velocidad constante
  // y cada pocos segundos busca un minibrot cerca (periodo por caja + Newton, como KF). Si lo halla, frena y lo muestra.
  alternarAutopiloto() {
    if (this.ap) { this.ap = null; this.vuelo = null; return 'Autopiloto · apagado'; }
    if (!this.worker) return 'Autopiloto · necesita el Worker';
    this.ap = { fase: 'bucear', t: 0, tObj: 0, tMini: 1.5, obj: null, vistos: 0, mirar: 0 };
    this.vuelo = null;
    return 'Autopiloto · buceando';
  }
  autopiloto(dt) {
    const ap = this.ap; ap.t += dt;
    const lisa = (v, obj, k) => v + (obj - v) * (1 - Math.exp(-dt * k));
    if (ap.fase === 'mirar') {
      this.vz = lisa(this.vz, 0, 3); this.vx = lisa(this.vx, 0, 3); this.vy = lisa(this.vy, 0, 3);
      if ((ap.mirar -= dt) <= 0) { ap.fase = 'bucear'; ap.tObj = 0; ap.tMini = 3; ap.obj = null; }
      return;
    }
    // objetivo: el píxel escapado más hondo de la vista (se renueva cada segundo)
    ap.tObj -= dt;
    if (ap.tObj <= 0 && this.ultStats && this.ultStats.nMax > 0) {
      const s = this.ultStats;
      const uv = this.uvDe(s.x + 0.5, s.y + 0.5);
      // no saltar de un lado al otro: mezclar con el objetivo anterior si están cerca
      ap.obj = this.puntoDe([uv[0] * 0.9, uv[1] * 0.9]);
      ap.tObj = 1.0;
    }
    // un minibrot cerca del objetivo: periodo + Newton en el Worker
    ap.tMini -= dt;
    if (ap.tMini <= 0 && !this.pend.mini && ap.obj && this.lz < LZ_DIRECTO + 4) {
      ap.tMini = 3.5;
      const P = M.bitsPara(this.lz, 96), [x, y, P0] = ap.obj;
      this.pend.mini = this.enviar({ tipo: 'mini', cx: M.cambiaP(x, P0, P), cy: M.cambiaP(y, P0, P), P, lr: this.lz - 1.5, maxP: Math.max(2000, this.maxIter), intentos: 4 });
    }
    let rap = 1.6;
    if (this.s >= 8) rap *= 0.5; else if (this.s >= 4) rap *= 0.8;          // si la GPU no da, ir más lento
    let ox = 0, oy = 0;
    if (ap.obj) { [ox, oy] = this.offsetA(ap.obj[0], ap.obj[1], ap.obj[2]); const k = 1 - Math.exp(-dt * 1.2); this.mover(ox * k, oy * k); }
    const lejos = Math.hypot(ox, oy);
    this.vz = lisa(this.vz, lejos > 0.8 ? 0.2 : rap, 1.5);
    this.vx = lisa(this.vx, 0, 6); this.vy = lisa(this.vy, 0, 6);
  }
  apMinibrot(r) {
    const ap = this.ap;
    if (!ap || !r || ap.fase !== 'bucear') return;
    // solo si se verá: tamaño entre ~10^-1 y 10^-5 del radio actual
    if (r.ltam > this.lz - 4 || r.ltam < this.lz - 24) return;
    ap.fase = 'minibrot'; ap.vistos++;
    this.avisar(`Minibrot · periodo ${r.periodo.toLocaleString('es-ES')}`);
    this.volar(r.cx, r.cy, r.P, r.ltam + 1.7, 0.9, () => {
      if (!this.ap) return;
      this.ap.fase = 'mirar'; this.ap.mirar = 2.2;
    });
  }

  // ---------------------------------------------------------------- marcadores
  cargarMarcadores() {
    this.propios = [];
    try { this.propios = JSON.parse(localStorage.getItem('lab.profundo.marcadores') || '[]'); } catch {}
    this.iMarc = -1;
  }
  get marcadores() { return MARCADORES.concat(this.propios); }
  guardarMarcador() {
    const dig = Math.ceil(this.P * LOG10_2) + 2;
    const m = { nombre: `Mío · 10${sup('-' + this.profundidad.toFixed(0))}`, x: M.fixToDec(this.cx, this.P, dig), y: M.fixToDec(this.cy, this.P, dig), lz: +this.lz.toFixed(3) };
    this.propios.push(m); if (this.propios.length > 24) this.propios.shift();
    try { localStorage.setItem('lab.profundo.marcadores', JSON.stringify(this.propios)); } catch {}
    return 'Marcador guardado · ' + m.nombre;
  }
  siguienteMarcador() {
    const L = this.marcadores; if (!L.length) return '';
    this.iMarc = (this.iMarc + 1) % L.length;
    this.irA(L[this.iMarc]);
    return `Marcador ${this.iMarc + 1} / ${L.length} · ${L[this.iMarc].nombre}`;
  }
  irA(mk) {
    this.ap = null; this.vuelo = null; this.vz = this.vx = this.vy = 0;
    const P = Math.max(M.bitsPara(mk.lz, 72), 96);
    const x = M.decToFix(mk.x, P), y = M.decToFix(mk.y, P);
    if (!this.worker && mk.lz < LZ_SIN_REF) return;
    // cerca (en pantalla o a pocas décadas): volar; si no, saltar
    this.P = Math.max(this.P, P); this.asegurarBits();
    const [ox, oy] = this.offsetA(x, y, P);
    if (Math.hypot(ox, oy) < 3 && Math.abs(mk.lz - this.lz) < 20) { this.volar(x, y, P, mk.lz, 1.2); return; }
    this.P = P; this.cx = x; this.cy = y; this.lz = mk.lz; this.saltar = true;
    this.boost = 1; this.maxIter = 0; this.actualizarIter();
  }

  // ---------------------------------------------------------------- cuadro
  frame(enc, dt, t) {
    const c = this.ctx, d = c.device, inp = c.input || {}, W = this.W, H = this.H;
    this.activo = true; this.tt += dt;
    const now = performance.now();
    if (inp.pressed && inp.pressed.a) { const m = this.alternarAutopiloto(); this.avisar(m); }
    this.navegar(dt, inp);
    this.asegurarBits();
    this.actualizarIter();
    this.gestionarRef(now);
    // ---- uniformes del núcleo
    const directo = this.lz > LZ_DIRECTO || (!this.worker && !this.ref);
    const esperando = !directo && !this.refOK;
    const usarBLA = !directo && !esperando && this.blaValida();
    const lp = this.lz - Math.log2(H / 2);           // log2 del tamaño de píxel
    const pe = Math.floor(lp) + 1, pm = 2 ** (lp - pe);
    let off = { x: 0, y: 0, e: M.ZE };
    if (!directo && !esperando) off = this.offFE();
    const dirx = M.fixToNum(this.cx, this.P), diry = M.fixToNum(this.cy, this.P);
    const N = this.ref ? this.ref.N : 1;
    const clave = [this.cx, this.cy, this.lz.toFixed(9), this.maxIter, directo ? 'd' : esperando ? 'e' : this.ref.id, usarBLA ? this.blaT.ldc.toFixed(2) : 'x', W, H].join('|');
    // ---- refinamiento progresivo con presupuesto de muestras por cuadro
    const muestras = (s) => Math.ceil(W / s) * Math.ceil(H / s);
    if (clave !== this.clave) {
      this.clave = clave; this.epoca++; this.moviendo = true;
      let s = 1; while (s < 16 && muestras(s) > this.B) s *= 2;
      this.s = s; this.y0 = 0; this.skip = false; this.completo = false;
    } else this.moviendo = false;
    let pase = null;
    if (!this.completo && !esperando) {
      const s = this.s;
      const filas = this.moviendo || this.y0 === 0 && muestras(s) * (this.skip ? 0.75 : 1) <= this.B * 1.05 ? H
        : Math.max(s, Math.floor(this.B / (this.skip ? 0.75 : 1) / Math.ceil(W / s)) * s);
      const y1 = Math.min(H, this.y0 + filas);
      pase = { s, y0: this.y0, y1, skip: this.skip };
      this.y0 = y1;
      if (this.y0 >= H) {
        if (this.s > 1) { this.s /= 2; this.skip = true; this.y0 = 0; } else this.completo = true;
      }
    }
    if (pase) {
      const u = new Float32Array(20);
      u.set([W, H, pase.s, pase.skip ? 1 : 0, pase.y0, pase.y1, this.maxIter, N, off.x, off.y, off.e, directo ? 0 : 1,
        pm, pe, this.blaT ? this.blaT.niveles : 1, (usarBLA ? 1 : 0) + (!directo && this.ref.nucleo ? 2 : 0), dirx, diry, 2 ** lp, this.lo]);
      d.queue.writeBuffer(this.ub, 0, u);
      enc.clearBuffer(this.st);
      const p = c.cpass(enc); p.setPipeline(this.pK); p.setBindGroup(0, this.bgK);
      p.dispatchWorkgroups(Math.ceil(Math.ceil(W / pase.s) / 8), Math.ceil(Math.ceil((pase.y1 - pase.y0) / pase.s) / 8)); p.end();
      const L = this.lect.find((l) => l.libre);
      if (L) { enc.copyBufferToBuffer(this.st, 0, L.buf, 0, 64); L.libre = false; L.copiado = true; L.tag = { epoca: this.epoca, s: pase.s, completo: this.completo, muestras: muestras(pase.s) }; }
      this.ultPase = pase;
    }
    // ---- rango de μ suavizado (salto inmediato tras un salto de marcador)
    const k = this.saltar ? 1 : 1 - Math.exp(-dt * 5);
    if (this.rangoEpoca >= 0) { this.lo += (this.rlo - this.lo) * k; this.hi += (this.rhi - this.hi) * k; this.h += (this.rh - this.h) * k; if (this.saltar && this.rangoEpoca === this.epoca) this.saltar = false; }
    // ---- color
    const host = this.host, la = this.tt * 0.05;
    const ud = new Float32Array(12);
    ud.set([W, H, this.lo, this.h, host.palette || 0, (host.chaos ? this.tt * 0.05 : 0) + 0.02, 2.6, 1.15,
      Math.cos(la) * 0.55 + 0.35, Math.sin(la) * 0.55 + 0.45, 0.75, 9.0]);
    d.queue.writeBuffer(this.ud, 0, ud);
    const p2 = c.cpass(enc); p2.setPipeline(this.pP); p2.setBindGroup(0, this.bgP);
    p2.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8)); p2.end();
    // ---- presupuesto: que el cuadro no se trabe (objetivo ~11 ms de GPU)
    // presupuesto: this.gpuMs lo mide after() (de submit a «trabajo terminado»). Baja rápido y sube despacio;
    // además, con la tasa de la GPU (pasos/ms) y el costo por muestra de la vista se recorta antes de trabarse.
    if (this.gpuMs != null && pase) {
      const ms = this.gpuMs; this.gpuMs = null;
      this.B *= Math.max(0.5, Math.min(1.08, Math.pow(12 / Math.max(ms, 1), 0.7)));
      const st = this.ultStats;
      if (st && ms > 5 && st.pasos > 0) { const t = st.pasos / (ms - 2); this.tasa = this.tasa ? 0.8 * this.tasa + 0.2 * t : t; }
      if (st && this.tasa && st.esc + st.int > 0) this.B = Math.min(this.B, this.tasa * 13 / Math.max(1, st.pasos / (st.esc + st.int)));
      this.B = Math.max(12000, Math.min(W * H * 1.4, this.B));
    }
    this.hud(dt);
  }
  after() {
    if (!this.midiendo) {
      this.midiendo = true; const t0 = performance.now();
      this.ctx.device.queue.onSubmittedWorkDone().then(() => { this.gpuMs = this.gpuMsUlt = performance.now() - t0; this.midiendo = false; });
    }
    for (const L of this.lect) {
      if (!L.copiado) continue;
      L.copiado = false;
      L.buf.mapAsync(GPUMapMode.READ).then(() => {
        const v = new Uint32Array(L.buf.getMappedRange().slice(0)); L.buf.unmap(); L.libre = true;
        this.procesar(v, L.tag);
      }).catch(() => { L.libre = true; });
    }
  }
  procesar(v, tag) {
    const f = new Float32Array(1), u = new Uint32Array(f.buffer);
    const esc = v[1], int = v[2];
    let lo = null, hi = null;
    if (esc) { u[0] = 0xffffffff - v[3]; lo = f[0]; u[0] = v[4]; hi = f[0]; }
    const s = { epoca: tag.epoca, s: tag.s, pasos: v[0] * 64, esc, int, lo, hi, nMax: v[5], x: v[6], y: v[7], reb: v[8], bj: v[9], tardios: v[10],
      hMedia: esc ? v[11] / esc : 0 };
    this.ultStats = s;
    if (lo != null) {
      // escala robusta del color: la media de log(1 + μ − μmín) de la vista (un píxel suelto pegado al borde no la mueve)
      const esc2 = Math.max(0.5, s.hMedia * 2.4 + Math.max(0, this.lo - lo) * 0);
      if (tag.epoca !== this.rangoEpoca) { this.rangoEpoca = tag.epoca; this.rlo = lo; this.rhi = hi; this.rh = esc2; }
      else { this.rlo = Math.min(this.rlo, lo); this.rhi = Math.max(this.rhi, hi); this.rh = 0.7 * this.rh + 0.3 * esc2; }
    }
    // iteraciones automáticas (como KF): si más de 1 de cada 500 muestras escapa pasada la mitad del tope, subirlo
    if (esc && tag.epoca === this.epoca) {
      const n = esc + int;
      const ahora = performance.now();
      if (s.tardios > 0.004 * n && this.boost < 32 && tag.s <= 4 && ahora - (this.tBoost || 0) > 900) { this.tBoost = ahora; this.boost *= 1.5; this.actualizarIter(); }
      else if (s.nMax < 0.15 * this.maxIter && this.boost > 1 && tag.s <= 2) { this.boost = Math.max(1, this.boost / 1.3); this.actualizarIter(); }
    }
    this.acum = this.acum || { pasos: 0, n: 0 };
    this.acum.pasos = s.pasos; this.acum.muestras = esc + int;
  }

  // ---------------------------------------------------------------- HUD (profundidad 10^-N)
  hud(dt) {
    this.hudT -= dt; if (this.hudT > 0) return; this.hudT = 0.15;
    const capa = this.ctx.capa; if (!capa) return;
    if (!this.hudEl || !capa.contains(this.hudEl)) {
      capa.innerHTML = `<div id="prof-hud" style="position:absolute;left:44px;top:38px;font:400 12px/1.7 var(--mono);color:var(--papel-2);transition:opacity .8s;opacity:0">
        <div class="rotulo-t" style="margin-bottom:4px">Mandelbrot profundo</div>
        <div style="font:300 40px/1.1 var(--serif);color:var(--papel);letter-spacing:.01em">10<span id="prof-exp"></span></div>
        <div id="prof-l1" style="margin-top:6px"></div><div id="prof-l2"></div><div id="prof-l3" style="color:var(--acento)"></div></div>`;
      this.hudEl = capa.querySelector('#prof-hud');
      this.hudExp = capa.querySelector('#prof-exp'); this.hudL = [1, 2, 3].map((i) => capa.querySelector('#prof-l' + i));
      requestAnimationFrame(() => { if (this.hudEl) this.hudEl.style.opacity = 1; });
    }
    const N = this.profundidad;
    this.hudExp.textContent = sup(N < 0.05 ? '0' : '-' + (N < 10 ? N.toFixed(1) : N.toFixed(0)));
    const modo = this.directo ? (this.worker ? 'f32 directo' : 'f32 directo · modo superficial (sin Worker)')
      : `perturbación${this.blaT ? ' · BLA ×' + this.blaT.niveles : ''}${this.lz < -120 ? ' · floatexp' : ''}`;
    this.hudL[0].textContent = `${modo} · ${this.maxIter.toLocaleString('es-ES')} iteraciones`;
    const r = this.ref;
    this.hudL[1].textContent = this.pend.ref ? 'calculando la referencia…'
      : r && !this.directo ? `referencia ${r.nucleo ? 'en un núcleo · periodo ' + r.periodo.toLocaleString('es-ES') : '· órbita de ' + r.N.toLocaleString('es-ES')} · ${r.P} bits`
      : '';
    const ref = this.completo ? '' : `refinando ${this.s}×${this.s}`;
    const ap = this.ap ? (this.ap.fase === 'minibrot' ? 'autopiloto · hacia un minibrot' : this.ap.fase === 'mirar' ? 'autopiloto · mirando' : 'autopiloto · buceando') : this.vuelo ? 'volando…' : '';
    const msj = this.msj && performance.now() - this.msj.t < 2600 ? this.msj.txt : '';
    this.hudL[2].textContent = [msj || ap, ref].filter(Boolean).join(' · ');
  }
  ocultar() { this.activo = false; if (this.hudEl && this.hudEl.parentNode) this.hudEl.parentNode.innerHTML = ''; this.hudEl = null; this.ap = null; this.vuelo = null; }

  lectura() { const N = Math.max(0, this.profundidad); return `10${sup('-' + (N < 10 ? N.toFixed(1) : N.toFixed(0)))} de profundidad`; }
  stats() {
    const s = this.ultStats, mu = s ? s.esc + s.int : 0;
    const r = this.ref;
    return [
      ['fractal', 'Mandelbrot profundo'],
      ['profundidad', '10' + sup('-' + Math.max(0, this.profundidad).toFixed(1)), true],
      ['iteraciones máx', this.maxIter.toLocaleString('es-ES')],
      ['método', this.directo ? 'f32 directo' : 'perturbación + rebasing'],
      ['referencia', !r || this.directo ? '—' : r.nucleo ? `núcleo p=${r.periodo}` : `órbita ${r.N}${r.escapo ? ' (escapa)' : ''}`],
      ['precisión', `${this.P} bits`],
      ['BLA', this.blaT && !this.directo ? `${this.blaT.niveles} niveles` : '—'],
      ['saltos BLA / muestra', s && mu ? (s.bj / mu).toFixed(1) : '—'],
      ['rebases / muestra', s && mu ? (s.reb / mu).toFixed(2) : '—'],
      ['pasos / muestra', s && mu ? (s.pasos / mu).toFixed(0) : '—'],
      ['refinamiento', this.completo ? 'completo' : `${this.s}×${this.s}`],
      ['presupuesto', `${(this.B / 1000).toFixed(0)} k muestras / cuadro`],
    ];
  }

  // ---------------------------------------------------------------- pruebas
  estado() {
    return { lz: this.lz, prof: this.profundidad, directo: this.directo, completo: this.completo, s: this.s, maxIter: this.maxIter,
      pend: { ...this.pend }, ref: this.ref && { N: this.ref.N, periodo: this.ref.periodo, nucleo: this.ref.nucleo, P: this.ref.P, escapo: this.ref.escapo },
      bla: this.blaT && { niveles: this.blaT.niveles, valida: this.ref ? this.blaT.refId === this.ref.id : false }, B: this.B, ap: this.ap && this.ap.fase,
      stats: this.ultStats, lo: this.lo, hi: this.hi, P: this.P };
  }
  irPrueba(x, y, lz) {
    this.ap = null; this.vuelo = null; this.vz = this.vx = this.vy = 0; this.rueda = 0;
    this.P = Math.max(M.bitsPara(lz, 72), 96); this.cx = M.decToFix(x, this.P); this.cy = M.decToFix(y, this.P); this.lz = lz;
    this.saltar = true; this.boost = 1; this.maxIter = 0; this.actualizarIter();
  }
  // μ de la GPU en los píxeles pedidos
  async muestrasGPU(pts) {
    const d = this.ctx.device, W = this.W, H = this.H, bpr = Math.ceil(W * 4 / 256) * 256;
    const buf = d.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.res }, { buffer: buf, bytesPerRow: bpr }, [W, H]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const f = new Float32Array(buf.getMappedRange());
    const out = pts.map(([x, y]) => f[y * bpr / 4 + x]);
    buf.unmap(); buf.destroy();
    return out;
  }
  // μ exacto (BigInt, sin perturbación) en el centro de esos píxeles
  async muestrasCPU(pts, maxIter = this.maxIter) {
    const P = M.bitsPara(this.lz, 64), lp = this.lz - Math.log2(this.H / 2);
    const cx = M.cambiaP(this.cx, this.P, P), cy = M.cambiaP(this.cy, this.P, P);
    const sh = lp + P;
    const puntos = pts.map(([x, y]) => [cx + aBig(x + 0.5 - this.W / 2, sh), cy + aBig(this.H / 2 - y - 0.5, sh)]);
    const r = await this.pedir({ tipo: 'pixel', puntos, P, maxIter });
    return r ? r.mu : null;
  }

  destroy() {
    removeEventListener('wheel', this.onWheel);
    if (this.worker) this.worker.terminate();
    [this.res, this.ub, this.ud, this.st, this.meta, this.orb, this.bla].forEach((x) => x && x.destroy());
    this.lect.forEach((l) => { try { l.buf.destroy(); } catch {} });
    if (window.__profundo === this) delete window.__profundo;
  }
}
