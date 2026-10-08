// Sala «Péndulos»: tres vistas de lo mismo, la sensibilidad a las condiciones iniciales.
// Ideas de Math Visual Lab (doble péndulo, mapa de fases, mapa estándar), reescritas en WebGPU.
//  0 · Abanico: miles de péndulos dobles que salen casi juntos (separados por ε) y se abren en abanico.
//  1 · Mapa de volteo: cada píxel es un péndulo con (θ₁, θ₂) iniciales; el color dice cuándo voltea por primera vez.
//  2 · Rotor pateado: el mapa estándar de Chirikov, un péndulo que recibe golpes periódicos; islas y mar caótico.
import { makeShader, U, fadePipeline, BLEND_ADD, BLEND_DECAY, Counters } from '../gpu.js';
import { HASH, FS_VERT, fmt, zonaLibre } from '../util.js';

const G = 9.81;
const COMUN = HASH + /* wgsl */`
struct Uni {
  a: vec4f,   // W, H, t, vista
  b: vec4f,   // h, subpasos, N, ganancia
  c: vec4f,   // pivote x, y (px), largo (px), paleta
  d: vec4f,   // lado de la malla, mapa x0, y0, tamaño (px)
  e: vec4f,   // K, ε, cursor θ1, cursor θ2
  f: vec4u,   // semilla, reiniciar, tiempo simulado (ms), 0
};
const g = ${G};
fn derivada(s: vec4f) -> vec4f {
  let d = s.x - s.y;
  let den = 3.0 - cos(2.0 * d);
  let a1 = (-g * 3.0 * sin(s.x) - g * sin(s.x - 2.0 * s.y) - 2.0 * sin(d) * (s.w * s.w + s.z * s.z * cos(d))) / den;
  let a2 = (2.0 * sin(d) * (2.0 * s.z * s.z + 2.0 * g * cos(s.x) + s.w * s.w * cos(d))) / den;
  return vec4f(s.z, s.w, a1, a2);
}
fn rk4(s: vec4f, h: f32) -> vec4f {
  let k1 = derivada(s);
  let k2 = derivada(s + k1 * (0.5 * h));
  let k3 = derivada(s + k2 * (0.5 * h));
  let k4 = derivada(s + k3 * h);
  return s + (k1 + 2.0 * k2 + 2.0 * k3 + k4) * (h / 6.0);
}
fn paleta(t: f32, p: f32) -> vec3f {
  // tres paradas con intención: verdín → hueso → cobre (y variantes)
  var a = vec3f(0.20, 0.55, 0.48); var b = vec3f(0.95, 0.90, 0.80); var c = vec3f(0.85, 0.42, 0.18);
  if (p > 0.5 && p < 1.5) { a = vec3f(0.15, 0.25, 0.6); b = vec3f(0.85, 0.9, 1.0); c = vec3f(0.55, 0.35, 0.85); }
  if (p > 1.5) { a = vec3f(0.5); b = vec3f(0.95); c = vec3f(0.7); }
  return select(mix(b, c, (t - 0.5) * 2.0), mix(a, b, t * 2.0), t < 0.5);
}
`;

const COMPUTE = COMUN + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var<storage, read_write> fan: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> mapa: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> volteo: array<f32>;
@group(0) @binding(4) var<storage, read_write> rotor: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> acc: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> cnt: array<atomic<u32>>;

@compute @workgroup_size(256)
fn pasoAbanico(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let N = u32(u.b.z);
  if (i >= N) { return; }
  var s = fan[i];
  if (u.f.y == 1u) {
    let k = (f32(i) / f32(N) - 0.5) * u.e.y;
    s = vec4f(u.e.z + k, u.e.w + k, 0.0, 0.0);
  }
  let h = u.b.x;
  for (var k = 0u; k < u32(u.b.y); k++) { s = rk4(s, h); }
  fan[i] = s;
}

