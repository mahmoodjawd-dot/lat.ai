// AudioWorklet that turns the mic's float samples (usually 48kHz) into
// 16kHz mono PCM16 chunks of ~100ms, the format AssemblyAI streaming expects.
// It also reports a rough loudness level for the waveform.

const TARGET_SAMPLE_RATE = 16000;
const SAMPLES_PER_CHUNK = 1600; // 100ms at 16kHz; AssemblyAI wants 50–1000ms chunks

class PcmDownsamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputSamplesPerOutputSample = sampleRate / TARGET_SAMPLE_RATE;
    this.fractionalInputPosition = 0;
    this.pendingOutputSamples = new Int16Array(SAMPLES_PER_CHUNK);
    this.pendingOutputSampleCount = 0;
  }

  process(inputs) {
    const monoInputSamples = inputs[0]?.[0];
    if (!monoInputSamples) {
      return true;
    }

    let sumOfSquares = 0;
    for (let sampleIndex = 0; sampleIndex < monoInputSamples.length; sampleIndex++) {
      sumOfSquares += monoInputSamples[sampleIndex] * monoInputSamples[sampleIndex];
    }
    this.port.postMessage({ type: "level", level: Math.sqrt(sumOfSquares / monoInputSamples.length) });

    // Simple decimation: pick the nearest input sample for each output sample.
    while (this.fractionalInputPosition < monoInputSamples.length) {
      const inputSample = monoInputSamples[Math.floor(this.fractionalInputPosition)];
      const clampedSample = Math.max(-1, Math.min(1, inputSample));
      this.pendingOutputSamples[this.pendingOutputSampleCount++] =
        clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff;

      if (this.pendingOutputSampleCount === SAMPLES_PER_CHUNK) {
        this.port.postMessage({ type: "pcm", buffer: this.pendingOutputSamples.buffer }, [this.pendingOutputSamples.buffer]);
        this.pendingOutputSamples = new Int16Array(SAMPLES_PER_CHUNK);
        this.pendingOutputSampleCount = 0;
      }
      this.fractionalInputPosition += this.inputSamplesPerOutputSample;
    }
    this.fractionalInputPosition -= monoInputSamples.length;
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsamplerProcessor);
