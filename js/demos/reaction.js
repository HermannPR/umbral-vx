// Sala 3: reacción-difusión Gray-Scott a resolución nativa, decenas de pasos por frame.
import { makeShader, U } from '../gpu.js';
import { FS_VERT, HASH, fmt, Governor } from '../util.js';

const COMMON = /* wgsl */`
struct Uni { size: vec4u, prm: vec4f, map: vec4f, seeds: array<vec4f, 8> };
@group(0) @binding(0) var<uniform> u: Uni;
// mapa de parámetros (F, k): regiones suaves que mezclan regímenes conocidos
fn params(x: f32, y: f32) -> vec2f {
  let t = u.prm.x * 0.02 + u.map.x;
  let q = vec2f(x, y) / f32(u.size.y);
  let a = sin(q.x * 2.1 + t) * cos(q.y * 2.7 - t * 0.7) * 0.5 + 0.5;
  let b = sin(q.y * 1.7 + q.x * 0.9 + t * 0.8 + u.map.y) * 0.5 + 0.5;
  let coral = vec2f(0.0545, 0.062);
  let mitosis = vec2f(0.0367, 0.0649);
  let maze = vec2f(0.029, 0.057);
  let worms = vec2f(0.058, 0.065);
  return mix(mix(coral, mitosis, smoothstep(0.25, 0.75, a)), mix(maze, worms, smoothstep(0.3, 0.7, a)), smoothstep(0.35, 0.65, b));
}

`;

const STEP = COMMON + HASH + /* wgsl */`
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
var<workgroup> tile: array<vec2f, 324>;

@compute @workgroup_size(16, 16)
fn step(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) l: vec3u) {
  let W = i32(u.size.x); let H = i32(u.size.y);
  let base = vec2i(wg.xy) * 16 - 1;
  for (var k = l.y * 16u + l.x; k < 324u; k += 256u) {
    let tx = i32(k % 18u); let ty = i32(k / 18u);
    let gx = (base.x + tx + W) % W; let gy = (base.y + ty + H) % H;
    tile[k] = unpack2x16unorm(src[gy * W + gx]);
  }
  workgroupBarrier();
  let gx = i32(wg.x * 16u + l.x); let gy = i32(wg.y * 16u + l.y);
  if (gx >= W || gy >= H) { return; }
  let c0 = (l.y + 1u) * 18u + l.x + 1u;
  let c = tile[c0];
  let lap = (tile[c0 - 1u] + tile[c0 + 1u] + tile[c0 - 18u] + tile[c0 + 18u]) * 0.2
          + (tile[c0 - 19u] + tile[c0 - 17u] + tile[c0 + 17u] + tile[c0 + 19u]) * 0.05 - c;
  let fk = params(f32(gx), f32(gy));
  let uvv = c.x * c.y * c.y;
  var n = clamp(c + vec2f(lap.x - uvv + fk.x * (1.0 - c.x), 0.5 * lap.y + uvv - (fk.x + fk.y) * c.y), vec2f(0.0), vec2f(1.0));
  // semillas (sólo en el primer paso del frame)
  if (u.size.z > 0u) {
    for (var s = 0u; s < u.size.w; s++) {
      let sd = u.seeds[s];
      let d = length(vec2f(f32(gx), f32(gy)) - sd.xy);
      if (d < sd.z) { n = vec2f(0.5, 0.25 + 0.2 * sd.w); }
    }
  }
  dst[gy * W + gx] = pack2x16unorm(n);
}

@compute @workgroup_size(256)
fn init(@builtin(global_invocation_id) g: vec3u) {
  let W = u.size.x; let H = u.size.y;
  let i = g.x + g.y * 32768u * 256u;
  if (i >= W * H) { return; }
  let x = f32(i % W); let y = f32(i / W);
  // semillas dispersas: celdas de 96 px con una gota aleatoria cada una
  let cell = vec2u(u32(x / 96.0), u32(y / 96.0));
  var s = pcg(cell.x * 7919u + cell.y * 104729u + u32(u.prm.y));
  let cx = (f32(cell.x) + rnd(&s)) * 96.0; let cy = (f32(cell.y) + rnd(&s)) * 96.0;
  let r = 4.0 + rnd(&s) * 10.0;
  var v = vec2f(1.0, 0.0);
  if (length(vec2f(x, y) - vec2f(cx, cy)) < r && rnd(&s) < 0.55) { v = vec2f(0.5, 0.25); }
  dst[i] = pack2x16unorm(v);
}
`;

