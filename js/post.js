// Post-proceso HDR compartido: bloom multi-nivel + tonemapping ACES -> canvas.
import { FS_VERT } from './util.js';

const DOWN = FS_VERT + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> u: vec4f;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let t = u.xy;
  var c = textureSampleLevel(src, smp, i.uv, 0.0).rgb * 0.5;
  c += textureSampleLevel(src, smp, i.uv + vec2f(-t.x, -t.y), 0.0).rgb * 0.125;
  c += textureSampleLevel(src, smp, i.uv + vec2f( t.x, -t.y), 0.0).rgb * 0.125;
  c += textureSampleLevel(src, smp, i.uv + vec2f(-t.x,  t.y), 0.0).rgb * 0.125;
  c += textureSampleLevel(src, smp, i.uv + vec2f( t.x,  t.y), 0.0).rgb * 0.125;
  if (u.z > 0.5) { c = min(c, vec3f(40.0)); }
  return vec4f(c, 1.0);
}`;

const UP = FS_VERT + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> u: vec4f;
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let t = u.xy;
  var c = textureSampleLevel(src, smp, i.uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(src, smp, i.uv + vec2f(-t.x, 0.0), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, smp, i.uv + vec2f( t.x, 0.0), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, smp, i.uv + vec2f(0.0, -t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, smp, i.uv + vec2f(0.0,  t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, smp, i.uv + vec2f(-t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, smp, i.uv + vec2f( t.x, -t.y), 0.0).rgb;
  c += textureSampleLevel(src, smp, i.uv + vec2f(-t.x,  t.y), 0.0).rgb;
  c += textureSampleLevel(src, smp, i.uv + vec2f( t.x,  t.y), 0.0).rgb;
  return vec4f(c / 16.0, 1.0);
}`;

const COMP = FS_VERT + /* wgsl */`
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
struct CU { a: vec4f, b: vec4f };     // a: exposure, bloom, vignette, time · b: elevación de negros (rgb), grano
@group(0) @binding(3) var<uniform> cu: CU;
fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let u = cu.a;
  let p = vec2i(i.pos.xy);
  var c = textureLoad(hdr, p, 0).rgb;
  let b = textureSampleLevel(bloom, smp, i.uv, 0.0).rgb;
  c = c + b * u.y;
  c *= u.x;
  let q = i.uv - 0.5;
  c *= mix(1.0, 1.0 - dot(q, q) * 1.6, u.z);
  c = aces(c);
  c = pow(c, vec3f(1.0 / 2.2));
  // negros cálidos (nunca #000) y grano de película, más visible en tonos medios
  c = c + cu.b.rgb * (1.0 - c);
  let n = fract(sin(dot(i.pos.xy + fract(u.w * 7.31) * 113.0, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  let l = dot(c, vec3f(0.299, 0.587, 0.114));
  c += n * (1.0 / 255.0 + cu.b.w * 4.0 * l * (1.0 - l));
  return vec4f(c, 1.0);
}`;

export class Post {
  constructor(device, format, W, H) {
    this.device = device; this.W = W; this.H = H;
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    this.hdr = device.createTexture({ size: [W, H], format: 'rgba16float', usage, label: 'hdr' });
    this.hdrView = this.hdr.createView();
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const mk = (code, fmt, blend) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: fmt, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    const add = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
    this.pDown = mk(DOWN, 'rgba16float');
    this.pUp = mk(UP, 'rgba16float', add);
    this.pComp = mk(COMP, format);
    // cadena de mips de bloom
    this.levels = [];
    let w = W, h = H;
    for (let i = 0; i < 6; i++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      const tex = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.levels.push({ tex, view: tex.createView(), w, h });
    }
    const ub = (data) => { const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, new Float32Array(data)); return b; };
    this.downBG = []; this.upBG = [];
    let srcView = this.hdrView, sw = W, sh = H;
    for (let i = 0; i < this.levels.length; i++) {
      this.downBG.push(device.createBindGroup({ layout: this.pDown.getBindGroupLayout(0), entries: [
        { binding: 0, resource: srcView }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: ub([1 / sw, 1 / sh, i === 0 ? 1 : 0, 0]) } }] }));
      srcView = this.levels[i].view; sw = this.levels[i].w; sh = this.levels[i].h;
    }
    for (let i = this.levels.length - 1; i > 0; i--) {
      const L = this.levels[i];
      this.upBG[i] = device.createBindGroup({ layout: this.pUp.getBindGroupLayout(0), entries: [
        { binding: 0, resource: L.view }, { binding: 1, resource: this.sampler }, { binding: 2, resource: { buffer: ub([1 / L.w, 1 / L.h, 0, 0]) } }] });
    }
    this.compU = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.compBG = device.createBindGroup({ layout: this.pComp.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.hdrView }, { binding: 1, resource: this.levels[0].view },
      { binding: 2, resource: this.sampler }, { binding: 3, resource: { buffer: this.compU } }] });
  }
  pass(enc, view, pipe, bg, load) {
    const p = (this.rpass || ((e, d) => e.beginRenderPass(d)))(enc, { colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    p.setPipeline(pipe); p.setBindGroup(0, bg); p.draw(3); p.end();
  }
  run(enc, outView, { exposure = 1, bloom = 0.6, vignette = 0.6, lift = [0.02, 0.018, 0.014], grain = 0.035 } = {}, time = 0) {
    const n = this.levels.length;
    if (bloom > 0) {
      for (let i = 0; i < n; i++) this.pass(enc, this.levels[i].view, this.pDown, this.downBG[i], false);
      for (let i = n - 1; i > 0; i--) this.pass(enc, this.levels[i - 1].view, this.pUp, this.upBG[i], true);
    }
    this.device.queue.writeBuffer(this.compU, 0, new Float32Array([exposure, bloom / n, vignette, time % 100, ...lift, grain]));
    this.pass(enc, outView, this.pComp, this.compBG, false);
  }
  destroy() { this.hdr.destroy(); this.levels.forEach((l) => l.tex.destroy()); }
}
