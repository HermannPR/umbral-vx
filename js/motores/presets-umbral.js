// Presets propios de UMBRAL para el motor GLSL (código original, MIT, casiangel333 · HermannPR).
// Cada preset es GLSL ES 3.0 con la firma de Shadertoy; ver js/motores/glsl.js para los uniformes.
// iChannel0: fila 0 (y = 0.25) espectro 0..1, fila 1 (y = 0.75) onda (0.5 = silencio). iChannel1: cuadro anterior.

// utilidades que comparten todos (se anteponen a cada preset)
const U = `
#define PI 3.14159265
#define TAU 6.2831853
float fft(float x) { return texture(iChannel0, vec2(clamp(x, 0.0, 1.0) * 0.75, 0.25)).r; }   // 0..0.75 del espectro: lo musical
float onda(float x) { return texture(iChannel0, vec2(fract(x), 0.75)).r * 2.0 - 1.0; }
vec3 tinta(float t) { return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67)) + uHue); }
vec3 tintaB(float t, vec3 a, vec3 b, vec3 c, vec3 d) { return a + b * cos(TAU * (c * t + d) + uHue); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float ruido(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * ruido(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
`;

const P = (id, nombre, etiquetas, glsl, extra = {}) => ({ id: 'umbral/' + id, nombre, autor: 'UMBRAL', licencia: 'MIT', etiquetas, glsl: U + glsl, ...extra });

