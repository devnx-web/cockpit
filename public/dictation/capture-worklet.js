// AudioWorklet de captura — roda na THREAD DE ÁUDIO (não na principal), então
// não picota mesmo com o modelo carregando/inferindo. Acumula ~2048 amostras
// e manda pro worker via port. Substitui o ScriptProcessorNode (deprecado e
// que engasgava sob carga, corrompendo o áudio).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      this._buf.push(input[0].slice(0)); // cópia do quantum (128 amostras)
      this._n += input[0].length;
      if (this._n >= 2048) {
        const out = new Float32Array(this._n);
        let off = 0;
        for (const b of this._buf) { out.set(b, off); off += b.length; }
        this.port.postMessage(out, [out.buffer]); // transfere (sem cópia)
        this._buf = [];
        this._n = 0;
      }
    }
    return true; // mantém o processor vivo
  }
}
registerProcessor("capture-processor", CaptureProcessor);
