// Speech output everywhere (extension side panel and desktop app): JustAsk speaks only through
// Cartesia Sonic over the TTS WebSocket (docs.cartesia.ai, API version 2026-08-14), with the same
// short-lived token as listening. Raw float PCM is scheduled gap-free with Web Audio.
// If Cartesia can't be reached, nothing is spoken; the caption on screen still shows every line.
import type { SpeechOut } from "@justask/core";
import { CARTESIA_VERSION } from "./stt";
import type { TokenSource } from "./tokens";

export const CARTESIA_TTS_WS = "wss://api.cartesia.ai/tts/websocket";
export const TTS_MODEL = "sonic-3";
export const TTS_SAMPLE_RATE = 44_100;
/** Cartesia's documented example voice. Set VITE_CARTESIA_VOICE_ID to choose another from the voice library. */
export const DEFAULT_VOICE_ID = "a0e99841-438c-4a64-b679-ae501e7d6091";
/** JustAsk's "Normal" speech rate. Her Slower / Normal / Faster setting is relative to it. */
const NORMAL_RATE = 0.9;

/** Build the TTS WebSocket URL. Token auth only (browser clients never hold the key). */
export function ttsUrl(token: string): string {
  const q = new URLSearchParams({ access_token: token, cartesia_version: CARTESIA_VERSION });
  return `${CARTESIA_TTS_WS}?${q.toString()}`;
}

/** JustAsk's rate setting (0.75 slower, 0.9 normal, 1.1 faster) as Cartesia's speed (0.6–1.5, 1 = normal). */
export function speedFor(rate: number): number {
  const s = (Number.isFinite(rate) && rate > 0 ? rate : NORMAL_RATE) / NORMAL_RATE;
  return Math.round(Math.min(1.5, Math.max(0.6, s)) * 100) / 100;
}

/** One generation request: the whole line in one message (`continue: false`) for the lowest latency. */
export function ttsRequest(o: { text: string; contextId: string; voiceId: string; speed: number; language?: string }) {
  return {
    model_id: TTS_MODEL,
    transcript: o.text,
    voice: { id: o.voiceId },
    output_format: { container: "raw", encoding: "pcm_f32le", sample_rate: TTS_SAMPLE_RATE },
    context_id: o.contextId,
    continue: false,
    language: o.language ?? "en",
    generation_config: { speed: o.speed },
  };
}

/** Base64 to bytes (atob is in every browser and in Node 16+). */
export function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Joins chunk bytes into whole little-endian float32 samples. A chunk may end mid-sample, so the
 * leftover bytes wait for the next one.
 */
export class PcmF32Reader {
  private rest = new Uint8Array(0);

  push(bytes: Uint8Array): Float32Array<ArrayBuffer> {
    const all = new Uint8Array(this.rest.length + bytes.length);
    all.set(this.rest);
    all.set(bytes, this.rest.length);
    const usable = all.length - (all.length % 4);
    this.rest = all.slice(usable);
    const view = new DataView(all.buffer, all.byteOffset, usable);
    const out = new Float32Array(usable / 4);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
}

type TtsMessage =
  | { type: "chunk"; context_id: string; data: string }
  | { type: "done"; context_id: string }
  | { type: "error"; context_id?: string; message?: string; status_code?: number }
  | { type: string; context_id?: string };

export interface SpeechOptions {
  voiceId?: string;
  language?: string;
  /** Test seams. */
  WebSocketImpl?: typeof WebSocket;
  AudioContextImpl?: typeof AudioContext;
  newId?: () => string;
  /** How long to wait for the socket to open before giving up on a line. */
  openTimeoutMs?: number;
}

interface Line {
  id: string;
  reader: PcmF32Reader;
  started: boolean;
  done: boolean;
  sources: Set<AudioBufferSourceNode>;
  finish: () => void;
}

/** JustAsk's voice: Cartesia Sonic. Implements the controller's `SpeechOut`. */
export class CartesiaSpeech implements SpeechOut {
  onSpeaking: (on: boolean) => void = () => {};
  muted = false;
  /** Her speech rate setting (0.75 / 0.9 / 1.1); sent as Cartesia `generation_config.speed`. */
  rate = NORMAL_RATE;

  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket | null> | null = null;
  private ctx: AudioContext | null = null;
  private nextAt = 0;
  private line: Line | null = null;
  private queue: string[] = [];
  /** While the microphone is open, lines wait here, so listening never hears JustAsk. */
  private holding = false;
  private held: string | null = null;
  private readonly WS: typeof WebSocket;
  private readonly AC: typeof AudioContext;

  constructor(
    private tokens: TokenSource,
    private opts: SpeechOptions = {},
  ) {
    this.WS = opts.WebSocketImpl ?? (globalThis.WebSocket as typeof WebSocket);
    this.AC = opts.AudioContextImpl ?? (globalThis.AudioContext as typeof AudioContext);
  }

  /**
   * Hold lines while she is talking; when she stops, say the newest held line. `drop` skips it
   * (she said something, and JustAsk's answer to that replaces it).
   */
  hold(on: boolean, drop = false) {
    this.holding = on;
    if (on) {
      this.queue = [];
      this.stopLine();
      return;
    }
    const t = this.held;
    this.held = null;
    if (t && !drop) this.speak(t);
  }

