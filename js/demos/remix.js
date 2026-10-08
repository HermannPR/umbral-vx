// Sala 7: remix — fractal (media resolución) + fluido + millones de partículas arrastradas por el fluido, todo compuesto en vivo.
import { makeShader, U } from '../gpu.js';
import { FS_VERT, HASH, fmt, Governor } from '../util.js';
import Fractal from './fractal.js';
import Fluid from './fluid.js';

const PART = HASH + /* wgsl */`
struct Uni { size: vec4f, prm: vec4f, burst: vec4f };
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var<storage, read_write> pt: array<vec4f>;
@group(0) @binding(2) var vel: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
fn curl(p: vec2f, t: f32) -> vec2f {
  let e = 0.002;
  let n = sin(p.x * 9.0 + t) * cos(p.y * 7.0 - t * 0.7) + sin((p.x + p.y) * 13.0 + t * 1.3) * 0.5;
  let nx = sin((p.x + e) * 9.0 + t) * cos(p.y * 7.0 - t * 0.7) + sin((p.x + e + p.y) * 13.0 + t * 1.3) * 0.5;
  let ny = sin(p.x * 9.0 + t) * cos((p.y + e) * 7.0 - t * 0.7) + sin((p.x + p.y + e) * 13.0 + t * 1.3) * 0.5;
  return vec2f(ny - n, -(nx - n)) / e;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x + g.y * 32768u * 256u;
  if (i >= u32(u.prm.w)) { return; }
  var q = pt[i];
  var h = pcg(i * 9781u + u32(u.prm.y * 60.0) * 13u);
  if (q.z <= 0.0 || q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) {
    q = vec4f(rnd(&h), rnd(&h), 2.0 + rnd(&h) * 6.0, rnd(&h));
  }
  let v = textureSampleLevel(vel, smp, q.xy, 0.0).xy / u.size.zw;
  var dp = v * u.prm.x + curl(q.xy, u.prm.y * 0.3) * 0.00004 * u.prm.z;
  if (u.burst.w > 0.0) {
    let d = q.xy - u.burst.xy; let r = length(d * vec2f(u.size.x / u.size.y, 1.0));
    if (r < 0.25) { dp += normalize(d + 1e-5) * (0.25 - r) * 0.08; }
  }
  q = vec4f(q.xy + dp, q.z - u.prm.x, q.w);
  pt[i] = q;
}
`;

const PDRAW = /* wgsl */`
struct Uni { size: vec4f, prm: vec4f, burst: vec4f };
@group(0) @binding(0) var<uniform> u: Uni;
@group(0) @binding(1) var<storage, read> pt: array<vec4f>;
@group(0) @binding(2) var dye: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(4) var vel: texture_2d<f32>;
struct VO { @builtin(position) p: vec4f, @location(0) c: vec3f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let q = pt[i];
  var o: VO;
  o.p = vec4f(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, 0.0, 1.0);
  let d = textureSampleLevel(dye, smp, q.xy, 0.0).rgb;
  let sp = length(textureSampleLevel(vel, smp, q.xy, 0.0).xy);
  let fade = smoothstep(0.0, 0.6, q.z) * smoothstep(8.0, 7.0, q.z);
  o.c = (d * 1.8 + vec3f(0.25, 0.35, 0.6) * (0.1 + 0.25 * q.w)) * (0.4 + smoothstep(30.0, 400.0, sp) * 2.0) * fade * u.burst.z;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f { return vec4f(i.c, 1.0); }
`;

const COMP = FS_VERT + /* wgsl */`
@group(0) @binding(0) var frac: texture_2d<f32>;
@group(0) @binding(1) var dye: texture_2d<f32>;
@group(0) @binding(2) var vel: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(4) var<uniform> k: vec4f;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let v = textureSampleLevel(vel, smp, i.uv, 0.0).xy;
  let off = v * k.x;
  let f = textureSampleLevel(frac, smp, i.uv - off, 0.0).rgb;
  let d = textureSampleLevel(dye, smp, i.uv, 0.0).rgb;
  let col = f * k.y + d * k.z + f * d * 0.6;
  return vec4f(col, 1.0);
}
`;

