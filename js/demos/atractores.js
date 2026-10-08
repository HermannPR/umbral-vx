// Sala «Atractores»: millones de puntos siguiendo flujos caóticos en 3D.
// Idea de Math Visual Lab (Lorenz). Al cambiar de sistema las partículas no se reinician:
// se reescalan al nuevo marco y el nuevo flujo las lleva hasta su atractor (la transformación es la dinámica).
import { makeShader, U, fadePipeline, BLEND_DECAY } from '../gpu.js';
import { HASH, FS_VERT, m4, v3, fmt, Governor } from '../util.js';

// id, nombre, centro, escala (a coordenadas de vista ~[-1.2, 1.2]), dt, rapidez típica, ecuaciones para rotular
const SISTEMAS = [
  { nombre: 'Lorenz', c: [0, 0, 24], s: 1 / 25, dt: 0.0026, vs: 5.5, n: 12288, g: 3.2, cada: 1, subs: 14, decay: 0.988, rot: [-1.5708, 0, 0],
    eq: ['ẋ = σ (y − x)', 'ẏ = x (ρ − z) − y', 'ż = x y − β z'], par: 'σ = 10   ρ = 28   β = 8⁄3' },
  { nombre: 'Aizawa', c: [0, 0, 0.55], s: 1 / 1.25, dt: 0.0075, vs: 1.5, rot: [-1.2, 0, 0],
    eq: ['ẋ = (z − b) x − d y', 'ẏ = d x + (z − b) y', 'ż = c + a z − z³⁄3 − (x² + y²)(1 + e z) + f z x³'], par: 'a = 0.95   b = 0.7   c = 0.6   d = 3.5' },
  { nombre: 'Thomas', c: [0, 0, 0], s: 1 / 3.4, dt: 0.045, vs: 0.55, rot: [0, 0, 0],
    eq: ['ẋ = sin y − b x', 'ẏ = sin z − b y', 'ż = sin x − b z'], par: 'b = 0.208186' },
  { nombre: 'Halvorsen', c: [-1.6, -1.6, -1.6], s: 1 / 9, dt: 0.0036, vs: 3.2, rot: [0, 0, 0],
    eq: ['ẋ = −a x − 4y − 4z − y²', 'ẏ = −a y − 4z − 4x − z²', 'ż = −a z − 4x − 4y − x²'], par: 'a = 1.89' },
  { nombre: 'Rössler', c: [0.6, -1.2, 6.5], s: 1 / 13, dt: 0.011, vs: 1.6, rot: [-1.5708, 0, 0],
    eq: ['ẋ = −y − z', 'ẏ = x + a y', 'ż = b + z (x − c)'], par: 'a = 0.2   b = 0.2   c = 5.7' },
];

const F_WGSL = /* wgsl */`
fn flujo(p: vec3f, id: i32) -> vec3f {
  switch id {
    case 0: { return vec3f(10.0 * (p.y - p.x), p.x * (28.0 - p.z) - p.y, p.x * p.y - 2.6666667 * p.z); }
    case 1: {
      return vec3f((p.z - 0.7) * p.x - 3.5 * p.y, 3.5 * p.x + (p.z - 0.7) * p.y,
        0.6 + 0.95 * p.z - p.z * p.z * p.z / 3.0 - (p.x * p.x + p.y * p.y) * (1.0 + 0.25 * p.z) + 0.1 * p.z * p.x * p.x * p.x);
    }
    case 2: { let b = 0.208186; return vec3f(sin(p.y) - b * p.x, sin(p.z) - b * p.y, sin(p.x) - b * p.z); }
    case 3: { let a = 1.89; return vec3f(-a * p.x - 4.0 * p.y - 4.0 * p.z - p.y * p.y, -a * p.y - 4.0 * p.z - 4.0 * p.x - p.z * p.z, -a * p.z - 4.0 * p.x - 4.0 * p.y - p.x * p.x); }
    default: { return vec3f(-p.y - p.z, p.x + 0.2 * p.y, 0.2 + p.z * (p.x - 5.7)); }
  }
}`;

