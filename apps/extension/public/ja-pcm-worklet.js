// Generated from PCM_WORKLET_SOURCE in packages/voice/src/stt.ts (a test keeps them equal).
class JaPcm extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("ja-pcm", JaPcm);