@compute @workgroup_size(16, 16)
fn pasoMapa(@builtin(global_invocation_id) id: vec3u) {
  let G = u32(u.d.x);
  if (id.x >= G || id.y >= G) { return; }
  let i = id.y * G + id.x;
  var s = mapa[i];
  if (u.f.y == 1u) {
    let th = (vec2f(id.xy) + 0.5) / f32(G) * 6.2831853 - 3.14159265;
    s = vec4f(th.x, -th.y, 0.0, 0.0);
    volteo[i] = -1.0;
  }
  if (volteo[i] < 0.0) {
    let h = u.b.x;
    for (var k = 0u; k < u32(u.b.y); k++) { s = rk4(s, h); }
    if (abs(s.x) > 3.14159265 || abs(s.y) > 3.14159265) {
      volteo[i] = f32(u.f.z) / 1000.0;
      atomicAdd(&cnt[0], 1u);
    }
    mapa[i] = s;
  }
}

fn splat(p: vec2f, col: vec3f) {
  let x0 = u.d.y; let y0 = u.d.z; let S = u.d.w;
  let q = vec2f(x0, y0) + vec2f(p.x, 1.0 - p.y) * S;
  let W = u32(u.a.x); let H = u32(u.a.y);
  if (q.x < 0.0 || q.y < 0.0 || q.x >= u.a.x || q.y >= u.a.y) { return; }
  let k = (u32(q.y) * W + u32(q.x)) * 3u;
  let c = col * 65536.0;
  atomicAdd(&acc[k], u32(c.x)); atomicAdd(&acc[k + 1u], u32(c.y)); atomicAdd(&acc[k + 2u], u32(c.z));
}

@compute @workgroup_size(256)
fn pasoRotor(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x + id.y * 65535u * 256u;
  let N = u32(u.b.z);
  if (i >= N) { return; }
  var s = rotor[i];
  let TAU = 6.2831853;
  if (u.f.y == 1u) {
    var r = pcg(i * 747796405u + u.f.x);
    let a = f32(r) / 4294967296.0; r = pcg(r);
    let b = f32(r) / 4294967296.0;
    r = pcg(r);
    s = vec4f(a * TAU, b * TAU, f32(r) / 4294967296.0, 0.0);
  }
  let K = u.e.x;
  let col = paleta(s.z, u.c.w) * u.b.w;
  for (var k = 0u; k < u32(u.b.y); k++) {
    let p = s.y + K * sin(s.x);
    let p2 = p - TAU * floor(p / TAU);
    let th = s.x + p2;
    s = vec4f(th - TAU * floor(th / TAU), p2, s.z, s.w);
    splat(s.xy / TAU, col);
  }
  rotor[i] = s;
}
`;

const LINEAS = COMUN + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var<storage, read> fan: array<vec4f>;
struct VO { @builtin(position) pos: vec4f, @location(0) col: vec3f };
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> VO {
  let s = fan[i];
  let P = u.c.xy; let L = u.c.z;
  let p1 = P + L * vec2f(sin(s.x), cos(s.x));
  let p2 = p1 + L * vec2f(sin(s.y), cos(s.y));
  var p = P;
  if (v == 1u || v == 2u) { p = p1; }
  if (v == 3u) { p = p2; }
  var o: VO;
  o.pos = vec4f(p.x / u.a.x * 2.0 - 1.0, 1.0 - p.y / u.a.y * 2.0, 0.0, 1.0);
  let N = u.b.z;
  let t = select(f32(i) / max(1.0, N - 1.0), 0.5, N < 1.5);
  o.col = paleta(t, u.c.w) * u.b.w * select(0.55, 1.0, v >= 2u);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(i.col, 1.0); }
`;

