// Motor GL: corre presets GLSL en un WebGL2 fuera de pantalla. Señal copia cada cuadro a WebGPU y le aplica su
// propia composición (espejo, zoom, osciloscopio, color), así que todos los motores comparten efectos, escenas y video.
//
// Dos tipos de preset:
//   · 'shadertoy' (los propios de UMBRAL): mainImage(out vec4, in vec2), iTime, iTimeDelta, iFrame, iResolution,
//     iMouse, iDate; iChannel0 = audio 512×2 (fila 0 espectro, fila 1 onda, como la entrada de música de
//     Shadertoy); iChannel1 = el cuadro anterior (si el preset pide retroalimentación).
//     Extras: uBass, uMid, uHigh, uKick, uSnare, uDrop, uBuild, uBeat, uBar, uSection, uEnergy, uHue, uKey, uBpm.
//   · 'isf' (Vidvox y modV, ver js/motores/isf.js): varias pasadas, búferes persistentes, audio y audioFFT.
// Encima puede ir un filtro ISF (los que tienen inputImage) como capa de efecto.
// Al cambiar de preset, el viejo y el nuevo se funden.

import { convertir, tamPasada, valoresReactivos } from './isf.js';

const CAB = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 iResolution; uniform float iTime; uniform float iTimeDelta; uniform int iFrame; uniform vec4 iMouse; uniform vec4 iDate;
uniform float iFrameRate; uniform float iSampleRate; uniform vec3 iChannelResolution[4];
uniform sampler2D iChannel0; uniform sampler2D iChannel1;
uniform float uBass, uMid, uHigh, uKick, uSnare, uDrop, uBuild, uBeat, uBar, uSection, uEnergy, uHue, uKey, uBpm;
out vec4 umbralSalida;
`;
const PIE = `
void main() { vec4 c = vec4(0.0, 0.0, 0.0, 1.0); mainImage(c, gl_FragCoord.xy); umbralSalida = vec4(c.rgb, 1.0); }
`;
const VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
const MEZCLA = `#version 300 es
precision highp float; uniform sampler2D a; uniform sampler2D b; uniform float m; uniform vec2 r; out vec4 o;
void main() { vec2 u = gl_FragCoord.xy / r; o = vec4(mix(texture(a, u).rgb, texture(b, u).rgb, m), 1.0); }`;

const SECCION = { intro: 0, subida: 1, drop: 2, pausa: 3 };

export class MotorGL {
  constructor({ report } = {}) {
    this.report = report || ((m) => console.warn(m));
    this.canvas = new OffscreenCanvas(16, 16);
    const gl = this.gl = this.canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 no disponible');
    this.flotante = !!gl.getExtension('EXT_color_buffer_float');
    this.cache = new Map();                 // id → programa compilado (o { error })
    const tri = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, tri);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // audio: 512×2 (Shadertoy) y dos tiras 512×1 (ISF: audioFFT y audio)
    this.audioTex = this.textura(512, 2, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.fftTex = this.textura(512, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.ondaTex = this.textura(512, 1, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.audio = new Uint8Array(1024);
    this.mezclaProg = this.programa(MEZCLA, 'mezcla');
    this.ranuras = [this.ranura(), this.ranura()];     // actual y anterior (para el fundido)
    this.m = 1; this.dur = 1.2;
    this.filtro = null;                                 // capa de efecto ISF
    this.mezclaFb = null;
    this.frame = 0; this.w = 16; this.h = 16;
  }
  textura(w, h, interno, fmt, tipo, filtro) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, interno, w, h, 0, fmt, tipo, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filtro || gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filtro || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  // un búfer = dos texturas que se turnan (se lee el cuadro anterior mientras se escribe el nuevo)
  bufer(w, h, flotante) {
    const gl = this.gl, b = { tex: [], fb: [], w, h, lado: 0 };
    const f = flotante && this.flotante;
    for (let k = 0; k < 2; k++) {
      b.tex[k] = f ? this.textura(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT) : this.textura(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      b.fb[k] = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb[k]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.tex[k], 0);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return b;
  }
  borrarBufer(b) { if (!b) return; const gl = this.gl; for (let k = 0; k < 2; k++) { gl.deleteTexture(b.tex[k]); gl.deleteFramebuffer(b.fb[k]); } }
  leer(b) { return b.tex[b.lado ^ 1]; }      // lo último escrito
  ranura() { return { preset: null, prog: null, bufs: {}, salida: null, t: 0, ult: null }; }
  programa(fs, nombre) {
    const gl = this.gl;
    const sh = (k, s) => { const x = gl.createShader(k); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) { const e = gl.getShaderInfoLog(x); gl.deleteShader(x); throw new Error(`${nombre}: ${e}`); } return x; };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${nombre}: ${gl.getProgramInfoLog(p)}`);
    const loc = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); loc[u.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, u.name); }
    return { prog: p, loc };
  }
  // compila (o devuelve de la caché) un preset; si falla, queda marcado y no se vuelve a intentar
  compilar(preset) {
    let c = this.cache.get(preset.id);
    if (!c) {
      try {
        if (preset.tipo === 'isf') { const x = convertir(preset.fuente); c = { ...this.programa(x.fs, preset.id), isf: x }; }
        else c = this.programa(CAB + preset.glsl + PIE, preset.id);
      } catch (e) { c = { error: String(e.message || e) }; this.report(`preset ${preset.id}: ${c.error.slice(0, 300)}`); }
      this.cache.set(preset.id, c);
    }
    return c.error ? null : c;
  }
  error(preset) { const c = this.cache.get(preset.id); return c && c.error; }
  liberar(r) { for (const k in r.bufs) this.borrarBufer(r.bufs[k]); r.bufs = {}; this.borrarBufer(r.salida); r.salida = null; }
  // cambia de preset con fundido (seg = 0 corta en seco)
  usar(preset, seg = 1.2) {
    if (!this.compilar(preset)) return false;
    if (this.ranuras[0].preset && seg > 0) { this.ranuras.reverse(); this.m = 0; this.dur = seg; } else this.m = 1;
    const r = this.ranuras[0];
    this.liberar(r);
    r.preset = preset; r.prog = this.compilar(preset); r.t = preset.t0 || 0; r.ult = null;
    return true;
  }
  // capa de efecto: un ISF con inputImage (null la quita)
  ponerFiltro(preset) {
    if (this.filtro) this.liberar(this.filtro);
    this.filtro = null;
    if (!preset || !this.compilar(preset)) return !preset;
    this.filtro = this.ranura(); this.filtro.preset = preset; this.filtro.prog = this.compilar(preset);
    return true;
  }
  tam(w, h) {
    w = Math.max(16, Math.round(w)); h = Math.max(16, Math.round(h));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h;
  }
  // el audio de este cuadro: espectro (0..255) y onda (128 = silencio), 512 muestras cada uno
  ponerAudio(espectro, onda) {
    const a = this.audio;
    if (espectro) a.set(espectro.subarray(0, 512), 0); else a.fill(0, 0, 512);
    if (onda) { const paso = onda.length / 512; for (let i = 0; i < 512; i++) a[512 + i] = onda[Math.floor(i * paso)]; } else a.fill(128, 512);
  }
  comunes(L, w, h, t, dt) {
    const gl = this.gl;
    if (L.TIME) gl.uniform1f(L.TIME, t);
    if (L.TIMEDELTA) gl.uniform1f(L.TIMEDELTA, dt);
    if (L.RENDERSIZE) gl.uniform2f(L.RENDERSIZE, w, h);
    if (L.FRAMEINDEX) gl.uniform1i(L.FRAMEINDEX, this.frame);
    if (L.DATE) { const d = new Date(); gl.uniform4f(L.DATE, d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()); }
  }
  // un preset Shadertoy: una pasada a su búfer de salida (que también es su iChannel1)
  pintarShadertoy(r, U, dt) {
    const gl = this.gl, c = r.prog;
    if (!r.salida || r.salida.w !== this.w || r.salida.h !== this.h) { this.borrarBufer(r.salida); r.salida = this.bufer(this.w, this.h, false); }
    const b = r.salida, k = b.lado;
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb[k]); gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(c.prog);
    const L = c.loc;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b.tex[k ^ 1]);
    if (L.iChannel0) gl.uniform1i(L.iChannel0, 0);
    if (L.iChannel1) gl.uniform1i(L.iChannel1, 1);
    if (L.iResolution) gl.uniform3f(L.iResolution, this.w, this.h, 1);
    if (L.iChannelResolution) gl.uniform3fv(L.iChannelResolution, [512, 2, 1, this.w, this.h, 1, 0, 0, 0, 0, 0, 0]);
    if (L.iTime) gl.uniform1f(L.iTime, r.t);
    if (L.iTimeDelta) gl.uniform1f(L.iTimeDelta, dt);
    if (L.iFrameRate) gl.uniform1f(L.iFrameRate, dt > 0 ? 1 / dt : 60);
    if (L.iSampleRate) gl.uniform1f(L.iSampleRate, 44100);
    if (L.iFrame) gl.uniform1i(L.iFrame, this.frame);
    if (L.iMouse) gl.uniform4f(L.iMouse, 0, 0, 0, 0);
    if (L.iDate) { const d = new Date(); gl.uniform4f(L.iDate, d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()); }
    for (const [n, v] of U) if (L[n]) gl.uniform1f(L[n], v);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    b.lado ^= 1;
    r.ult = b.tex[k];
  }
  // un preset ISF: sus pasadas en orden; la última sin TARGET va a la salida
  pintarISF(r, A, dt, entrada) {
    const gl = this.gl, c = r.prog, X = c.isf, L = c.loc, W = this.w, H = this.h;
    const vals = valoresReactivos(X.entradas, A, r.t, r.preset.reaccion ?? (X.entradas.some((e) => e.TYPE === 'audioFFT' || e.TYPE === 'audio') ? 0.4 : 1));
    gl.useProgram(c.prog);
    gl.bindVertexArray(this.vao);
    this.comunes(L, W, H, r.t, dt);
    // entradas fijas de este cuadro
    let unidad = 0;
    const ligar = (nombre, tex, w, h) => {
      gl.activeTexture(gl.TEXTURE0 + unidad); gl.bindTexture(gl.TEXTURE_2D, tex);
      if (L[nombre]) gl.uniform1i(L[nombre], unidad);
      if (L[`_${nombre}_imgSize`]) gl.uniform2f(L[`_${nombre}_imgSize`], w, h);
      if (L[`_${nombre}_imgRect`]) gl.uniform4f(L[`_${nombre}_imgRect`], 0, 0, w, h);
      unidad++;
    };
    for (const e of X.entradas) {
      const n = e.glsl, l = L[n];
      if (e.TYPE === 'image') { if (entrada) ligar(n, entrada, W, H); continue; }
      if (e.TYPE === 'audioFFT') { ligar(n, this.fftTex, 512, 1); continue; }
      if (e.TYPE === 'audio') { ligar(n, this.ondaTex, 512, 1); continue; }
      if (!l) continue;
      const v = vals[n];
      if (e.TYPE === 'float') gl.uniform1f(l, v);
      else if (e.TYPE === 'bool' || e.TYPE === 'event') gl.uniform1i(l, v ? 1 : 0);
      else if (e.TYPE === 'long') gl.uniform1i(l, v | 0);
      else if (e.TYPE === 'color') gl.uniform4fv(l, v);
      else if (e.TYPE === 'point2D') gl.uniform2fv(l, v);
    }
    const base = unidad;
    // tamaños y búferes de cada pasada
    const tams = X.pasadas.map((p) => [tamPasada(p.WIDTH, W, H, vals) || W, tamPasada(p.HEIGHT, W, H, vals) || H]);
    X.pasadas.forEach((p, i) => {
      if (!p.destino) return;
      const [w, h] = tams[i], b = r.bufs[p.destino];
      if (!b || b.w !== w || b.h !== h) { this.borrarBufer(b); r.bufs[p.destino] = this.bufer(w, h, true); }
    });
    if (!r.salida || r.salida.w !== W || r.salida.h !== H) { this.borrarBufer(r.salida); r.salida = this.bufer(W, H, false); }
    X.pasadas.forEach((p, i) => {
      const destino = p.destino ? r.bufs[p.destino] : r.salida;
      // los búferes con nombre se leen en su último estado (el de este cuadro si ya se pintó)
      unidad = base;
      for (const n in r.bufs) ligar(n, this.leer(r.bufs[n]), r.bufs[n].w, r.bufs[n].h);
      const [w, h] = p.destino ? tams[i] : [W, H];
      gl.bindFramebuffer(gl.FRAMEBUFFER, destino.fb[destino.lado]); gl.viewport(0, 0, w, h);
      if (L.PASSINDEX) gl.uniform1i(L.PASSINDEX, i);
      if (L.RENDERSIZE) gl.uniform2f(L.RENDERSIZE, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      destino.lado ^= 1;
    });
    // si la última pasada tenía TARGET, la salida es ese búfer
    const ultima = X.pasadas[X.pasadas.length - 1];
    r.ult = ultima.destino ? this.leer(r.bufs[ultima.destino]) : this.leer(r.salida);
  }
  pintar(r, U, A, dt, entrada) {
    if (!r.prog) return;
    if (r.prog.isf) this.pintarISF(r, A, dt, entrada); else this.pintarShadertoy(r, U, dt);
  }
  // dibuja el cuadro y deja el resultado en el canvas (listo para copyExternalImageToTexture)
  // A: { bass, mid, high, kick, golpe, snare, drop, build, beat, bar, seccion, energy, hue, key, bpm, velocidad }
  subirAudio() {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, this.audioTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.RED, gl.UNSIGNED_BYTE, this.audio);
    gl.bindTexture(gl.TEXTURE_2D, this.fftTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 1, gl.RED, gl.UNSIGNED_BYTE, this.audio.subarray(0, 512));
    gl.bindTexture(gl.TEXTURE_2D, this.ondaTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 1, gl.RED, gl.UNSIGNED_BYTE, this.audio.subarray(512));
  }
  // copia una textura al canvas (la salida que Señal copia a WebGPU)
  alCanvas(tex) {
    const gl = this.gl, M = this.mezclaProg;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(M.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(M.loc.a, 0); gl.uniform1i(M.loc.b, 1); gl.uniform1f(M.loc.m, 1); gl.uniform2f(M.loc.r, this.w, this.h);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // la capa de efecto sobre otra fuente (el canvas de MilkDrop): la sube como inputImage y deja el resultado en el canvas
  filtrarFuente(fuente, A, dt) {
    const gl = this.gl, F = this.filtro;
    if (!F) return false;
    this.tam(fuente.width, fuente.height);
    this.subirAudio();
    if (!this.entradaTex) this.entradaTex = this.textura(16, 16, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    gl.bindTexture(gl.TEXTURE_2D, this.entradaTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, fuente);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    F.t += dt * (A.velocidad ?? 1);
    this.pintarISF(F, A, dt, this.entradaTex);
    this.alCanvas(F.ult);
    this.frame++;
    return true;
  }
  dibujar(A, dt) {
    const gl = this.gl;
    this.subirAudio();
    const U = [['uBass', A.bass], ['uMid', A.mid], ['uHigh', A.high], ['uKick', A.kick], ['uSnare', A.snare], ['uDrop', A.drop], ['uBuild', A.build],
      ['uBeat', A.beat], ['uBar', A.bar], ['uSection', SECCION[A.seccion] ?? 0], ['uEnergy', A.energy], ['uHue', A.hue], ['uKey', A.key ?? -1], ['uBpm', A.bpm || 120]];
    const [r0, r1] = this.ranuras;
    const vel = A.velocidad ?? 1;
    if (this.m < 1) this.m = Math.min(1, this.m + dt / this.dur);
    r0.t += dt * vel; this.pintar(r0, U, A, dt);
    const funde = this.m < 1 && r1.prog;
    if (funde) { r1.t += dt * vel; this.pintar(r1, U, A, dt); }
    // mezcla: al canvas, o a un búfer intermedio si hay filtro encima
    const F = this.filtro;
    let fbMezcla = null;
    if (F) {
      if (!this.mezclaFb || this.mezclaFb.w !== this.w || this.mezclaFb.h !== this.h) { this.borrarBufer(this.mezclaFb); this.mezclaFb = this.bufer(this.w, this.h, false); }
      fbMezcla = this.mezclaFb.fb[0];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbMezcla); gl.viewport(0, 0, this.w, this.h);
    const M = this.mezclaProg;
    gl.useProgram(M.prog);
    const s = this.m * this.m * (3 - 2 * this.m);
    const a = funde && r1.ult ? r1.ult : r0.ult;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, a);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, r0.ult);
    gl.uniform1i(M.loc.a, 0); gl.uniform1i(M.loc.b, 1); gl.uniform1f(M.loc.m, funde && r1.ult ? s : 1); gl.uniform2f(M.loc.r, this.w, this.h);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (F) {
      F.t += dt * vel;
      this.pintarISF(F, A, dt, this.mezclaFb.tex[0]);
      this.alCanvas(F.ult);
    }
    this.frame++;
  }
  destroy() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
    this.cache.clear();
  }
}
