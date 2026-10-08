// Sala 1: colisión de dos galaxias espirales con millones de estrellas (WebGPU compute).
import { makeShader, U } from '../gpu.js';
import { HASH, FS_VERT, m4, v3, fmt, Governor } from '../util.js';

const RH2 = 0.6, EPS2 = 0.006;

const SIM = HASH + /* wgsl */`
struct P { cA: vec4f, cB: vec4f, vA: vec4f, vB: vec4f, nA: vec4f, nB: vec4f, prm: vec4f, spawn: vec4u, kick: vec4f };
@group(0) @binding(0) var<uniform> u: P;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
const RH2 = ${RH2};
struct R { vp: mat4x4f, cam: vec4f, prm: vec4f, res: vec4f };
@group(1) @binding(0) var<uniform> ru: R;
@group(1) @binding(1) var<storage, read_write> acc: array<atomic<u32>>;

fn starColor(P: vec4f, V: vec4f) -> vec3f {
  let gal = floor(V.w / 4.0);
  let typ = V.w - gal * 4.0;
  let temp = P.w;
  var col = mix(vec3f(1.0, 0.62, 0.25), vec3f(0.2, 0.45, 1.0), smoothstep(0.1, 0.7, temp)) * mix(1.0, 1.6, temp);
  if (gal > 0.5) { col = mix(vec3f(1.0, 0.8, 0.45), vec3f(0.55, 0.3, 1.0), smoothstep(0.1, 0.7, temp)) * mix(1.0, 1.6, temp); }
  if (typ > 1.5) { col = vec3f(1.0, 0.75, 0.45) * 0.6; }
  else if (typ > 0.5) { col = vec3f(1.0, 0.2, 0.45) * 2.5; }
  let sp = length(V.xyz);
  let pal = ru.prm.y;
  if (pal > 0.5 && pal < 1.5) {
    col = mix(vec3f(1.0, 0.25, 0.05), vec3f(1.0, 0.9, 0.4), smoothstep(0.2, 1.6, sp)) * select(1.0, 2.0, typ > 0.5 && typ < 1.5);
  } else if (pal > 1.5 && pal < 2.5) {
    col = mix(vec3f(0.1, 0.35, 1.0), vec3f(0.7, 1.0, 1.0), smoothstep(0.4, 2.2, sp)) * (0.6 + temp);
  } else if (pal > 2.5) {
    col = mix(vec3f(0.1, 1.0, 0.55), vec3f(0.9, 0.2, 1.0), gal) * (0.5 + 0.8 * fract(temp * 7.0));
  }
  col *= 0.7 + 0.5 * smoothstep(0.3, 2.0, sp);
  let dist = length(P.xyz - ru.cam.xyz);
  return col * ru.prm.x * clamp(40.0 / (dist * dist), 0.3, 3.0);
}

// proyección + acumulación atómica en punto fijo (más rápido que mezclar millones de puntos con el rasterizador)
fn splat(P: vec4f, V: vec4f) {
  let c = ru.vp * vec4f(P.xyz, 1.0);
  if (c.w <= 0.05) { return; }
  let ndc = c.xy / c.w;
  if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0) { return; }
  let W = u32(ru.res.x); let H = u32(ru.res.y);
  let px = min(u32((ndc.x * 0.5 + 0.5) * ru.res.x), W - 1u);
  let py = min(u32((0.5 - ndc.y * 0.5) * ru.res.y), H - 1u);
  let col = starColor(P, V) * 100000.0;
  let k = (py * W + px) * 3u;
  atomicAdd(&acc[k], u32(col.x)); atomicAdd(&acc[k + 1u], u32(col.y)); atomicAdd(&acc[k + 2u], u32(col.z));
}

fn accel(p: vec3f, c: vec3f, gm: f32, vh2: f32) -> vec3f {
  let d = c - p;
  let r2 = dot(d, d);
  let inv = inverseSqrt(r2 + u.prm.y);
  return d * (gm * inv * inv * inv + vh2 / (r2 + RH2));
}

@compute @workgroup_size(256)
fn sim(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x + g.y * 32768u * 256u;
  if (i >= u.spawn.w) { return; }
  var p = pos[i].xyz;
  var v = vel[i].xyz;
  let dt = u.prm.x;
  let S = u32(u.prm.z);
  for (var k = 0u; k < S; k++) {
    let fk = f32(k) * dt;
    let a = accel(p, u.cA.xyz + u.vA.xyz * fk, u.cA.w, u.vA.w) + accel(p, u.cB.xyz + u.vB.xyz * fk, u.cB.w, u.vB.w);
    v += a * dt;
    p += v * dt;
  }
  if (u.kick.w > 0.0) {
    let d = p - u.kick.xyz;
    let r2 = dot(d, d);
    v += d * inverseSqrt(r2 + 0.01) * u.kick.w * exp(-r2 * 0.6);
  }
  let P = vec4f(p, pos[i].w); let V = vec4f(v, vel[i].w);
  pos[i] = P;
  vel[i] = V;
  splat(P, V);
}

fn gauss(s: ptr<function, u32>) -> f32 {
  let a = max(rnd(s), 1e-7); let b = rnd(s);
  return sqrt(-2.0 * log(a)) * cos(6.2831853 * b);
}

@compute @workgroup_size(256)
fn spawn(@builtin(global_invocation_id) g: vec3u) {
  let j = g.x + g.y * 32768u * 256u;
  if (j >= u.spawn.y) { return; }
  let i = u.spawn.x + j;
  var s = pcg(i * 9781u + u.spawn.z * 6271u);
  let which = rnd(&s) < 0.4;
  var c = u.cA.xyz; var cv = u.vA.xyz; var n = u.nA.xyz; var gm = u.cA.w; var vh2 = u.vA.w; var rs = u.nA.w;
  if (which) { c = u.cB.xyz; cv = u.vB.xyz; n = u.nB.xyz; gm = u.cB.w; vh2 = u.vB.w; rs = u.nB.w; }
  let e1 = normalize(cross(n, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.8)));
  let e2 = cross(n, e1);
  let kind = rnd(&s);
  var r: f32; var th: f32; var z: f32; var typ = 0.0;
  if (kind < 0.14) {           // bulbo
    r = rs * 0.35 * abs(gauss(&s)) + 0.03;
    th = rnd(&s) * 6.2831853;
    z = gauss(&s) * r * 0.5;
    typ = 2.0;
  } else {                     // disco con brazos espirales
    r = min(rs * -log(max(1.0 - rnd(&s), 1e-6)) + 0.08, rs * 6.0);
    let arm = floor(rnd(&s) * 2.0);
    let spread = select(0.55, 0.22, rnd(&s) < 0.7);
    th = arm * 3.14159265 + log(r / rs + 0.2) * 1.6 + gauss(&s) * spread;
    z = gauss(&s) * (0.025 + 0.02 * r);
    if (spread < 0.3 && rnd(&s) < 0.07) { typ = 1.0; }  // nebulosas / regiones HII
  }
  let radial = e1 * cos(th) + e2 * sin(th);
  let p = c + radial * r + n * z;
  let d = length(p - c);
  let v2 = gm * d * d / pow(d * d + u.prm.y, 1.5) + vh2 * d * d / (d * d + RH2);
  var tang = normalize(cross(n, radial));
  var disp = 0.04;
  if (typ == 2.0) { tang = normalize(tang + vec3f(gauss(&s), gauss(&s), gauss(&s)) * 0.6); disp = 0.15; }
  let vel0 = cv + tang * sqrt(v2) * (1.0 + gauss(&s) * disp);
  pos[i] = vec4f(p, clamp(r / (rs * 3.5) + (rnd(&s) - 0.5) * 0.5, 0.0, 1.0));
  vel[i] = vec4f(vel0, select(0.0, 4.0, which) + typ);
}
`;