const SIM = HASH + F_WGSL + /* wgsl */`
struct Uni {
  vp: mat4x4f,
  cam: vec4f,     // ojo xyz, ganancia
  res: vec4f,     // W, H, paleta, mezcla de rotación
  sys: vec4f,     // id, dt, subpasos, N
  cs: vec4f,      // centro xyz, escala
  rm: vec4f,      // centro anterior xyz, escala anterior (w > 0: reescalar este frame)
  sd: vec4u,      // semilla, desde, hasta (rango a sembrar), 0
  vs: vec4f,      // rapidez típica, radio de siembra, 0, 0
  rot: vec4f,     // rotación del sistema (euler x, y, z) para presentarlo de pie
};
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> acc: array<atomic<u32>>;

fn gauss(s: ptr<function, u32>) -> f32 {
  let a = max(rnd(s), 1e-7); let b = rnd(s);
  return sqrt(-2.0 * log(a)) * cos(6.2831853 * b);
}
fn rotar(p: vec3f) -> vec3f {
  let cx = cos(u.rot.x); let sx = sin(u.rot.x);
  let q = vec3f(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
  let cy = cos(u.rot.y); let sy = sin(u.rot.y);
  return vec3f(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);
}
fn color(t: f32, pal: f32) -> vec3f {
  if (pal < 0.5) { return mix(vec3f(0.42, 0.17, 0.07), vec3f(1.0, 0.92, 0.8), t); }        // tinta: cobre → hueso
  if (pal < 1.5) { return mix(vec3f(0.03, 0.12, 0.38), vec3f(0.82, 0.92, 1.0), t); }        // cianotipia
  if (pal < 2.5) { return vec3f(0.85, 0.84, 0.82) * (0.25 + 0.75 * t); }                    // grafito
  return mix(vec3f(0.5, 0.05, 0.03), vec3f(1.0, 0.72, 0.3), t);                             // brasa
}

@compute @workgroup_size(256)
fn sim(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x + g.y * 32768u * 256u;
  let N = u32(u.sys.w);
  if (i >= N) { return; }
  let id = i32(u.sys.x);
  var P = pos[i];
  var p = P.xyz;
  var s = pcg(i * 9781u + u.sd.x);
  if (u.rm.w > 0.0) { p = (p - u.rm.xyz) * (u.rm.w / u.cs.w) + u.cs.xyz; }
  let sembrar = i >= u.sd.y && i < u.sd.z;
  if (sembrar || any(p != p) || length((p - u.cs.xyz) * u.cs.w) > 4.0) {
    p = u.cs.xyz + vec3f(gauss(&s), gauss(&s), gauss(&s)) * (u.vs.y / u.cs.w);
    if (sembrar) { P.w = rnd(&s); }
  }
  let dt = u.sys.y;
  let S = u32(u.sys.z);
  if (id == 0 && abs(p.x) + abs(p.y) < 1e-3) { p = u.cs.xyz + vec3f(gauss(&s), gauss(&s), gauss(&s)) * 8.0; }
  let cada = u.vs.z > 0.5;
  for (var k = 0u; k < S; k++) {
    let k1 = flujo(p, id);
    let k2 = flujo(p + k1 * (0.5 * dt), id);
    p += k2 * dt;
    if (cada) { splat(p, P.w, id); }
  }
  pos[i] = vec4f(p, P.w);
  if (!cada) { splat(p, P.w, id); }
}

// proyección y acumulación atómica en punto fijo
fn splat(p: vec3f, w: f32, id: i32) {
  let v = rotar((p - u.cs.xyz) * u.cs.w);
  let c = u.vp * vec4f(v, 1.0);
  if (c.w <= 0.05) { return; }
  let ndc = c.xy / c.w;
  if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0) { return; }
  let W = u32(u.res.x); let H = u32(u.res.y);
  let px = min(u32((ndc.x * 0.5 + 0.5) * u.res.x), W - 1u);
  let py = min(u32((0.5 - ndc.y * 0.5) * u.res.y), H - 1u);
  let sp = length(flujo(p, id)) * u.cs.w / u.vs.x;
  let t = smoothstep(0.05, 1.1, sp);
  let d = length(v - u.cam.xyz);
  let col = color(t, u.res.z) * u.cam.w * (0.55 + 0.9 * w) * clamp(9.0 / (d * d), 0.4, 2.5) * 65536.0;
  let k = (py * W + px) * 3u;
  atomicAdd(&acc[k], u32(col.x)); atomicAdd(&acc[k + 1u], u32(col.y)); atomicAdd(&acc[k + 2u], u32(col.z));
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

export default class Atractores {
  static palettes = ['Tinta', 'Cianotipia', 'Grafito', 'Brasa'];
  static controls = { ls: 'orbitar', rs: 'acercar · inclinar', trig: '− / + velocidad del tiempo', a: 'soltarlos desde un punto', y: 'estelas largas' };
  static info = { title: 'Atractores', desc: '' };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.0, bloom: 0.12, vignette: 0.55, lift: [0.024, 0.02, 0.016], grain: 0.03 }; this.sonido = {}; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    const L = d.limits;
    this.MAX = Math.min(12 << 20, Math.floor(Math.min(L.maxStorageBufferBindingSize, L.maxBufferSize) / 16));
    let saved = 0; try { saved = +localStorage.getItem('lab.atractoresN') || 0; } catch {}
    this.N = Math.min(this.MAX, saved || (3 << 20));
    this.pos = U.storage(d, this.MAX * 16);
    this.acc = U.storage(d, W * H * 12);
    this.u = U.uniform(d, 256);
    this.ru = U.uniform(d, 16);
    d.queue.writeBuffer(this.ru, 0, new Float32Array([W, H, 0, 0]));
    const sm = makeShader(d, SIM, 'atractores-sim', report);
    this.pSim = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: sm, entryPoint: 'sim' } });
    this.bgSim = d.createBindGroup({ layout: this.pSim.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.u } }, { binding: 1, resource: { buffer: this.pos } }, { binding: 2, resource: { buffer: this.acc } }] });
    const rm = makeShader(d, RESOLVE, 'atractores-resolve', report);
    this.pRes = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: rm, entryPoint: 'vs' },
      fragment: { module: rm, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: BLEND_DECAY }] } });
    this.bgRes = d.createBindGroup({ layout: this.pRes.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.ru } }, { binding: 1, resource: { buffer: this.acc } }] });
    this.gov = new Governor({ min: 1 << 20, max: this.MAX, value: this.N, stepUp: (v) => v + (1 << 20), stepDown: (v) => v - (1 << 20), lowMs: 11, highMs: 14.5, every: 0.7 });
    this.sys = 0; this.sysT = 0; this.remap = null; this.seed = 1; this.sembrar = [0, this.N]; this.radio = 1.0;
    this.az = 0.6; this.el = 0.25; this.zoom = 1; this.vel = 1; this.primero = true; this.age = 0;
    this.rot = [...SISTEMAS[0].rot]; this.probe = null; this.ultNota = 0;
    this.rotulo();
  }
  rotulo() {
    const S = SISTEMAS[this.sys];
    this.ctx.capa.innerHTML = `<div class="eq" style="position:absolute;left:44px;top:38px;transition:opacity .8s;opacity:0">
      <div class="rotulo-t" style="margin-bottom:12px">${S.nombre}</div>
      ${S.eq.map((l) => `<div style="font:italic 400 17px/1.55 var(--serif);color:var(--papel-2)">${l}</div>`).join('')}
      <div class="rotulo" style="margin-top:10px;color:var(--papel-3)">${S.par}</div></div>`;
    requestAnimationFrame(() => { const e = this.ctx.capa.querySelector('.eq'); if (e) e.style.opacity = 1; });
  }
  nombreModo() { return SISTEMAS[this.sys].nombre; }
  cambiarModo(dir) { this.siguiente(dir); return this.nombreModo(); }
  siguiente(dir = 1) {
    const old = SISTEMAS[this.sys];
    this.sys = (this.sys + dir + SISTEMAS.length) % SISTEMAS.length;
    this.remap = [...old.c, old.s];
    this.sysT = 0; this.probe = null;
    this.ctx.sonido.evento('a');
    this.rotulo();
  }
  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, W = this.ctx.W, H = this.ctx.H;
    this.age += dt; this.sysT += dt;
    if (inp.pressed.a) { this.sembrar = [0, this.N]; this.radio = 0.02; }
    if (this.ctx.recorrido && this.sysT > 14) this.siguiente();
    const trig = inp.r2 - inp.l2;
    this.vel = Math.max(0.2, Math.min(3, this.vel * Math.exp(trig * dt * 1.2)));
    this.az += (0.07 + inp.lx * 1.2) * dt;
    this.el = Math.max(-1.2, Math.min(1.2, this.el - inp.ly * dt));
    this.zoom = Math.max(0.45, Math.min(2.2, this.zoom * Math.exp(inp.ry * dt * 1.2)));
    // carga adaptativa
    const ms = this.ctx.perf.gpuMs ?? this.ctx.perf.frameMs;
    if (this.age > 1.5 && this.gov.update(dt, ms)) {
      const nv = this.gov.value;
      if (nv > this.N) { if (this.age < 12) { this.sembrar = [this.N, nv]; this.radio = 1; this.N = nv; } else this.gov.value = this.N; }
      else this.N = nv;
      try { localStorage.setItem('lab.atractoresN', this.N); } catch {}
    }
    const S = SISTEMAS[this.sys];
    // rotación de presentación con suavizado (al cambiar de sistema gira hacia su orientación)
    for (let k = 0; k < 3; k++) this.rot[k] += (S.rot[k] - this.rot[k]) * Math.min(1, dt * 1.5);
    const dist = 3.3 * this.zoom;
    const eye = [Math.cos(this.az) * Math.cos(this.el) * dist, Math.sin(this.el) * dist, Math.sin(this.az) * Math.cos(this.el) * dist];
    const vp = m4.mul(m4.perspective(0.75, W / H, 0.05, 50), m4.lookAt(eye, [0, 0, 0], [0, 1, 0]));
    // Lorenz se ve mejor con pocas trayectorias y estelas largas; los demás, con densidad
    const decay = this.chaos ? 0.94 : (S.decay || 0.8);
    this.Nvis = S.n ? Math.min(this.N, S.n) : this.N;
    const subs = S.subs || 4, cada = S.cada || 0;
    const gain = 0.0016 * (W * H) / this.Nvis * ((1 - decay) / 0.2) / (cada ? subs : 1) * (S.g || 1) * (this.sysT < 1.5 ? 0.4 + 0.4 * this.sysT : 1);
    const f = new Float32Array(64), u32 = new Uint32Array(f.buffer);
    f.set(vp, 0); f.set([...eye, gain], 16); f.set([W, H, this.palette || 0, 0], 20);
    f.set([this.sys, S.dt * this.vel * Math.min(1.5, dt * 60) * 4 / subs, subs, this.Nvis], 24);
    f.set([...S.c, S.s], 28);
    f.set(this.remap ? this.remap : [0, 0, 0, 0], 32);
    u32.set([this.seed++ * 7919, this.sembrar ? this.sembrar[0] : 0, this.sembrar ? this.sembrar[1] : 0, 0], 36);
    f.set([S.vs, this.radio, cada, 0], 40);
    f.set([...this.rot, 0], 44);
    d.queue.writeBuffer(this.u, 0, f);
    this.remap = null; this.sembrar = null; this.radio = 1;
    const cp = this.ctx.cpass(enc); cp.setPipeline(this.pSim); cp.setBindGroup(0, this.bgSim);
    cp.dispatchWorkgroups(...U.grid1D(this.Nvis)); cp.end();
    const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: this.primero ? 'clear' : 'load', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rp.setPipeline(this.pRes); rp.setBindGroup(0, this.bgRes); rp.setBlendConstant([decay, decay, decay, decay]); rp.draw(3); rp.end();
    this.primero = false;
    this.testigo(S, dt);
  }
  // trayectoria testigo en CPU: cada cruce del plano x = centro dispara una nota (sección de Poincaré)
  testigo(S, dt) {
    if (!this.probe) this.probe = [S.c[0] + 0.3 / S.s, S.c[1] + 0.2 / S.s, S.c[2] + 0.1 / S.s];
    const id = this.sys, h = S.dt * this.vel * Math.min(1.5, dt * 60);
    const fl = (p) => {
      const [x, y, z] = p;
      switch (id) {
        case 0: return [10 * (y - x), x * (28 - z) - y, x * y - 8 / 3 * z];
        case 1: return [(z - 0.7) * x - 3.5 * y, 3.5 * x + (z - 0.7) * y, 0.6 + 0.95 * z - z * z * z / 3 - (x * x + y * y) * (1 + 0.25 * z) + 0.1 * z * x * x * x];
        case 2: return [Math.sin(y) - 0.208186 * x, Math.sin(z) - 0.208186 * y, Math.sin(x) - 0.208186 * z];
        case 3: return [-1.89 * x - 4 * y - 4 * z - y * y, -1.89 * y - 4 * z - 4 * x - z * z, -1.89 * z - 4 * x - 4 * y - x * x];
        default: return [-y - z, x + 0.2 * y, 0.2 + z * (x - 5.7)];
      }
    };
    let p = this.probe;
    for (let k = 0; k < 4; k++) {
      const k1 = fl(p), m = v3.add(p, v3.mul(k1, h / 2)), k2 = fl(m);
      const q = v3.add(p, v3.mul(k2, h));
      if (Math.sign(q[0] - S.c[0]) !== Math.sign(p[0] - S.c[0]) && performance.now() - this.ultNota > 110) {
        this.ultNota = performance.now();
        const zf = (q[2] - S.c[2]) * S.s * 0.5 + 0.5, yf = (q[1] - S.c[1]) * S.s;
        this.ctx.sonido.evento('cruce', { z: zf + 0.25 * yf, lado: Math.sign(q[0] - S.c[0]) || 1 });
      }
      p = q;
    }
    if (!isFinite(p[0]) || v3.len(v3.sub(p, S.c)) * S.s > 4) this.probe = null; else this.probe = p;
  }
  lectura() { return `${SISTEMAS[this.sys].nombre} · ${fmt.int(this.N)} puntos`; }
  stats() {
    const fps = this.ctx.perf.fps;
    return [
      ['puntos', fmt.int(this.N), true],
      ['sistema', SISTEMAS[this.sys].nombre],
      ['pasos RK2 / s', fmt.si((this.Nvis || this.N) * 4 * fps)],
      ['velocidad del tiempo', '×' + this.vel.toFixed(2)],
    ];
  }
  destroy() { this.pos.destroy(); this.acc.destroy(); this.u.destroy(); this.ru.destroy(); this.ctx.capa.innerHTML = ''; }
}
