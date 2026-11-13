// ISF (Interactive Shader Format, de Vidvox): lee la cabecera JSON de un .fs y lo convierte a un programa
// GLSL ES 3.0 que corre el motor GL (js/motores/glsl.js). Los archivos se sirven tal cual, con su crédito;
// la conversión ocurre aquí, al cargarlos.
//
// Soporta: INPUTS float, bool, long, color, point2D, event, image, audio, audioFFT; PASSES con TARGET,
// PERSISTENT, FLOAT, WIDTH y HEIGHT (expresiones con $WIDTH, $HEIGHT y las entradas); TIME, TIMEDELTA,
// RENDERSIZE, PASSINDEX, FRAMEINDEX, DATE, isf_FragNormCoord y las macros IMG_*.
// No soporta: shaders de vértices propios (.vs) ni IMPORTED (imágenes externas). El catálogo ya los excluye.

// palabras reservadas de GLSL ES 3.0 que los shaders de escritorio usan a veces como nombres
const RESERVADAS = ['input', 'output', 'sample', 'filter', 'active', 'common', 'partition', 'half', 'fixed', 'union', 'cast', 'goto', 'inline',
  'interface', 'long', 'short', 'double', 'public', 'static', 'extern', 'external', 'packed', 'resource', 'template', 'this', 'using',
  'namespace', 'sizeof', 'typedef', 'enum', 'noinline', 'volatile', 'superp', 'unsigned'];
const NATIVAS_1 = ['sign', 'round', 'trunc', 'fract', 'floor', 'ceil', 'abs', 'exp', 'log', 'sqrt', 'exp2', 'log2', 'radians', 'degrees'];
const RE_RES = new RegExp(`\\b(${RESERVADAS.join('|')})\\b`, 'g');
const seguro = (n) => (RESERVADAS.includes(n) ? 'isf_' + n : n.replace(/[^A-Za-z0-9_]/g, '_'));

export function leerCabecera(txt) {
  const m = txt.match(/^\s*\/\*\s*(\{[\s\S]*?\})\s*\*\//);
  if (!m) throw new Error('sin cabecera ISF');
  let cab;
  try { cab = JSON.parse(m[1]); } catch { cab = JSON.parse(m[1].replace(/,\s*([\]}])/g, '$1')); }
  return { cab, cuerpo: txt.slice(m.index + m[0].length) };
}

const TIPO_GLSL = { float: 'float', bool: 'bool', long: 'int', color: 'vec4', point2D: 'vec2', event: 'bool' };
const IMAGEN = new Set(['image', 'audio', 'audioFFT']);

