// Live check of JustAsk's Cartesia voice against a Convex deployment that has CARTESIA_API_KEY.
// Run: CONVEX_URL=https://<deployment>.convex.cloud npm run test:voice
// Uses DEVICE_TOKEN if set; otherwise creates a throwaway account named "Voice check" on that deployment.
import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { base64Bytes, DEFAULT_VOICE_ID, PcmF32Reader, sttUrl, ttsRequest, ttsUrl } from "../src";

const url = process.env.CONVEX_URL;
if (!url) throw new Error("Set CONVEX_URL to a deployment with CARTESIA_API_KEY.");
const convex = new ConvexHttpClient(url);
const ok = (m: string) => console.log("✓", m);

let device = process.env.DEVICE_TOKEN;
if (!device) {
  ({ token: device } = (await convex.mutation("accounts:createSelf" as never, { displayName: "Voice check", device: { kind: "extension", platform: "test", label: "voice check" } } as never)) as { token: string });
}
const minted = (await convex.action("voice:cartesiaToken" as never, { token: device } as never)) as { token: string; expiresAt: number };
assert.ok(minted.token && minted.expiresAt > Date.now(), "voice:cartesiaToken returns a token");
ok("Convex minted a short-lived Cartesia token (the key stayed in Convex)");

/** Open a socket and collect JSON messages until `until` says stop (or timeout). */
function talk(wsUrl: string, send: (ws: WebSocket) => void, until: (msg: any) => boolean, ms = 15_000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const got: any[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out; got ${got.map((m) => m.type).join(", ") || "nothing"}`));
    }, ms);
    ws.onopen = () => send(ws);
    ws.onerror = () => reject(new Error("socket error"));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data);
      got.push(msg);
      if (msg.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`Cartesia error: ${msg.title ?? ""} ${msg.message ?? ""}`));
      } else if (until(msg)) {
        clearTimeout(timer);
        ws.close();
        resolve(got);
      }
    };
  });
}

// Speaking: Sonic returns audio for one line.
const voiceId = process.env.CARTESIA_VOICE_ID || DEFAULT_VOICE_ID;
const t0 = Date.now();
const tts = await talk(
  ttsUrl(minted.token),
  (ws) => ws.send(JSON.stringify(ttsRequest({ text: "Click the big blue button that says Refill a prescription.", contextId: "voice-check", voiceId, speed: 1 }))),
  (m) => m.type === "done",
);
const reader = new PcmF32Reader();
const samples = tts.filter((m) => m.type === "chunk").reduce((n, m) => n + reader.push(base64Bytes(m.data)).length, 0);
assert.ok(samples > 44_100, "at least a second of audio");
ok(`Sonic spoke the line: ${(samples / 44_100).toFixed(1)} s of audio, first byte to done in ${Date.now() - t0} ms`);

// Listening: the STT socket accepts the token and closes cleanly on "done".
const stt = await talk(
  sttUrl(minted.token),
  (ws) => {
    ws.send(new Int16Array(16_000).buffer); // one second of silence
    ws.send("done");
  },
  (m) => m.type === "done",
);
assert.ok(stt.some((m) => m.type === "done"));
ok("ink-whisper STT accepted the token and audio");

console.log("\nCartesia voice works on this deployment");
