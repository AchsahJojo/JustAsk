// JustAsk's voice in the extension: Cartesia only, for listening and for speaking (packages/voice).
// One token cache per page, shared by the speaker and the listener.
import { browser } from "wxt/browser";
import { CartesiaListener, CartesiaSpeech, CartesiaTokens } from "@justask/voice";
import { backend } from "./backend";

export const voiceTokens = new CartesiaTokens(() => backend.cartesiaToken());

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
