// Entrada por Web MIDI: en lugar del micrófono, UMBRAL lee CC de un puerto (en Mac, el bus IAC) y los
// asigna a bombo, bajo, lead y voz. La idea: en FL Studio, un Peak Controller por insert manda el nivel
// de cada instrumento como CC (guía en docs/fl-studio-midi.md). Señal ve lo mismo que con stems:
// bombo → golpes, bajo → pulso de zoom, lead → chispas finas, voz → color o escena.
// Los CC son de 7 bits (128 valores): se suavizan un poco para que no se vean escalones.
const CLAVE = 'umbral.midi';
export const ROLES = ['bombo', 'bajo', 'lead', 'voz'];
export const NOMBRE_ROL = { bombo: 'bombo', bajo: 'bajo', lead: 'lead', voz: 'voz' };
const BASE = { puerto: '', cc: { bombo: 20, bajo: 21, lead: 22, voz: 23 }, canal: 0 };   // canal 0 = cualquiera

export const hayMidi = () => typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';

export class EntradaMidi {
  constructor() {
    this.cfg = JSON.parse(JSON.stringify(BASE));
    try { const g = JSON.parse(localStorage.getItem(CLAVE) || '{}'); Object.assign(this.cfg, g); this.cfg.cc = { ...BASE.cc, ...(g.cc || {}) }; } catch {}
    this.acc = null; this.entrada = null; this.aprendiendo = null; this.error = '';
    this.reiniciar();
    this.oyentes = new Set();
  }
  // niveles y golpes en cero: al cambiar de puerto no se queda pegado el último CC
  reiniciar() {
    this.v = { bombo: 0, bajo: 0, lead: 0, voz: 0 }; this.c = { ...this.v };
    this.t = { bombo: -99, bajo: -99, lead: -99, voz: -99 }; this.arm = { bombo: true, bajo: true, lead: true, voz: true };
    this.ultMsg = 0; this.msgs = 0;
  }
  alCambiar(f) { this.oyentes.add(f); return () => this.oyentes.delete(f); }
  avisar() { for (const f of this.oyentes) { try { f(this); } catch {} } }
  guardar() { try { localStorage.setItem(CLAVE, JSON.stringify(this.cfg)); } catch {} }
  get puertos() { return this.acc ? [...this.acc.inputs.values()].map((p) => ({ id: p.id, nombre: p.name || p.id })) : []; }
  get activa() { return !!this.entrada; }

  async pedir() {
    if (!hayMidi()) throw new Error('Este navegador no tiene Web MIDI (usa Chrome, Edge o Brave)');
    if (!this.acc) {
      this.acc = await navigator.requestMIDIAccess({ sysex: false });
      this.acc.onstatechange = () => this.avisar();
    }
    return this.puertos;
  }
  // abre el puerto guardado (o el que se pase, o el primero que diga IAC, o el primero)
  async abrir(id) {
    const ps = await this.pedir();
    if (!ps.length) throw new Error('No hay puertos MIDI. En Mac: Configuración Audio MIDI → Estudio MIDI → IAC → «El dispositivo está en línea»');
    const elegido = ps.find((p) => p.id === (id || this.cfg.puerto)) || ps.find((p) => /iac|bus/i.test(p.nombre)) || ps[0];
    this.cerrar(false);
    this.entrada = this.acc.inputs.get(elegido.id);
    this.entrada.onmidimessage = (e) => this.mensaje(e.data);
    this.cfg.puerto = elegido.id; this.guardar();
    this.avisar();
    return elegido;
  }
  cerrar(avisar = true) {
    if (this.entrada) { this.entrada.onmidimessage = null; this.entrada = null; }
    this.aprendiendo = null; this.reiniciar();
    if (avisar) this.avisar();
  }
  ponerCC(rol, cc) { cc = Math.round(+cc); if (!(cc >= 0 && cc < 128)) return; this.cfg.cc[rol] = cc; this.guardar(); this.avisar(); }
  // el siguiente CC que llegue queda asignado a este rol
  aprender(rol) { this.aprendiendo = rol; this.avisar(); }

  mensaje(d) {
    if (!d || d.length < 3) return;
    const tipo = d[0] & 0xf0, canal = (d[0] & 0x0f) + 1;
    if (tipo !== 0xb0) return;
    if (this.cfg.canal && canal !== this.cfg.canal) return;
    const cc = d[1], val = d[2] / 127;
    this.ultMsg = performance.now(); this.msgs++;
    if (this.aprendiendo) { this.cfg.cc[this.aprendiendo] = cc; this.aprendiendo = null; this.guardar(); this.avisar(); }
    for (const r of ROLES) if (this.cfg.cc[r] === cc) this.v[r] = val;
  }

  // una lectura por cuadro: rellena el estado de la pista (mismo formato que con el micrófono)
  estado(r, dt, now) {
    const c = this.c, v = this.v;
    for (const k of ROLES) {
      // ataque inmediato (el CC ya viene de un seguidor de picos), caída corta
      c[k] = v[k] > c[k] ? v[k] : c[k] + (v[k] - c[k]) * Math.min(1, dt * 18);
      // golpes con histéresis: sube de 0.5 tras haber bajado de 0.3
      if (this.arm[k] && v[k] > 0.5) { this.arm[k] = false; this.t[k] = now; if (k === 'bombo') { r.tKick = now; r.kick = Math.min(1, 0.5 + v[k] * 0.5); } }
      else if (!this.arm[k] && v[k] < 0.3) this.arm[k] = true;
    }
    r.tv = now; r.real = true; r.pista = true;
    r.bandas = [Math.max(c.bombo, c.bajo * 0.8), c.voz, c.lead];
    r.wob = c.voz; r.energia = (c.bombo + c.bajo + c.lead + c.voz) / 4; r.brillo = 0.4 + c.lead * 0.4;
    if (this.t.lead > -90 && now - this.t.lead < 0.02) r.tCaja = now;
    // sin drops inventados: los estallidos de chispas se sentían repetitivos en vivo (Hermann, 15 nov)
    r.seccion = r.energia < 0.08 ? 'pausa' : 'intro'; r.prog = 0;
    r.stems = { voz: c.voz, bateria: c.bombo, bajo: c.bajo, otros: c.lead, vozOn: c.voz > 0.25,
      tVoz: this.t.voz, tSilaba: this.t.voz, tBajo: this.t.bajo, tPlatillo: this.t.lead, tOtros: this.t.lead, ruta: { golpe: 'bateria', torsion: 'voz', chispas: 'otros' } };
    r.midiVivo = performance.now() - this.ultMsg < 2000;
    return r;
  }
}