export default class Remix {
  static palettes = ['Océano', 'Fuego', 'Nebulosa', 'Espectro'];
  static controls = { ls: 'guiar el fluido', rs: 'girar la cámara del fractal', trig: '− / + millones de partículas', a: 'vórtice + explosión de partículas' };
  static info = {
    title: 'Remix',
    short: 'Fractal + fluido + partículas',
    desc: 'Tres simulaciones a la vez: un fractal 3D por raymarching, un fluido Navier-Stokes que lo deforma y millones de partículas arrastradas por la corriente.',
  };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.0, bloom: 0.55, vignette: 0.6 }; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    this.W = W; this.H = H;
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
    this.fracTex = d.createTexture({ size: [hw, hh], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.fluidTex = d.createTexture({ size: [hw, hh], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.inF = { lx: 0, ly: 0, rx: 0, ry: 0, l2: 0, r2: 0, pressed: {}, held: {} };
    this.inL = { lx: 0, ly: 0, rx: 0, ry: 0, l2: 0, r2: 0, pressed: {}, held: {} };
    this.ptr = { down: false, x: 0, y: 0 };
    const sub = (view, input) => ({ ...this.ctx, W: hw, H: hh, post: { hdrView: view }, input, pointer: this.ptr });
    this.frac = new Fractal(sub(this.fracTex.createView(), this.inF));
    this.fluid = new Fluid(sub(this.fluidTex.createView(), this.inL));
    this.frac.palette = this.fluid.palette = 0; this.frac.distScale = 1.9;
    await this.frac.init(); await this.fluid.init();
    this.frac.maxSteps = 120;
    this.fluid.gov.max = 60;
    this.smp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const L = d.limits;
    this.MAX = Math.min(Math.max(1 << 20, Math.round((12 << 20) * (this.ctx.calidad ? this.ctx.calidad.carga : 1) / (1 << 20)) << 20), Math.floor(Math.min(L.maxStorageBufferBindingSize, L.maxBufferSize) / 16));
    let saved = 0; try { saved = +localStorage.getItem('lab.remixN') || 0; } catch {}
    this.N = Math.min(this.MAX, saved || (2 << 20));
    this.pt = U.storage(d, this.MAX * 16);
    this.ub = U.uniform(d, 48); this.kb = U.uniform(d, 16);
    const pm = makeShader(d, PART, 'remix-part', report);
    this.pPart = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: pm, entryPoint: 'main' } });
    const dm = makeShader(d, PDRAW, 'remix-pdraw', report);
    const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
    this.pDraw = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: dm, entryPoint: 'vs' },
      fragment: { module: dm, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: { color: add, alpha: add } }] }, primitive: { topology: 'point-list' } });
    const cm = makeShader(d, COMP, 'remix-comp', report);
    this.pComp = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: cm, entryPoint: 'vs' }, fragment: { module: cm, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
    const B = (p, ents) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: ents.map((r, i) => ({ binding: i, resource: r })) });
    const fl = this.fluid;
    this.bgPart = [0, 1].map((k) => B(this.pPart, [{ buffer: this.ub }, { buffer: this.pt }, fl.velV[k], this.smp]));
    this.bgDraw = [0, 1].map((k) => B(this.pDraw, [{ buffer: this.ub }, { buffer: this.pt }, fl.dyeV[k], this.smp, fl.velV[k]]));
    const fracView = this.fracTex.createView(), fluidView = this.fluidTex.createView();
    this.bgComp = [0, 1].map((k) => B(this.pComp, [fracView, fluidView, fl.velV[k], this.smp, { buffer: this.kb }]));
    this.gov = new Governor({ min: 1 << 19, max: this.MAX, value: this.N, stepUp: (v) => v + (1 << 19), stepDown: (v) => v - (1 << 19), lowMs: 11.5, highMs: 14.5, every: 0.6 });
    this.age = 0; this.burstOn = 0;
    d.queue.writeBuffer(this.pt, 0, new Float32Array(4 * 1024)); // vida 0: se reinician solas
    this.clearN = 0;
  }
  frame(enc, dt, t) {
    const d = this.ctx.device, inp = this.ctx.input, W = this.W, H = this.H;
    this.age += dt;
    // reparto de mandos entre sub-simulaciones
    Object.assign(this.inL, { lx: inp.lx, ly: inp.ly, rx: inp.lx * 0.8, ry: inp.ly * 0.8, l2: 0, r2: 0, pressed: { a: inp.pressed.a }, held: { a: inp.held.a } });
    Object.assign(this.inF, { lx: 0, ly: 0, rx: inp.rx, ry: inp.ry, l2: 0, r2: 0, pressed: {}, held: {} });
    const p0 = this.ctx.pointer; Object.assign(this.ptr, { down: p0.down, x: p0.x / 2, y: p0.y / 2 });
    for (const s of [this.frac, this.fluid]) { s.palette = this.palette; s.chaos = this.chaos; }
    // número de partículas
    const trig = inp.r2 - inp.l2;
    if (Math.abs(trig) > 0.05) { this.manual = true; this.tgt = Math.max(1 << 18, Math.min(this.MAX, (this.tgt || this.N) + trig * dt * 2.5e6)); this.N = Math.round(this.tgt / 65536) * 65536; this.gov.value = this.N; }
    // el gobernador baja la carga desde el primer medio segundo si el cuadro se pasa (antes esperaba 2 s: ~1.5 s a 53 fps al entrar)
    else { this.tgt = this.N; const msG = this.ctx.perf.gpuMs ?? this.ctx.perf.frameMs; if (!this.manual && this.age < 16 && (this.age > 2 || (this.age > 0.6 && msG > this.gov.highMs)) && this.gov.update(dt, msG)) { this.N = this.gov.value; try { localStorage.setItem('lab.remixN', this.N); } catch {} } }
    if (this.N > this.clearN) { // partículas nuevas: vida 0 → renacen en el shader
      d.queue.writeBuffer(this.pt, this.clearN * 16, new Float32Array((this.N - this.clearN) * 4)); this.clearN = this.N;
    }
    this.frac.frame(enc, dt, t);
    this.fluid.frame(enc, dt, t);
    const par = this.fluid.par;
    let burst = [0, 0, 1, 0];
    if (inp.pressed.a) burst = [this.fluid.cursor[0] / this.fluid.SW, this.fluid.cursor[1] / this.fluid.SH, 1, 1];
    d.queue.writeBuffer(this.ub, 0, new Float32Array([W, H, this.fluid.SW, this.fluid.SH, Math.min(dt, 1 / 30), t, this.chaos ? 3 : 1, this.N,
      ...burst.slice(0, 2), 0.6 * Math.sqrt((2 << 20) / this.N), burst[3]]));
    d.queue.writeBuffer(this.kb, 0, new Float32Array([0.00006, this.frac.fade * 0.42, 1.3, 0]));
    const cp = this.ctx.cpass(enc); cp.setPipeline(this.pPart); cp.setBindGroup(0, this.bgPart[par]); cp.dispatchWorkgroups(...U.grid1D(this.N)); cp.end();
    const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rp.setPipeline(this.pComp); rp.setBindGroup(0, this.bgComp[par]); rp.draw(3);
    rp.setPipeline(this.pDraw); rp.setBindGroup(0, this.bgDraw[par]); rp.draw(this.N);
    rp.end();
  }
  after() { this.frac.after(); }
  stats() {
    const fps = this.ctx.perf.fps, fs = this.frac.stats(), fl = this.fluid;
    return [
      ['partículas', fmt.int(this.N), true],
      ['fractal (½ res)', `${fmt.int(this.frac.ctx.W * this.frac.ctx.H)} px`],
      ['evaluaciones DE / s', fs[4][1]],
      ['celdas de fluido', fmt.int(fl.SW * fl.SH)],
      ['iteraciones Jacobi', String(fl.iters * 2)],
      ['partículas·paso / s', fmt.si(this.N * fps)],
    ];
  }
  destroy() { this.frac.destroy(); this.fluid.destroy(); [this.fracTex, this.fluidTex, this.pt, this.ub, this.kb].forEach((x) => x.destroy()); }
}
