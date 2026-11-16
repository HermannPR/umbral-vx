// Separa una canción en stems dentro de un Worker (la sala sigue a 60/120 fps mientras tanto).
// HTDemucs v4 (Meta, MIT) exportado a ONNX por demucs-web (timcsy, MIT), sobre ONNX Runtime Web: WebGPU si hay,
// si no WASM. El modelo (180 MB) se baja una sola vez de Hugging Face y se guarda en la Cache API del navegador:
// las siguientes veces, y sin conexión, sale de ahí. Todo lo demás (ORT y su .wasm) viene con la página.
import * as ort from './vendor/ort/ort.webgpu.min.mjs';
import { DemucsProcessor } from './vendor/demucs/processor.js';

export const MODELO = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';
const CACHE = 'umbral-stems-v1';
const BYTES = 180534758;

ort.env.wasm.wasmPaths = new URL('./vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
ort.env.logLevel = 'error';

let proc = null, backend = '', cancelado = false;
const decir = (m, t) => self.postMessage(m, t || []);

async function cacheAbierta() { try { return await caches.open(CACHE); } catch { return null; } }

export async function modeloGuardado() {
  const c = await cacheAbierta(); if (!c) return false;
  const r = await c.match(MODELO); return !!r;
}

// del caché, o de la red con avance (y se guarda)
async function bajarModelo() {
  const c = await cacheAbierta();
  const r0 = c && (await c.match(MODELO));
  if (r0) { decir({ tipo: 'fase', fase: 'cargando', de: 'caché' }); return await r0.arrayBuffer(); }
  decir({ tipo: 'fase', fase: 'bajando' });
  const r = await fetch(MODELO);
  if (!r.ok || !r.body) throw new Error(`no se pudo bajar el modelo (${r.status})`);
  const total = +r.headers.get('Content-Length') || BYTES, lector = r.body.getReader(), trozos = [];
  let n = 0, ult = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    if (cancelado) { lector.cancel(); throw new Error('cancelado'); }
    trozos.push(value); n += value.length;
    const ahora = performance.now();
    if (ahora - ult > 150) { ult = ahora; decir({ tipo: 'bajando', n, total }); }
  }
  const buf = new Uint8Array(n); let o = 0;
  for (const t of trozos) { buf.set(t, o); o += t.length; }
  if (n < 1e8) throw new Error('el modelo llegó incompleto');
  if (c) {
    try { await c.put(MODELO, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(n) } })); }
    catch (e) { decir({ tipo: 'aviso', texto: 'no se pudo guardar el modelo para la próxima vez: ' + e.message }); }
  }
  return buf.buffer;
}

async function hayWebGPU() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}

async function cargar(forzar) {
  if (proc && (!forzar || forzar === backend)) return;
  const buf = await bajarModelo();
  decir({ tipo: 'fase', fase: 'preparando' });
  const ep = forzar === 'wasm' || !(await hayWebGPU()) ? ['wasm'] : ['webgpu'];
  proc = new DemucsProcessor({ ort, sessionOptions: { executionProviders: ep, graphOptimizationLevel: 'basic', enableCpuMemArena: false } });
  try { await proc.loadModel(buf); backend = ep[0]; }
  catch (e) {
    if (ep[0] !== 'webgpu') throw e;
    decir({ tipo: 'aviso', texto: 'WebGPU no pudo con el modelo; sigo con WASM (más lento): ' + e.message });
    proc = new DemucsProcessor({ ort, sessionOptions: { executionProviders: ['wasm'], graphOptimizationLevel: 'basic' } });
    await proc.loadModel(buf); backend = 'wasm';
  }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.tipo === 'cancelar') { cancelado = true; return; }
  if (m.tipo === 'estado') { decir({ tipo: 'estado', guardado: await modeloGuardado(), webgpu: await hayWebGPU() }); return; }
  if (m.tipo === 'borrar') { try { await caches.delete(CACHE); } catch {} proc = null; decir({ tipo: 'estado', guardado: false }); return; }
  if (m.tipo !== 'separar') return;
  cancelado = false;
  const t0 = performance.now();
  try {
    await cargar(m.backend);
    decir({ tipo: 'fase', fase: 'separando', backend });
    const tSep = performance.now();
    proc.onProgress = (p) => {
      if (cancelado) throw new Error('cancelado');
      decir({ tipo: 'avance', p: p.progress, seg: p.currentSegment, de: p.totalSegments, t: (performance.now() - tSep) / 1000 });
    };
    const r = await proc.separate(m.izq, m.der);
    const stems = {}, transf = [];
    for (const k of ['vocals', 'drums', 'bass', 'other']) { stems[k] = [r[k].left, r[k].right]; transf.push(r[k].left.buffer, r[k].right.buffer); }
    decir({ tipo: 'listo', stems, sr: 44100, backend, seg: (performance.now() - tSep) / 1000, total: (performance.now() - t0) / 1000 }, transf);
  } catch (e) {
    decir({ tipo: 'error', texto: e && e.message === 'cancelado' ? 'cancelado' : String((e && e.message) || e) });
  }
};
