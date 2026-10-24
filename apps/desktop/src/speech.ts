import type { SpeechOut } from "@justask/core";

/** speechSynthesis at a slow rate (WebView2 supports it). Cartesia Sonic can plug in behind the same interface later. */
export class BrowserSpeech implements SpeechOut {
  private voice: SpeechSynthesisVoice | null = null;
  onSpeaking: (on: boolean) => void = () => {};
  muted = false;

  constructor(private rate = 0.9) {
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.voice =
        vs.find((x) => /^en[-_]US/i.test(x.lang) && /natural|aria|jenny|samantha|google/i.test(x.name)) ??
        vs.find((x) => /^en[-_]US/i.test(x.lang)) ??
        vs.find((x) => /^en/i.test(x.lang)) ??
        null;
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

  /** Speak and resolve when finished (or after `maxMs`), so a following line doesn't cut it off. */
  speakAndWait(text: string, maxMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      if (this.muted || typeof speechSynthesis === "undefined" || !text) return resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = this.rate;
      if (this.voice) u.voice = this.voice;
      const timer = setTimeout(resolve, maxMs);
      u.onstart = () => this.onSpeaking(true);
      u.onend = u.onerror = () => {
        clearTimeout(timer);
        if (!speechSynthesis.speaking) this.onSpeaking(false);
        resolve();
      };
      speechSynthesis.speak(u);
    });
  }

  stop() {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    this.onSpeaking(false);
  }
}
