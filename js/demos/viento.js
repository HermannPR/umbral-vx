// Sala «Viento urbano»: de wind-pinn (y pinn-zonatec).
// · Lattice Boltzmann D2Q9 en vivo sobre la misma ciudad sintética (480 m × 240 m, 31 edificios), con
//   Smagorinsky para que aguante números de Reynolds altos y se vean las calles de vórtices.
// · La PINN entrenada (6 capas × 64, tanh, 48 rasgos de Fourier) se evalúa en la GPU sobre toda la malla:
//   reconstruye el viento medio a partir de 250 sensores. La tercera vista compara ambas.
import { makeShader, U, fadePipeline, BLEND_ADD } from '../gpu.js';
import { HASH, FS_VERT, fmt } from '../util.js';

const U_LB = 0.1;          // 5 m/s de referencia en unidades de red
const MODOS = ['LBM en vivo', 'PINN · 250 sensores', 'diferencia |PINN − media LBM|'];

const UNI = /* wgsl */`
struct Uni {
  a: vec4f,   // nx, ny, tau0, Cs (Smagorinsky)
  b: vec4f,   // ux de entrada, uy de entrada, U_LB, modo
  c: vec4f,   // W, H, dominio x0, y0 (px)
  d: vec4f,   // dominio ancho, alto (px), paleta, t
  e: vec4f,   // sonda x, y (celdas), ganancia de estelas, pasos por frame
  f: vec4u,   // semilla, nº de trazadores, reiniciar, 0
};
@group(0) @binding(0) var<uniform> u: Uni;
`;

