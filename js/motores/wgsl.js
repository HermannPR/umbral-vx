// Motor WGSL: corre efectos de fosfora (github.com/kevinraymond/fosfora, MIT o Apache-2.0) nativos en WebGPU.
// Cada efecto es un .pfx (JSON: entradas, «rates», retroalimentación) y un fragment shader `fs_main` que espera
// la cabecera de fosfora (struct PhosphorUniforms, prev_frame, texturas de audio, param(), feedback()…) y sus
// librerías (ruido, paletas, sdf…). Aquí se arma igual que en fosfora y se llena PhosphorUniforms con el Oído.

// desplazamientos (en floats) dentro de PhosphorUniforms (448 bytes), calculados de su struct
const O = { time: 0, delta_time: 1, resolution: 2, sub_bass: 4, rms: 11, kick: 12, centroid: 13, flux: 14, flatness: 15, rolloff: 16, bandwidth: 17,
  zcr: 18, onset: 19, beat: 20, beat_phase: 21, bpm: 22, beat_strength: 23, params: 24, feedback_decay: 40, frame_index: 41, dominant_chroma: 42,
  scroll_phase: 43, loudness_m: 72, loudness_s: 73, key_class: 75, key_is_minor: 76, key_confidence: 77, downbeat: 78, bar_phase: 79, beat_in_bar: 80,
  stereo_width: 82, section_novelty: 84, buildup: 85, drop: 86, percussive_energy: 87, harmonic_energy: 88, band_pan: 100, bar_index: 108,
  beat_index: 109, tempo_confidence: 110, beat_locked: 111 };
const TAM_U = 448;
const LIBS = ['noise', 'palette', 'sdf', 'tonemap', 'chronoflow', 'overlay_lib'];
const VS = `
struct UmbralVO { @builtin(position) pos: vec4f };
@vertex fn umbral_vs(@builtin(vertex_index) i: u32) -> UmbralVO {
  var q = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: UmbralVO; o.pos = vec4f(q[i], 0.0, 1.0); return o;
}`;

function mitad(f) {   // float32 → float16 (para la textura de onda rgba16float)
  const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, f); const x = b.getUint32(0);
  const s = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) return s; if (e >= 31) return s | 0x7c00;
  return s | (e << 10) | (m >>> 13);
}

