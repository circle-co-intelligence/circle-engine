class CaptionCapture extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.size = options.processorOptions.size; this.samples = new Int16Array(this.size); this.n = 0; this.active = true;
    this.port.onmessage = e => { if (e.data === 'stop') this.active = false; };
  }
  process(inputs) {
    if (!this.active) return false;
    const mono = inputs[0]?.[0];
    if (mono) for (const sample of mono) {
      this.samples[this.n++] = Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767));
      if (this.n === this.size) { this.port.postMessage(this.samples.buffer, [this.samples.buffer]); this.samples = new Int16Array(this.size); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('caption-capture', CaptionCapture);
