// Entrada unificada: mando (Gamepad API, mapeo estándar) + teclado como respaldo.
const BTN = ['a', 'b', 'x', 'y', 'l1', 'r1', 'l2', 'r2', 'pausa', 'start', 'l3', 'r3', 'up', 'down', 'left', 'right', 'home'];
const KEYMAP = {
  Enter: 'a', ' ': 'pausa', Backspace: 'b', x: 'x', c: 'y', '[': 'l1', ']': 'r1', ',': 'l1', '.': 'r1',
  m: 'start', Tab: 'start', Escape: 'b', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};
const dz = (v, d = 0.14) => (Math.abs(v) < d ? 0 : Math.sign(v) * (Math.abs(v) - d) / (1 - d));

export const enPanel = (e) => !!(e && e.target && e.target.closest && e.target.closest('#panel, #asa'));

export class Input {
  constructor({ onConnect, onDisconnect }) {
    this.held = {}; this.pressed = {}; this.prev = {};
    this.lx = this.ly = this.rx = this.ry = this.l2 = this.r2 = 0;
    this.keys = new Set(); this.taps = new Set(); this.pad = null; this.padIndex = -1; this.lastPadUse = -1e9;
    addEventListener('gamepadconnected', (e) => { this.padIndex = e.gamepad.index; onConnect && onConnect(e.gamepad); });
    addEventListener('gamepaddisconnected', (e) => { if (e.gamepad.index === this.padIndex) { this.padIndex = -1; this.pad = null; } onDisconnect && onDisconnect(e.gamepad); });
    // lo que se escribe o se aprieta dentro del panel (deslizadores, listas, botones) no mueve la sala
    addEventListener('keydown', (e) => { if (enPanel(e)) return; if (!e.metaKey && !e.ctrlKey) { const kk = e.key.length === 1 ? e.key.toLowerCase() : e.key; this.keys.add(kk); if (!e.repeat) this.taps.add(kk); if (e.key === 'Tab' || e.key === ' ') e.preventDefault(); } });
    addEventListener('keyup', (e) => this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
    addEventListener('blur', () => this.keys.clear());
  }
  get connected() { return !!this.pad; }
  poll() {
    const k = this.keys, now = {};
    let lx = 0, ly = 0, rx = 0, ry = 0, l2 = 0, r2 = 0;
    // teclado
    if (k.has('a')) lx -= 1; if (k.has('d')) lx += 1; if (k.has('w')) ly -= 1; if (k.has('s')) ly += 1;
    if (k.has('j')) rx -= 1; if (k.has('l')) rx += 1; if (k.has('i')) ry -= 1; if (k.has('k')) ry += 1;
    if (k.has('q')) l2 = 1; if (k.has('e')) r2 = 1;
    for (const key of k) if (KEYMAP[key]) now[KEYMAP[key]] = true;
    for (const key of this.taps) if (KEYMAP[key]) now[KEYMAP[key]] = true;
    this.taps.clear();
    if (this.inject) { now[this.inject] = true; this.inject = null; }
    // mando
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = this.padIndex >= 0 ? pads[this.padIndex] : null;
    if (!pad) for (const p of pads) if (p && p.connected) { pad = p; this.padIndex = p.index; break; }
    this.pad = pad;
    if (pad) {
      const a = pad.axes, b = pad.buttons;
      const plx = dz(a[0] || 0), ply = dz(a[1] || 0), prx = dz(a[2] || 0), pry = dz(a[3] || 0);
      const pl2 = b[6] ? b[6].value : 0, pr2 = b[7] ? b[7].value : 0;
      let any = Math.abs(plx) + Math.abs(ply) + Math.abs(prx) + Math.abs(pry) + pl2 + pr2 > 0.05;
      BTN.forEach((name, i) => { if (b[i] && b[i].pressed) { now[name] = true; any = true; } });
      if (any) this.lastPadUse = performance.now();
      lx += plx; ly += ply; rx += prx; ry += pry; l2 = Math.max(l2, pl2 > 0.04 ? pl2 : 0); r2 = Math.max(r2, pr2 > 0.04 ? pr2 : 0);
    }
    const c = (v) => Math.max(-1, Math.min(1, v));
    this.lx = c(lx); this.ly = c(ly); this.rx = c(rx); this.ry = c(ry); this.l2 = l2; this.r2 = r2;
    this.pressed = {};
    for (const n of BTN) { if (now[n] && !this.prev[n]) this.pressed[n] = true; }
    // repetición para navegación de menú con stick/D-pad
    this.prev = now; this.held = now;
  }
  rumble(strong = 0.35, weak = 0.6, ms = 110) {
    const act = this.pad && this.pad.vibrationActuator;
    if (act && act.playEffect) act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
  }
}
