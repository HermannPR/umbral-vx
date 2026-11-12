// Grado cíclico común al Bulbo, Mandelbox y profundo, antes del post HDR.
import { makeShader } from '../gpu.js';
import { ANILLO, MODOS_GALV } from './galvanizado-anillo.js';
export { MODOS_GALV };
export const PERIODO_COLOR = 9.6;
// Reloj independiente de la velocidad del caos. Para tomas editadas: t local +
// (entrada en canción - 2) mod 9.6. En vivo el reloj arranca en fase cero.
export function tiempoColor(local, entrada = 2) {
  return local + ((entrada - 2) % PERIODO_COLOR + PERIODO_COLOR) % PERIODO_COLOR;
}
const COMMON = /* wgsl */`
struct U { dim: vec4f, prm: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;
const W3 = vec3f(0.2126, 0.7152, 0.0722);
// Curva filmica C (Hermann 10 oct 12:50): L' = (1-exp(-2.5 L))/(1-exp(-2.5)); negro fijo, altas luces suaves.
// Se aplica a la luma lineal ANTES del promedio/blur (fase) y ANTES de gain/gamma; identica a --curva-c 2.5 del gradador.
fn filmica(l: f32) -> f32 { return (1.0 - exp(-2.5 * clamp(l, 0.0, 1.0))) / (1.0 - exp(-2.5)); }
`;
const DOWN = COMMON + /* wgsl */`
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dim = vec2u(ceil(u.dim.xy / 16.0));
  if (any(id.xy >= dim)) { return; }
  // Promedio estratificado 4×4 de sqrt(L), en una rejilla de ~16 px.
  var ls = 0.0;
  for (var y = 0; y < 4; y++) { for (var x = 0; x < 4; x++) {
    let uv = (vec2f(id.xy) + (vec2f(f32(x), f32(y)) + 0.5) / 4.0) / vec2f(dim);
    let l = filmica(dot(textureSampleLevel(src, smp, uv, 0.0).rgb, W3));
    ls += sqrt(l);
  } }
  textureStore(dst, id.xy, vec4f(ls / 16.0, 0.0, 0.0, 1.0));
}`;
const BLUR = COMMON + /* wgsl */`
fn suavizada(uv: vec2f) -> f32 {
  // Cuadratura gaussiana 3×3: pesos 1/6, 2/3, 1/6 a ±sqrt(3)*sigma.
  // Solo en la textura reducida; sigma = 20 (A) o 14 (B) px @960.
  let delta = vec2f(u.prm.y * 1.732050808 / 960.0) * vec2f(1.0, u.dim.x / u.dim.y);
  var l = 0.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let w = select(1.0/6.0, 2.0/3.0, x == 0) * select(1.0/6.0, 2.0/3.0, y == 0);
    l += w * textureSampleLevel(src, smp, uv + vec2f(f32(x), f32(y)) * delta, 0.0).r;
  } }
  return l;
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dim = textureDimensions(dst);
  if (any(id.xy >= dim)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dim);
  let px = vec2f(1.0) / u.dim.xy;
  let gx = 0.5 * (suavizada(uv + vec2f(px.x, 0.0)) - suavizada(uv - vec2f(px.x, 0.0)));
  let gy = 0.5 * (suavizada(uv + vec2f(0.0, px.y)) - suavizada(uv - vec2f(0.0, px.y)));
  let tilt = clamp(length(vec2f(gx, gy)) * 25.0 * u.dim.x / 960.0, 0.0, 1.0);
  textureStore(dst, id.xy, vec4f(suavizada(uv), tilt, 0.0, 1.0));
}`;
const GRADE = COMMON + /* wgsl */`
@group(0) @binding(4) var suav: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> ring: array<vec4f>;
fn dosTonos(i: u32, base: u32) -> vec3f {
  let w = 0.5 - 0.5 * cos(6.28318530718 * f32(i % 1024u) / 1024.0);
  return mix(ring[base].rgb, ring[base + 1u].rgb, w);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= vec2u(u.dim.xy))) { return; }
  let raw = textureLoad(src, id.xy, 0);
  if (u.dim.z < 3.5) { textureStore(dst, id.xy, raw); return; }
  let uv = (vec2f(id.xy) + 0.5) / u.dim.xy;
  let lsTilt = textureSampleLevel(suav, smp, uv, 0.0).rg;
  let ls = lsTilt.x;
  let ph = 6.28318530718 * u.dim.w / 9.6;
  let fase = fract(u.prm.z * ls + 0.18 * sin(ph) - u.prm.w * lsTilt.y + 0.06 * sin(4.0 * uv.x + ph));
  let pos = fase * 1024.0;
  let i = u32(floor(pos));
  // np.rint del anillo físico: más cercano, empates al par, wrap real.
  let f = fract(pos);
  let j = (i + select(0u, 1u, f > 0.5 || (f == 0.5 && (i & 1u) == 1u))) % 1024u;
  var unit = ring[j].rgb;
  var fill = vec3f(0.008, 0.008, 0.035);
  if (u.dim.z > 5.5) {
    let base = 1024u + 3u * (u32(u.dim.z) - 6u);
    unit = mix(dosTonos(i, base), dosTonos(i + 1u, base), f);
    let soft = 1.0 - 0.12 * pow(sin(3.14159265359 * ls), 2.0);
    unit = vec3f(1.0) + (unit - 1.0) * soft;
    fill = ring[base + 2u].rgb;
  }
  // galería (12 nov): la misma exposición que las paletas clásicas (antes ×1.7 y γ 0.85 quemaban las luces)
  // y el color más sobrio, sobre todo en los cíclicos: la forma se lee por la luz y el color la acompaña
  let l = filmica(dot(raw.rgb, W3));
  let lg = pow(clamp(l * 1.2, 0.0, 1.0), 1.3);
  unit = mix(vec3f(dot(unit, W3)), unit, select(0.85, 0.6, u.dim.z < 5.5));
  textureStore(dst, id.xy, vec4f(unit * lg + fill * pow(1.0 - lg, 3.0), 1.0));
}`;
export default class Galvanizado {
  constructor(ctx) { this.ctx = ctx; }
  async init() {
    const { device: d, W, H, report } = this.ctx;
    const texture = (w, h) => d.createTexture({size:[w,h], format:'rgba16float', usage:GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING});
    this.raw = texture(W,H); this.rawView = this.raw.createView();
    this.w = Math.ceil(W/16); this.h = Math.ceil(H/16);
    this.low = texture(this.w,this.h); this.blur = texture(this.w,this.h);
    this.ub = d.createBuffer({size:32, usage:GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    this.ring = d.createBuffer({size:ANILLO.byteLength, usage:GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    d.queue.writeBuffer(this.ring,0,ANILLO);
    this.smp = d.createSampler({minFilter:'linear',magFilter:'linear'});
    this.pipes = await Promise.all([DOWN,BLUR,GRADE].map((code,i)=>d.createComputePipelineAsync({layout:'auto',compute:{module:makeShader(d,code,'galvanizado-'+i,report),entryPoint:'main'}})));
    const lowView=this.low.createView(), blurView=this.blur.createView();
    this.bgs = [[this.rawView,lowView],[lowView,blurView],[this.rawView,this.ctx.post.hdrView]].map(([src,dst],i)=>d.createBindGroup({layout:this.pipes[i].getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.ub}},{binding:1,resource:src},{binding:2,resource:this.smp},{binding:3,resource:dst},
      ...(i===2?[{binding:4,resource:blurView},{binding:5,resource:{buffer:this.ring}}]:[])]}));
  }
  run(enc, palette, time) {
    const b = palette === 5;
    // ciclico-A (4): N=0.8 y B: N=0.6 en la galería (el video usó N=2.0 y 1.3, que en vivo deshacían la forma); dos tonos: N=1.
    this.ctx.device.queue.writeBuffer(this.ub,0,new Float32Array([this.ctx.W,this.ctx.H,palette,time % 9.6,0,b?14:20,b?0.6:(palette===4?0.8:1),b?0.05:0.03]));
    const p = this.ctx.cpass(enc);
    // Las paletas históricas pasan intactas, sin calcular suavizado.
    for(let i=palette>=4?0:2;i<3;i++) {
      p.setPipeline(this.pipes[i]); p.setBindGroup(0,this.bgs[i]);
      p.dispatchWorkgroups(Math.ceil((i===2?this.ctx.W:this.w)/8),Math.ceil((i===2?this.ctx.H:this.h)/8));
    }
    p.end();
  }
  destroy() { [this.raw,this.low,this.blur,this.ub,this.ring].forEach(x=>x.destroy()); }
}
