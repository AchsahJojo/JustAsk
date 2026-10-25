import { describe, expect, it } from "vitest";
import { CARTESIA_VERSION, floatToPcm16, rms, sttUrl, TranscriptBuffer, TurnTimer } from "../src/stt";

describe("sttUrl", () => {
  it("targets Cartesia's STT socket with a token, never a key", () => {
    const u = new URL(sttUrl("tok_123"));
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe("wss://api.cartesia.ai/stt/websocket");
    expect(u.searchParams.get("access_token")).toBe("tok_123");
    expect(u.searchParams.get("model")).toBe("ink-whisper");
    expect(u.searchParams.get("encoding")).toBe("pcm_s16le");
    expect(u.searchParams.get("sample_rate")).toBe("16000");
    expect(u.searchParams.get("cartesia_version")).toBe(CARTESIA_VERSION);
    expect(u.searchParams.get("language")).toBe("en");
    expect(u.searchParams.has("api_key")).toBe(false);
  });
});

describe("floatToPcm16", () => {
  it("scales and clamps", () => {
    expect(Array.from(floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });
});

describe("TranscriptBuffer", () => {
  it("concatenates final deltas exactly and shows the interim guess", () => {
    const b = new TranscriptBuffer();
    expect(b.push({ type: "transcript", is_final: false, text: "make the" })).toBe("make the");
    expect(b.push({ type: "transcript", is_final: true, text: "Make the text" })).toBe("Make the text");
    expect(b.gotFinal).toBe(true);
    expect(b.push({ type: "transcript", is_final: false, text: " big" })).toBe("Make the text big");
    expect(b.push({ type: "transcript", is_final: true, text: " bigger." })).toBe("Make the text bigger.");
    expect(b.push({ type: "done" })).toBe("Make the text bigger.");
  });
});

describe("TurnTimer (3 s to start, 2 s of quiet to finish)", () => {
  const quiet = 0.001;
  const loud = 0.05;
  it("gives the user 3 seconds to start talking", () => {
    const t = new TurnTimer(0);
    expect(t.feed(quiet, 2_900)).toBeNull();
    expect(t.feed(quiet, 3_000)).toBe("no-speech");
  });
  it("a pause shorter than 2 seconds never ends the turn; 2 seconds of quiet does", () => {
    const t = new TurnTimer(0);
    expect(t.feed(loud, 1_000)).toBeNull();
    expect(t.feed(quiet, 2_900)).toBeNull(); // 1.9 s pause to think
    expect(t.feed(loud, 3_000)).toBeNull();
    expect(t.feed(quiet, 4_900)).toBeNull();
    expect(t.feed(quiet, 5_000)).toBe("finished");
  });
  it("words from the speech service count as talking, even from a quiet voice", () => {
    const t = new TurnTimer(0);
    t.voice(2_500);
    expect(t.feed(quiet, 3_100)).toBeNull();
    expect(t.feed(quiet, 4_500)).toBe("finished");
  });
  it("stops a very long turn", () => {
    const t = new TurnTimer(0);
    expect(t.feed(loud, 29_900)).toBeNull();
    expect(t.feed(loud, 30_000)).toBe("too-long");
  });
  it("rms measures loudness", () => {
    expect(rms([0, 0, 0])).toBe(0);
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
    expect(rms([])).toBe(0);
  });
});
