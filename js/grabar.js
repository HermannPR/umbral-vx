// Grabar video: lo que se ve en el lienzo y lo que suena, en tiempo real, con MediaRecorder.
// Sin dependencias. Chrome/Edge recientes y Safari dan MP4 (H.264 + AAC); si no se puede, WebM (VP9 + Opus).
// El audio sale de la mezcla final (después del compresor), así el video suena como se oye.
const TIPOS = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function tipoVideo() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return TIPOS.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}
export const puedeGrabar = () => typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream && !!tipoVideo();

export class Grabadora {
  constructor() { this.rec = null; this.t0 = 0; this.nombre = ''; }
  get activa() { return !!this.rec && this.rec.state !== 'inactive'; }
  get segundos() { return this.activa ? (performance.now() - this.t0) / 1000 : 0; }
  // canvas: el lienzo · ac: AudioContext · nodos: lo que se graba como audio · alTerminar(info)
  iniciar({ canvas, ac, nodos = [], fps = 60, nombre = 'umbral', alTerminar }) {
    if (this.activa) return false;
    const mime = tipoVideo();
    if (!mime) throw new Error('Este navegador no puede grabar video');
    const vs = canvas.captureStream(fps);
    const pistas = [...vs.getVideoTracks()];
    let dest = null;
    if (ac) {
      dest = ac.createMediaStreamDestination();
      for (const n of nodos) { try { n.connect(dest); } catch {} }
      pistas.push(...dest.stream.getAudioTracks());
    }
    const px = canvas.width * canvas.height;
    const bps = Math.round(Math.min(40e6, Math.max(6e6, px * fps * 0.08)));
    const rec = this.rec = new MediaRecorder(new MediaStream(pistas), { mimeType: mime, videoBitsPerSecond: bps, audioBitsPerSecond: 256000 });
    const trozos = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) trozos.push(e.data); };
    rec.onstop = () => {
      for (const n of nodos) { try { n.disconnect(dest); } catch {} }
      pistas.forEach((t) => t.stop());
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      const blob = new Blob(trozos, { type: mime.split(';')[0] });
      const archivo = `${this.nombre}.${ext}`;
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = archivo;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      const dur = (performance.now() - this.t0) / 1000;
      this.rec = null;
      if (alTerminar) alTerminar({ archivo, bytes: blob.size, dur, mime, ext });
    };
    this.nombre = nombre.replace(/[^\w\-áéíóúñü]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'umbral';
    this.t0 = performance.now();
    rec.start(1000);
    return { mime, bps };
  }
  detener() { if (this.activa) this.rec.stop(); }
}