const SIM = HASH + UNI + /* wgsl */`
@group(0) @binding(1) var<storage, read> fin: array<f32>;
@group(0) @binding(2) var<storage, read_write> fout: array<f32>;
@group(0) @binding(3) var<storage, read> mask: array<u32>;
@group(0) @binding(4) var<storage, read_write> mac: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> media: array<vec2f>;
@group(0) @binding(6) var<storage, read_write> pinn: array<vec4f>;
@group(0) @binding(7) var<storage, read> pesos: array<f32>;
@group(0) @binding(8) var<storage, read_write> tr: array<vec4f>;

const CX = array<i32, 9>(0, 1, 0, -1, 0, 1, -1, -1, 1);
const CY = array<i32, 9>(0, 0, 1, 0, -1, 1, 1, -1, -1);
const WQ = array<f32, 9>(0.44444444, 0.11111111, 0.11111111, 0.11111111, 0.11111111, 0.02777778, 0.02777778, 0.02777778, 0.02777778);
const OPP = array<u32, 9>(0u, 3u, 4u, 1u, 2u, 7u, 8u, 5u, 6u);

fn feq(i: u32, rho: f32, v: vec2f) -> f32 {
  let cu = 3.0 * (f32(CX[i]) * v.x + f32(CY[i]) * v.y);
  return rho * WQ[i] * (1.0 + cu + 0.5 * cu * cu - 1.5 * dot(v, v));
}

@compute @workgroup_size(16, 16)
fn iniciar(@builtin(global_invocation_id) g: vec3u) {
  let nx = u32(u.a.x); let ny = u32(u.a.y);
  if (g.x >= nx || g.y >= ny) { return; }
  let k = g.y * nx + g.x; let N = nx * ny;
  var v = u.b.xy;
  if (mask[k] == 1u) { v = vec2f(0.0); }
  for (var i = 0u; i < 9u; i++) { fout[i * N + k] = feq(i, 1.0, v); }
  mac[k] = vec4f(v, 1.0, 0.0);
  media[k] = v;
}

@compute @workgroup_size(16, 16)
fn paso(@builtin(global_invocation_id) g: vec3u) {
  let nx = u32(u.a.x); let ny = u32(u.a.y);
  if (g.x >= nx || g.y >= ny) { return; }
  let k = g.y * nx + g.x; let N = nx * ny;
  if (mask[k] == 1u) { mac[k] = vec4f(0.0, 0.0, 1.0, 1.0); return; }
  var f: array<f32, 9>;
  let borde = g.x == 0u || g.y == 0u || g.x == nx - 1u || g.y == ny - 1u;
  if (borde) {
    // normal hacia adentro: si el viento entra por aquí, condición de entrada; si sale, gradiente nulo
    var n = vec2f(0.0);
    if (g.x == 0u) { n.x = 1.0; } else if (g.x == nx - 1u) { n.x = -1.0; }
    if (g.y == 0u) { n.y = 1.0; } else if (g.y == ny - 1u) { n.y = -1.0; }
    if (dot(n, u.b.xy) > 0.0) {
      for (var i = 0u; i < 9u; i++) { f[i] = feq(i, 1.0, u.b.xy); }
    } else {
      let x2 = u32(clamp(i32(g.x) + i32(n.x), 0, i32(nx) - 1)); let y2 = u32(clamp(i32(g.y) + i32(n.y), 0, i32(ny) - 1));
      let k2 = y2 * nx + x2;
      for (var i = 0u; i < 9u; i++) { f[i] = fin[i * N + k2]; }
    }
  } else {
    // arrastre (pull) con rebote en las paredes de los edificios
    for (var i = 0u; i < 9u; i++) {
      let sx = i32(g.x) - CX[i]; let sy = i32(g.y) - CY[i];
      let ks = u32(sy) * nx + u32(sx);
      if (mask[ks] == 1u) { f[i] = fin[OPP[i] * N + k]; } else { f[i] = fin[i * N + ks]; }
    }
  }
  var rho = 0.0; var v = vec2f(0.0);
  for (var i = 0u; i < 9u; i++) { rho += f[i]; v += f[i] * vec2f(f32(CX[i]), f32(CY[i])); }
  rho = clamp(rho, 0.6, 1.6);
  v /= rho;
  let sp = length(v);
  if (sp > 0.3) { v *= 0.3 / sp; }
  // Smagorinsky: viscosidad turbulenta a partir del tensor de no-equilibrio
  var pxx = 0.0; var pyy = 0.0; var pxy = 0.0;
  for (var i = 0u; i < 9u; i++) {
    let fn_ = f[i] - feq(i, rho, v);
    let cx = f32(CX[i]); let cy = f32(CY[i]);
    pxx += cx * cx * fn_; pyy += cy * cy * fn_; pxy += cx * cy * fn_;
  }
  let Q = sqrt(pxx * pxx + pyy * pyy + 2.0 * pxy * pxy);
  let t0 = u.a.z; let cs = u.a.w;
  let tau = 0.5 * (t0 + sqrt(t0 * t0 + 18.0 * 1.41421 * cs * cs * Q / rho));
  for (var i = 0u; i < 9u; i++) { fout[i * N + k] = f[i] - (f[i] - feq(i, rho, v)) / tau; }
  mac[k] = vec4f(v, rho, 0.0);
  media[k] = mix(media[k], v, 0.0015);
}

// La PINN de wind-pinn: entrada (x, y) en metros → [z, sen(πzB), cos(πzB)] → 6 × 64 tanh → (u, v, p)
@compute @workgroup_size(64)
fn evaluarPinn(@builtin(global_invocation_id) g: vec3u) {
  let nx = u32(u.a.x); let ny = u32(u.a.y);
  let k = g.x;
  if (k >= nx * ny) { return; }
  if (mask[k] == 1u) { pinn[k] = vec4f(0.0); return; }
  let ix = k % nx; let iy = k / nx;
  let dx = 480.0 / f32(nx);
  let z = vec2f((f32(ix) + 0.5) * dx / 480.0, (f32(iy) + 0.5) * dx / 240.0) * 2.0 - 1.0;
  var a: array<f32, 98>;
  a[0] = z.x; a[1] = z.y;
  for (var j = 0u; j < 48u; j++) {
    let zb = 3.14159265 * (z.x * pesos[j] + z.y * pesos[48u + j]);
    a[2u + j] = sin(zb); a[50u + j] = cos(zb);
  }
  var h: array<f32, 64>;
  var o = 96u;            // los pesos empiezan tras B (2 × 48)
  // capa 1: 64 × 98
  for (var r = 0u; r < 64u; r++) {
    var s = pesos[o + 64u * 98u + r];
    for (var c = 0u; c < 98u; c++) { s += pesos[o + r * 98u + c] * a[c]; }
    h[r] = tanh(s);
  }
  o += 64u * 98u + 64u;
  for (var l = 0u; l < 5u; l++) {
    var h2: array<f32, 64>;
    for (var r = 0u; r < 64u; r++) {
      var s = pesos[o + 64u * 64u + r];
      for (var c = 0u; c < 64u; c++) { s += pesos[o + r * 64u + c] * h[c]; }
      h2[r] = tanh(s);
    }
    h = h2;
    o += 64u * 64u + 64u;
  }
  var out = vec3f(0.0);
  for (var r = 0u; r < 3u; r++) {
    var s = pesos[o + 3u * 64u + r];
    for (var c = 0u; c < 64u; c++) { s += pesos[o + r * 64u + c] * h[c]; }
    out[r] = s;
  }
  pinn[k] = vec4f(out.xy * u.b.z, out.z * 30.0, 0.0);   // (u/U0, v/U0) → unidades de red
}

fn campo(p: vec2f) -> vec2f {
  let nx = i32(u.a.x); let ny = i32(u.a.y);
  let q = clamp(p - 0.5, vec2f(0.0), vec2f(f32(nx) - 1.001, f32(ny) - 1.001));
  let i = vec2i(floor(q)); let fr = q - floor(q);
  let k00 = i.y * nx + i.x; let k10 = k00 + 1; let k01 = k00 + nx; let k11 = k01 + 1;
  if (u.b.w > 0.5) {
    return mix(mix(pinn[k00].xy, pinn[k10].xy, fr.x), mix(pinn[k01].xy, pinn[k11].xy, fr.x), fr.y);
  }
  return mix(mix(mac[k00].xy, mac[k10].xy, fr.x), mix(mac[k01].xy, mac[k11].xy, fr.x), fr.y);
}

// trazadores: (x, y, x anterior, y anterior) en celdas; segundo vec4: edad, vida
@compute @workgroup_size(256)
fn trazar(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= u.f.y) { return; }
  var P = tr[2u * i]; var M = tr[2u * i + 1u];
  var s = pcg(i * 9781u + u.f.x);
  let nx = u.a.x; let ny = u.a.y;
  let p = P.xy;
  let v = campo(p);
  var q = p + v * u.e.w;
  M.x += 1.0;
  let kq = u32(clamp(q.y, 0.0, ny - 1.0)) * u32(nx) + u32(clamp(q.x, 0.0, nx - 1.0));
  if (u.f.z == 1u || M.x > M.y || q.x < 0.0 || q.y < 0.0 || q.x >= nx || q.y >= ny || mask[kq] == 1u) {
    q = vec2f(rnd(&s) * nx, rnd(&s) * ny);
    M = vec4f(0.0, 90.0 + rnd(&s) * 260.0, 0.0, 0.0);
    tr[2u * i] = vec4f(q, q);
  } else {
    tr[2u * i] = vec4f(q, p);
  }
  tr[2u * i + 1u] = M;
}
`;

