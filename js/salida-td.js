// Salida de datos a TouchDesigner (u otra app) por WebSocket. UMBRAL es el cliente; TD es el servidor
// (Web Server DAT con WebSocket). Un JSON chico por cuadro; protocolo en docs/td-protocolo.md.
// Si el servidor no responde, reintenta cada 2 s sin molestar. Si el socket se atora (bufferedAmount),
// se salta cuadros en lugar de acumularlos. Si el servidor contesta {"eco": t}, mide la ida y vuelta.
export const VERSION_TD = 1;
const CLAVE = 'umbral.td';

export class SalidaTD {
  constructor() {
    this.cfg = { activa: false, puerto: 9980, host: 'localhost', fps: 60 };
    try { Object.assign(this.cfg, JSON.parse(localStorage.getItem(CLAVE) || '{}')); } catch {}
    this.ws = null; this.estado = 'apagada'; this.enviados = 0; this.saltados = 0; this.rtt = null; this.ultEnvio = 0; this.n = 0;
    this.contexto = () => ({});   // main.js lo llena: escena, preset, motor
    this.oyentes = new Set();
    if (this.cfg.activa) this.conectar();
  }
  alCambiar(f) { this.oyentes.add(f); return () => this.oyentes.delete(f); }
  avisar() { for (const f of this.oyentes) { try { f(this); } catch {} } }
  guardar() { try { localStorage.setItem(CLAVE, JSON.stringify(this.cfg)); } catch {} }
  get url() { return `ws://${this.cfg.host}:${this.cfg.puerto}`; }
  activar(on) { this.cfg.activa = !!on; this.guardar(); if (on) this.conectar(); else this.cerrar(); }
  ponerPuerto(p) { p = Math.round(+p); if (!(p > 0 && p < 65536)) return; this.cfg.puerto = p; this.guardar(); if (this.cfg.activa) { this.cerrar(); this.conectar(); } }
  cerrar() {
    clearTimeout(this.reintento);
    if (this.ws) { const w = this.ws; this.ws = null; w.onclose = w.onerror = w.onmessage = null; try { w.close(); } catch {} }
    this.estado = this.cfg.activa ? 'reintentando' : 'apagada'; this.avisar();
  }
  conectar() {
    if (typeof WebSocket === 'undefined') { this.estado = 'sin WebSocket'; this.avisar(); return; }
    clearTimeout(this.reintento);
    if (this.ws) return;
    let w;
    try { w = new WebSocket(this.url); } catch (e) { this.estado = 'error'; this.programar(); return; }
    this.ws = w; this.estado = 'conectando'; this.avisar();
    w.onopen = () => { this.estado = 'conectada'; this.avisar(); try { w.send(JSON.stringify({ v: VERSION_TD, tipo: 'hola', app: 'umbral', t: Date.now() })); } catch {} };
    w.onmessage = (e) => {
      try { const j = JSON.parse(e.data); if (typeof j.eco === 'number') { const d = Date.now() - j.eco; this.rtt = this.rtt === null ? d : this.rtt + (d - this.rtt) * 0.1; } } catch {}
    };
    w.onclose = () => { this.ws = null; if (this.cfg.activa) { this.estado = 'reintentando'; this.programar(); } this.avisar(); };
    w.onerror = () => {};
  }
  programar() { clearTimeout(this.reintento); if (this.cfg.activa) this.reintento = setTimeout(() => this.conectar(), 2000); }

  // r: el estado de la pista (mismo formato que estado() de Señal); vivo: el detector en vivo (o null)
  enviar(r, vivo) {
    const w = this.ws;
    if (!w || w.readyState !== 1) return;
    const ahora = performance.now();
    if (ahora - this.ultEnvio < 1000 / this.cfg.fps - 2) return;
    if (w.bufferedAmount > 64 * 1024) { this.saltados++; return; }
    this.ultEnvio = ahora;
    const tv = r.tv || ahora / 1000, beat = 60 / (r.bpm || 120);
    const golpe = r.tKick > -90 ? Math.max(0, 1 - Math.max(0, tv - r.tKick) / 0.25) * (r.kick || 0.7) : 0;
    const fase = typeof r.fase === 'number' ? r.fase : r.tBeat > -90 ? (((tv - r.tBeat) / beat) % 1 + 1) % 1 : 0;
    const C = this.contexto() || {}, b = r.bandas || [0, 0, 0], st = r.stems;
    const m = {
      v: VERSION_TD, n: this.n++, t: Date.now(),
      bandas: [+b[0].toFixed(3), +b[1].toFixed(3), +b[2].toFixed(3)],
      golpe: +golpe.toFixed(3), kick: r.tKick > -90 && tv - r.tKick < 1 / 30 ? 1 : 0,
      bpm: +(r.bpm || 0).toFixed(1), fase: +fase.toFixed(3), compas: r.compas | 0,
      novedad: vivo ? +vivo.N.actual.toFixed(3) : 0, seccion: r.seccion || '',
      tono: r.tono ?? -1, menor: !!r.menor, escena: C.escena || '', preset: C.preset || '',
    };
    if (st) m.stems = { bombo: +(st.bateria || 0).toFixed(3), bajo: +(st.bajo || 0).toFixed(3), lead: +(st.otros || 0).toFixed(3), voz: +(st.voz || 0).toFixed(3) };
    try { w.send(JSON.stringify(m)); this.enviados++; } catch {}
  }
}
