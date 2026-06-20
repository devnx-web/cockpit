// =========================================================
// Worker de ditado (renderer oculto) — captura de áudio
// Captura o microfone via AudioWorklet (thread de áudio, sem picotar) e manda
// o PCM pro main quando para. A transcrição é no Groq (whisper-large-v3), feita
// no main process. Sem modelo local.
//
// IPC (window.dictation / dictation-preload.cjs):
//   recebe: onCmd({ action:"start"|"stop" })
//   emite:  { type:"status", status:"recording"|"capturing"|"error", detail? }
//           { type:"final-audio", buf:<ArrayBuffer Float32 16k>, rate:16000 }
// =========================================================
const TARGET_RATE = 16000;

const D = window.dictation;
const emit = (o) => { try { D.emit(o); } catch (e) { console.error(e); } };
const status = (status, detail) => emit({ type: "status", status, detail });

let recording = false;
let starting = false;
let stopRequested = false;

let audioCtx = null;
let mediaStream = null;
let srcNode = null;
let workletNode = null;
let chunks = [];
let ctxRate = TARGET_RATE;

// ---------------------------------------------------------
// Captura (AudioWorklet — thread de áudio dedicada, não picota)
// ---------------------------------------------------------
async function startCapture() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  });
  audioCtx = new AudioContext(); // taxa nativa; resample pra 16k no fim
  ctxRate = audioCtx.sampleRate;
  console.log(`[dictation] AudioContext sampleRate=${ctxRate}`);
  await audioCtx.audioWorklet.addModule("/dictation/capture-worklet.js");
  srcNode = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "capture-processor");
  chunks = [];
  workletNode.port.onmessage = (ev) => { if (recording) chunks.push(ev.data); };
  srcNode.connect(workletNode);
  workletNode.connect(audioCtx.destination); // puxa o processor (saída = silêncio)
}

async function stopCapture() {
  try { if (workletNode) { workletNode.port.onmessage = null; workletNode.disconnect(); } } catch {}
  try { if (srcNode) srcNode.disconnect(); } catch {}
  try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (audioCtx) await audioCtx.close(); } catch {}
  workletNode = srcNode = mediaStream = audioCtx = null;
}

function collectAudio() {
  if (!chunks.length) return new Float32Array(0);
  let len = 0;
  for (const c of chunks) len += c.length;
  const merged = new Float32Array(len);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return resampleTo16k(merged, ctxRate);
}

function resampleTo16k(input, inRate) {
  if (inRate === TARGET_RATE || input.length === 0) return input;
  const ratio = inRate / TARGET_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  // média por janela (filtro caixa) = downsample com anti-aliasing simples
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let s = 0, c = 0;
    for (let j = start; j < end; j++) { s += input[j]; c++; }
    out[i] = c ? s / c : (input[start] || 0);
  }
  return out;
}

// ---------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------
async function onStart() {
  if (recording || starting) return;
  starting = true;
  stopRequested = false;
  try {
    await startCapture();
  } catch (e) {
    starting = false;
    status("error", `mic falhou: ${e?.message || e}`);
    await stopCapture();
    return;
  }
  if (stopRequested) { // pararam durante o start
    starting = false;
    await stopCapture();
    chunks = [];
    emit({ type: "final-audio", buf: new Float32Array(0).buffer, rate: TARGET_RATE });
    return;
  }
  recording = true;
  starting = false;
  status("recording");
}

async function onStop() {
  if (starting) { stopRequested = true; return; }
  if (!recording) { emit({ type: "final-audio", buf: new Float32Array(0).buffer, rate: TARGET_RATE }); return; }
  recording = false;
  status("capturing");
  const audio = collectAudio();
  console.log(`[dictation] capturado ${(audio.length / TARGET_RATE).toFixed(1)}s`);
  await stopCapture();
  chunks = [];
  emit({ type: "final-audio", buf: audio.buffer.slice(0), rate: TARGET_RATE });
}

D.onCmd(async (cmd) => {
  if (!cmd || !cmd.action) return;
  if (cmd.action === "start") await onStart();
  else if (cmd.action === "stop") await onStop();
});

console.log("[dictation] worker de captura pronto");
status("ready");
