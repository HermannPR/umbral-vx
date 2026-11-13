// Oído común de los motores: del analizador de la sala (512 bandas, la máquina o tu música) y de la línea de
// tiempo de Señal (bombo, caja, drop, sección, tonalidad) saca las señales que piden los distintos formatos:
// UMBRAL (bass, mid, high, kick…), fosfora (7 bandas, rms, centroide, flujo, onset…) e ISF (espectro y onda).
// Cada banda tiene control de ganancia: el pico decae despacio, así cualquier canción llena la escala.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
// límites en Hz de las 7 bandas de fosfora
const CORTES = [20, 60, 250, 500, 2000, 4000, 6000, 20000];

export class Oido {
  constructor() {
    this.espectro = new Uint8Array(512); this.onda = new Uint8Array(1024);
    this.prev = new Float32Array(512);
    this.b7 = new Float32Array(7); this.pico7 = new Float32Array(7).fill(0.15);
    this.b3 = [0, 0, 0]; this.pico3 = [0.15, 0.15, 0.15];
    this.flujoPico = 0.05; this.onset = 0; this.ultKick = -1; this.golpe = false; this.beatIdx = 0; this.ultBeat = -1;
    this.E = {};
  }
  // an: AnalyserNode (o null); A: estado de la música de Señal; env: envolventes que ya calculó Señal
  leer(an, A, env, dt) {
    const S = this.espectro, O = this.onda, E = this.E;
    let real = false;
    if (an && A.real) {
      an.getByteFrequencyData(S.length === an.frequencyBinCount ? S : (this._tmp || (this._tmp = new Uint8Array(an.frequencyBinCount))));
      if (this._tmp) S.set(this._tmp.subarray(0, 512));
      if (O.length === an.fftSize) an.getByteTimeDomainData(O); else { const t = this._td || (this._td = new Uint8Array(an.fftSize)); an.getByteTimeDomainData(t); O.set(t.subarray(0, 1024)); }
      real = true;
    } else { S.fill(0); O.fill(128); }
    const nyq = (an && an.context ? an.context.sampleRate : 48000) / 2, hz = nyq / (an ? an.frequencyBinCount : 512);
    // 7 bandas (media de cada rango), con control de ganancia
    for (let k = 0; k < 7; k++) {
      const i0 = Math.max(1, Math.floor(CORTES[k] / hz)), i1 = Math.min(511, Math.max(i0 + 1, Math.floor(CORTES[k + 1] / hz)));
      let s = 0; for (let i = i0; i < i1; i++) s += S[i]; s /= (i1 - i0) * 255;
      this.pico7[k] = Math.max(s, this.pico7[k] * Math.exp(-dt / 8), 0.08);
      const v = s / this.pico7[k];
      this.b7[k] += (v - this.b7[k]) * Math.min(1, dt * (v > this.b7[k] ? 30 : 8));
    }
    // graves / medios / agudos: de la pista si los trae (ya calibrados), si no de las 7 bandas
    const b = this.b7;
    const tres = A.bandas && A.pista ? A.bandas : [Math.max(b[0], b[1]), (b[2] + b[3] + b[4]) / 3, (b[5] + b[6]) / 2];
    for (let k = 0; k < 3; k++) this.b3[k] += (tres[k] - this.b3[k]) * Math.min(1, dt * 20);
    // rasgos espectrales
    let tot = 0, cen = 0, flujo = 0, lg = 0, n = 0;
    for (let i = 1; i < 512; i++) { const v = S[i] / 255; tot += v; cen += v * i; const d = v - this.prev[i]; if (d > 0) flujo += d; this.prev[i] = v; if (v > 0.001) { lg += Math.log(v); n++; } }
    const media = tot / 511;
    let acum = 0, roll = 0; for (let i = 1; i < 512; i++) { acum += S[i] / 255; if (acum >= tot * 0.85) { roll = i / 511; break; } }
    let rms = 0, zcr = 0; for (let i = 0; i < 1024; i++) { const v = (O[i] - 128) / 128; rms += v * v; if (i && (O[i] >= 128) !== (O[i - 1] >= 128)) zcr++; }
    rms = Math.sqrt(rms / 1024);
    this.flujoPico = Math.max(flujo, this.flujoPico * Math.exp(-dt / 4), 0.5);
    // bombo de la línea de tiempo = onset; si no hay línea de tiempo, el flujo
    const nuevoKick = A.tKick !== this.ultKick && A.tKick > -90 && A.tv >= A.tKick;
    if (nuevoKick) this.ultKick = A.tKick;
    this.golpe = nuevoKick;
    this.onset = nuevoKick ? 1 : this.onset * Math.exp(-dt * 10);
    const beat = 60 / (A.bpm || 120);
    const fase = A.tKick > -90 ? clamp((A.tv - A.tKick) / beat, 0, 1) : (A.tv / beat) % 1;
    if (nuevoKick) this.beatIdx++;
    const enBar = this.beatIdx % 4;
    Object.assign(E, {
      real, bass: this.b3[0], mid: this.b3[1], high: this.b3[2], kick: env.kick, snare: env.caja, drop: env.drop, build: env.sub,
      beat: fase, bar: (enBar + fase) / 4, seccion: A.seccion || '', energy: clamp((this.b3[0] + this.b3[1] + this.b3[2]) / 3, 0, 1.5),
      hue: env.hue || 0, key: A.tono ?? -1, bpm: A.bpm || 120, golpe: nuevoKick,
      // fosfora
      b7: this.b7, rms: clamp(rms * 3, 0, 1), centroide: tot > 0 ? cen / tot / 511 : 0, flujo: clamp(flujo / this.flujoPico, 0, 1),
      planitud: n > 0 && media > 0 ? clamp(Math.exp(lg / n) / media, 0, 1) : 0, rolloff: roll, ancho: clamp(media * 4, 0, 1), zcr: zcr / 1024,
      onset: this.onset, beatIdx: this.beatIdx, enBar, compas: Math.floor(this.beatIdx / 4),
    });
    return E;
  }
}
