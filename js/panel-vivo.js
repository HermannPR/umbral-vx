// Sección «En vivo» del panel (solo en Señal): modo rave, proyector y salidas, grabación por tramos,
// entrada MIDI y salida de datos a TouchDesigner. Devuelve una función que la desarma.
import { ROLES, NOMBRE_ROL, hayMidi } from './midi.js';
import { GrabadoraTramos } from './tramos.js';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mb = (b) => (b / 1e6).toFixed(b > 1e8 ? 0 : 1) + ' MB';

export function armarVivo(g, A) {
  const P = A.pista, R = A.rave, T = A.tramos, M = P.midi, O = P.salida;
  const caja = document.createElement('div'); caja.className = 'pm pv';
  caja.innerHTML = `
    <div class="pm-vt">modo rave · se queda sola horas</div>
    <div class="pm-fila"><button type="button" class="pv-rave">▶ modo rave</button></div>
    <div class="pv-estado pm-meta"></div>
    <div class="pm-fila"><button type="button" class="pv-recal" title="Vuelve a medir el ruido del cuarto (2 s)">recalibrar el micrófono</button></div>
    <div class="pv-cal pm-meta"></div>
    <details class="pv-proy"><summary>proyector y salidas</summary>
      <label>giro <select class="pv-giro"><option value="0">0°</option><option value="180">180° (colgado de cabeza)</option></select></label>
      <label>espejo <select class="pv-espejo"><option>no</option><option>horizontal</option><option>cuatro</option></select></label>
      <label><input type="checkbox" class="pv-expo"> exposición automática (no lava el techo)</label>
      <div class="pm-fila"><button type="button" class="pv-pop" data-p="proyector">abrir proyector</button><button type="button" class="pv-pop" data-p="tele">abrir tele</button><button type="button" class="pv-cerrar">cerrar</button></div>
      <div class="pm-fila"><button type="button" class="pv-veto">olvidar escenas vetadas</button></div>
      <div class="pm-meta">Las ventanas no tienen pestañas: arrástralas a la pantalla y doble clic para pantalla completa.</div>
    </details>
    <details class="pv-tramos"><summary>grabar por tramos</summary>
      <label>cada <input type="number" class="pv-min" min="1" max="60" step="1" style="width:4em"> min</label>
      <div class="pm-fila"><button type="button" class="pv-carpeta" hidden>elegir carpeta</button><button type="button" class="pv-grabar">● grabar por tramos</button></div>
      <div class="pv-tr-estado pm-meta"></div>
      <div class="pm-fila"><button type="button" class="pv-lista">ver tramos guardados</button></div>
      <div class="pv-tr-lista"></div>
    </details>
    <details class="pv-midi"><summary>entrada MIDI (FL Studio)</summary>
      <div class="pm-fila"><select class="pv-puerto" aria-label="Puerto MIDI"></select><button type="button" class="pv-usar">usar MIDI</button></div>
      <div class="pv-roles"></div>
      <div class="pv-midi-estado pm-meta"></div>
    </details>
    <details class="pv-td"><summary>datos a TouchDesigner</summary>
      <label><input type="checkbox" class="pv-td-on"> enviar por WebSocket</label>
      <label>puerto <input type="number" class="pv-td-puerto" min="1" max="65535" style="width:6em"></label>
      <div class="pv-td-estado pm-meta"></div>
    </details>`;
  g.$children.appendChild(caja);
  const q = (s) => caja.querySelector(s), aviso = (m) => A.aviso && A.aviso(m);
  const intentar = (f) => async (e) => { try { await f(e); } catch (err) { aviso((err && err.message) || String(err)); } };

  // modo rave
  q('.pv-rave').addEventListener('click', intentar(async () => { if (R.activo) R.desactivar(); else await R.activar(); }));
  q('.pv-giro').addEventListener('change', (e) => R.ajustar('giro', +e.target.value));
  q('.pv-espejo').addEventListener('change', (e) => R.ajustar('espejo', e.target.value));
  q('.pv-expo').addEventListener('change', (e) => R.ajustar('exposicion', e.target.checked));
  caja.querySelectorAll('.pv-pop').forEach((b) => b.addEventListener('click', intentar(() => {
    const p = b.dataset.p; R.abrirSalida(p, { x: p === 'tele' ? 1920 : 0, girar: p === 'proyector' && R.cfg.giro === 180 });
  })));
  q('.pv-recal').addEventListener('click', () => { P.recalibrar(); aviso('Midiendo el cuarto: 2 s'); });
  q('.pv-cerrar').addEventListener('click', () => R.cerrarSalidas());
  q('.pv-veto').addEventListener('click', () => { R.olvidarVetos(); aviso('Vetos olvidados'); });

  // tramos
  if (GrabadoraTramos.puedeCarpeta) q('.pv-carpeta').hidden = false;
  q('.pv-carpeta').addEventListener('click', intentar(() => T.elegirCarpeta()));
  q('.pv-min').addEventListener('change', (e) => { const v = Math.max(1, Math.min(60, +e.target.value || 5)); T.min = v; });
  q('.pv-grabar').addEventListener('click', intentar(() => (T.activa ? T.detener() : A.grabarTramos())));
  q('.pv-lista').addEventListener('click', intentar(async () => {
    const L = await T.listar(), box = q('.pv-tr-lista');
    box.innerHTML = L.length ? L.map((x, i) => `<div class="pm-fila"><span class="pm-meta">${esc(x.nombre)} · ${mb(x.bytes)}</span><button type="button" data-i="${i}" data-a="bajar">⤓</button><button type="button" data-i="${i}" data-a="borrar">✕</button></div>`).join('') : '<div class="pm-meta">No hay tramos guardados.</div>';
    box.onclick = intentar(async (e) => { const b = e.target.closest('button[data-a]'); if (!b) return; const x = L[+b.dataset.i]; if (b.dataset.a === 'bajar') await T.bajar(x); else { await T.borrar(x); b.parentElement.remove(); } });
  }));

  // MIDI
  const selP = q('.pv-puerto');
  const pintarPuertos = () => { const ps = M.puertos; selP.innerHTML = ps.length ? ps.map((p) => `<option value="${esc(p.id)}"${p.id === M.cfg.puerto ? ' selected' : ''}>${esc(p.nombre)}</option>`).join('') : '<option value="">(sin puertos: pulsa «usar MIDI»)</option>'; };
  q('.pv-roles').innerHTML = ROLES.map((r) => `<div class="pm-fila pv-rol" data-r="${r}"><span class="pv-nom">${NOMBRE_ROL[r]}</span> CC <input type="number" min="0" max="127" style="width:4em"><button type="button">aprender</button><span class="pv-nivel"><i></i></span></div>`).join('');
  caja.querySelectorAll('.pv-rol').forEach((f) => {
    const r = f.dataset.r;
    f.querySelector('input').addEventListener('change', (e) => M.ponerCC(r, e.target.value));
    f.querySelector('button').addEventListener('click', () => M.aprender(r));
  });
  q('.pv-usar').addEventListener('click', intentar(async () => {
    if (!hayMidi()) throw new Error('Este navegador no tiene Web MIDI (Chrome, Edge o Brave)');
    if (P.fuente === 'midi') { P.quitar(); return; }
    await M.pedir(); pintarPuertos();
    await P.usarMidi(selP.value || undefined);
    aviso('Señal escucha el MIDI · ' + P.nombre);
  }));
  selP.addEventListener('change', intentar(() => (P.fuente === 'midi' ? P.usarMidi(selP.value) : null)));
  pintarPuertos();

  // TouchDesigner
  q('.pv-td-on').addEventListener('change', (e) => O.activar(e.target.checked));
  q('.pv-td-puerto').addEventListener('change', (e) => O.ponerPuerto(e.target.value));

  const pintar = () => {
    const V = P.vivo.estado;
    q('.pv-rave').textContent = R.activo ? '■ salir del modo rave' : '▶ modo rave';
    q('.pv-estado').textContent = P.enVivo
      ? `${P.fuente === 'midi' ? 'MIDI' : 'micrófono'} · ${V.bpm ? V.bpm + ' BPM' : 'buscando el pulso'}${V.amarrado ? ' · amarrado' : ''} · retardo ${V.retardoMs} ms · novedad ${V.novedad} · ${V.cambios} cambios${R.activo ? ' · vetadas ' + R.veto.size : ''}`
      : 'Usa el micrófono o el MIDI para el modo en vivo.';
    const C = P.cal && P.cal.estado, esMic = P.fuente === 'mic';
    q('.pv-recal').hidden = !esMic;
    q('.pv-cal').textContent = !esMic || !C ? '' : C.calibrando ? `autocalibrando: midiendo el cuarto… ${C.faltan.toFixed(1)} s`
      : `autocalibrado · ruido del cuarto ${C.pisoDb} dB · música ${C.snrDb > 0 ? '+' : ''}${C.snrDb} dB sobre el ruido · ${C.presencia > 0.5 ? 'suena' : 'silencio'} · sensibilidad ${C.sensibilidad.map((x) => '×' + x).join(' / ')}`;
    const gi = q('.pv-giro'); if (document.activeElement !== gi) gi.value = String(R.cfg.giro);
    const es = q('.pv-espejo'); if (document.activeElement !== es) es.value = R.cfg.espejo;
    q('.pv-expo').checked = !!R.cfg.exposicion;
    const mi = q('.pv-min'); if (document.activeElement !== mi) mi.value = T.min;
    q('.pv-grabar').textContent = T.activa ? '■ detener tramos' : '● grabar por tramos';
    const s = Math.floor(T.segundos);
    q('.pv-tr-estado').textContent = T.activa ? `tramo ${T.tramos.length} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} · ${mb(T.actual ? T.actual.bytes : 0)} · ${T.dest}${T.error ? ' · ' + T.error : ''}` : T.dest ? 'guarda en: ' + T.dest : '';
    q('.pv-usar').textContent = P.fuente === 'midi' ? 'dejar el MIDI' : 'usar MIDI';
    caja.querySelectorAll('.pv-rol').forEach((f) => {
      const r = f.dataset.r, inp = f.querySelector('input');
      if (document.activeElement !== inp) inp.value = M.cfg.cc[r];
      f.querySelector('button').textContent = M.aprendiendo === r ? 'mueve un control…' : 'aprender';
      f.querySelector('i').style.width = Math.round((M.c[r] || 0) * 100) + '%';
    });
    q('.pv-midi-estado').textContent = M.activa ? `${M.msgs} mensajes${performance.now() - M.ultMsg < 2000 ? ' · llegando' : ' · sin datos'}` : '';
    q('.pv-td-on').checked = !!O.cfg.activa;
    const tp = q('.pv-td-puerto'); if (document.activeElement !== tp) tp.value = O.cfg.puerto;
    q('.pv-td-estado').textContent = `${O.url} · ${O.estado}${O.estado === 'conectada' ? ` · ${O.enviados} mensajes${O.saltados ? ' · ' + O.saltados + ' saltados' : ''}${O.rtt !== null ? ' · ida y vuelta ' + O.rtt.toFixed(1) + ' ms' : ''}` : ''}`;
  };
  pintar();
  const id = setInterval(pintar, 250);
  const quitarM = M.alCambiar(pintarPuertos);
  return () => { clearInterval(id); quitarM(); };
}