const MAPA = FS_VERT + COMUN + /* wgsl */`
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var<storage, read> mapa: array<vec4f>;
@group(0) @binding(2) var<storage, read> volteo: array<f32>;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let G = u32(u.d.x);
  let q = (i.pos.xy - u.d.yz) / u.d.w;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= 1.0 || q.y >= 1.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let c = vec2u(q * f32(G));
  let k = c.y * G + c.x;
  let f = volteo[k];
  let s = mapa[k];
  var col: vec3f;
  if (f < 0.0) {
    // aún no voltea: gris tenue que late con el ángulo del segundo brazo
    col = vec3f(0.018, 0.017, 0.015) + vec3f(0.03, 0.029, 0.025) * (0.5 + 0.5 * cos(s.y));
  } else {
    let t = clamp(log2(1.0 + f) / log2(1.0 + 40.0), 0.0, 1.0);
    col = paleta(1.0 - t, u.c.w) * mix(0.62, 0.1, t);
  }
  // cursor
  let cur = (vec2f(u.e.z, -u.e.w) + 3.14159265) / 6.2831853;
  let dpx = abs(q - cur) * u.d.w;
  if ((dpx.x < 0.6 && dpx.y > 6.0 && dpx.y < 16.0) || (dpx.y < 0.6 && dpx.x > 6.0 && dpx.x < 16.0)) { col = vec3f(1.0, 0.95, 0.85); }
  return vec4f(col, 1.0);
}
`;

const RESOLVE = FS_VERT + /* wgsl */`
@group(0) @binding(0) var<uniform> res: vec4f;
@group(0) @binding(1) var<storage, read_write> acc: array<u32>;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let p = vec2u(i.pos.xy);
  let k = (p.y * u32(res.x) + p.x) * 3u;
  let c = vec3f(f32(acc[k]), f32(acc[k + 1u]), f32(acc[k + 2u])) / 65536.0;
  acc[k] = 0u; acc[k + 1u] = 0u; acc[k + 2u] = 0u;
  return vec4f(c, 1.0);
}
`;

const VISTAS = ['Abanico', 'Mapa de volteo', 'Rotor pateado'];

