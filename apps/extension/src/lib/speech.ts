// JustAsk's voice in the extension: Cartesia only, for listening and for speaking (packages/voice).
// One token cache per page, shared by the speaker and the listener.
import { browser } from "wxt/browser";
import { CartesiaListener, CartesiaSpeech, CartesiaTokens } from "@justask/voice";
import { backend } from "./backend";

/**
 * Whether the voice service answered the last token request. When it didn't (no key on the server,
 * Cartesia down), JustAsk keeps working with captions and typing, and the panel says the voice is off.
 */
let voiceUp = true;
const voiceWatchers = new Set<(up: boolean) => void>();
function setVoiceUp(up: boolean) {
  if (up === voiceUp) return;
  voiceUp = up;
  for (const w of voiceWatchers) w(up);
}
export function onVoiceStatus(w: (up: boolean) => void): () => void {
  voiceWatchers.add(w);
  w(voiceUp);
  return () => voiceWatchers.delete(w);
}

export const voiceTokens = new CartesiaTokens(async () => {
  // No account yet throws, and the panel already explains that; only a real outage flips the status.
  const r = await backend.cartesiaToken();
  setVoiceUp(r !== null);
  return r;
});

/** Voice ID from the build (VITE_CARTESIA_VOICE_ID), else Cartesia's documented default. */
const voiceId = import.meta.env.VITE_CARTESIA_VOICE_ID || undefined;

export function newSpeech(): CartesiaSpeech {
  return new CartesiaSpeech(voiceTokens, { voiceId });
}

/** Press-to-talk over Cartesia STT. The worklet ships as a file: extension pages block `blob:` scripts. */
export function newListener(): CartesiaListener {
  return new CartesiaListener(voiceTokens, { workletUrl: browser.runtime.getURL("/ja-pcm-worklet.js") });
}

export type { CartesiaListener, CartesiaSpeech };
