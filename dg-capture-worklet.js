// Mic capture for Deepgram, running in the AUDIO thread.
//
// This replaces a ScriptProcessorNode, whose onaudioprocess callback ran on the
// MAIN thread: with 15+ tiles and video decoding, a busy frame simply missed the
// callback and those samples were gone — words dropped out of the transcript and
// Deepgram saw silence gaps (a good suspect for the mobile STT churn).
// A worklet keeps pulling at audio-thread priority and posts finished chunks;
// main-thread jank can only delay delivery, never lose samples.
//
// Served from static/ as /dg-capture-worklet.js. Keep it plain ES2019 — it is
// loaded verbatim by addModule(), not bundled.
class DgCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // 4096 frames matches the old ScriptProcessor buffer → identical packet
    // cadence towards Deepgram (~85ms at 48kHz).
    this.chunkSize = opts.chunkSize > 0 ? opts.chunkSize : 4096;
    this.buf = new Float32Array(this.chunkSize);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    // No input yet (track muted / not connected): stay alive, emit nothing.
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.chunkSize) {
        const out = this.buf.slice(0);
        this.port.postMessage(out, [out.buffer]); // transfer, no copy
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('dg-capture', DgCaptureProcessor);
