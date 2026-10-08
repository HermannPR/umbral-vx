// Sala 4: fluido 2D Navier-Stokes ("stable fluids") con confinamiento de vorticidad y tinte a resolución nativa.
import { makeShader, U } from '../gpu.js';
import { FS_VERT, fmt, Governor } from '../util.js';

const NE = 16;
const COMMON = /* wgsl */`
struct Uni { size: vec4u, prm: vec4f, prm2: vec4f, em: array<vec4f, ${NE}>, dir: array<vec4f, ${NE}>, col: array<vec4f, ${NE}> };
@group(0) @binding(0) var<uniform> u: Uni;
fn sid(p: vec2i) -> i32 { let q = clamp(p, vec2i(0), vec2i(u.size.xy) - 1); return q.y * i32(u.size.x) + q.x; }
fn inSim(g: vec3u) -> bool { return g.x < u.size.x && g.y < u.size.y; }
`;

const CURL = COMMON + /* wgsl */`
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> curl: array<f32>;
fn V(p: vec2i) -> vec2f { return textureLoad(vel, clamp(p, vec2i(0), vec2i(u.size.xy) - 1), 0).xy; }
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (!inSim(g)) { return; }
  let p = vec2i(g.xy);
  curl[sid(p)] = 0.5 * ((V(p + vec2i(1, 0)).y - V(p - vec2i(1, 0)).y) - (V(p + vec2i(0, 1)).x - V(p - vec2i(0, 1)).x));
}`;

const FORCE = COMMON + /* wgsl */`
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> curl: array<f32>;
@group(0) @binding(3) var outV: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (!inSim(g)) { return; }
  let p = vec2i(g.xy);
  var v = textureLoad(vel, p, 0).xy;
  let c = curl[sid(p)];
  let gx = abs(curl[sid(p + vec2i(1, 0))]) - abs(curl[sid(p - vec2i(1, 0))]);
  let gy = abs(curl[sid(p + vec2i(0, 1))]) - abs(curl[sid(p - vec2i(0, 1))]);
  let n = vec2f(gx, gy) / (length(vec2f(gx, gy)) + 1e-5);
  v += vec2f(n.y, -n.x) * c * u.prm.z * u.prm.x;
  let fp = vec2f(p) + 0.5;
  let ne = u32(u.prm2.y);
  for (var i = 0u; i < ne; i++) {
    let e = u.em[i]; let d = fp - e.xy;
    let w = exp(-dot(d, d) / (e.z * e.z));
    if (w < 1e-4) { continue; }
    let dr = u.dir[i];
    if (dr.z < 0.5) { v += dr.xy * e.w * w * u.prm.x; }
    else { v += vec2f(-d.y, d.x) / e.z * e.w * w * u.prm.x; }
  }
  textureStore(outV, p, vec4f(clamp(v, vec2f(-3000.0), vec2f(3000.0)), 0.0, 1.0));
}`;

const DIV = COMMON + /* wgsl */`
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> div: array<f32>;
@group(0) @binding(3) var<storage, read_write> pr: array<f32>;
fn V(p: vec2i) -> vec2f {
  let s = vec2i(u.size.xy);
  var v = textureLoad(vel, clamp(p, vec2i(0), s - 1), 0).xy;
  if (p.x < 0 || p.x >= s.x) { v.x = -v.x; }
  if (p.y < 0 || p.y >= s.y) { v.y = -v.y; }
  return v;
}
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (!inSim(g)) { return; }
  let p = vec2i(g.xy);
  div[sid(p)] = 0.5 * (V(p + vec2i(1, 0)).x - V(p - vec2i(1, 0)).x + V(p + vec2i(0, 1)).y - V(p - vec2i(0, 1)).y);
  pr[sid(p)] *= 0.8;
}`;