export const PRESETS_UMBRAL = [
  P('barras', 'Barras espejo', ['espectro', 'clásico'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 uv = fc / iResolution.xy; float n = 64.0;
  float x = abs(uv.x - 0.5) * 2.0; float i = floor(x * n) / n;
  float v = pow(fft(i * 0.9 + 0.01), 1.4) * (0.75 + uKick * 0.5);
  float y = abs(uv.y - 0.5) * 2.0;
  float cel = fract(x * n); float hueco = smoothstep(0.0, 0.08, cel) * smoothstep(1.0, 0.92, cel);
  float barra = step(y, v) * hueco;
  float seg = step(0.25, fract(y * 24.0));
  vec3 c = tinta(i * 0.6 + uBar * 0.2) * barra * mix(1.0, seg, 0.55);
  c += tinta(i * 0.6 + 0.5) * exp(-abs(y - v) * 60.0) * hueco * 0.8;
  c += vec3(0.02, 0.015, 0.03) * (1.0 - y) + uDrop * 0.15 * tinta(0.1);
  o = vec4(c, 1.0);
}`),

  P('anillo-espectral', 'Anillo espectral', ['espectro', 'radial'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  float a = atan(p.y, p.x), r = length(p);
  float s = abs(a) / PI;                                   // simétrico izquierda-derecha
  float v = pow(fft(s * 0.85 + 0.02), 1.3);
  float r0 = 0.22 + uKick * 0.04 + uDrop * 0.05;
  float borde = r0 + v * 0.28;
  float rayo = smoothstep(0.004, 0.0, abs(r - borde)) + smoothstep(borde, r0, r) * step(r0, r) * 0.35;
  vec3 c = tinta(s * 0.8 + iTime * 0.03) * rayo * 1.4;
  c += tinta(0.5) * smoothstep(0.012, 0.0, abs(r - r0)) * (0.6 + uKick);
  c += tinta(0.2) * exp(-r * 6.0) * (0.15 + uBass * 0.5);
  vec2 q = fc / iResolution.xy;
  vec3 eco = texture(iChannel1, (q - 0.5) * (0.985 - uKick * 0.02) + 0.5).rgb;
  o = vec4(max(c, eco * 0.86), 1.0);
}`, { feedback: true }),

  P('cascada', 'Cascada (espectrograma)', ['espectro', 'tiempo'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 uv = fc / iResolution.xy;
  if (fc.y > iResolution.y - 2.0) {                        // la fila de arriba es el espectro de ahora
    float v = pow(fft(uv.x), 1.5);
    o = vec4(tinta(v * 0.7 + 0.1) * v * 1.6, 1.0); return;
  }
  vec2 d = vec2(0.0, 1.0 + uKick * 2.0) / iResolution.xy;  // todo baja un píxel (más en los golpes)
  vec3 c = texture(iChannel1, uv + d).rgb * 0.995;
  o = vec4(c, 1.0);
}`, { feedback: true }),

  P('osciloscopio-circular', 'Osciloscopio circular', ['onda', 'radial'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  float a = atan(p.y, p.x) / TAU + 0.5, r = length(p);
  float w = onda(a) * (0.12 + uEnergy * 0.1);
  float base = 0.27 + uKick * 0.03;
  float d = abs(r - base - w);
  vec3 c = tinta(a + iTime * 0.05) * (0.0025 / (d + 0.0025)) * 0.9;
  float w2 = onda(a + 0.37) * 0.08;
  c += tinta(a + 0.5) * (0.0015 / (abs(r - base * 0.62 - w2) + 0.0015)) * 0.5;
  vec2 q = fc / iResolution.xy;
  vec3 eco = texture(iChannel1, (q - 0.5) * rot(0.004 + uMid * 0.01) * (0.99 + uKick * 0.03) + 0.5).rgb;
  o = vec4(c + eco * (0.88 + uBuild * 0.08), 1.0);
}`, { feedback: true }),

  P('tunel', 'Túnel de anillos', ['túnel', '3d'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  p *= rot(iTime * 0.1 + uDrop * 0.6);
  float r = length(p), a = atan(p.y, p.x);
  float z = 0.35 / max(r, 0.001) + iTime * (0.8 + uEnergy * 1.6) + uKick * 0.4;
  float lados = 6.0 + floor(uSection) * 2.0;
  float poli = cos(PI / lados) / cos(mod(a + PI / lados, TAU / lados) - PI / lados);
  z = 0.35 / max(r * poli, 0.001) + iTime * (0.8 + uEnergy * 1.6);
  float anillo = smoothstep(0.08, 0.0, abs(fract(z) - 0.5) - 0.38);
  float banda = fft(fract(z * 0.05) * 0.8);
  float rayas = smoothstep(0.9, 1.0, sin(a * lados * 2.0 + z * 2.0) * 0.5 + 0.5);
  vec3 c = tinta(floor(z) * 0.07) * anillo * (0.4 + banda * 2.0);
  c += tinta(0.6) * rayas * 0.25 * uHigh;
  c *= smoothstep(0.0, 0.4, r) * 1.2;
  c += tinta(0.0) * exp(-r * 10.0) * (0.3 + uKick);
  o = vec4(c, 1.0);
}`),

  P('caleido', 'Caleidoscopio', ['caleidoscopio', 'fractal'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  float n = 6.0 + 2.0 * floor(uBar * 3.0);
  float a = atan(p.y, p.x), r = length(p);
  a = mod(a, TAU / n); a = abs(a - PI / n);
  p = vec2(cos(a), sin(a)) * r;
  vec3 c = vec3(0.0); float z = 1.6 + uKick * 0.25;
  for (int i = 0; i < 7; i++) {
    p = abs(p * z) - vec2(0.55 + 0.1 * sin(iTime * 0.3), 0.32 + uBass * 0.2);
    p *= rot(iTime * 0.07 + float(i) * 0.4 + uDrop);
    float d = length(p) * exp(-float(i) * 0.4);
    c += tinta(float(i) * 0.11 + iTime * 0.02) * (0.012 / (abs(d - 0.2 - fft(float(i) / 7.0) * 0.3) + 0.012));
  }
  o = vec4(c * 0.35 * (0.8 + uEnergy), 1.0);
}`),

  P('ochentas', 'Rejilla synthwave', ['retro', '3d'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 uv = (fc - 0.5 * iResolution.xy) / iResolution.y;
  vec3 c = vec3(0.0); float hz = -0.02;
  if (uv.y > hz) {                                          // cielo: sol a rayas que late
    vec2 s = uv - vec2(0.0, 0.2);
    float r = length(s), sol = smoothstep(0.26 + uKick * 0.02, 0.25, r);
    float rayas = step(0.0, sin((uv.y * 60.0) - iTime * 2.0) + (uv.y - 0.05) * 9.0);
    c = mix(vec3(0.95, 0.25, 0.55), vec3(1.0, 0.85, 0.3), clamp(s.y * 2.2 + 0.6, 0.0, 1.0)) * sol * rayas;
    c += vec3(0.5, 0.1, 0.6) * exp(-r * 4.0) * (0.35 + uBass * 0.6);
    c += vec3(0.05, 0.02, 0.12) * (1.0 - uv.y);
    float x = uv.x * 1.2;
    float monte = 0.06 + fft(abs(x) * 0.6) * 0.18 * (1.0 - abs(x) * 0.4);
    if (uv.y - hz < monte) c = vec3(0.04, 0.0, 0.08) + vec3(0.6, 0.2, 0.9) * smoothstep(0.004, 0.0, abs(uv.y - hz - monte));
  } else {                                                  // suelo: rejilla que corre hacia ti
    float z = 0.25 / (hz - uv.y + 0.001);
    float x = uv.x * z;
    float lz = abs(fract(z + iTime * (1.5 + uEnergy * 2.0)) - 0.5);
    float lx = abs(fract(x * 2.0) - 0.5);
    float lin = smoothstep(0.06 * z * 0.25, 0.0, min(lz, lx * 0.5));
    c = vec3(0.9, 0.2, 0.9) * lin * (0.6 + uKick) * exp(-z * 0.06);
    c += vec3(0.2, 0.05, 0.3) * exp(-(hz - uv.y) * 12.0);
  }
  c = 0.5 * c + 0.5 * c * vec3(1.0) * (0.5 + 0.5 * cos(uHue));
  o = vec4(c, 1.0);
}`),

  P('fluido', 'Tinta líquida', ['fluido', 'suave'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y * 2.0;
  float t = iTime * 0.12;
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + uBass * 0.8), fbm(p + 3.0 * q + vec2(8.3, 2.8) + t * 1.4));
  float f = fbm(p + 3.5 * r + uKick * 0.3);
  vec3 c = tintaB(f + length(q) * 0.4, vec3(0.5), vec3(0.5), vec3(1.0, 0.9, 0.8), vec3(0.0, 0.1, 0.2));
  c *= 0.25 + f * f * 1.8 * (0.8 + uEnergy * 0.6);
  c += tinta(0.7) * pow(r.x, 6.0) * uHigh * 2.0;
  o = vec4(c, 1.0);
}`),

  P('estrellas', 'Hiperespacio', ['partículas', '3d'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  vec3 c = vec3(0.0);
  float vel = 0.15 + uEnergy * 0.6 + uDrop * 1.2;
  for (int k = 0; k < 4; k++) {
    float capa = fract(iTime * vel * 0.25 + float(k) * 0.25);
    float esc = mix(18.0, 0.6, capa);
    vec2 q = p * esc + float(k) * 13.7;
    vec2 id = floor(q), f = fract(q) - 0.5;
    float h = h21(id);
    vec2 pos = vec2(h, fract(h * 37.1)) - 0.5;
    float d = length(f - pos * 0.7);
    float brillo = smoothstep(0.08, 0.0, d) * smoothstep(0.0, 0.25, capa) * smoothstep(1.0, 0.8, capa);
    c += tinta(h + 0.1 * float(k)) * brillo * (1.0 + fft(h) * 3.0);
  }
  vec2 q = fc / iResolution.xy;
  vec3 eco = texture(iChannel1, (q - 0.5) * (0.97 - uKick * 0.03) + 0.5).rgb;
  o = vec4(c + eco * (0.75 + uBuild * 0.2), 1.0);
}`, { feedback: true }),

  P('metabolas', 'Metabolas', ['orgánico', 'suave'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  float campo = 0.0; vec3 col = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    vec2 c = 0.32 * vec2(sin(iTime * (0.3 + fi * 0.07) + fi * 1.7), cos(iTime * (0.26 + fi * 0.05) + fi * 2.3));
    float r = 0.05 + fft(fi / 9.0) * 0.09 + uKick * 0.015;
    float v = r * r / max(dot(p - c, p - c), 1e-4);
    campo += v; col += tinta(fi / 9.0) * v;
  }
  col /= campo;
  float borde = smoothstep(1.0, 1.08, campo);
  float linea = smoothstep(0.05, 0.0, abs(campo - 1.0)) ;
  vec3 c = col * borde * (0.6 + uEnergy * 0.5) + vec3(1.0) * linea * 0.6;
  c += tinta(0.5) * 0.04 * campo;
  o = vec4(c, 1.0);
}`),

  P('voronoi', 'Celdas que laten', ['geometría', 'orgánico'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = fc / iResolution.y * (5.0 + uBuild * 3.0);
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0; vec2 idm = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y), id = i + g;
    vec2 pt = 0.5 + 0.45 * sin(iTime * 0.6 + TAU * vec2(h21(id), h21(id + 7.0)));
    float d = length(g + pt - f);
    if (d < d1) { d2 = d1; d1 = d; idm = id; } else if (d < d2) d2 = d;
  }
  float h = h21(idm), e = fft(h * 0.8);
  float borde = smoothstep(0.03 + uKick * 0.04, 0.0, d2 - d1);
  vec3 c = tinta(h * 0.5 + iTime * 0.02) * (0.08 + e * e * 2.2) * (1.0 - d1 * 0.8);
  c += tinta(0.6) * borde * (0.4 + uSnare);
  o = vec4(c, 1.0);
}`),

  P('plasma', 'Plasma ácido', ['retro', 'suave'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y * (3.0 + uBass);
  float t = iTime * (0.6 + uEnergy);
  float v = sin(p.x * 2.0 + t) + sin(p.y * 2.3 - t * 1.2) + sin((p.x + p.y) * 1.7 + t * 0.7) + sin(length(p) * 3.0 - t * 1.6 - uKick * 2.0);
  vec3 c = tinta(v * 0.18 + iTime * 0.04);
  c = pow(c, vec3(1.6)) * (0.7 + uKick * 0.6);
  o = vec4(c, 1.0);
}`),

  P('galaxia', 'Galaxia espiral', ['partículas', 'radial'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  p *= rot(iTime * 0.05);
  float r = length(p), a = atan(p.y, p.x);
  float brazos = 3.0;
  float espiral = sin(a * brazos - log(r + 1e-3) * (4.0 + uBass * 3.0) + iTime * 0.8);
  float nucleo = exp(-r * (9.0 - uKick * 4.0));
  float polvo = fbm(vec2(a * 2.0, r * 8.0 - iTime * 0.3));
  vec3 c = tinta(r * 1.5 + 0.2) * smoothstep(0.2, 1.0, espiral) * exp(-r * 2.6) * (0.5 + polvo);
  vec2 q = p * 60.0; float est = smoothstep(0.96, 1.0, h21(floor(q))) * smoothstep(0.4, 0.0, length(fract(q) - 0.5));
  c += est * (0.3 + fft(h21(floor(q))) * 2.0);
  c += vec3(1.0, 0.9, 0.8) * nucleo * (0.8 + uKick * 1.5);
  o = vec4(c, 1.0);
}`),

  P('lineas-paralelas', 'Joy Division', ['onda', 'clásico'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 uv = fc / iResolution.xy;
  vec3 c = vec3(0.0); float n = 40.0;
  float x = (uv.x - 0.5) * 1.8;
  float env = exp(-x * x * 8.0);
  for (int k = 0; k < 40; k++) {
    float fi = float(39 - k);                                   // de atrás (arriba) hacia adelante (abajo)
    float y0 = 0.15 + fi / n * 0.7;
    float h = fbm(vec2(x * 6.0 + fi * 3.1, iTime * 0.4 + fi)) * env * (0.04 + fft(fi / n) * 0.18) * (1.0 + uKick * 0.6);
    float y = y0 + h;
    float d = abs(uv.y - y);
    if (uv.y < y) c *= 0.0;                                   // la de adelante tapa a las de atrás
    c += vec3(0.92, 0.9, 0.85) * smoothstep(2.2 / iResolution.y, 0.0, d);
  }
  c *= mix(vec3(1.0), tinta(0.1), 0.25);
  o = vec4(c, 1.0);
}`),

  P('lissajous', 'Lissajous', ['onda', 'geometría'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  vec3 c = vec3(0.0);
  float a = 3.0 + floor(uBar * 4.0), b = 2.0;
  for (int i = 0; i < 160; i++) {
    float t = float(i) / 160.0 * TAU;
    vec2 q = 0.36 * vec2(sin(a * t + iTime * 0.5), sin(b * t)) * (1.0 + onda(t / TAU) * 0.3 + uKick * 0.08);
    c += tinta(t / TAU) * 0.0009 / (dot(p - q, p - q) + 0.0004);
  }
  vec2 uv = fc / iResolution.xy;
  vec3 eco = texture(iChannel1, (uv - 0.5) * rot(0.01) * 0.995 + 0.5).rgb;
  o = vec4(c * 0.06 + eco * 0.9, 1.0);
}`, { feedback: true }),

  P('esferas', 'Esferas cromadas', ['3d', 'raymarching'], `
float mapa(vec3 p) {
  vec3 q = p; q.xz *= rot(iTime * 0.3); q.xy *= rot(iTime * 0.21);
  float d = length(q) - 0.9 - uKick * 0.15 - fft(0.05) * 0.2;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec3 c = 1.6 * vec3(sin(iTime * 0.7 + fi * 1.05), cos(iTime * 0.5 + fi * 2.1) * 0.6, cos(iTime * 0.7 + fi * 1.05));
    d = min(d, length(p - c) - 0.25 - fft(fi / 6.0) * 0.3);
  }
  return d;
}
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  vec3 ro = vec3(0.0, 0.0, -4.5), rd = normalize(vec3(p, 1.3));
  float t = 0.0, d; int i;
  for (i = 0; i < 80; i++) { d = mapa(ro + rd * t); if (d < 0.001 || t > 12.0) break; t += d * 0.9; }
  vec3 c = tinta(0.6) * 0.05 * (1.0 - length(p));
  if (t < 12.0) {
    vec3 x = ro + rd * t; vec2 e = vec2(0.001, 0.0);
    vec3 n = normalize(vec3(mapa(x + e.xyy) - mapa(x - e.xyy), mapa(x + e.yxy) - mapa(x - e.yxy), mapa(x + e.yyx) - mapa(x - e.yyx)));
    vec3 r = reflect(rd, n);
    float fres = pow(1.0 - max(dot(-rd, n), 0.0), 3.0);
    vec3 cielo = tinta(r.y * 0.5 + 0.5) * (0.5 + 0.5 * r.y) + smoothstep(0.9, 1.0, r.y) * 2.0;
    c = cielo * (0.35 + fres) + tinta(0.1) * max(dot(n, normalize(vec3(1, 2, -1))), 0.0) * 0.3;
    c *= 1.0 + uDrop * 0.8;
  }
  o = vec4(c, 1.0);
}`),

  P('mandala', 'Mandala de pétalos', ['radial', 'geometría'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  float r = length(p), a = atan(p.y, p.x);
  vec3 c = vec3(0.0);
  for (int k = 1; k <= 5; k++) {
    float fk = float(k), n = 4.0 + fk * 2.0;
    float rr = 0.08 * fk + fft(fk / 6.0) * 0.06 + uKick * 0.01 * fk;
    float petalo = rr * (0.75 + 0.25 * cos(a * n + iTime * (fk * 0.2) * (mod(fk, 2.0) * 2.0 - 1.0)));
    c += tinta(fk * 0.13 + iTime * 0.03) * smoothstep(0.006, 0.0, abs(r - petalo)) * (0.8 + uBass);
  }
  c += tinta(0.0) * exp(-r * 18.0) * (0.6 + uKick * 2.0);
  vec2 q = fc / iResolution.xy;
  vec3 eco = texture(iChannel1, (q - 0.5) * 1.006 + 0.5).rgb;
  o = vec4(c + eco * 0.82, 1.0);
}`, { feedback: true }),

  P('relampagos', 'Relámpagos', ['energía', 'drop'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  vec3 c = vec3(0.0);
  for (int k = 0; k < 5; k++) {
    float fk = float(k), sem = floor(iTime * (2.0 + uKick * 6.0)) + fk * 17.0;
    float x = (fbm(vec2(p.y * 3.0 + sem, sem)) - 0.5) * 0.8 + (h21(vec2(sem)) - 0.5) * 1.2;
    float d = abs(p.x - x);
    float energia = fft(fk / 5.0) * (0.6 + uDrop * 1.5 + uSnare);
    c += tinta(0.55 + fk * 0.05) * 0.004 / (d + 0.002) * energia;
  }
  c += tinta(0.6) * 0.06 * uKick;
  o = vec4(c, 1.0);
}`),

  P('terreno', 'Terreno del espectro', ['3d', 'espectro'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 uv = (fc - 0.5 * iResolution.xy) / iResolution.y;
  vec3 c = vec3(0.0);
  for (int k = 0; k < 48; k++) {
    int i = 47 - k;                                             // de la fila lejana a la cercana: la cercana tapa
    float z = 1.0 + float(i) * 0.08;
    float x = uv.x * z;
    float fila = fract(float(i) / 48.0 - iTime * 0.1);
    float h = fft(abs(x) * 0.5 + fila * 0.1) * (1.0 - abs(x) * 0.3) * 0.5 + fbm(vec2(x * 3.0, float(i) + iTime)) * 0.05;
    float y = -0.35 + h / z + 0.25 * (1.0 - 1.0 / z);
    float d = abs(uv.y - y);
    float vis = exp(-float(i) * 0.05);
    c = mix(c, vec3(0.0), step(uv.y, y) * 0.9);
    float px = 1.0 / iResolution.y;
    c += tinta(float(i) * 0.02 + h) * (smoothstep(2.6 * px * z, 0.0, d) * 1.5 + exp(-d / (9.0 * px)) * 0.22) * vis * (0.9 + uKick);
  }
  o = vec4(c, 1.0);
}`),

  P('ondas-agua', 'Gotas en el agua', ['suave', 'orgánico'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  float v = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i), per = 1.6 + fi * 0.37;
    float ciclo = floor((iTime + fi * 0.71) / per);
    vec2 c = (vec2(h21(vec2(ciclo, fi)), h21(vec2(fi, ciclo + 3.0))) - 0.5) * vec2(1.4, 0.8);
    float edad = mod(iTime + fi * 0.71, per);
    float r = length(p - c);
    v += sin((r - edad * 0.35) * 60.0) * exp(-abs(r - edad * 0.35) * 18.0) * exp(-edad * 1.2) * (0.6 + fft(fi / 6.0) * 2.0);
  }
  vec3 c = tinta(0.55 + v * 0.1) * (0.08 + abs(v) * 0.7) + vec3(1.0) * pow(max(v, 0.0), 6.0) * (1.0 + uKick);
  o = vec4(c, 1.0);
}`),

  P('prisma', 'Prisma giratorio', ['3d', 'geometría'], `
