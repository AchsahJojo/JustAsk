import type { SpeechOut } from "@justask/core";

/** speechSynthesis at a slow rate. Cartesia Sonic plugs in behind the same interface later. */
export class BrowserSpeech implements SpeechOut {
  private voice: SpeechSynthesisVoice | null = null;
  onSpeaking: (on: boolean) => void = () => {};
  muted = false;

  constructor(private rate = 0.9) {
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.voice = vs.find((x) => /^en[-_]US/i.test(x.lang) && /natural|samantha|google/i.test(x.name)) ?? vs.find((x) => /^en[-_]US/i.test(x.lang)) ?? vs.find((x) => /^en/i.test(x.lang)) ?? null;
    };
    if (typeof speechSynthesis !== "undefined") {
      pick();
      speechSynthesis.addEventListener?.("voiceschanged", pick);
    }
  }

  speak(text: string, opts: { interrupt?: boolean } = {}) {
    if (this.muted || typeof speechSynthesis === "undefined" || !text) return;
    if (opts.interrupt !== false) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this.rate;
    if (this.voice) u.voice = this.voice;
    u.onstart = () => this.onSpeaking(true);
    u.onend = u.onerror = () => {
      if (!speechSynthesis.speaking) this.onSpeaking(false);
    };
    speechSynthesis.speak(u);
  }

  stop() {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.onSpeaking(false);
  }
}

type SR = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

/** Web Speech recognition (Chrome, Edge). Brave/Firefox/Safari need Cartesia STT (Phase 1). */
export class BrowserListener {
  private rec: SR | null = null;
  static supported() {
    return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }

  get listening() {
    return !!this.rec;
  }

  listen(handlers: { onInterim: (t: string) => void; onFinal: (t: string) => void; onError: (msg: string) => void; onEnd: () => void }) {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return handlers.onError("Voice isn't available in this browser. Type instead.");
    if (this.rec) return this.stop();
    const r: SR = new Ctor();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = false;
    let finalText = "";
    let last = "";
    r.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      last = t;
      handlers.onInterim(t);
      if (e.results[e.results.length - 1].isFinal) finalText = t;
    };
    r.onerror = (e) =>
      handlers.onError(
        e.error === "not-allowed"
          ? "The microphone is off. Open JustAsk setup to turn it on, or type instead."
          : e.error === "no-speech"
            ? "I didn't hear anything. Try again."
            : "I didn't catch that. Try again.",
      );
    r.onend = () => {
      this.rec = null;
      handlers.onEnd();
      const t = (finalText || last).trim();
      if (t) handlers.onFinal(t);
    };
    this.rec = r;
    try {
      r.start();
    } catch {
      this.rec = null;
      handlers.onError("Could not start the microphone.");
    }
  }

  stop() {
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
  }
}
