// Núcleo WebGL2 para el modo de respaldo: programas, texturas flotantes, FBOs y tonemapping.
export const VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

export function program(gl, vs, fs, report, label) {
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) report(`GLSL ${label}: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) report(`GL link ${label}: ${gl.getProgramInfoLog(p)}`);
  const locs = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); const name = u.name.replace(/\[0\]$/, ''); locs[name] = gl.getUniformLocation(p, u.name); }
  return { p, u: locs };
}

export function target(gl, w, h, { fmt = 'RGBA16F', filter = true, mrt = 1 } = {}) {
  const ifmt = gl[fmt], type = fmt.endsWith('32F') ? gl.FLOAT : gl.HALF_FLOAT;
  const texs = [];
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  for (let i = 0; i < mrt; i++) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    const f = filter ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
    texs.push(t);
  }
  gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex: texs[0], texs, w, h };
}
export function upload(gl, tgt, i, data) {
  gl.bindTexture(gl.TEXTURE_2D, tgt.texs[i]);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tgt.w, tgt.h, gl.RGBA, gl.FLOAT, data);
}
export function freeTarget(gl, t) { if (!t) return; t.texs.forEach((x) => gl.deleteTexture(x)); gl.deleteFramebuffer(t.fb); }

// ejecuta un programa a pantalla completa sobre un destino; texs = { nombre: textura }
export function pass(gl, prog, dst, uniforms = {}, texs = {}, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null);
  gl.viewport(0, 0, w ?? dst.w, h ?? dst.h);
  gl.useProgram(prog.p);
  let unit = 0;
  for (const [k, t] of Object.entries(texs)) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(prog.u[k], unit++); }
  setU(gl, prog, uniforms);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
export function setU(gl, prog, uniforms) {
  for (const [k, v] of Object.entries(uniforms)) {
    const l = prog.u[k]; if (l == null) continue;
    if (typeof v === 'number') gl.uniform1f(l, v);
    else if (v.int !== undefined) gl.uniform1i(l, v.int);
    else if (v.length === 2) gl.uniform2fv(l, v); else if (v.length === 3) gl.uniform3fv(l, v);
    else if (v.length === 4) gl.uniform4fv(l, v); else gl.uniform4fv(l, v);
  }
}

export const TONEMAP = `#version 300 es
precision highp float;
uniform sampler2D src; uniform float exposure; uniform vec2 res;
out vec4 o;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec3 c = texture(src, uv).rgb;
  vec3 b = vec3(0.0);
  for (int i = 0; i < 8; i++) { float a = float(i) * 0.785; b += textureLod(src, uv + vec2(cos(a), sin(a)) * 0.006, 0.0).rgb; }
  c += b / 8.0 * 0.25;
  vec2 q = uv - 0.5; c *= exposure * (1.0 - dot(q, q) * 0.8);
  o = vec4(pow(aces(c), vec3(1.0 / 2.2)), 1.0);
}`;