float sdCaja(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
float mapa(vec3 p) {
  p.xy *= rot(iTime * 0.4 + uDrop); p.yz *= rot(iTime * 0.3);
  float d = sdCaja(p, vec3(0.8 + uKick * 0.12));
  float hueco = length(p) - 1.05 - fft(0.1) * 0.15;
  return max(d, -hueco);
}
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  vec3 ro = vec3(0.0, 0.0, -3.6), rd = normalize(vec3(p, 1.2));
  float t = 0.0, brillo = 0.0;
  for (int i = 0; i < 90; i++) {
    float d = mapa(ro + rd * t);
    brillo += 0.012 / (abs(d) + 0.02);
    if (d < 0.001 || t > 9.0) break;
    t += max(d * 0.8, 0.01);
  }
  vec3 c = tinta(t * 0.1 + iTime * 0.02) * brillo * 0.08 * (0.6 + uEnergy);
  o = vec4(c, 1.0);
}`),

  P('pulso-cuadrado', 'Cuadros concéntricos', ['geometría', 'retro'], `
void mainImage(out vec4 o, in vec2 fc) {
  vec2 p = (fc - 0.5 * iResolution.xy) / iResolution.y;
  p *= rot(sin(iTime * 0.2) * 0.4 + uBar * TAU * 0.125);
  float d = max(abs(p.x), abs(p.y));
  float z = d * 10.0 - iTime * (1.0 + uEnergy * 2.0) - uKick;
  float i = floor(z);
  float linea = smoothstep(0.1, 0.0, abs(fract(z) - 0.5) - 0.35);
  vec3 c = tinta(i * 0.08) * linea * (0.3 + fft(fract(i * 0.07)) * 2.2);
  c *= smoothstep(0.75, 0.0, d);
  o = vec4(c, 1.0);
}`),
];