export class MotorWGSL {
  constructor(device, { report, base } = {}) {
    this.d = device; this.report = report || ((m) => console.warn(m)); this.base = base;
    this.cache = new Map(); this.w = 16; this.h = 16; this.W = 16; this.H = 16;
    this.u = device.createBuffer({ size: TAM_U, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.f = new Float32Array(TAM_U / 4);
    this.smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const tx = (w, h, format) => device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.ondaTex = tx(1024, 1, 'rgba16float'); this.ondaDatos = new Uint16Array(1024 * 4);
    this.espTex = tx(512, 1, 'r8unorm'); this.grama = tx(1, 1, 'r8unorm');
    device.queue.writeTexture({ texture: this.grama }, new Uint8Array([0]), { bytesPerRow: 256 }, [1, 1]);
    this.juegos = [null, null]; this.j = 0;      // dos juegos de texturas: el preset de antes se queda congelado para el fundido
    this.actual = null; this.frame = 0; this.scroll = 0; this.integrales = new Float32Array(16);
  }
  // las 7 ligaduras de fosfora, siempre (un layout explícito no depende de cuáles use cada efecto)
  layout() {
    if (this._layout) return this._layout;
    const F = GPUShaderStage.FRAGMENT, tx = (b) => ({ binding: b, visibility: F, texture: { sampleType: 'float' } }), sm = (b) => ({ binding: b, visibility: F, sampler: { type: 'filtering' } });
    this.bgl = this.d.createBindGroupLayout({ entries: [{ binding: 0, visibility: F, buffer: { type: 'uniform' } }, tx(1), sm(2), tx(3), tx(4), tx(5), sm(6)] });
    return (this._layout = this.d.createPipelineLayout({ bindGroupLayouts: [this.bgl] }));
  }
  async cabecera() {
    if (this.cab) return this.cab;
    const txt = (n) => fetch(`${this.base}/${n}`).then((r) => { if (!r.ok) throw new Error(`${n}: ${r.status}`); return r.text(); });
    const [bloque, ...libs] = await Promise.all(['uniformes.wgsl', ...LIBS.map((l) => `lib/${l}.wgsl`)].map(txt));
    // feedback(): el cuadro anterior ocupa solo la parte dibujada de la textura (resolución adaptativa)
    const fb = bloque.replace(/return textureSample\(prev_frame, prev_sampler, uv\);/, 'return textureSample(prev_frame, prev_sampler, uv * (u.resolution / vec2f(textureDimensions(prev_frame))));');
    this.cab = fb + '\n' + libs.join('\n') + VS;
    return this.cab;
  }
  async compilar(preset) {
    let c = this.cache.get(preset.id);
    if (c) return c.error ? null : c;
    try {
      const cab = await this.cabecera();
      const fuente = preset.wgsl || await fetch(`${this.base}/${preset.archivo}`).then((r) => r.text());
      const d = this.d;
      d.pushErrorScope('validation');
      const m = d.createShaderModule({ code: cab + '\n' + fuente, label: preset.id });
      const info = await m.getCompilationInfo();
      const errs = info.messages.filter((x) => x.type === 'error');
      if (errs.length) throw new Error(errs.slice(0, 3).map((x) => `${x.lineNum}: ${x.message}`).join(' · '));
      const p = await d.createRenderPipelineAsync({ layout: this.layout(), vertex: { module: m, entryPoint: 'umbral_vs' }, fragment: { module: m, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] } });
      const e = await d.popErrorScope();
      if (e) throw new Error(e.message);
      c = { p, pfx: preset.pfx || {} };
    } catch (e) {
      c = { error: String(e.message || e) }; this.report(`preset ${preset.id}: ${c.error.slice(0, 300)}`);
    }
    this.cache.set(preset.id, c);
    return c.error ? null : c;
  }
  juego() {
    const J = this.juegos[this.j];
    if (J && J.W === this.W && J.H === this.H) return J;
    if (J) J.tex.forEach((t) => t.destroy());
    const tex = [0, 1].map(() => this.d.createTexture({ size: [this.W, this.H], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }));
    return (this.juegos[this.j] = { tex, vistas: tex.map((t) => t.createView()), W: this.W, H: this.H, lado: 0, bg: [null, null], p: J ? J.p : null, borrar: true });
  }
  // cambia de efecto; el anterior queda congelado en su juego de texturas (Señal lo funde)
  async usar(preset) {
    const c = await this.compilar(preset);
    if (!c) return false;
    this.j ^= 1;
    const J = this.juego(); J.borrar = true; J.bg = [null, null]; J.p = c.p;
    this.actual = { preset, c };
    // parámetros: valores por defecto empacados como en fosfora (Float 1, Bool 1, Point2D 2, Color 4)
    const ent = c.pfx.inputs || [], par = new Float32Array(16), rates = [];
    let off = 0;
    const desp = {};
    for (const e of ent) {
      const d = e.default, n = e.type === 'Point2D' ? 2 : e.type === 'Color' ? 4 : 1;
      if (off + n > 16) break;
      desp[e.name] = off;
      if (Array.isArray(d)) par.set(d.slice(0, n), off); else par[off] = e.type === 'Bool' ? (d ? 1 : 0) : +d || 0;
      off += n;
    }
    for (const r of c.pfx.rates || []) { const nom = typeof r === 'string' ? r : r.param; if (desp[nom] != null && off < 16) rates.push([desp[nom], off++]); }
    this.actual.par = par; this.actual.rates = rates; this.actual.flo = ent.filter((e) => e.type === 'Float' && desp[e.name] != null).map((e) => ({ ...e, o: desp[e.name] }));
    this.integrales.fill(0); this.t = 0;
    return true;
  }
  tam(W, H, w, h) { this.W = W; this.H = H; this.w = Math.max(16, Math.round(w)); this.h = Math.max(16, Math.round(h)); }
  // la textura donde quedó el último cuadro (para la composición de Señal) y la fracción dibujada
  get vista() { const J = this.juegos[this.j]; return J ? J.vistas[J.lado ^ 1] : null; }
  dibujar(enc, E, dt, onda, fuerza = 1) {
    const A = this.actual; if (!A) return;
    const d = this.d, f = this.f, J = this.juego();
    this.t = (this.t || 0) + dt * (E.velocidad ?? 1);
    f.fill(0);
    f[O.time] = this.t; f[O.delta_time] = dt; f[O.resolution] = this.w; f[O.resolution + 1] = this.h;
    for (let k = 0; k < 7; k++) f[O.sub_bass + k] = Math.min(1.5, E.b7[k] * fuerza);
    f[O.rms] = E.rms; f[O.kick] = E.kick; f[O.centroid] = E.centroide; f[O.flux] = E.flujo; f[O.flatness] = E.planitud; f[O.rolloff] = E.rolloff;
    f[O.bandwidth] = E.ancho; f[O.zcr] = E.zcr; f[O.onset] = E.onset; f[O.beat] = E.golpe ? 1 : 0; f[O.beat_phase] = E.beat; f[O.bpm] = E.bpm;
    f[O.beat_strength] = E.kick;
    // parámetros: los Float se mecen un poco con la música; los «rates» se integran
    const par = A.par.slice();
    A.flo.forEach((e, k) => { const lo = e.min ?? 0, hi = e.max ?? 1, b = [E.bass, E.mid, E.high][k % 3]; par[e.o] = Math.min(hi, Math.max(lo, par[e.o] + (b - 0.3) * 0.15 * (hi - lo) * fuerza)); });
    for (const [src, dst] of A.rates) { this.integrales[dst] += par[src] * dt; par[dst] = this.integrales[dst]; }
    f.set(par, O.params);
    f[O.feedback_decay] = A.c.pfx.feedback_decay ?? 0.9; f[O.frame_index] = this.frame++;
    f[O.dominant_chroma] = E.key >= 0 ? E.key / 12 : 0; this.scroll += dt * (0.2 + E.energy); f[O.scroll_phase] = this.scroll % 1;
    f[O.loudness_m] = E.rms; f[O.loudness_s] = E.energy; f[O.key_class] = E.key >= 0 ? E.key : 0; f[O.key_confidence] = E.key >= 0 ? 1 : 0;
    f[O.downbeat] = E.golpe && E.enBar === 0 ? 1 : 0; f[O.bar_phase] = E.bar; f[O.beat_in_bar] = E.enBar; f[O.stereo_width] = 0.5;
    f[O.section_novelty] = E.golpe && E.enBar === 0 ? 0.3 : 0; f[O.buildup] = E.build; f[O.drop] = E.drop;
    f[O.percussive_energy] = E.kick; f[O.harmonic_energy] = E.mid;
    for (let k = 0; k < 8; k++) f[O.band_pan + k] = 0.5;
    f[O.bar_index] = E.compas; f[O.beat_index] = E.beatIdx; f[O.tempo_confidence] = E.real ? 1 : 0; f[O.beat_locked] = E.real ? 1 : 0;
    d.queue.writeBuffer(this.u, 0, f);
    // audio: onda (min/max por celda) y espectro
    const W = this.ondaDatos;
    for (let i = 0; i < 1024; i++) { const v = (onda[i] - 128) / 128, h = mitad(v); W[i * 4] = h; W[i * 4 + 1] = h; W[i * 4 + 2] = 0; W[i * 4 + 3] = 0x3c00; }
    d.queue.writeTexture({ texture: this.ondaTex }, W, { bytesPerRow: 1024 * 8 }, [1024, 1]);
    d.queue.writeTexture({ texture: this.espTex }, E.espectro, { bytesPerRow: 512 }, [512, 1]);
    const k = J.lado;
    if (!J.bg[k]) J.bg[k] = d.createBindGroup({ layout: this.bgl, entries: this.entradas(J.vistas[k ^ 1]) });
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: J.vistas[k], loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }] });
    rp.setViewport(0, 0, this.w, this.h, 0, 1); rp.setScissorRect(0, 0, this.w, this.h);
    rp.setPipeline(J.p); rp.setBindGroup(0, J.bg[k]); rp.draw(3); rp.end();
    J.lado ^= 1;
  }
  entradas(prev) {
    return [{ binding: 0, resource: { buffer: this.u } }, { binding: 1, resource: prev }, { binding: 2, resource: this.smp },
      { binding: 3, resource: this.ondaTex.createView() }, { binding: 4, resource: this.espTex.createView() }, { binding: 5, resource: this.grama.createView() }, { binding: 6, resource: this.smp }];
  }
  destroy() { this.juegos.forEach((J) => J && J.tex.forEach((t) => t.destroy())); this.u.destroy(); this.ondaTex.destroy(); this.espTex.destroy(); this.grama.destroy(); }
}