const LINEAS = UNI + /* wgsl */`
@group(0) @binding(1) var<storage, read> tr: array<vec4f>;
struct VO { @builtin(position) pos: vec4f, @location(0) a: f32 };
fn aPantalla(p: vec2f) -> vec4f {
  let s = u.c.zw + vec2f(p.x / u.a.x, 1.0 - p.y / u.a.y) * u.d.xy;
  return vec4f(s.x / u.c.x * 2.0 - 1.0, 1.0 - s.y / u.c.y * 2.0, 0.0, 1.0);
}
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> VO {
  let P = tr[2u * i]; let M = tr[2u * i + 1u];
  var o: VO;
  o.pos = aPantalla(select(P.zw, P.xy, v == 1u));
  let vida = clamp(M.x / 20.0, 0.0, 1.0) * clamp((M.y - M.x) / 30.0, 0.0, 1.0);
  o.a = vida * u.e.z;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(vec3f(0.85, 0.92, 0.95) * i.a, 1.0); }

// sensores: una cruz pequeña por sensor (4 vértices = 2 segmentos)
@group(0) @binding(2) var<storage, read> sens: array<vec2f>;
@vertex fn vsSensor(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> VO {
  let p = sens[i] * (u.a.x / 480.0);
  let s = u.c.zw + vec2f(p.x / u.a.x, 1.0 - p.y / u.a.y) * u.d.xy;
  let r = 4.0 * u.c.x / 3000.0 + 2.0;
  var d = vec2f(-r, 0.0);
  if (v == 1u) { d = vec2f(r, 0.0); } else if (v == 2u) { d = vec2f(0.0, -r); } else if (v == 3u) { d = vec2f(0.0, r); }
  let q = s + d;
  var o: VO;
  o.pos = vec4f(q.x / u.c.x * 2.0 - 1.0, 1.0 - q.y / u.c.y * 2.0, 0.0, 1.0);
  o.a = select(0.5, 1.6, u.b.w > 0.5);
  return o;
}
@fragment fn fsSensor(i: VO) -> @location(0) vec4f { return vec4f(vec3f(0.91, 0.45, 0.23) * i.a, 1.0); }
`;

