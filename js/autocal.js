// Autocalibración del micrófono: el cuarto cambia (ruido, volumen, distancia a las bocinas) y Señal se ajusta sola.
//   · Piso de ruido por banda. En los primeros 2 s se mide lo que haya. Si ya suena música fuerte, el piso se
//     estima 20 dB abajo. Después baja al instante con cualquier momento más callado y solo sube despacio
//     cuando lo que entra está cerca del piso (cambió el zumbido del cuarto, no es música).
//   · Presencia de música, de 0 a 1, por la relación señal/ruido (5 dB: nada; 13 dB: música). En silencio las bandas caen a 0 y no hay
//     golpes: la ganancia automática ya no infla el ruido del cuarto hasta llenar la escala.
//   · Bandas sin ruido: a la energía se le resta el piso, y el pico de la ganancia nunca baja de 3× el piso.
//   · Sensibilidad automática por banda: si salen demasiados golpes (o casi ninguno con música), el umbral se
//     mueve hasta caer en un ritmo creíble. El bombo va de 0.7 a 3.5 golpes por segundo.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dB = (x) => 20 * Math.log10(Math.max(1e-9, x));
const CALIBRA_S = 2;
const PISO_MIN = 1e-5;   // -100 dB por banda: con silencio digital (micrófono silenciado) no hay piso de cero
const RITMO = [[0.7, 3.5], [1, 6], [1, 6]];   // golpes por segundo creíbles por banda (graves, medios, agudos)

export class AutoCal {
  constructor() { this.reiniciar(); }
  reiniciar() {
    this.t = 0; this.muestras = [[], [], []];
    this.piso = [0, 0, 0]; this.listo = false;
    this.presencia = 0; this.snr = 0; this.nivel = 0;
    this.k = [1, 1, 1]; this.golpes = [[], [], []]; this.tAjuste = 0;
  }

  // una vez por cuadro, con la energía media (amplitud) de cada banda
  paso(e, dt, now) {
    this.t += dt;
    const E = e[0] + e[1] + e[2];
    this.nivel += (E - this.nivel) * (1 - Math.exp(-dt / 0.3));
    if (!this.listo) {
      for (let k = 0; k < 3; k++) this.muestras[k].push(e[k]);
      if (this.t < CALIBRA_S) { this.presencia = 0; return; }
      for (let k = 0; k < 3; k++) {
        const m = this.muestras[k].sort((a, b) => a - b), p10 = m[Math.floor(m.length * 0.1)] || 1e-6;
        // con música fuerte desde el inicio, el 10 % más callado sigue siendo música: el ruido estará 20 dB abajo
        this.piso[k] = Math.max(PISO_MIN, dB(p10) > -45 ? p10 / 10 : p10);
      }
      this.muestras = null; this.listo = true;
    }
    for (let k = 0; k < 3; k++) {
      // baja al instante; sube (~10 s por cada 6 dB) solo si lo que entra está a menos de 12 dB del piso
      if (e[k] < this.piso[k]) this.piso[k] = Math.max(PISO_MIN, e[k]);
      else if (e[k] < this.piso[k] * 4) this.piso[k] *= Math.exp(dt * Math.LN2 / 10);
    }
    const P = this.piso[0] + this.piso[1] + this.piso[2];
    this.snr = dB(this.nivel / P);
    const obj = clamp((this.snr - 5) / 8, 0, 1);   // 5 dB: nada · 13 dB: música
    this.presencia += (obj - this.presencia) * (1 - Math.exp(-dt / (obj > this.presencia ? 0.15 : 0.8)));
    // sensibilidad automática: una vez por segundo, por el ritmo de golpes de los últimos 8 s
    if (now - this.tAjuste > 1 && this.t > CALIBRA_S + 4) {
      this.tAjuste = now;
      for (let k = 0; k < 3; k++) {
        const g = this.golpes[k]; while (g.length && now - g[0] > 8) g.shift();
        const ritmo = g.length / 8, [lo, hi] = RITMO[k];
        if (ritmo > hi) this.k[k] *= 1.08;
        else if (ritmo < lo && this.presencia > 0.7) this.k[k] /= 1.06;
        this.k[k] = clamp(this.k[k], 0.6, 2.2);
      }
    }
  }
  // energía de la banda sin el ruido del cuarto
  neto(k, e) { return this.listo ? Math.max(0, e - this.piso[k] * 1.4) : 0; }
  picoMin(k) { return this.listo ? this.piso[k] * 3 : 1e-4; }
  golpe(k, now) { this.golpes[k].push(now); }
  get hayMusica() { return this.listo && this.presencia > 0.5; }
  get estado() {
    return { listo: this.listo, calibrando: !this.listo, faltan: Math.max(0, CALIBRA_S - this.t),
      pisoDb: Math.round(dB(this.piso[0] + this.piso[1] + this.piso[2])), snrDb: Math.round(this.snr),
      presencia: +this.presencia.toFixed(2), sensibilidad: this.k.map((x) => +(1 / x).toFixed(2)) };
  }
}
