// Piezas de los stems que no dependen del modelo: WAV para descargar y envolventes por stem para Señal.

// WAV PCM de 16 bits (lo abre cualquier editor). canales: Float32Array[] del mismo largo.
export function wav(canales, sr) {
  const nc = canales.length, n = canales[0].length, bytes = n * nc * 2;
  const ab = new ArrayBuffer(44 + bytes), v = new DataView(ab);
  const txt = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  txt(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); txt(8, 'WAVE');
  txt(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  txt(36, 'data'); v.setUint32(40, bytes, true);
  const out = new Int16Array(ab, 44, n * nc);
  for (let i = 0, j = 0; i < n; i++) for (let c = 0; c < nc; c++, j++) {
    const s = Math.max(-1, Math.min(1, canales[c][i]));
    out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// Envolvente de un stem a `fps` cuadros por segundo: RMS por cuadro, escalado para que el percentil 97 valga 1.
// Los stems casi mudos (voz en una instrumental) se quedan bajos: no se normalizan contra su propio ruido.
export function envolvente(canales, sr, fps, nF, off = 0) {
  const out = new Float32Array(nF), hop = sr / fps, nc = canales.length, L = canales[0].length;
  let total = 0;
  for (let f = 0; f < nF; f++) {
    const c0 = (f / fps + off) * sr, a = Math.max(0, Math.floor(c0 - hop)), b = Math.min(L, Math.floor(c0 + hop));
    let e = 0;
    for (let c = 0; c < nc; c++) { const d = canales[c]; for (let i = a; i < b; i += 2) e += d[i] * d[i]; }
    out[f] = Math.sqrt(e / Math.max(1, ((b - a) / 2) * nc));
    total += out[f];
  }
  const s = Float32Array.from(out).sort(), p97 = s[Math.floor(s.length * 0.97)] || 0;
  const ref = Math.max(p97, 0.02);            // un stem con RMS < 0.02 casi no suena
  for (let f = 0; f < nF; f++) out[f] = Math.min(1, out[f] / ref);
  out.media = total / Math.max(1, nF);
  return out;
}

// Ataques de un stem a partir de su envolvente: subidas (flujo) con umbral adaptativo, como los golpes del mapa.
export function ataques(env, fps, off, picos, refr = 0.1) {
  const f = new Float32Array(env.length);
  for (let i = 2; i < env.length; i++) f[i] = Math.max(0, env[i] - env[i - 2]);
  return picos(f, fps, 1.2, refr, off);
}

// Entradas de la voz: vuelve a sonar tras ≥ 1.2 s de silencio (presencia suavizada ~0.25 s).
export function entradas(env, fps, off) {
  const n = env.length, r = Math.max(1, Math.round(fps * 0.12)), t = [], s = [];
  let calla = 0, armada = true;           // armada: hubo silencio largo y la próxima voz cuenta como entrada
  for (let i = 0; i < n; i++) {
    let m = 0, k = 0; for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) { m += env[j]; k++; }
    m /= k;
    if (m < 0.12) { if (++calla > fps * 1.2) armada = true; } else calla = 0;
    if (armada && m > 0.3) { armada = false; t.push(i / fps + off); s.push(1); }
  }
  return { t: Float32Array.from(t), s: Float32Array.from(s) };
}
