// Ayuda de controles. El esquema es el mismo en todas las salas:
//   ← →  / LB RB   sala anterior · siguiente      ↑ ↓ / cruceta ↑↓   modo de la sala
//   Enter / A      acción de la sala               Espacio / Select   pausa
//   Esc / B, Start antesala                        ?                  esta ayuda
// Lo propio de cada sala vive en sticks (WASD / IJKL), gatillos (Q/E), X (paleta) y C/Y.
const PAD = { a: 'A', b: 'B', x: 'X', y: 'Y', l1: 'LB', r1: 'RB', l2: 'LT', r2: 'RT', ls: 'L', rs: 'R', start: '☰', pausa: '⧉', ud: '✚ ↕', lr: 'LB RB' };
const TECLA = { a: 'enter', b: 'esc', x: 'X', y: 'C', l1: '←', r1: '→', l2: 'Q', r2: 'E', ls: 'WASD', rs: 'IJKL', start: 'M', pausa: 'espacio', ud: '↑ ↓', lr: '← →', ayuda: '?' };
const DATA = { ud: 'up down', lr: 'l1 r1 left right', ls: 'ls', rs: 'rs' };

export function glifo(b, pad) {
  const t = (pad ? PAD : TECLA)[b] || b;
  const red = pad && ['a', 'b', 'x', 'y', 'ls', 'rs'].includes(b);
  return `<span class="g${red ? ' red' : ''}" data-b="${DATA[b] || b}">${t}</span>`;
}

export function leyenda(D, pad, modo) {
  const c = D.controls || {};
  const filas = [];
  const add = (gs, txt, cls = '') => txt && filas.push(`<div class="k ${cls}">${gs}</div><div class="t ${cls}">${txt}</div>`);
  add(glifo('lr', pad), 'sala anterior · siguiente');
  add(glifo('ud', pad), 'modo' + (modo ? ` · <b>${modo}</b>` : ''));
  add(glifo('a', pad), c.a || 'acción');
  add(glifo('pausa', pad), 'pausa');
  add(pad ? glifo('b', true) + glifo('start', true) : glifo('b', false), 'antesala');
  add(glifo('ls', pad), c.ls, 'sala');
  add(glifo('rs', pad), c.rs, 'sala');
  add(glifo('l2', pad) + glifo('r2', pad), c.trig, 'sala');
  if (D.palettes) add(glifo('x', pad), 'paleta', 'sala');
  if (c.y !== null) add(glifo('y', pad), c.y || 'modo caos', 'sala');
  if (!pad) for (const [k, t] of D.teclas || []) add(`<span class="g">${k}</span>`, t, 'sala');
  if (!pad) {
    filas.push('<div class="sep"></div><div class="sep"></div>');
    const g = (t) => `<span class="g">${t}</span>`;
    add(g('?'), 'abrir o cerrar este panel', 'gen');
    add(g('H'), 'ocultar todo el texto', 'gen');
    add(g('T'), 'instrumentos (fps, GPU)', 'gen');
    add(g('N'), 'sonido sí / no', 'gen');
    add(g('V') + g('O'), 'pantalla completa · guardar PNG', 'gen');
    add(g('P'), 'recorrido automático', 'gen');
    add(g('1') + g('…') + g('0'), 'ir directo a una sala', 'gen');
  }
  return filas.join('');
}