const RESOLVE = FS_VERT + /* wgsl */`
struct R { vp: mat4x4f, cam: vec4f, prm: vec4f, res: vec4f };
@group(0) @binding(0) var<uniform> ru: R;
@group(0) @binding(1) var<storage, read_write> acc: array<u32>;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let p = vec2u(i.pos.xy);
  let k = (p.y * u32(ru.res.x) + p.x) * 3u;
  let c = vec3f(f32(acc[k]), f32(acc[k + 1u]), f32(acc[k + 2u])) / 100000.0;
  acc[k] = 0u; acc[k + 1u] = 0u; acc[k + 2u] = 0u;
  return vec4f(c + vec3f(0.002, 0.003, 0.008), 1.0);
}
`;

export default class Galaxy {
  static palettes = ['Clásica', 'Infrarrojo', 'Rayos X', 'Aurora'];
  static controls = { ls: 'orbitar cámara', rs: 'zoom / altura', trig: '− / + millones de estrellas', a: 'onda de choque (supernova)' };
  static info = {
    short: 'N-cuerpos con millones de estrellas',
    title: 'Galaxia de millones',
    desc: 'Dos galaxias espirales en colisión: cada estrella integra en la GPU la gravedad de ambos núcleos y sus halos oscuros (4 subpasos/frame).',
  };
  constructor(ctx) { this.ctx = ctx; this.post = { exposure: 1.0, bloom: 0.3, vignette: 0.45 }; }
  async init() {
    const { device: d, report } = this.ctx;
    const L = d.limits;
    this.MAX = Math.min(Math.max(1 << 20, Math.round((16 << 20) * (this.ctx.calidad ? this.ctx.calidad.carga : 1) / (1 << 20)) << 20), Math.floor(Math.min(L.maxStorageBufferBindingSize, L.maxBufferSize) / 16));
    let saved = 0; try { saved = +localStorage.getItem('lab.galaxyN') || 0; } catch {}
    this.N = Math.min(this.MAX, saved || (3 << 20));
    this.pos = U.storage(d, this.MAX * 16); this.vel = U.storage(d, this.MAX * 16);
    this.su = U.uniform(d, 144); this.spu = U.uniform(d, 144);
    const sm = makeShader(d, SIM, 'galaxy-sim', report);
    this.pSim = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: sm, entryPoint: 'sim' } });
    this.pSpawn = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: sm, entryPoint: 'spawn' } });
    this.ru = U.uniform(d, 112);
    this.acc = U.storage(d, this.ctx.W * this.ctx.H * 12);
    const dm = makeShader(d, RESOLVE, 'galaxy-resolve', report);
    this.pDraw = await d.createRenderPipelineAsync({ layout: 'auto', vertex: { module: dm, entryPoint: 'vs' }, fragment: { module: dm, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
    this.bgSplat = d.createBindGroup({ layout: this.pSim.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: this.ru } }, { binding: 1, resource: { buffer: this.acc } }] });
    const bg = (p, ub) => d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: ub } }, { binding: 1, resource: { buffer: this.pos } }, { binding: 2, resource: { buffer: this.vel } }] });
    this.bgSim = bg(this.pSim, this.su); this.bgSpawn = bg(this.pSpawn, this.spu);
    this.bgDraw = d.createBindGroup({ layout: this.pDraw.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.ru } }, { binding: 1, resource: { buffer: this.acc } }] });
    this.gov = new Governor({ min: 1 << 20, max: this.MAX, value: this.N, stepUp: (v) => v + (1 << 20), stepDown: (v) => v - (1 << 20), lowMs: 11.5, highMs: 14.5, every: 0.6 });
    this.reset();
  }
  reset() {
    const mA = 1.0, mB = 0.55, M = mA + mB;
    const R = [9.0, 4.4, 2.0], V = [-0.42, -0.2, -0.1];
    this.c = {
      A: { p: v3.mul(R, -mB / M), v: v3.mul(V, -mB / M), gm: mA, vh2: 0.22, rs: 0.5, n: v3.norm([0.15, 0.25, 1]) },
      B: { p: v3.mul(R, mA / M), v: v3.mul(V, mA / M), gm: mB, vh2: 0.14, rs: 0.36, n: v3.norm([-0.6, 0.45, 0.66]) },
    };
    this.simT = 0; this.seed = (Math.random() * 1e6) | 0;
    this.pendingSpawn = [0, this.N];
  }
  coreAccel(p, o) {
    const d = v3.sub(o.p, p), r2 = v3.dot(d, d), inv = 1 / Math.sqrt(r2 + EPS2);
    return v3.mul(d, o.gm * inv * inv * inv + o.vh2 / (r2 + RH2));
  }
  writeSim(dt, S, spawnStart, spawnCount, buf = this.su) {
    const { A, B } = this.c;
    const f = new Float32Array(36), u = new Uint32Array(f.buffer);
    if (this.kick && buf === this.su) { f.set(this.kick, 32); this.kick = null; }
    f.set([...A.p, A.gm, ...B.p, B.gm, ...A.v, A.vh2, ...B.v, B.vh2, ...A.n, A.rs, ...B.n, B.rs, dt, EPS2, S, this.simT]);
    u.set([spawnStart, spawnCount, this.seed++, this.N], 28);
    this.ctx.device.queue.writeBuffer(buf, 0, f);
  }
  frame(enc, dt, t) {
    const d = this.ctx.device;
    if (this.age === undefined) this.age = 0;
    this.age += dt;
    // ajuste de carga: sube durante los primeros 14 s, después sólo baja
    const ms = this.ctx.perf.gpuMs ?? this.ctx.perf.frameMs;
    const inp = this.ctx.input;
    const trig = inp.r2 - inp.l2;
    if (Math.abs(trig) > 0.05) {
      this.manual = true;
      this.target = Math.max(1 << 19, Math.min(this.MAX, (this.target || this.N) + trig * dt * 3e6));
      const want = Math.round(this.target / 65536) * 65536;
      if (want > this.N) { this.pendingSpawn = [this.N, want - this.N]; this.N = want; }
      else if (want < this.N) this.N = want;
      this.gov.value = this.N;
    } else this.target = this.N;
    if (inp.pressed.a) this.shock();
    if (this.chaos) { this.chaosT = (this.chaosT || 0) + dt; if (this.chaosT > 2.5) { this.chaosT = 0; this.shock(); } }
    this.camAz = (this.camAz || 0) + (inp.lx * 1.4 + inp.rx * 0.6) * dt;
    this.camEl = Math.max(-1.2, Math.min(1.2, (this.camEl || 0) - inp.ly * 1.0 * dt));
    this.camZoom = Math.max(0.35, Math.min(2.5, (this.camZoom || 1) * Math.exp(inp.ry * 1.2 * dt)));
    if (!this.manual && this.age > 1.5 && this.gov.update(dt, ms)) {
      const nv = this.gov.value;
      // las estrellas nuevas se agregan alrededor de los núcleos actuales (antes reset(): la colisión reiniciaba 3–4 veces al entrar)
      if (nv > this.N) { if (this.age < 9) { this.pendingSpawn = [this.N, nv - this.N]; this.N = nv; } else this.gov.value = this.N; }
      else this.N = nv;
      try { localStorage.setItem('lab.galaxyN', this.N); } catch {}
    }
    if (this.pendingSpawn) {
      const [s0, cnt] = this.pendingSpawn; this.pendingSpawn = null;
      this.writeSim(0.0025, 4, s0, cnt, this.spu);
      const p = this.ctx.cpass(enc); p.setPipeline(this.pSpawn); p.setBindGroup(0, this.bgSpawn);
      p.dispatchWorkgroups(...U.grid1D(cnt)); p.end();
    }
    this.step(enc, dt, t);
  }
  step(enc, dt, t) {
    const d = this.ctx.device;
    const S = this.chaos ? 8 : 4, h = 0.0025 * Math.min(1.5, dt * 60) * (this.chaos ? 1.3 : 1);
    this.writeSim(h, S, 0, 0);
    // integrar núcleos en CPU con los mismos subpasos
    const { A, B } = this.c;
    for (let k = 0; k < S; k++) {
      const aA = this.coreAccel(A.p, B), aB = this.coreAccel(B.p, A);
      A.v = v3.add(A.v, v3.mul(aA, h)); B.v = v3.add(B.v, v3.mul(aB, h));
      // fricción dinámica artificial cuando están cerca
      const sep = v3.len(v3.sub(A.p, B.p));
      if (sep < 2.5) {
        const M = A.gm + B.gm, vcm = v3.mul(v3.add(v3.mul(A.v, A.gm), v3.mul(B.v, B.gm)), 1 / M), k2 = 0.06 * h * (2.5 - sep);
        A.v = v3.sub(A.v, v3.mul(v3.sub(A.v, vcm), k2)); B.v = v3.sub(B.v, v3.mul(v3.sub(B.v, vcm), k2));
      }
      A.p = v3.add(A.p, v3.mul(A.v, h)); B.p = v3.add(B.p, v3.mul(B.v, h));
    }
    this.simT += h * S;
    if (this.simT > 45) this.reset();
    const cp = this.ctx.cpass(enc); cp.setPipeline(this.pSim); cp.setBindGroup(0, this.bgSim); cp.setBindGroup(1, this.bgSplat);
    cp.dispatchWorkgroups(...U.grid1D(this.N)); cp.end();
    // cámara
    const M = A.gm + B.gm;
    const cm = v3.mul(v3.add(v3.mul(A.p, A.gm), v3.mul(B.p, B.gm)), 1 / M);
    this.cam = this.cam ? v3.mix(this.cam, cm, 0.02) : cm;
    const az = t * 0.07 + this.camAz, el = Math.max(-1.45, Math.min(1.45, 0.55 + 0.35 * Math.sin(t * 0.045) + this.camEl)), sepD = v3.len(v3.sub(A.p, B.p));
    this.sonido = { cerca: Math.max(0, Math.min(1, 1 - (sepD - 1) / 9)) };
    this.fit = this.fit ? this.fit + (Math.max(4.4, sepD * 0.85 + 2.2) - this.fit) * Math.min(1, dt * 0.8) : Math.max(4.4, sepD * 0.85 + 2.2);
    const dist = (this.fit + 1.0 * Math.sin(t * 0.06 + 1)) * this.camZoom;
    const eye = v3.add(this.cam, [Math.cos(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.sin(az) * Math.cos(el) * dist]);
    const W = this.ctx.W, H = this.ctx.H;
    const vp = m4.mul(m4.perspective(0.8, W / H, 0.05, 100), m4.lookAt(eye, this.cam, [0, 1, 0]));
    const r = new Float32Array(28);
    r.set(vp, 0); r.set([...eye, 0], 16); r.set([0.055 * (3145728 / this.N) * (W * H / 5.9e6), this.palette || 0, t, this.N], 20); r.set([W, H, 0, 0], 24);
    d.queue.writeBuffer(this.ru, 0, r);
    const rp = this.ctx.rpass(enc, { colorAttachments: [{ view: this.ctx.post.hdrView, loadOp: 'clear', clearValue: [0.002, 0.003, 0.008, 1], storeOp: 'store' }] });
    rp.setPipeline(this.pDraw); rp.setBindGroup(0, this.bgDraw); rp.draw(3); rp.end();
  }
  shock() {
    const c = Math.random() < 0.5 ? this.c.A : this.c.B;
    this.kick = [...c.p, this.chaos ? 2.2 : 1.4];
  }
  onKey(k) { if (k === 'r') this.reset(); }
  stats() {
    const fps = this.ctx.perf.fps, N = this.N;
    const flopsPer = (this.chaos ? 8 : 4) * 42 + 30; // 4 subpasos × (2 núcleos+halos+integración) + proyección
    return [
      ['estrellas', fmt.int(N), true],
      ['subpasos / frame', this.chaos ? 8 : 4],
      ['interacciones / s', fmt.si(N * (this.chaos ? 8 : 4) * 2 * fps)],
      ['≈ cómputo', fmt.si(N * flopsPer * fps, 'FLOP/s')],
      ['≈ memoria', fmt.si(N * 80 * fps, 'B/s')],
      ['tiempo simulado', this.simT.toFixed(1)],
      ['máx. buffer', fmt.int(this.MAX)],
    ];
  }
  destroy() { this.spu.destroy(); this.acc.destroy(); this.pos.destroy(); this.vel.destroy(); this.su.destroy(); this.ru.destroy(); }
}