  /** Say a line. `interrupt: false` queues it after the current line instead of cutting it off. */
  speak(text: string, opts: { interrupt?: boolean } = {}) {
    if (this.muted || !text.trim()) return;
    if (this.holding) {
      this.held = text;
      return;
    }
    if (opts.interrupt === false && this.line) {
      this.queue.push(text);
      return;
    }
    this.queue = [];
    void this.say(text);
  }

  /** Speak and resolve when finished (or after `maxMs`), so a following action doesn't cut it off. */
  speakAndWait(text: string, maxMs = 8000): Promise<void> {
    if (this.muted || !text.trim()) return Promise.resolve();
    this.queue = [];
    return Promise.race([this.say(text), new Promise<void>((r) => setTimeout(r, maxMs))]);
  }

  stop() {
    this.queue = [];
    this.held = null;
    this.stopLine();
  }

  // ───────────── internals ─────────────

  private newId(): string {
    return this.opts.newId?.() ?? globalThis.crypto?.randomUUID?.() ?? `ja-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /** Cancel the current line on the server and silence what is already scheduled. */
  private stopLine() {
    const l = this.line;
    if (!l) return;
    this.line = null;
    if (this.ws?.readyState === this.WS.OPEN) {
      try {
        this.ws.send(JSON.stringify({ context_id: l.id, cancel: true }));
      } catch {
        /* socket closing */
      }
    }
    for (const s of l.sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    l.sources.clear();
    this.nextAt = 0;
    l.finish();
  }

  private say(text: string): Promise<void> {
    this.stopLine();
    return new Promise<void>((resolve) => {
      let settled = false;
      const line: Line = {
        id: this.newId(),
        reader: new PcmF32Reader(),
        started: false,
        done: false,
        sources: new Set(),
        finish: () => {
          if (settled) return;
          settled = true;
          if (this.line === line) this.line = null;
          this.onSpeaking(false);
          resolve();
          // Lines queued with `interrupt: false` play next (not while she is talking).
          const next = this.line || this.holding ? undefined : this.queue.shift();
          if (next) void this.say(next);
        },
      };
      this.line = line;
      void (async () => {
        const ws = await this.socket();
        if (this.line !== line) return;
        if (!ws) return line.finish();
        try {
          const ctx = this.audio();
          if (ctx.state === "suspended") void ctx.resume().catch(() => {});
          ws.send(JSON.stringify(ttsRequest({ text, contextId: line.id, voiceId: this.opts.voiceId || DEFAULT_VOICE_ID, speed: speedFor(this.rate), language: this.opts.language })));
        } catch {
          line.finish();
        }
      })();
    });
  }

  private audio(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") this.ctx = new this.AC({ sampleRate: TTS_SAMPLE_RATE });
    return this.ctx;
  }

  /** The open socket, opening one with a fresh token when needed. Null when Cartesia can't be reached. */
  private socket(): Promise<WebSocket | null> {
    if (this.ws && this.ws.readyState === this.WS.OPEN) return Promise.resolve(this.ws);
    if (this.opening) return this.opening;
    this.opening = (async () => {
      let token: string | null = null;
      try {
        token = await this.tokens.get();
      } catch {
        token = null;
      }
      if (!token) return null;
      return new Promise<WebSocket | null>((resolve) => {
        let ws: WebSocket;
        try {
          ws = new this.WS(ttsUrl(token!));
        } catch {
          return resolve(null);
        }
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          resolve(null);
        }, this.opts.openTimeoutMs ?? 5000);
        ws.onopen = () => {
          clearTimeout(timer);
          this.ws = ws;
          resolve(ws);
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve(null);
        };
        ws.onclose = () => {
          clearTimeout(timer);
          if (this.ws === ws) this.ws = null;
          // A line still waiting on this socket can't finish now.
          if (this.line && !this.line.done) this.line.finish();
          resolve(null);
        };
        ws.onmessage = (ev) => this.onMessage(ev.data);
      });
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private onMessage(data: unknown) {
    if (typeof data !== "string") return;
    let msg: TtsMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const l = this.line;
    if (!l || msg.context_id !== l.id) return; // a cancelled line's late chunks
    if (msg.type === "chunk" && typeof (msg as { data?: unknown }).data === "string") return this.play(l, (msg as { data: string }).data);
    if (msg.type === "done") {
      l.done = true;
      if (l.sources.size === 0) l.finish();
      return;
    }
    if (msg.type === "error") l.finish();
  }

  private play(l: Line, b64: string) {
    const samples = l.reader.push(base64Bytes(b64));
    if (!samples.length) return;
    const ctx = this.audio();
    const buf = ctx.createBuffer(1, samples.length, TTS_SAMPLE_RATE);
    buf.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.nextAt);
    this.nextAt = at + buf.duration;
    l.sources.add(src);
    src.onended = () => {
      l.sources.delete(src);
      if (l.done && l.sources.size === 0) l.finish();
    };
    src.start(at);
    if (!l.started) {
      l.started = true;
      this.onSpeaking(true);
    }
  }
}