// convierte un .fs: devuelve { fs, entradas, pasadas, filtro } listo para compilar
export function convertir(txt) {
  const { cab, cuerpo } = leerCabecera(txt);
  const entradas = (cab.INPUTS || []).map((e) => ({ ...e, glsl: seguro(e.NAME) }));
  const pasadas = (cab.PASSES && cab.PASSES.length ? cab.PASSES : [{}]).map((p) => ({ ...p, destino: p.TARGET ? seguro(p.TARGET) : null }));
  const lin = [];
  lin.push('uniform float TIME; uniform float TIMEDELTA; uniform vec2 RENDERSIZE; uniform int PASSINDEX; uniform int FRAMEINDEX; uniform vec4 DATE;');
  for (const e of entradas) {
    if (IMAGEN.has(e.TYPE)) lin.push(`uniform sampler2D ${e.glsl}; uniform vec2 _${e.glsl}_imgSize; uniform vec4 _${e.glsl}_imgRect; uniform bool _${e.glsl}_flip;`);
    else if (TIPO_GLSL[e.TYPE]) lin.push(`uniform ${TIPO_GLSL[e.TYPE]} ${e.glsl};`);
  }
  const vistos = new Set();
  for (const p of pasadas) if (p.destino && !vistos.has(p.destino)) { vistos.add(p.destino); lin.push(`uniform sampler2D ${p.destino}; uniform vec2 _${p.destino}_imgSize;`); }
  let c = cuerpo
    .replace(/^\s*#version[^\n]*$/gm, '')
    .replace(/^\s*varying\s+[^;]+;/gm, '')
    .replace(/\bvoid\s+main\s*\(\s*(void)?\s*\)/, 'void isf_main()');
  // nombres reservados en ES 3.0 (sin tocar los que ya traen prefijo)
  c = c.replace(RE_RES, (w) => 'isf_' + w);
  // funciones propias con nombre de una nativa de un argumento (p. ej. sign(p1, p2, p3) o round(float)):
  // GLSL de escritorio lo acepta como sobrecarga y ES 3.0 no. Se renombran y las firmas nativas se reenvían.
  const reenvios = [];
  for (const n of NATIVAS_1) {
    const defs = [...c.matchAll(new RegExp(`\\b(?:float|vec[234]|int|bool)\\s+${n}\\s*\\(([^)]*)\\)\\s*\\{`, 'g'))];
    if (!defs.length) continue;
    const propios = new Set(defs.map((m) => m[1].trim().split(/\s+/)[0]).filter((t, i) => !defs[i][1].includes(',')));
    c = c.replace(new RegExp(`\\b${n}\\s*\\(`, 'g'), `isf_${n}(`);
    for (const t of ['float', 'vec2', 'vec3', 'vec4']) if (!propios.has(t)) reenvios.push(`${t} isf_${n}(${t} x) { return ${n}(x); }`);
  }
  if (reenvios.length) c = reenvios.join('\n') + '\n' + c;
  const fs = `#version 300 es
precision highp float;
precision highp int;
out vec4 isf_FragColor;
#define gl_FragColor isf_FragColor
#define texture2D texture
#define texture2DRect texture
#define texture2DProj textureProj
#define IMG_SIZE(img) vec2(textureSize(img, 0))
#define IMG_NORM_PIXEL(img, c) texture(img, c)
#define IMG_PIXEL(img, c) texture(img, (c) / vec2(textureSize(img, 0)))
#define IMG_THIS_PIXEL(img) texture(img, isf_FragNormCoord)
#define IMG_THIS_NORM_PIXEL(img) texture(img, isf_FragNormCoord)
#define IMG_NORM_PIXEL_2D(img, s, c) texture(img, c)
#define IMG_PIXEL_2D(img, s, c) texture(img, (c) / vec2(textureSize(img, 0)))
#define IMG_THIS_PIXEL_2D(img, s) texture(img, isf_FragNormCoord)
#define IMG_THIS_NORM_PIXEL_2D(img, s) texture(img, isf_FragNormCoord)
#define vv_FragNormCoord isf_FragNormCoord
${lin.join('\n')}
vec2 isf_FragNormCoord;
${c}
void main() { isf_FragNormCoord = gl_FragCoord.xy / RENDERSIZE; isf_FragColor = vec4(0.0, 0.0, 0.0, 1.0); isf_main(); }
`;
  const filtro = entradas.some((e) => e.TYPE === 'image' && e.NAME === 'inputImage');
  return { fs, entradas, pasadas, filtro, cab };
}

// tamaño de una pasada: "floor($WIDTH/4.0)" y similares; solo números, $variables y funciones de Math
const FUNCS = /\b(floor|ceil|round|max|min|pow|abs|sqrt)\b/g;
export function tamPasada(expr, W, H, vals) {
  if (expr == null || expr === '') return null;
  if (typeof expr === 'number') return Math.max(1, Math.round(expr));
  let s = String(expr).replace(/\$WIDTH/g, String(W)).replace(/\$HEIGHT/g, String(H))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => String(+vals[n] || 0));
  if (!/^[\d\s.+\-*/(),a-z]*$/.test(s) || s.replace(FUNCS, '').match(/[a-z]/)) return null;
  try { const v = Function(`"use strict"; const {floor,ceil,round,max,min,pow,abs,sqrt} = Math; return (${s});`)(); return Number.isFinite(v) ? Math.max(1, Math.round(v)) : null; }
  catch { return null; }
}

// reacción a la música para shaders que no la traen: las entradas float se mueven con graves / medios / agudos,
// los puntos dan vueltas, los eventos de nombre «disparador» saltan con el bombo
const DISPARA = /flash|trig|burst|blast|random|new|shuffle|bang|pulse|jump|go\b/i;
export function valoresReactivos(entradas, A, t, fuerza = 1) {
  const v = {}, bandas = [A.bass, A.mid, A.high];
  let k = 0;
  for (const e of entradas) {
    const n = e.glsl;
    if (e.TYPE === 'float') {
      const lo = e.MIN ?? 0, hi = e.MAX ?? 1, d = e.DEFAULT ?? (lo + hi) / 2;
      const b = bandas[k++ % 3] || 0;
      v[n] = Math.min(hi, Math.max(lo, d + (b - 0.3) * 0.35 * (hi - lo) * fuerza + A.kick * 0.08 * (hi - lo) * fuerza));
    } else if (e.TYPE === 'bool') v[n] = !!e.DEFAULT;
    else if (e.TYPE === 'long') v[n] = e.DEFAULT ?? (e.VALUES ? e.VALUES[0] : 0);
    else if (e.TYPE === 'color') v[n] = e.DEFAULT || [1, 1, 1, 1];
    else if (e.TYPE === 'point2D') {
      const lo = e.MIN || [0, 0], hi = e.MAX || [1, 1], d = e.DEFAULT || [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
      const r = 0.22 * fuerza * (0.7 + A.bass * 0.6);
      v[n] = [d[0] + (hi[0] - lo[0]) * r * Math.sin(t * 0.61 + k), d[1] + (hi[1] - lo[1]) * r * Math.cos(t * 0.83 + k * 1.7)];
      if (d[0] === 0 && d[1] === 0 && hi[0] <= 1) v[n] = [0.5 + 0.3 * Math.sin(t * 0.61), 0.5 + 0.3 * Math.cos(t * 0.83)];
      k++;
    } else if (e.TYPE === 'event') v[n] = DISPARA.test(e.NAME) ? A.golpe : false;
  }
  return v;
}