const CAMPO = FS_VERT + UNI + /* wgsl */`
@group(0) @binding(1) var<storage, read> mask: array<u32>;
@group(0) @binding(2) var<storage, read> mac: array<vec4f>;
@group(0) @binding(3) var<storage, read> pinn: array<vec4f>;
@group(0) @binding(4) var<storage, read> media: array<vec2f>;
@group(0) @binding(5) var estela: texture_2d<f32>;

fn rampa(s: f32, pal: f32) -> vec3f {
  // rapidez en m/s → pizarra (quieto) · acero · niebla (rápido)
  var c0 = vec3f(0.035, 0.05, 0.06); var c1 = vec3f(0.09, 0.2, 0.27); var c2 = vec3f(0.2, 0.36, 0.44); var c3 = vec3f(0.72, 0.8, 0.82);
  if (pal > 0.5 && pal < 1.5) { c0 = vec3f(0.05, 0.04, 0.03); c1 = vec3f(0.25, 0.12, 0.06); c2 = vec3f(0.75, 0.45, 0.2); c3 = vec3f(1.0, 0.92, 0.75); }
  if (pal > 1.5) { c0 = vec3f(0.04); c1 = vec3f(0.14); c2 = vec3f(0.42); c3 = vec3f(0.9); }
  let t = clamp(s / 11.0, 0.0, 1.0) * 3.0;
  if (t < 1.0) { return mix(c0, c1, t); }
  if (t < 2.0) { return mix(c1, c2, t - 1.0); }
  return mix(c2, c3, t - 2.0);
}
fn vel(k: i32, modo: f32) -> vec2f {
  if (modo > 1.5) { return pinn[k].xy - media[k]; }
  if (modo > 0.5) { return pinn[k].xy; }
  return mac[k].xy;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let est = textureLoad(estela, vec2i(i.pos.xy), 0).rgb;
  let q = (i.pos.xy - u.c.zw) / u.d.xy;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= 1.0 || q.y >= 1.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let nx = i32(u.a.x); let ny = i32(u.a.y);
  let c = vec2i(i32(q.x * u.a.x), i32((1.0 - q.y) * u.a.y));
  let k = c.y * nx + c.x;
  if (mask[k] == 1u) {
    // edificio: azotea plana con un filo más claro
    var borde = false;
    for (var j = 0; j < 4; j++) {
      let o = array<vec2i, 4>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1))[j];
      let c2 = clamp(c + o, vec2i(0), vec2i(nx - 1, ny - 1));
      if (mask[c2.y * nx + c2.x] == 0u) { borde = true; }
    }
    return vec4f(select(vec3f(0.028, 0.027, 0.025), vec3f(0.085, 0.08, 0.072), borde), 1.0);
  }
  let modo = u.b.w;
  let v = vel(k, modo);
  let ms = 5.0 / u.b.z;     // unidades de red → m/s
  var col: vec3f;
  if (modo > 1.5) {
    let e = length(v) * ms;
    col = mix(vec3f(0.025, 0.03, 0.035), vec3f(0.62, 0.3, 0.16), pow(clamp(e / 8.0, 0.0, 1.0), 1.5));
  } else {
    col = rampa(length(v) * ms, u.d.z);
    // vorticidad: un tinte cálido o frío, contenido
    let kx = clamp(c + vec2i(1, 0), vec2i(0), vec2i(nx - 1, ny - 1)); let kxm = clamp(c - vec2i(1, 0), vec2i(0), vec2i(nx - 1, ny - 1));
    let ky = clamp(c + vec2i(0, 1), vec2i(0), vec2i(nx - 1, ny - 1)); let kym = clamp(c - vec2i(0, 1), vec2i(0), vec2i(nx - 1, ny - 1));
    let w = (vel(ky.y * nx + ky.x, modo).x - vel(kym.y * nx + kym.x, modo).x) - (vel(kx.y * nx + kx.x, modo).y - vel(kxm.y * nx + kxm.x, modo).y);
    let tint = select(vec3f(0.35, 0.6, 0.75), vec3f(0.91, 0.5, 0.3), w > 0.0);
    col = mix(col, tint * 0.6, clamp(abs(w) * 9.0, 0.0, 0.32));
  }
  return vec4f(col + est, 1.0);
}
`;