export default class Pendulos {
  static palettes = ['Verdín', 'Cianotipia', 'Grafito'];
  static controls = { ls: 'cursor del mapa · ángulos de salida', trig: '− / + separación ε · fuerza K', a: 'soltar de nuevo', y: null };
  static info = { title: 'Péndulos', desc: '' };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.0, bloom: 0.18, vignette: 0.5, lift: [0.022, 0.02, 0.016], grain: 0.03 }; this.sonido = { vista: 0 }; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    const q = this.ctx.calidad ? this.ctx.calidad.carga : 1;
    this.NF = Math.round(6144 * Math.max(0.33, q) / 256) * 256;
    this.G = q >= 0.7 ? 1024 : q >= 0.45 ? 768 : 512;
    this.NR = Math.round(6144 * Math.max(0.33, q) / 256) * 256;
    this.fan = U.storage(d, this.NF * 16); this.mapa = U.storage(d, this.G * this.G * 16); this.volteo = U.storage(d, this.G * this.G * 4);
    this.rotor = U.storage(d, this.NR * 16); this.acc = U.storage(d, W * H * 12);
    this.cnt = new Counters(d, 4, 6);
    this.u = U.uniform(d, 96); this.ru = U.uniform(d, 16);
    d.queue.writeBuffer(this.ru, 0, new Float32Array([W, H, 0, 0]));
    const cm = makeShader(d, COMPUTE, 'pendulos', report);
    const mk = (ep) => d.createComputePipelineAsync({ layout: 'auto', compute: { module: cm, entryPoint: ep } });
    [this.pFan, this.pMapa, this.pRotor] = await Promise.all([mk('pasoAbanico'), mk('pasoMapa'), mk('pasoRotor')]);
    const B = (b) => ({ buffer: b });
    this.bgFan = d.createBindGroup({ layout: this.pFan.getBindGroupLayout(0), entries: [{ binding: 0, resource: B(this.u) }, { binding: 1, resource: B(this.fan) }] });
    this.bgMapa = d.createBindGroup({ layout: this.pMapa.getBindGroupLayout(0), entries: [{ binding: 0, resource: B(this.u) }, { binding: 2, resource: B(this.mapa) }, { binding: 3, resource: B(this.volteo) }, { binding: 6, resource: B(this.cnt.buf) }] });
    this.bgRotor = d.createBindGroup({ layout: this.pRotor.getBindGroupLayout(0), entries: [{ binding: 0, resource: B(this.u) }, { binding: 4, resource: B(this.rotor) }, { binding: 5, resource: B(this.acc) }] });
    const lm = makeShader(d, LINEAS, 'pendulos-lineas', report);
    this.pLin = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: lm, entryPoint: 'vs' }, fragment: { module: lm, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: BLEND_ADD }] }, primitive: { topology: 'line-list' } });
    this.bgLin = d.createBindGroup({ layout: this.pLin.getBindGroupLayout(0), entries: [{ binding: 0, resource: B(this.u) }, { binding: 1, resource: B(this.fan) }] });
    // péndulo testigo del cursor (vista de mapa): un búfer propio con un solo estado
    this.uno = U.storage(d, 16); this.uU = U.uniform(d, 96);
    this.bgUno = d.createBindGroup({ layout: this.pLin.getBindGroupLayout(0), entries: [{ binding: 0, resource: B(this.uU) }, { binding: 1, resource: B(this.uno) }] });
    const mm = makeShader(d, MAPA, 'pendulos-mapa', report);
    this.pMap = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mm, entryPoint: 'vs' }, fragment: { module: mm, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
    this.bgMap = d.createBindGroup({ layout: this.pMap.getBindGroupLayout(0), entries: [{ binding: 0, resource: B(this.u) }, { binding: 1, resource: B(this.mapa) }, { binding: 2, resource: B(this.volteo) }] });
    const rm = makeShader(d, RESOLVE, 'pendulos-resolve', report);
    this.pRes = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: rm, entryPoint: 'vs' }, fragment: { module: rm, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: BLEND_DECAY }] } });
    this.bgRes = d.createBindGroup({ layout: this.pRes.getBindGroupLayout(0), entries: [{ binding: 0, resource: B(this.ru) }, { binding: 1, resource: B(this.acc) }] });
    this.pFade = fadePipeline(d);
    this.vista = 0; this.eps = 1e-4; this.K = 0.971635; this.th = [2.05, 2.6]; this.cur = [1.2, -0.4];
    this.reiniciar = [true, true, true]; this.simT = [0, 0, 0]; this.primero = true; this.vistaT = 0; this.seed = 1;
    this.testigos = null; this.uState = null; this.flips = 0; this.ultVuelta = 0;
    // mapas (vistas II y III): cuadrado arriba de la ficha, con lugar para los ejes y para el péndulo testigo a la derecha
    this.geo = zonaLibre(1, { arriba: 48, extraIzq: 44, extraAbajo: 30, maxH: innerHeight * 0.84, soloArriba: true });
    this.rotulo();
  }
  rotulo() {
    const v = this.vista, capa = this.ctx.capa, W = innerWidth, H = innerHeight;
    const notas = [
      ['Abanico', `${fmt.int(this.NF)} péndulos dobles; entre el primero y el último solo cambia el ángulo inicial en ε.`],
      ['Mapa de volteo', 'Cada punto es un péndulo que sale del reposo en (θ₁, θ₂). Claro: voltea pronto. Oscuro: tarda. Gris: todavía no.'],
      ['Rotor pateado', 'pₙ₊₁ = pₙ + K sen θₙ  ·  θₙ₊₁ = θₙ + pₙ₊₁. Con K pequeño, órbitas ordenadas; al subir K, el caos se las come.'],
    ][v];
    let ejes = '';
    if (v > 0) {
      const { x: x0, y: y0, w: S } = this.geo;
      const lx = v === 1 ? ['−π', 'θ₁', 'π'] : ['0', 'θ', '2π'], ly = v === 1 ? ['−π', 'θ₂', 'π'] : ['0', 'p', '2π'];
      ejes = `<svg width="${W}" height="${H}" style="position:absolute;inset:0">
        <rect x="${x0 - 0.5}" y="${y0 - 0.5}" width="${S + 1}" height="${S + 1}" fill="none" stroke="rgba(236,230,218,.18)"/>
        <text class="rotulo" x="${x0}" y="${y0 + S + 22}">${lx[0]}</text><text class="rotulo" x="${x0 + S / 2}" y="${y0 + S + 22}" text-anchor="middle" style="font-style:italic">${lx[1]}</text><text class="rotulo" x="${x0 + S}" y="${y0 + S + 22}" text-anchor="end">${lx[2]}</text>
        <text class="rotulo" x="${x0 - 14}" y="${y0 + S}" text-anchor="end">${ly[0]}</text><text class="rotulo" x="${x0 - 14}" y="${y0 + S / 2}" text-anchor="end" style="font-style:italic">${ly[1]}</text><text class="rotulo" x="${x0 - 14}" y="${y0 + 10}" text-anchor="end">${ly[2]}</text>
      </svg>`;
    }
    capa.innerHTML = ejes + `<div class="nota" style="position:absolute;left:44px;top:38px;max-width:${v > 0 ? Math.max(200, this.geo.x - 44 - 70) : 380}px;transition:opacity .8s;opacity:0">
      <div class="rotulo-t" style="margin-bottom:10px">${['I', 'II', 'III'][v]} · ${notas[0]}</div>
      <div style="font:italic 400 16px/1.45 var(--serif);color:var(--papel-2)">${notas[1]}</div></div>`;
    requestAnimationFrame(() => { const e = capa.querySelector('.nota'); if (e) e.style.opacity = 1; });
  }
  nombreModo() { return VISTAS[this.vista]; }
  cambiarModo(dir) { this.vista = (this.vista + dir + 3) % 3; this.vistaT = 0; this.primero = true; this.rotulo(); this.ctx.sonido.evento('a'); return this.nombreModo(); }
  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, W = this.ctx.W, H = this.ctx.H;
    this.vistaT += dt;
    if (this.ctx.recorrido && this.vistaT > 15) this.cambiarModo(1);
    if (inp.pressed.a) { this.reiniciar[this.vista] = true; }
    const v = this.vista;
    this.sonido.vista = v;
    const trig = inp.r2 - inp.l2;
    if (v === 0) {
      if (Math.abs(trig) > 0.05) this.eps = Math.max(1e-9, Math.min(0.05, this.eps * Math.exp(trig * dt * 2.5)));
      if (Math.hypot(inp.lx, inp.ly) > 0.1) { this.th[0] += inp.lx * dt; this.th[1] += -inp.ly * dt; this.reiniciar[0] = true; }
      if (this.simT[0] > 40) this.reiniciar[0] = true;
    } else if (v === 1) {
      this.cur[0] = Math.max(-3.1, Math.min(3.1, this.cur[0] + inp.lx * dt * 1.2));
      this.cur[1] = Math.max(-3.1, Math.min(3.1, this.cur[1] - inp.ly * dt * 1.2));
      if (Math.hypot(inp.lx, inp.ly) > 0.1 || !this.uState) this.uState = [this.cur[0], this.cur[1], 0, 0];
      if (this.simT[1] > 45) this.reiniciar[1] = true;
    } else {
      if (Math.abs(trig) > 0.05) { this.K = Math.max(0.05, Math.min(3.5, this.K + trig * dt * 0.5)); }
      if (this.ctx.recorrido) this.K = 0.97 + 0.75 * Math.sin(this.vistaT * 0.25);
    }
    const res = this.reiniciar[v];
    if (res) { this.simT[v] = 0; this.reiniciar[v] = false; this.primero = true; if (v === 0) this.testigos = null; }
    const h = 1 / 240, subs = v === 0 ? 4 : v === 1 ? 3 : 80;
    this.simT[v] += h * subs;
    const r = W / innerWidth, S = this.geo.w * r, x0 = this.geo.x * r, y0 = this.geo.y * r;
    const L = H * 0.2;
    const gain = v === 0 ? 0.0045 * 6144 / this.NF : 0.0011 * (W * H) / (this.NR * subs);
    const f = new Float32Array(24), u32 = new Uint32Array(f.buffer);
    f.set([W, H, t, v], 0); f.set([h, subs, v === 0 ? this.NF : this.NR, gain], 4); f.set([W / 2, H * 0.45, L, this.palette || 0], 8);
    f.set([this.G, x0, y0, S], 12); f.set([v === 2 ? this.K : 0, this.eps, v === 0 ? this.th[0] : this.cur[0], v === 0 ? this.th[1] : this.cur[1]], 16);
    u32.set([this.seed++ * 2654435761 >>> 0, res ? 1 : 0, Math.round(this.simT[v] * 1000), 0], 20);
    d.queue.writeBuffer(this.u, 0, f);
    const hdr = this.ctx.post.hdrView;
    if (v === 0) {
      const cp = this.ctx.cpass(enc); cp.setPipeline(this.pFan); cp.setBindGroup(0, this.bgFan); cp.dispatchWorkgroups(Math.ceil(this.NF / 256)); cp.end();
      const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: hdr, loadOp: this.primero ? 'clear' : 'load', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
      rp.setPipeline(this.pFade); rp.setBlendConstant([0.82, 0.82, 0.82, 1]); rp.draw(3);
      rp.setPipeline(this.pLin); rp.setBindGroup(0, this.bgLin); rp.draw(4, this.NF); rp.end();
      this.testigo(h, subs);
    } else if (v === 1) {
      this.cnt.clear(enc);
      const cp = this.ctx.cpass(enc); cp.setPipeline(this.pMapa); cp.setBindGroup(0, this.bgMapa);
      cp.dispatchWorkgroups(Math.ceil(this.G / 16), Math.ceil(this.G / 16)); cp.end();
      this.cnt.copy(enc);
      const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: hdr, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
      rp.setPipeline(this.pMap); rp.setBindGroup(0, this.bgMap); rp.draw(3);
      // el péndulo del cursor, dibujado a la derecha del mapa
      this.pasoUno(h, subs);
      const fu = new Float32Array(24); fu.set(f);
      const libre = W - (x0 + S); fu.set([x0 + S + libre / 2, H * 0.36, Math.min(libre * 0.3, H * 0.15), this.palette || 0], 8); fu.set([W, H, t, v], 0); fu.set([h, subs, 1, 1.4], 4);
      d.queue.writeBuffer(this.uU, 0, fu); d.queue.writeBuffer(this.uno, 0, new Float32Array(this.uState));
      rp.setPipeline(this.pLin); rp.setBindGroup(0, this.bgUno); rp.draw(4, 1); rp.end();
    } else {
      const cp = this.ctx.cpass(enc); cp.setPipeline(this.pRotor); cp.setBindGroup(0, this.bgRotor); cp.dispatchWorkgroups(...U.grid1D(this.NR)); cp.end();
      const decay = 0.992;
      const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: hdr, loadOp: this.primero ? 'clear' : 'load', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
      rp.setPipeline(this.pRes); rp.setBindGroup(0, this.bgRes); rp.setBlendConstant([decay, decay, decay, decay]); rp.draw(3); rp.end();
    }
    this.primero = false;
  }
  after() {
    this.cnt.after();
    if (this.vista === 1 && this.cnt.values) { this.flips = this.cnt.values[0]; this.sonido.actividad = Math.min(1, this.flips / (this.G * this.G * 0.0015)); }
  }
  // integración en CPU de un solo estado (misma física)
  static rk4(s, h) {
    const der = (s) => {
      const d = s[0] - s[1], den = 3 - Math.cos(2 * d);
      return [s[2], s[3], (-G * 3 * Math.sin(s[0]) - G * Math.sin(s[0] - 2 * s[1]) - 2 * Math.sin(d) * (s[3] * s[3] + s[2] * s[2] * Math.cos(d))) / den,
        (2 * Math.sin(d) * (2 * s[2] * s[2] + 2 * G * Math.cos(s[0]) + s[3] * s[3] * Math.cos(d))) / den];
    };
    const add = (a, b, k) => a.map((x, i) => x + b[i] * k);
    const k1 = der(s), k2 = der(add(s, k1, h / 2)), k3 = der(add(s, k2, h / 2)), k4 = der(add(s, k3, h));
    return s.map((x, i) => x + (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) * h / 6);
  }
  pasoUno(h, subs) { for (let k = 0; k < subs; k++) this.uState = Pendulos.rk4(this.uState, h); }
  // el primero y el último del abanico, en CPU: la distancia entre ellos es el «caos» que se oye
  testigo(h, subs) {
    if (!this.testigos) { const e = this.eps / 2; this.testigos = [[this.th[0] - e, this.th[1] - e, 0, 0], [this.th[0] + e, this.th[1] + e, 0, 0]]; }
    const prev = this.testigos[0][1];
    for (let k = 0; k < subs; k++) this.testigos = this.testigos.map((s) => Pendulos.rk4(s, h));
    const [a, b] = this.testigos;
    this.sonido.angulo = a[1];
    const dist = Math.hypot(Math.sin(a[0]) - Math.sin(b[0]), Math.cos(a[0]) - Math.cos(b[0]), Math.sin(a[1]) - Math.sin(b[1]), Math.cos(a[1]) - Math.cos(b[1]));
    this.sonido.caos = Math.min(1, dist / 2.5);
    const vuelta = Math.floor((prev + Math.PI) / (2 * Math.PI)) !== Math.floor((a[1] + Math.PI) / (2 * Math.PI));
    if (vuelta && performance.now() - this.ultVuelta > 150) { this.ultVuelta = performance.now(); this.ctx.sonido.evento('vuelta', { k: (Math.random() * 8) | 0, pan: Math.sin(a[0]) * 0.6 }); }
  }
  lectura() {
    if (this.vista === 0) return `abanico · ε = ${this.eps.toExponential(0)} · ${this.simT[0].toFixed(1)} s`;
    if (this.vista === 1) return `θ₁ ${this.cur[0].toFixed(2)}  θ₂ ${this.cur[1].toFixed(2)} · ${this.simT[1].toFixed(1)} s simulados`;
    return `rotor pateado · K = ${this.K.toFixed(3)}`;
  }
  stats() {
    const fps = this.ctx.perf.fps;
    const n = this.vista === 0 ? this.NF : this.vista === 1 ? this.G * this.G : this.NR;
    return [
      [this.vista === 2 ? 'órbitas' : 'péndulos', fmt.int(n), true],
      ['vista', VISTAS[this.vista]],
      ['pasos / s', fmt.si(n * (this.vista === 2 ? 80 : this.vista === 0 ? 4 : 3) * fps)],
      this.vista === 1 ? ['voltearon este frame', fmt.int(this.flips)] : ['ε', this.eps.toExponential(1)],
    ];
  }
  destroy() {
    [this.fan, this.mapa, this.volteo, this.rotor, this.acc, this.u, this.ru, this.uno, this.uU].forEach((b) => b.destroy());
    this.cnt.destroy(); this.ctx.capa.innerHTML = '';
  }
}