const JACOBI = COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> div: array<f32>;
@group(0) @binding(2) var<storage, read> pin: array<f32>;
@group(0) @binding(3) var<storage, read_write> pout: array<f32>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (!inSim(g)) { return; }
  let p = vec2i(g.xy);
  pout[sid(p)] = 0.25 * (pin[sid(p + vec2i(1, 0))] + pin[sid(p - vec2i(1, 0))] + pin[sid(p + vec2i(0, 1))] + pin[sid(p - vec2i(0, 1))] - div[sid(p)]);
}`;

const PROJECT = COMMON + /* wgsl */`
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> pr: array<f32>;
@group(0) @binding(3) var outV: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (!inSim(g)) { return; }
  let p = vec2i(g.xy);
  var v = textureLoad(vel, p, 0).xy - 0.5 * vec2f(pr[sid(p + vec2i(1, 0))] - pr[sid(p - vec2i(1, 0))], pr[sid(p + vec2i(0, 1))] - pr[sid(p - vec2i(0, 1))]);
  let s = vec2i(u.size.xy);
  if (p.x == 0 || p.x == s.x - 1) { v.x = 0.0; }
  if (p.y == 0 || p.y == s.y - 1) { v.y = 0.0; }
  textureStore(outV, p, vec4f(v, 0.0, 1.0));
}`;

const ADV_VEL = COMMON + /* wgsl */`
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var outV: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3u) {
  if (!inSim(g)) { return; }
  let s = vec2f(u.size.xy);
  let fp = vec2f(g.xy) + 0.5;
  let v = textureLoad(vel, vec2i(g.xy), 0).xy;
  let back = (fp - u.prm.x * v) / s;
  textureStore(outV, vec2i(g.xy), vec4f(textureSampleLevel(vel, smp, back, 0.0).xy * u.prm.w, 0.0, 1.0));
}`;

const ADV_DYE = COMMON + /* wgsl */`
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var dye: texture_2d<f32>;
@group(0) @binding(4) var outD: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) g: vec3u) {
  let D = u.size.zw;
  if (g.x >= D.x || g.y >= D.y) { return; }
  let uv = (vec2f(g.xy) + 0.5) / vec2f(D);
  let v = textureSampleLevel(vel, smp, uv, 0.0).xy;
  let back = uv - u.prm.x * v / vec2f(u.size.xy);
  var c = textureSampleLevel(dye, smp, back, 0.0).rgb * u.prm2.x;
  let fp = uv * vec2f(u.size.xy);
  let ne = u32(u.prm2.y);
  for (var i = 0u; i < ne; i++) {
    let e = u.em[i]; let d = fp - e.xy;
    let w = exp(-dot(d, d) / (e.z * e.z * 0.6));
    c += u.col[i].rgb * w * u.col[i].w * u.prm.x;
  }
  textureStore(outD, vec2i(g.xy), vec4f(min(c, vec3f(8.0)), 1.0));
}`;

const DRAW = FS_VERT + /* wgsl */`
@group(0) @binding(0) var dye: texture_2d<f32>;
@group(0) @binding(1) var vel: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let p = vec2i(i.pos.xy);
  let c = textureLoad(dye, p, 0).rgb;
  let l = dot(textureLoad(dye, p + vec2i(2, 0), 0).rgb - textureLoad(dye, p - vec2i(2, 0), 0).rgb, vec3f(0.33));
  let m = dot(textureLoad(dye, p + vec2i(0, 2), 0).rgb - textureLoad(dye, p - vec2i(0, 2), 0).rgb, vec3f(0.33));
  let n = normalize(vec3f(-l * 2.0, -m * 2.0, 1.0));
  let sh = 0.75 + 0.35 * dot(n, normalize(vec3f(-0.4, -0.5, 0.7)));
  let sp = length(textureSampleLevel(vel, smp, i.uv, 0.0).xy);
  var col = c * sh + c * smoothstep(80.0, 600.0, sp) * 0.4;
  return vec4f(col + vec3f(0.004, 0.005, 0.01), 1.0);
}`;

const PALS = [
  (h) => hsv(0.55 + 0.07 * Math.sin(h * 6.283), 0.55 + 0.25 * Math.sin(h * 12.6) ** 2, 1),   // océano: azules y un blanco frío
  (h) => hsv(0.02 + 0.09 * Math.sin(h * 6.283) ** 2, 0.85, 1),     // fuego
  (h) => hsv(0.78 + 0.15 * Math.sin(h * 6.283), 0.6, 1),           // nebulosa
  (h) => hsv(h, 0.85, 1),                                          // espectro
];
function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1; const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

export default class Fluid {
  static palettes = ['Océano', 'Fuego', 'Nebulosa', 'Espectro'];
  static controls = { ls: 'mover cursor', rs: 'chorro en esa dirección', trig: '− / + fuerza de los chorros', a: 'lanzar un vórtice' };
  static info = {
    title: 'Fluido',
    short: 'Navier-Stokes 2D + vorticidad',
    desc: 'Navier-Stokes incompresible: advección, confinamiento de vorticidad y decenas de iteraciones de Jacobi para la presión en cada frame; el tinte va a resolución nativa.',
  };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.0, bloom: 0.5, vignette: 0.6 }; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    const SW = Math.ceil(W / 2), SH = Math.ceil(H / 2);
    Object.assign(this, { W, H, SW, SH });
    const tex = (w, h) => d.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.vel = [tex(SW, SH), tex(SW, SH)]; this.dye = [tex(W, H), tex(W, H)];
    this.velV = this.vel.map((t) => t.createView()); this.dyeV = this.dye.map((t) => t.createView());
    const n = SW * SH * 4;
    this.pr = [U.storage(d, n), U.storage(d, n)]; this.div = U.storage(d, n); this.curl = U.storage(d, n);
    this.ub = U.uniform(d, 48 + NE * 48);
    this.smp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const cp = async (code, label) => d.createComputePipelineAsync({ layout: 'auto', compute: { module: makeShader(d, code, label, report), entryPoint: 'main' } });
    [this.pCurl, this.pForce, this.pDiv, this.pJac, this.pProj, this.pAdvV, this.pAdvD] = await Promise.all([
      cp(CURL, 'curl'), cp(FORCE, 'force'), cp(DIV, 'div'), cp(JACOBI, 'jacobi'), cp(PROJECT, 'project'), cp(ADV_VEL, 'advV'), cp(ADV_DYE, 'advD')]);
    const dm = makeShader(d, DRAW, 'fluid-draw', report);
    this.pDraw = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: dm, entryPoint: 'vs' }, fragment: { module: dm, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
    const B = (p, ents) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: ents.map((r, i) => ({ binding: i, resource: r })) });
    const ub = { buffer: this.ub }, buf = (b) => ({ buffer: b });
    // ciclo por frame: A -fuerza-> B -proyección-> A -advección-> B; el siguiente frame invierte A/B
    this.bg = [0, 1].map((A) => {
      const Bi = 1 - A;
      return {
        curl: B(this.pCurl, [ub, this.velV[A], buf(this.curl)]),
        force: B(this.pForce, [ub, this.velV[A], buf(this.curl), this.velV[Bi]]),
        div: B(this.pDiv, [ub, this.velV[Bi], buf(this.div), buf(this.pr[0])]),
        proj: B(this.pProj, [ub, this.velV[Bi], buf(this.pr[0]), this.velV[A]]),
        advV: B(this.pAdvV, [ub, this.velV[A], this.smp, this.velV[Bi]]),
        advD: B(this.pAdvD, [ub, this.velV[Bi], this.smp, this.dyeV[A], this.dyeV[Bi]]),
        draw: B(this.pDraw, [this.dyeV[Bi], this.velV[Bi], this.smp]),
      };
    });
    this.jac = [B(this.pJac, [ub, buf(this.div), buf(this.pr[0]), buf(this.pr[1])]), B(this.pJac, [ub, buf(this.div), buf(this.pr[1]), buf(this.pr[0])])];
    this.gov = new Governor({ min: 10, max: Math.round(160 * Math.max(0.4, (this.ctx.calidad ? this.ctx.calidad.carga : 1))), value: 40, stepUp: (v) => v + 6, stepDown: (v) => v - 6, lowMs: 11, highMs: 14.5, every: 0.5 });
    this.par = 0; this.cursor = [SW * 0.5, SH * 0.5]; this.force = 1; this.vortices = []; this.lastPtr = null;
  }
  emitters(t, dt) {
    const { SW, SH } = this, em = [], s = Math.min(SW, SH), k = this.chaos ? 1.8 : 1;
    const pal = PALS[this.palette || 0];
    const n = this.chaos ? 8 : 5;
    for (let i = 0; i < n; i++) {
      const ph = i * 2.399, sp = (0.13 + 0.04 * i) * k;
      const x = SW * (0.5 + 0.38 * Math.sin(t * sp + ph)), y = SH * (0.5 + 0.36 * Math.sin(t * sp * 1.37 + ph * 1.7));
      const dx = 0.38 * SW * sp * Math.cos(t * sp + ph), dy = 0.36 * SH * sp * 1.37 * Math.cos(t * sp * 1.37 + ph * 1.7);
      const l = Math.hypot(dx, dy) || 1;
      const pulse = 0.6 + 0.4 * Math.sin(t * 0.7 + i);
      const ang = Math.atan2(dy, dx) + 1.2 * Math.sin(t * 0.9 + i * 1.3);
      em.push({ p: [x, y], r: s * 0.018, str: 3800 * this.force * k * pulse, dir: [Math.cos(ang), Math.sin(ang)], type: 0, col: [...pal(t * 0.03 + i / n), 2.2 * pulse] });
    }
    // vórtices lanzados con A
    this.vortices = this.vortices.filter((v) => (v.life -= dt) > 0);
    for (const v of this.vortices) em.push({ p: v.p, r: s * 0.06, str: v.str * Math.min(1, v.life), dir: [0, 0], type: 1, col: [...v.col, 3.0 * Math.min(1, v.life)] });
    return em;
  }
  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, ptr = this.ctx.pointer, { SW, SH, W, H } = this;
    const ms = this.ctx.perf.gpuMs ?? this.ctx.perf.frameMs;
    this.gov.update(dt, ms);
    const iters = this.gov.value;
    this.iters = iters;
    this.force = Math.max(0.2, Math.min(4, this.force * Math.exp((inp.r2 - inp.l2) * dt * 1.2)));
    this.cursor[0] = Math.max(0, Math.min(SW, this.cursor[0] + inp.lx * dt * SH * 0.7));
    this.cursor[1] = Math.max(0, Math.min(SH, this.cursor[1] + inp.ly * dt * SH * 0.7));
    const pal = PALS[this.palette || 0];
    if (inp.pressed.a) this.vortices.push({ p: [...this.cursor], str: (Math.random() < 0.5 ? -1 : 1) * 2600 * this.force, life: 1.6, col: pal(Math.random()) });
    if (this.chaos && Math.random() < dt * 1.2) this.vortices.push({ p: [Math.random() * SW, Math.random() * SH], str: (Math.random() < 0.5 ? -1 : 1) * 3000, life: 1.2, col: pal(Math.random()) });
    const em = this.emitters(t, dt);
    const rsm = Math.hypot(inp.rx, inp.ry);
    if (rsm > 0.1 || Math.hypot(inp.lx, inp.ly) > 0.1) {
      em.push({ p: [...this.cursor], r: Math.min(SW, SH) * 0.025, str: 1600 * rsm * this.force, dir: rsm > 0.1 ? [inp.rx / rsm, inp.ry / rsm] : [0, 0], type: 0, col: [...pal(t * 0.1), 1.5 + rsm * 2] });
    }
    if (ptr.down) {
      const p = [ptr.x / 2, ptr.y / 2];
      if (this.lastPtr) {
        const dx = p[0] - this.lastPtr[0], dy = p[1] - this.lastPtr[1], l = Math.hypot(dx, dy);
        if (l > 0.5) em.push({ p, r: Math.min(SW, SH) * 0.03, str: Math.min(4000, l / dt * 2), dir: [dx / l, dy / l], type: 0, col: [...pal(t * 0.1 + 0.5), 3] });
      }
      this.lastPtr = p;
    } else this.lastPtr = null;
    const list = em.slice(0, NE);
    const a = new ArrayBuffer(48 + NE * 48), u32 = new Uint32Array(a), f = new Float32Array(a);
    u32.set([SW, SH, W, H]);
    const h = 1 / 60;
    f.set([h, t, this.chaos ? 22 : 12, 0.999, 0.993, list.length, this.palette || 0, this.chaos ? 1 : 0], 4);
    list.forEach((e, i) => { f.set([...e.p, e.r, e.str], 12 + i * 4); f.set([...e.dir, e.type, 0], 12 + NE * 4 + i * 4); f.set(e.col, 12 + NE * 8 + i * 4); });
    d.queue.writeBuffer(this.ub, 0, a);
    const bg = this.bg[this.par];
    const gs = [Math.ceil(SW / 16), Math.ceil(SH / 16)];
    const p = this.ctx.cpass(enc);
    const run = (pipe, b, g = gs) => { p.setPipeline(pipe); p.setBindGroup(0, b); p.dispatchWorkgroups(...g); };
    run(this.pCurl, bg.curl); run(this.pForce, bg.force); run(this.pDiv, bg.div);
    p.setPipeline(this.pJac);
    for (let i = 0; i < iters * 2; i++) { p.setBindGroup(0, this.jac[i & 1]); p.dispatchWorkgroups(...gs); }
    run(this.pProj, bg.proj); run(this.pAdvV, bg.advV);
    run(this.pAdvD, bg.advD, [Math.ceil(W / 16), Math.ceil(H / 16)]);
    p.end();
    const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rp.setPipeline(this.pDraw); rp.setBindGroup(0, bg.draw); rp.draw(3); rp.end();
    this.par ^= 1;
  }
  onKey(k) { if (k === 'r') this.ctx.input.pressed.a = true; }
  stats() {
    const fps = this.ctx.perf.fps, cells = this.SW * this.SH;
    return [
      ['celdas de velocidad', fmt.int(cells), true],
      ['píxeles de tinte', fmt.int(this.W * this.H)],
      ['iteraciones Jacobi / frame', String(this.iters * 2)],
      ['actualizaciones / s', fmt.si(cells * (this.iters * 2 + 6) * fps + this.W * this.H * fps)],
      ['fuerza chorros', '×' + this.force.toFixed(2)],
      ['vórtices activos', String(this.vortices.length)],
    ];
  }
  destroy() { [...this.vel, ...this.dye, ...this.pr, this.div, this.curl, this.ub].forEach((x) => x.destroy()); }
}