export default class Viento {
  static palettes = ['Pizarra', 'Ámbar', 'Grafito'];
  static controls = { ls: 'dirección del viento', rs: 'mover el anemómetro', trig: '− / + rapidez del viento', a: 'reiniciar el flujo', y: null };
  static info = { title: 'Viento urbano', desc: '' };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 0.95, bloom: 0.05, vignette: 0.4, lift: [0.02, 0.022, 0.024], grain: 0.025 }; this.sonido = { rapidez: 5 }; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    const q = this.ctx.calidad ? this.ctx.calidad.carga : 1;
    const datos = await (await fetch('datos/viento.json')).json();
    this.datos = datos;
    this.nx = q >= 0.7 ? 480 : q >= 0.45 ? 360 : 240; this.ny = this.nx / 2;
    const nx = this.nx, ny = this.ny, N = nx * ny, dx = 480 / nx;
    // máscara de edificios
    const mask = new Uint32Array(N);
    for (const b of datos.buildings) {
      for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
        const x = (ix + 0.5) * dx, y = (iy + 0.5) * dx;
        if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1) mask[iy * nx + ix] = 1;
      }
    }
    this.mask = U.storage(d, N * 4); d.queue.writeBuffer(this.mask, 0, mask);
    this.maskCPU = mask;
    this.f0 = U.storage(d, N * 36); this.f1 = U.storage(d, N * 36);
    this.mac = U.storage(d, N * 16, GPUBufferUsage.COPY_SRC); this.media = U.storage(d, N * 8); this.pinn = U.storage(d, N * 16, GPUBufferUsage.COPY_SRC);
    // pesos de la PINN: B (2 × 48) y luego cada capa W (fila mayor) + b
    const p = [...datos.B[0], ...datos.B[1]];
    for (const l of datos.layers) p.push(...l.W, ...l.b);
    this.pesos = U.storage(d, p.length * 4); d.queue.writeBuffer(this.pesos, 0, new Float32Array(p));
    this.sens = U.storage(d, datos.sensors.length * 8); d.queue.writeBuffer(this.sens, 0, new Float32Array(datos.sensors.flat()));
    this.NT = Math.round(70000 * Math.max(0.35, q) / 256) * 256;
    this.tr = U.storage(d, this.NT * 32);
    this.u = U.uniform(d, 96);
    this.lect = d.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.estela = d.createTexture({ size: [W, H], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.estelaV = this.estela.createView();
    const sm = makeShader(d, SIM, 'viento-sim', report);
    const mk = (ep) => d.createComputePipelineAsync({ layout: 'auto', compute: { module: sm, entryPoint: ep } });
    [this.pIni, this.pPaso, this.pPinn, this.pTr] = await Promise.all([mk('iniciar'), mk('paso'), mk('evaluarPinn'), mk('trazar')]);
    const B = (b) => ({ buffer: b });
    const bg = (pl, ents) => d.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: Object.entries(ents).map(([k, v]) => ({ binding: +k, resource: B(v) })) });
    this.bgIni = [bg(this.pIni, { 0: this.u, 2: this.f0, 3: this.mask, 4: this.mac, 5: this.media }), bg(this.pIni, { 0: this.u, 2: this.f1, 3: this.mask, 4: this.mac, 5: this.media })];
    this.bgPaso = [bg(this.pPaso, { 0: this.u, 1: this.f0, 2: this.f1, 3: this.mask, 4: this.mac, 5: this.media }), bg(this.pPaso, { 0: this.u, 1: this.f1, 2: this.f0, 3: this.mask, 4: this.mac, 5: this.media })];
    this.bgPinn = bg(this.pPinn, { 0: this.u, 3: this.mask, 6: this.pinn, 7: this.pesos });
    this.bgTr = bg(this.pTr, { 0: this.u, 3: this.mask, 4: this.mac, 6: this.pinn, 8: this.tr });
    const lm = makeShader(d, LINEAS, 'viento-lineas', report);
    const rp = (vs, fs, blend) => d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: lm, entryPoint: vs }, fragment: { module: lm, entryPoint: fs, targets: [{ format: 'rgba16float', blend }] }, primitive: { topology: 'line-list' } });
    [this.pLin, this.pSen] = await Promise.all([rp('vs', 'fs', BLEND_ADD), rp('vsSensor', 'fsSensor', BLEND_ADD)]);
    this.bgLin = d.createBindGroup({ layout: this.pLin.getBindGroupLayout(0), entries: [{ binding: 0, resource: B(this.u) }, { binding: 1, resource: B(this.tr) }] });
    this.bgSen = d.createBindGroup({ layout: this.pSen.getBindGroupLayout(0), entries: [{ binding: 0, resource: B(this.u) }, { binding: 2, resource: B(this.sens) }] });
    const cm = makeShader(d, CAMPO, 'viento-campo', report);
    this.pCampo = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: cm, entryPoint: 'vs' }, fragment: { module: cm, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
    this.bgCampo = d.createBindGroup({ layout: this.pCampo.getBindGroupLayout(0), entries: [
      { binding: 0, resource: B(this.u) }, { binding: 1, resource: B(this.mask) }, { binding: 2, resource: B(this.mac) },
      { binding: 3, resource: B(this.pinn) }, { binding: 4, resource: B(this.media) }, { binding: 5, resource: this.estelaV }] });
    this.pFade = fadePipeline(d);
    this.modo = 0; this.ang = 0; this.angObj = 0; this.vel = 5; this.sonda = this.libre(nx * 0.5, ny * 0.47); this.seed = 1; this.lado = 0;
    this.reiniciar = true; this.pinnHecha = false; this.pasos = 0; this.modoT = 0; this.leyendo = false; this.rapidezSonda = 5;
    this.disponer();
  }
  // celda libre más cercana (el anemómetro no puede quedar dentro de un edificio)
  libre(x, y) {
    const nx = this.nx, ny = this.ny;
    for (let r = 0; r < nx; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const ix = Math.round(x + dx), iy = Math.round(y + dy);
      if (ix > 0 && iy > 0 && ix < nx - 1 && iy < ny - 1 && !this.maskCPU[iy * nx + ix]) return [ix + 0.5, iy + 0.5];
    }
    return [x, y];
  }
  disponer() {
    const W = this.ctx.W, H = this.ctx.H;
    const dw = Math.min(W * 0.8, H * 0.6 * 2), dh = dw / 2;
    this.dom = [Math.round(W * 0.53 - dw / 2), Math.round(H * 0.4 - dh / 2), dw, dh];
    this.rotulo();
  }
  rotulo() {
    const r = this.ctx.W / innerWidth, [x0, y0, dw, dh] = this.dom.map((v) => v / r);
    const m100 = dw * 100 / 480;
    const ang = this.modo > 0 ? 0 : this.ang, dir = ['oeste', 'suroeste', 'sur', 'sureste', 'este', 'noreste', 'norte', 'noroeste'][((Math.round(-ang / (Math.PI / 4)) % 8) + 8) % 8];
    const ticks = (this.modo === 2 ? [0, 3, 5, 8] : [0, 4, 8, 11]).map((v, i) => `<text class="rotulo" x="${x0 + dw - 160 + i / 3 * 160}" y="${y0 + dh + 40}" text-anchor="middle">${v}</text>`).join('');
    this.ctx.capa.innerHTML = `<svg width="${innerWidth}" height="${innerHeight}" style="position:absolute;inset:0;overflow:visible">
      <rect x="${x0 - 0.5}" y="${y0 - 0.5}" width="${dw + 1}" height="${dh + 1}" fill="none" stroke="rgba(236,230,218,.22)"/>
      <g class="rotulo-t"><text x="${x0}" y="${y0 - 14}">${MODOS[this.modo]}</text>
      <text x="${x0 + dw}" y="${y0 - 14}" text-anchor="end">480 m × 240 m · ${this.nx} × ${this.ny} celdas</text></g>
      <line x1="${x0}" y1="${y0 + dh + 22}" x2="${x0 + m100}" y2="${y0 + dh + 22}" stroke="rgba(236,230,218,.6)"/>
      <line x1="${x0}" y1="${y0 + dh + 18}" x2="${x0}" y2="${y0 + dh + 26}" stroke="rgba(236,230,218,.6)"/><line x1="${x0 + m100}" y1="${y0 + dh + 18}" x2="${x0 + m100}" y2="${y0 + dh + 26}" stroke="rgba(236,230,218,.6)"/>
      <text class="rotulo" x="${x0 + m100 + 10}" y="${y0 + dh + 26}">100 m</text>
      <g transform="translate(${x0 + m100 + 120}, ${y0 + dh + 22}) rotate(${(-ang * 180) / Math.PI})"><line x1="-14" y1="0" x2="12" y2="0" stroke="#e8743b" stroke-width="1.2"/><path d="M12 0 L5 -4 L5 4 Z" fill="#e8743b"/></g>
      <text class="rotulo" x="${x0 + m100 + 146}" y="${y0 + dh + 26}">viento del ${dir} · ${(this.modo > 0 ? 5 : this.vel).toFixed(1)} m/s</text>
      <defs><linearGradient id="vr"><stop offset="0" stop-color="#090d0f"/><stop offset=".33" stop-color="#173444"/><stop offset=".66" stop-color="#5d8ea3"/><stop offset="1" stop-color="#dfe6e6"/></linearGradient></defs>
      <rect x="${x0 + dw - 160}" y="${y0 + dh + 17}" width="160" height="5" fill="${this.modo === 2 ? '#e8743b' : 'url(#vr)'}"/>${ticks}
      <text class="rotulo" x="${x0 + dw - 170}" y="${y0 + dh + 23}" text-anchor="end">${this.modo === 2 ? 'error m/s' : 'rapidez m/s'}</text>
      <circle id="vt-sonda" r="7" fill="none" stroke="rgba(236,230,218,.9)"/><line id="vt-l" stroke="rgba(236,230,218,.5)"/>
      <text id="vt-txt" class="rotulo" style="fill:var(--papel)"></text>
      ${this.modo > 0 ? `<text class="rotulo" x="${x0}" y="${y0 + dh + 58}" style="fill:var(--papel-3)">la PINN se entrenó solo con viento del oeste a 5 m/s; error L2 de rapidez: PINN ${(this.datos.metrics.pinn_rel_l2_speed * 100).toFixed(1)} % · interpolación ${(this.datos.metrics.griddata_rel_l2_speed * 100).toFixed(1)} %</text>${this.modo === 2 ? `<text class="rotulo" x="${x0}" y="${y0 + dh + 76}" style="fill:var(--papel-3)">este LBM corre con menos viscosidad que la simulación que la entrenó: la media no tiene por qué coincidir</text>` : ''}` : ''}
    </svg>`;
    this.$sonda = this.ctx.capa.querySelector('#vt-sonda'); this.$txt = this.ctx.capa.querySelector('#vt-txt'); this.$l = this.ctx.capa.querySelector('#vt-l');
  }
  nombreModo() { return MODOS[this.modo]; }
  cambiarModo(dir) { this.modo = (this.modo + dir + 3) % 3; this.modoT = 0; this.cambio = true; this.ctx.sonido.evento('modo'); if (this.modo > 0) this.angObj = 0; return this.nombreModo(); }
  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, W = this.ctx.W, H = this.ctx.H, nx = this.nx, ny = this.ny;
    this.modoT += dt;
    let cambio = false;
    if (this.ctx.recorrido && this.modoT > 15) this.cambiarModo(1);
    if (this.cambio) { cambio = true; this.cambio = false; }
    if (inp.pressed.a) this.reiniciar = true;
    if (this.modo === 0 && Math.hypot(inp.lx, inp.ly) > 0.5) this.angObj = Math.atan2(-inp.ly, inp.lx);
    if (this.modo === 0 && this.ctx.recorrido) this.angObj = 0.5 * Math.sin(this.modoT * 0.2);
    const dA = Math.atan2(Math.sin(this.angObj - this.ang), Math.cos(this.angObj - this.ang));
    const giro = Math.abs(dA) > 0.002;
    this.ang += dA * Math.min(1, dt * 0.8);
    this.vel = Math.max(2, Math.min(6, this.vel + (inp.r2 - inp.l2) * dt * 1.5));
    this.sonda[0] = Math.max(1, Math.min(nx - 2, this.sonda[0] + inp.rx * dt * nx * 0.25));
    this.sonda[1] = Math.max(1, Math.min(ny - 2, this.sonda[1] - inp.ry * dt * ny * 0.4));
    if (Math.hypot(inp.rx, inp.ry) < 0.1 && this.maskCPU[Math.floor(this.sonda[1]) * nx + Math.floor(this.sonda[0])]) this.sonda = this.libre(...this.sonda);
    if (this.ctx.pointer.down) {
      const [x0, y0, dw, dh] = this.dom, p = this.ctx.pointer;
      this.sonda = [Math.max(1, Math.min(nx - 2, (p.x - x0) / dw * nx)), Math.max(1, Math.min(ny - 2, (1 - (p.y - y0) / dh) * ny))];
    }
    const V = this.modo > 0 ? 5 : this.vel, ul = U_LB * V / 5;
    const steps = 14;
    const f = new Float32Array(24), u32 = new Uint32Array(f.buffer);
    f.set([nx, ny, 0.515, 0.14], 0); f.set([ul * Math.cos(this.ang), ul * Math.sin(this.ang), U_LB, this.modo], 4);
    f.set([W, H, this.dom[0], this.dom[1]], 8); f.set([this.dom[2], this.dom[3], this.palette || 0, t], 12);
    f.set([...this.sonda, 0.022 * Math.sqrt(70000 / this.NT), steps], 16);
    u32.set([this.seed++ * 2654435761 >>> 0, this.NT, this.reiniciar ? 1 : 0, 0], 20);
    d.queue.writeBuffer(this.u, 0, f);
    const cdisp = [Math.ceil(nx / 16), Math.ceil(ny / 16)];
    if (this.reiniciar) {
      const cp = this.ctx.cpass(enc); cp.setPipeline(this.pIni);
      for (const b of this.bgIni) { cp.setBindGroup(0, b); cp.dispatchWorkgroups(...cdisp); }
      cp.end(); this.lado = 0; this.pasos = 0;
    }
    if (!this.pinnHecha) {
      const cp = this.ctx.cpass(enc); cp.setPipeline(this.pPinn); cp.setBindGroup(0, this.bgPinn); cp.dispatchWorkgroups(Math.ceil(nx * ny / 64)); cp.end();
      this.pinnHecha = true;
    }
    {
      const cp = this.ctx.cpass(enc); cp.setPipeline(this.pPaso);
      for (let s = 0; s < steps; s++) { cp.setBindGroup(0, this.bgPaso[this.lado]); cp.dispatchWorkgroups(...cdisp); this.lado ^= 1; }
      cp.setPipeline(this.pTr); cp.setBindGroup(0, this.bgTr); cp.dispatchWorkgroups(Math.ceil(this.NT / 256));
      cp.end();
    }
    this.pasos += steps;
    this.reiniciar = false;
    // estelas: desvanecer y dibujar segmentos, luego sensores
    const rp1 = this.ctx.rpass(enc, { colorAttachments: [{ view: this.estelaV, loadOp: this.primeraEstela ? 'load' : 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    this.primeraEstela = true;
    rp1.setPipeline(this.pFade); rp1.setBlendConstant([0.9, 0.9, 0.9, 1]); rp1.draw(3);
    rp1.setPipeline(this.pLin); rp1.setBindGroup(0, this.bgLin); rp1.draw(2, this.NT);
    rp1.end();
    const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rp.setPipeline(this.pCampo); rp.setBindGroup(0, this.bgCampo); rp.draw(3);
    rp.setPipeline(this.pSen); rp.setBindGroup(0, this.bgSen); rp.draw(4, this.datos.sensors.length);
    rp.end();
    // lectura del anemómetro (asíncrona)
    if (!this.leyendo && (this.pasos % 4 === 0 || true)) {
      const k = Math.floor(this.sonda[1]) * nx + Math.floor(this.sonda[0]);
      const src = this.modo > 0 ? this.pinn : this.mac;
      enc.copyBufferToBuffer(src, k * 16, this.lect, 0, 16); this.copiado = true;
    }
    if (cambio || giro) this.rotulo();
    this.dibujarSonda();
  }
  after() {
    if (!this.copiado) return;
    this.copiado = false; this.leyendo = true;
    this.lect.mapAsync(GPUMapMode.READ).then(() => {
      const a = new Float32Array(this.lect.getMappedRange().slice(0));
      this.lect.unmap(); this.leyendo = false;
      const v = Math.hypot(a[0], a[1]) / U_LB * 5;
      this.rapidezSonda = v; this.sonido.rapidez = v;
      this.presion = this.modo > 0 ? a[2] : (a[2] - 1) / 3 * 1.2 * Math.pow(5 / U_LB, 2);
    }).catch(() => { this.leyendo = false; });
  }
  dibujarSonda() {
    if (!this.$sonda) return;
    const r = this.ctx.W / innerWidth, [x0, y0, dw, dh] = this.dom.map((v) => v / r);
    const x = x0 + this.sonda[0] / this.nx * dw, y = y0 + (1 - this.sonda[1] / this.ny) * dh;
    this.$sonda.setAttribute('cx', x); this.$sonda.setAttribute('cy', y);
    const tx = x + 12, ty = y - 14;
    this.$l.setAttribute('x1', x + 5); this.$l.setAttribute('y1', y - 5); this.$l.setAttribute('x2', tx); this.$l.setAttribute('y2', ty + 4);
    this.$txt.setAttribute('x', tx + 3); this.$txt.setAttribute('y', ty);
    this.$txt.textContent = `${this.rapidezSonda.toFixed(1)} m/s${this.presion != null ? ' · ' + this.presion.toFixed(1) + ' Pa' : ''}`;
  }
  lectura() { return `${MODOS[this.modo]} · anemómetro ${this.rapidezSonda.toFixed(1)} m/s`; }
  stats() {
    const fps = this.ctx.perf.fps, cells = this.nx * this.ny;
    return [['celdas de red', fmt.int(cells), true], ['actualizaciones / s', fmt.si(cells * 14 * fps)], ['trazadores', fmt.int(this.NT)],
      ['PINN', '6 × 64 tanh · 48 Fourier'], ['evaluaciones PINN', fmt.int(cells) + ' (una vez)']];
  }
  destroy() {
    [this.mask, this.f0, this.f1, this.mac, this.media, this.pinn, this.pesos, this.sens, this.tr, this.u, this.lect].forEach((b) => b.destroy());
    this.estela.destroy(); this.ctx.capa.innerHTML = '';
  }
}
