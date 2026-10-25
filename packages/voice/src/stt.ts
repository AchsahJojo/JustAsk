// Speech input everywhere (extension side panel and desktop app): JustAsk listens only through
// Cartesia's streaming STT WebSocket (docs.cartesia.ai, API version 2026-08-14), with a short-lived
// access token minted by the Convex action voice:cartesiaToken. The API key never reaches the client.
// Any failure falls back to the typed box.
import { NO_ACCOUNT, type TokenSource } from "./tokens";

export const CARTESIA_STT_WS = "wss://api.cartesia.ai/stt/websocket";
export const CARTESIA_VERSION = "2026-08-14";
export const STT_SAMPLE_RATE = 16_000;

/** Messages spoken to the user. Short and plain. */
export const STT_MESSAGES = {
  unavailable: "Voice isn't working right now. Please type instead.",
  micOff: "The microphone is off. You can type instead.",
  noSpeech: "I didn't hear anything. Try again, or type it.",
  noAccount: "Voice works once your JustAsk is set up. Open Settings to set it up, or type instead.",
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

/** How long the user gets: to start talking, to pause mid-sentence, and in total. */
export interface TurnLimits {
  /** Quiet from the moment the mic is live until listening gives up ("I didn't hear anything"). */
  startMs: number;
  /** Quiet after speech before the turn is over. Pauses shorter than this never cut the user off. */
  silenceMs: number;
  /** Longest single turn. */
  maxMs: number;
  /** Microphone level (RMS of float samples) that counts as speech. */
  threshold: number;
}

export const DEFAULT_TURN: TurnLimits = { startMs: 3_000, silenceMs: 2_000, maxMs: 30_000, threshold: 0.01 };

/** Root mean square of a block of float samples: its loudness. */
export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Decides when a press-to-talk turn is over, from what the microphone hears (not from the speech
 * service, whose own end-of-sentence comes after a short pause). Feed it every audio block.
 */
export class TurnTimer {
  private heardAt: number | null = null;

  constructor(
    private startedAt: number,
    private limits: TurnLimits = DEFAULT_TURN,
  ) {}

  /** Something was heard at `t` (a loud enough block, or words from the speech service). */
  voice(t: number) {
    this.heardAt = t;
  }

  get heard(): boolean {
    return this.heardAt !== null;
  }

  /** One audio block at time `t`. Returns why the turn should end now, or null to keep listening. */
  feed(level: number, t: number): "no-speech" | "finished" | "too-long" | null {
    if (level >= this.limits.threshold) this.heardAt = t;
    if (t - this.startedAt >= this.limits.maxMs) return "too-long";
    if (this.heardAt === null) return t - this.startedAt >= this.limits.startMs ? "no-speech" : null;
    return t - this.heardAt >= this.limits.silenceMs ? "finished" : null;
  }
}

export interface ListenHandlers {
  /** The microphone is live and recording (audio is kept from here on, even before Cartesia connects). */
  onReady?: () => void;
  onInterim: (t: string) => void;
  onFinal: (t: string) => void;
  onError: (msg: string) => void;
  onEnd: () => void;
}

/** The microphone worklet: posts each 128-sample block of channel 0 to the page. */
export const PCM_WORKLET_SOURCE = `class JaPcm extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("ja-pcm", JaPcm);`;

export interface ListenerOptions {
  /**
   * URL of a file holding the PCM worklet (`PCM_WORKLET_SOURCE`). Extension pages need this: their
   * content security policy blocks `blob:` scripts. Default: a blob URL (desktop WebView).
   */
  workletUrl?: string;
  /** Turn timing; defaults to `DEFAULT_TURN` (3 s to start, 2 s of quiet to finish). */
  turn?: Partial<TurnLimits>;
  /** How long to wait for the last words after the turn ends. */
  closeWaitMs?: number;
}

/** Press-to-talk listener over Cartesia STT. One utterance per `listen`; pressing again finishes it. */
export class CartesiaListener {
  private active: { finish: () => void; abort: () => void } | null = null;
  private turn: TurnLimits;
  private closeWaitMs: number;

  constructor(
    private tokens: TokenSource,
    private opts: ListenerOptions = {},
  ) {
    this.turn = { ...DEFAULT_TURN, ...opts.turn };
    this.closeWaitMs = opts.closeWaitMs ?? 2_500;
  }

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
        timers.push(setTimeout(deliver, this.closeWaitMs));
      } else if (pending.length && (!ws || ws.readyState === WebSocket.CONNECTING)) {
        // Spoke before the socket was up: the buffered audio goes out when it opens (see onopen).
        timers.push(setTimeout(deliver, this.closeWaitMs + 5_000));
      } else deliver();
    };
    this.active = { finish, abort: () => end({}) };

    // 1. Token: asked for now, alongside the microphone (usually cached already), never before it.
    const tokenP = this.tokens.get().then(
      (token) => ({ token, noAccount: false }),
      (e: unknown) => ({ token: null as string | null, noAccount: (e as Error)?.message === NO_ACCOUNT }),
    );
    // A cached token or "no account yet" answers within a few ms: no account means no voice,
    // so say so without asking for the microphone. A real fetch keeps running alongside the mic.
    const early = await Promise.race([tokenP, new Promise<null>((r) => setTimeout(() => r(null), 30))]);
    if (ended) return;
    if (early?.noAccount) return end({ error: STT_MESSAGES.noAccount });

    // 2. Microphone and audio straight away: capture starts with the click. Until the socket is
    //    open, blocks wait in `pending`, so the start of a sentence is never lost.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const denied = (e as { name?: string })?.name === "NotAllowedError";
      return end({ error: denied ? STT_MESSAGES.micOff : STT_MESSAGES.unavailable });
    }
    if (ended) return stopMic();

    // 16 kHz mono, ~100 ms blocks of Int16 PCM. The turn clock starts when the mic is live.
    let turn: TurnTimer | null = null;
    try {
      ctx = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
      if (this.opts.workletUrl) await ctx.audioWorklet.addModule(this.opts.workletUrl);
      else {
        const url = URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
      }
      if (ended || !ctx || !stream) return;
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "ja-pcm");
      const chunk = Math.round(ctx.sampleRate / 10);
      let acc: number[] = [];
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        if (finishing || ended) return;
        for (const s of ev.data) acc.push(s);
        if (acc.length < chunk) return;
        const block = Float32Array.from(acc);
        const pcm = floatToPcm16(block).buffer as ArrayBuffer;
        acc = [];
        const now = Date.now();
        turn ??= new TurnTimer(now, this.turn);
        const over = turn.feed(rms(block), now);
        if (ws?.readyState === WebSocket.OPEN) ws.send(pcm);
        else pending.push(pcm);
        if (over) finish();
      };
      src.connect(node);
      // Chromium only pulls nodes that reach the destination. The worklet writes no output, so this is silent.
      node.connect(ctx.destination);
    } catch {
      return end({ error: STT_MESSAGES.unavailable });
    }
    h.onReady?.();

    // 3. Socket, once the token is here. Buffered audio goes first.
    const { token, noAccount } = await tokenP;
    if (ended) return;
    if (!token) return end({ error: noAccount ? STT_MESSAGES.noAccount : STT_MESSAGES.unavailable });
    try {
      ws = new WebSocket(sttUrl(token));
      ws.binaryType = "arraybuffer";
    } catch {
      return end({ error: STT_MESSAGES.unavailable });
    }
    ws.onopen = () => {
      for (const block of pending.splice(0)) ws?.send(block);
      if (finishing) {
        try {
          ws?.send("close");
        } catch {
          return deliver();
        }
        timers.push(setTimeout(deliver, this.closeWaitMs));
      }
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
      if (text) {
        h.onInterim(text);
        turn?.voice(Date.now()); // words count as speech, even from a quiet voice
      }
      // The turn ends on the user's quiet (TurnTimer), not on the service's end-of-sentence:
      // a pause to think never cuts them off.
    };
    ws.onerror = () => {
      if (finishing) deliver();
      else end({ error: STT_MESSAGES.unavailable });
    };
    ws.onclose = () => {
      if (finishing) deliver();
      else if (!ended) end({ error: STT_MESSAGES.unavailable });
    };

    // Backstop if audio blocks stop arriving (a stalled device): never listen forever.
    timers.push(setTimeout(finish, this.turn.maxMs + this.turn.startMs));
  }
}