const DRAW = FS_VERT + COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> st: array<u32>;
fn at(x: i32, y: i32) -> vec2f {
  let W = i32(u.size.x); let H = i32(u.size.y);
  return unpack2x16unorm(st[clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)]);
}
fn pal(t: f32, k: f32) -> vec3f {
  var a = vec3f(0.5, 0.4, 0.3); var b = vec3f(0.5, 0.4, 0.35); var c = vec3f(1.0); var d = vec3f(0.0, 0.15, 0.25);
  if (k > 2.5) { a = vec3f(0.5); b = vec3f(0.5); d = vec3f(0.0, 0.33, 0.67); }
  else if (k > 0.5 && k < 1.5) { a = vec3f(0.3, 0.5, 0.55); b = vec3f(0.3, 0.45, 0.45); c = vec3f(1.0, 1.0, 1.0); d = vec3f(0.6, 0.7, 0.8); }
  else if (k > 1.5 && k < 2.5) { a = vec3f(0.55, 0.35, 0.6); b = vec3f(0.45, 0.35, 0.4); c = vec3f(1.0, 0.8, 0.6); d = vec3f(0.9, 0.2, 0.3); }
  return a + b * cos(6.2831853 * (c * t + d));
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let x = i32(i.pos.x); let y = i32(i.pos.y);
  let c = at(x, y);
  let gx = at(x + 1, y).y - at(x - 1, y).y;
  let gy = at(x, y + 1).y - at(x, y - 1).y;
  let n = normalize(vec3f(-gx * 6.0, -gy * 6.0, 1.0));
  let L = normalize(vec3f(-0.5, -0.6, 0.65));
  let dif = max(dot(n, L), 0.0);
  let spe = pow(max(dot(reflect(-L, n), vec3f(0.0, 0.0, 1.0)), 0.0), 24.0);
  let v = smoothstep(0.05, 0.4, c.y);
  let fk = params(f32(x), f32(y));
  let base = pal(c.y * 0.9 + (fk.x - 0.03) * 14.0 + (fk.y - 0.06) * 30.0 + u.prm.x * 0.01, u.prm.w);
  var col = mix(vec3f(0.01, 0.012, 0.025), base, v) * (0.35 + 0.9 * dif) + spe * v * 0.9;
  col += base * smoothstep(0.25, 0.45, c.y) * 0.35;
  return vec4f(col, 1.0);
}
`;

export default class Reaction {
  static palettes = ['Coral', 'Laguna', 'Orquídea', 'Arcoíris'];
  static controls = { ls: 'mover pincel', rs: 'desplazar mapa F/k', trig: '− / + pasos de simulación por frame', a: 'sembrar (mantener)' };
  static info = {
    title: 'Reacción-difusión',
    short: 'Gray-Scott, millones de celdas',
    desc: 'Dos sustancias químicas virtuales (Gray-Scott) se difunden y reaccionan en cada píxel; decenas de pasos completos de la simulación por frame.',
  };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.1, bloom: 0.25, vignette: 0.5 }; }
  async init() {
    const { device: d, report, W, H } = this.ctx;
    this.W = W; this.H = H;
    this.ub = U.uniform(d, 16 * 3 + 16 * 8);
    this.ubSeed = U.uniform(d, 16 * 3 + 16 * 8);
    this.buf = [U.storage(d, W * H * 4), U.storage(d, W * H * 4)];
    const m = makeShader(d, STEP, 'rd-step', report);
    this.pStep = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'step' } });
    this.pInit = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'init' } });
    const dm = makeShader(d, DRAW, 'rd-draw', report);
    this.pDraw = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: dm, entryPoint: 'vs' },
      fragment: { module: dm, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
    const sbg = (ub, a, b) => d.createBindGroup({ layout: this.pStep.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: ub } }, { binding: 1, resource: { buffer: this.buf[a] } }, { binding: 2, resource: { buffer: this.buf[b] } }] });
    this.bgStep = [sbg(this.ub, 0, 1), sbg(this.ub, 1, 0)];
    this.bgSeed = [sbg(this.ubSeed, 0, 1), sbg(this.ubSeed, 1, 0)];
    this.bgInit = d.createBindGroup({ layout: this.pInit.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.ub } }, { binding: 2, resource: { buffer: this.buf[0] } }] });
    this.bgDraw = [0, 1].map((k) => d.createBindGroup({ layout: this.pDraw.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.ub } }, { binding: 1, resource: { buffer: this.buf[k] } }] }));
    this.gov = new Governor({ min: 4, max: Math.round(400 * (this.ctx.calidad ? this.ctx.calidad.carga : 1)), value: 24, stepUp: (v) => Math.ceil(v * 1.15), stepDown: (v) => Math.floor(v * 0.85), lowMs: 11, highMs: 14.5, every: 0.5 });
    this.cur = 0; this.mapOff = [0, 0]; this.brush = [W * 0.5, H * 0.5]; this.autoT = 0; this.totalSteps = 0; this.manualSteps = null;
    this.needInit = true;
  }
  writeU(buf, t, seeds) {
    const a = new ArrayBuffer(16 * 11), u = new Uint32Array(a), f = new Float32Array(a);
    u.set([this.W, this.H, seeds.length ? 1 : 0, seeds.length]);
    f.set([t, (Math.random() * 1e6) | 0, 0, this.palette || 0], 4);
    f.set([this.mapOff[0], this.mapOff[1], 0, 0], 8);
    seeds.slice(0, 8).forEach((s, i) => f.set(s, 12 + i * 4));
    this.ctx.device.queue.writeBuffer(buf, 0, a);
  }
  frame(enc, dt, t) {
    const inp = this.ctx.input, ptr = this.ctx.pointer, W = this.W, H = this.H;
    const ms = this.ctx.perf.gpuMs ?? this.ctx.perf.frameMs;
    const trig = inp.r2 - inp.l2;
    if (Math.abs(trig) > 0.05) { this.manualSteps = Math.max(1, Math.min(400, (this.manualSteps ?? this.gov.value) * Math.exp(trig * dt * 1.5))); }
    else if (this.manualSteps == null) this.gov.update(dt, ms);
    let steps = Math.round(this.manualSteps ?? this.gov.value);
    if (this.chaos) steps = Math.round(steps * 1.0);
    this.steps = steps;
    // pincel: stick izquierdo o ratón
    this.brush[0] = (this.brush[0] + inp.lx * dt * H * 0.6 + W) % W;
    this.brush[1] = (this.brush[1] + inp.ly * dt * H * 0.6 + H) % H;
    this.mapOff[0] += inp.rx * dt * 0.8; this.mapOff[1] += inp.ry * dt * 0.8;
    const seeds = [];
    const rr = H * 0.012;
    if (inp.held.a) { seeds.push([...this.brush, rr * 1.4, 1]); if (inp.pressed.a) for (let k = 0; k < 6; k++) seeds.push([this.brush[0] + (Math.random() - 0.5) * rr * 10, this.brush[1] + (Math.random() - 0.5) * rr * 10, rr, 0]); }
    if (ptr.down) seeds.push([ptr.x, ptr.y, rr * 1.3, 1]);
    this.autoT += dt;
    const every = this.chaos ? 0.12 : 0.9;
    if (this.autoT > every) {
      this.autoT = 0;
      const n = this.chaos ? 3 : 1;
      for (let k = 0; k < n; k++) seeds.push([Math.random() * W, Math.random() * H, rr * (0.6 + Math.random()), 0]);
    }
    if (this.chaos) this.mapOff[0] += dt * 0.25;
    this.showBrush = Math.abs(inp.lx) + Math.abs(inp.ly) > 0.05 || inp.held.a;
    this.writeU(this.ub, t, []);
    if (seeds.length) this.writeU(this.ubSeed, t, seeds);
    const p = this.ctx.cpass(enc);
    if (this.needInit) { this.needInit = false; this.cur = 0; p.setPipeline(this.pInit); p.setBindGroup(0, this.bgInit); p.dispatchWorkgroups(...U.grid1D(W * H)); }
    p.setPipeline(this.pStep);
    const gx = Math.ceil(W / 16), gy = Math.ceil(H / 16);
    for (let s = 0; s < steps; s++) {
      p.setBindGroup(0, (s === 0 && seeds.length ? this.bgSeed : this.bgStep)[this.cur]);
      p.dispatchWorkgroups(gx, gy);
      this.cur ^= 1;
    }
    p.end();
    this.totalSteps += steps;
    const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rp.setPipeline(this.pDraw); rp.setBindGroup(0, this.bgDraw[this.cur]); rp.draw(3); rp.end();
  }
  onKey(k) { if (k === 'r') this.needInit = true; }
  stats() {
    const fps = this.ctx.perf.fps, cells = this.W * this.H;
    return [
      ['celdas', fmt.int(cells), true],
      ['pasos / frame', String(this.steps)],
      ['pasos / s', fmt.si(this.steps * fps)],
      ['actualizaciones de celda / s', fmt.si(cells * this.steps * fps), true],
      ['≈ cómputo', fmt.si(cells * this.steps * fps * 40, 'FLOP/s')],
      ['pasos totales', fmt.int(this.totalSteps)],
    ];
  }
  destroy() { this.ub.destroy(); this.ubSeed.destroy(); this.buf.forEach((b) => b.destroy()); }
}
