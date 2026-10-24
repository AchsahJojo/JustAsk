// Speech input for the desktop app. WebView2 has no working Web Speech recognition, so this
// streams the microphone to Cartesia's streaming STT WebSocket (docs.cartesia.ai, API version
// 2026-08-14) with a short-lived access token minted by the Convex action voice:cartesiaToken.
// The API key never reaches the app. Any failure falls back to the typed box.

export const CARTESIA_STT_WS = "wss://api.cartesia.ai/stt/websocket";
export const CARTESIA_VERSION = "2026-08-14";
export const STT_SAMPLE_RATE = 16_000;

/** Messages spoken to the user. Short and plain. */
export const STT_MESSAGES = {
  unavailable: "Voice isn't working right now. Please type instead.",
  micOff: "The microphone is off. You can type instead.",
  noSpeech: "I didn't hear anything. Try again, or type it.",
} as const;

/** Build the STT WebSocket URL. `ink-whisper` finalizes by itself after a pause, which suits press-to-talk. */
export function sttUrl(token: string, opts: { silenceSecs?: number; language?: string } = {}): string {
  const q = new URLSearchParams({
    model: "ink-whisper",
    encoding: "pcm_s16le",
    sample_rate: String(STT_SAMPLE_RATE),
    language: opts.language ?? "en",
    cartesia_version: CARTESIA_VERSION,
    max_silence_duration_secs: String(opts.silenceSecs ?? 1.2),
    access_token: token,
  });
  return `${CARTESIA_STT_WS}?${q.toString()}`;
}

/** Float samples in [-1, 1] to little-endian signed 16-bit PCM (clamped). */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export type SttMessage =
  | { type: "transcript"; is_final: boolean; text: string }
  | { type: "flush_done" }
  | { type: "done" }
  | { type: "error"; message?: string; title?: string };

/**
 * Accumulates Cartesia transcript messages. Final chunks are deltas and are concatenated
 * exactly as sent (no trimming, no added spaces). A non-final chunk is the current guess.
 */
export class TranscriptBuffer {
  private finalText = "";
  private interim = "";
  gotFinal = false;

  push(msg: SttMessage): string {
    if (msg.type === "transcript") {
      if (msg.is_final) {
        this.finalText += msg.text ?? "";
        this.interim = "";
        this.gotFinal = true;
      } else {
        this.interim = msg.text ?? "";
      }
    }
    return this.text;
  }

  get text(): string {
    return this.finalText + this.interim;
  }
}

export interface ListenHandlers {
  onInterim: (t: string) => void;
  onFinal: (t: string) => void;
  onError: (msg: string) => void;
  onEnd: () => void;
}

const WORKLET = `class JaPcm extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("ja-pcm", JaPcm);`;

/** Press-to-talk listener over Cartesia STT. One utterance per `listen`; pressing again finishes it. */
export class CartesiaListener {
  private active: { finish: () => void; abort: () => void } | null = null;

  constructor(
    private getToken: () => Promise<string | null>,
    private limits = { maxMs: 15_000, noSpeechMs: 8_000, closeWaitMs: 2_500 },
  ) {}

  static supported(): boolean {
    return (
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof WebSocket !== "undefined" &&
      typeof AudioContext !== "undefined"
    );
  }

  get listening(): boolean {
    return !!this.active;
  }

  /** Stop listening and deliver what was heard. */
  stop() {
    this.active?.finish();
  }

  /** Stop listening and drop what was heard (used by Stop). */
  cancel() {
    this.active?.abort();
  }

  async listen(h: ListenHandlers): Promise<void> {
    if (this.active) return this.stop();
    if (!CartesiaListener.supported()) {
      h.onError(STT_MESSAGES.unavailable);
      h.onEnd();
      return;
    }

    let ended = false;
    let ws: WebSocket | null = null;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const buf = new TranscriptBuffer();
    const pending: ArrayBuffer[] = [];
    let finishing = false;

    const stopMic = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      void ctx?.close().catch(() => {});
      ctx = null;
    };
    const end = (result: { text?: string; error?: string }) => {
      if (ended) return;
      ended = true;
      timers.forEach(clearTimeout);
      stopMic();
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
      this.active = null;
      h.onEnd();
      if (result.error) h.onError(result.error);
      else if (result.text) h.onFinal(result.text);
    };
    const deliver = () => {
      const text = buf.text.trim();
      end(text ? { text } : { error: STT_MESSAGES.noSpeech });
    };
    const finish = () => {
      if (ended || finishing) return;
      finishing = true;
      stopMic();
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send("close");
        } catch {
          return deliver();
        }
        timers.push(setTimeout(deliver, this.limits.closeWaitMs));
      } else deliver();
    };
    this.active = { finish, abort: () => end({}) };

    // 1. Token from Convex.
    let token: string | null = null;
    try {
      token = await this.getToken();
    } catch {
      token = null;
    }
    if (ended) return;
    if (!token) return end({ error: STT_MESSAGES.unavailable });

    // 2. Microphone.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const denied = (e as { name?: string })?.name === "NotAllowedError";
      return end({ error: denied ? STT_MESSAGES.micOff : STT_MESSAGES.unavailable });
    }
    if (ended) return stopMic();

    // 3. Socket.
    try {
      ws = new WebSocket(sttUrl(token));
      ws.binaryType = "arraybuffer";
    } catch {
      return end({ error: STT_MESSAGES.unavailable });
    }
    ws.onopen = () => {
      for (const chunk of pending.splice(0)) ws?.send(chunk);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: SttMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "error") return end({ error: STT_MESSAGES.unavailable });
      if (msg.type === "done") return deliver();
      const text = buf.push(msg);
      if (text) h.onInterim(text);
      // ink-whisper finalizes after a pause: one utterance per press.
      if (msg.type === "transcript" && msg.is_final && buf.text.trim()) finish();
    };
    ws.onerror = () => {
      if (finishing) deliver();
      else end({ error: STT_MESSAGES.unavailable });
    };
    ws.onclose = () => {
      if (finishing) deliver();
      else if (!ended) end({ error: STT_MESSAGES.unavailable });
    };

    // 4. Audio: 16 kHz mono, ~100 ms chunks of Int16 PCM.
    try {
      ctx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (ended || !ctx || !stream) return;
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "ja-pcm");
      const chunk = Math.round(ctx.sampleRate / 10);
      let acc: number[] = [];
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        if (finishing || ended) return;
        for (const s of ev.data) acc.push(s);
        if (acc.length < chunk) return;
        const pcm = floatToPcm16(Float32Array.from(acc)).buffer as ArrayBuffer;
        acc = [];
        if (ws?.readyState === WebSocket.OPEN) ws.send(pcm);
        else if (ws?.readyState === WebSocket.CONNECTING) pending.push(pcm);
      };
      src.connect(node);
      // Chromium only pulls nodes that reach the destination. The worklet writes no output, so this is silent.
      node.connect(ctx.destination);
    } catch {
      return end({ error: STT_MESSAGES.unavailable });
    }

    timers.push(setTimeout(finish, this.limits.maxMs));
    timers.push(
      setTimeout(() => {
        if (!buf.text.trim()) finish();
      }, this.limits.noSpeechMs),
    );
  }
}
