import { describe, expect, it, vi } from "vitest";
import { CartesiaSpeech, CartesiaTokens, DEFAULT_VOICE_ID, NO_ACCOUNT, PcmF32Reader, speedFor, ttsUrl } from "../src";

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = FakeWS.CONNECTING;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWS.OPEN;
      this.onopen?.();
    });
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
  emit(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

class FakeSource {
  buffer: any = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  connect() {}
  start(at: number) {
    this.startedAt = at;
  }
  stop() {
    this.stopped = true;
  }
  end() {
    this.onended?.();
  }
}

class FakeAudio {
  static sources: FakeSource[] = [];
  state = "running";
  currentTime = 0;
  destination = {};
  constructor(public o: { sampleRate: number }) {}
  createBuffer(_ch: number, n: number, rate: number) {
    return { duration: n / rate, copyToChannel() {} };
  }
  createBufferSource() {
    const s = new FakeSource();
    FakeAudio.sources.push(s);
    return s;
  }
  async resume() {}
  async close() {}
}

/** Base64 of little-endian float32 samples. */
const pcm = (...xs: number[]) => Buffer.from(new Float32Array(xs).buffer).toString("base64");
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(token: string | null = "tok_1") {
  FakeWS.all = [];
  FakeAudio.sources = [];
  let n = 0;
  const speech = new CartesiaSpeech({ get: async () => token }, { WebSocketImpl: FakeWS as never, AudioContextImpl: FakeAudio as never, newId: () => `ctx${++n}` });
  const speaking: boolean[] = [];
  speech.onSpeaking = (on) => speaking.push(on);
  return { speech, speaking };
}

describe("CartesiaSpeech", () => {
  it("speaks a line with Sonic over the token URL, at the user's speed, and reports speaking on and off", async () => {
    const { speech, speaking } = setup();
    speech.rate = 0.75;
    speech.speak("Click the blue button.");
    await tick();
    const ws = FakeWS.all[0];
    expect(ws.url).toBe(ttsUrl("tok_1"));
    expect(ws.url).not.toMatch(/api_key/);
    expect(ws.sent[0]).toMatchObject({
      model_id: "sonic-3",
      transcript: "Click the blue button.",
      voice: { id: DEFAULT_VOICE_ID },
      output_format: { container: "raw", encoding: "pcm_f32le", sample_rate: 44100 },
      context_id: "ctx1",
      continue: false,
      generation_config: { speed: 0.83 },
    });
    ws.emit({ type: "chunk", context_id: "ctx1", data: pcm(0.1, -0.1, 0.2) });
    expect(speaking).toEqual([true]);
    ws.emit({ type: "done", context_id: "ctx1" });
    expect(speaking).toEqual([true]);
    FakeAudio.sources[0].end();
    expect(speaking).toEqual([true, false]);
  });

  it("a new line cancels the old one, and the old line's late audio is ignored", async () => {
    const { speech } = setup();
    speech.speak("First.");
    await tick();
    const ws = FakeWS.all[0];
    ws.emit({ type: "chunk", context_id: "ctx1", data: pcm(0.1) });
    speech.speak("Second.");
    await tick();
    expect(FakeAudio.sources[0].stopped).toBe(true);
    expect(ws.sent).toContainEqual({ context_id: "ctx1", cancel: true });
    expect(ws.sent.at(-1)).toMatchObject({ transcript: "Second.", context_id: "ctx2" });
    ws.emit({ type: "chunk", context_id: "ctx1", data: pcm(0.3) });
    expect(FakeAudio.sources).toHaveLength(1);
    expect(FakeWS.all).toHaveLength(1); // one socket, reused
  });

  it("schedules chunks back to back with no gap", async () => {
    const { speech } = setup();
    speech.speak("Hello there.");
    await tick();
    const ws = FakeWS.all[0];
    const n = 4410; // 0.1 s
    ws.emit({ type: "chunk", context_id: "ctx1", data: pcm(...new Array(n).fill(0)) });
    ws.emit({ type: "chunk", context_id: "ctx1", data: pcm(...new Array(n).fill(0)) });
    const [a, b] = FakeAudio.sources;
    expect(b.startedAt! - a.startedAt!).toBeCloseTo(0.1, 5);
  });

  it("stop() silences the line and tells Cartesia to cancel it", async () => {
    const { speech, speaking } = setup();
    speech.speak("A long sentence.");
    await tick();
    FakeWS.all[0].emit({ type: "chunk", context_id: "ctx1", data: pcm(0.5) });
    speech.stop();
    expect(FakeAudio.sources[0].stopped).toBe(true);
    expect(FakeWS.all[0].sent).toContainEqual({ context_id: "ctx1", cancel: true });
    expect(speaking.at(-1)).toBe(false);
  });

  it("holds lines while the mic is open; says the newest after, or drops it when the user spoke", async () => {
    const { speech } = setup();
    speech.hold(true);
    speech.speak("One.");
    speech.speak("Two.");
    await tick();
    expect(FakeWS.all).toHaveLength(0);
    speech.hold(false);
    await tick();
    expect(FakeWS.all[0].sent.map((m) => m.transcript)).toEqual(["Two."]);
    speech.hold(true);
    speech.speak("Three.");
    speech.hold(false, true);
    await tick();
    expect(FakeWS.all[0].sent.filter((m) => m.transcript).map((m) => m.transcript)).toEqual(["Two."]);
  });

  it("interrupt: false queues the line after the current one", async () => {
    const { speech } = setup();
    speech.speak("Good.");
    speech.speak("Next, click Send.", { interrupt: false });
    await tick();
    const ws = FakeWS.all[0];
    expect(ws.sent.map((m) => m.transcript)).toEqual(["Good."]);
    ws.emit({ type: "done", context_id: "ctx1" });
    await tick();
    expect(ws.sent.map((m) => m.transcript).filter(Boolean)).toEqual(["Good.", "Next, click Send."]);
  });

  it("with no token, stays silent without throwing, and speakAndWait still resolves", async () => {
    const { speech, speaking } = setup(null);
    speech.speak("Hello.");
    await expect(speech.speakAndWait("Hello.", 50)).resolves.toBeUndefined();
    expect(FakeWS.all).toHaveLength(0);
    expect(speaking.every((s) => s === false)).toBe(true);
  });

  it("an error from Cartesia ends the line", async () => {
    const { speech, speaking } = setup();
    const done = speech.speakAndWait("Hi.", 1000);
    await tick();
    FakeWS.all[0].emit({ type: "error", context_id: "ctx1", message: "bad voice" });
    await done;
    expect(speaking.at(-1)).toBe(false);
  });

  it("muted says nothing", async () => {
    const { speech } = setup();
    speech.muted = true;
    speech.speak("Hi.");
    await tick();
    expect(FakeWS.all).toHaveLength(0);
  });
});

describe("speedFor", () => {
  it.each([
    [0.9, 1],
    [0.75, 0.83],
    [1.1, 1.22],
    [0.3, 0.6],
    [3, 1.5],
    [NaN, 1],
  ])("rate %s -> speed %s", (rate, speed) => expect(speedFor(rate)).toBe(speed));
});

describe("PcmF32Reader", () => {
  it("joins samples split across chunks", () => {
    const bytes = new Uint8Array(new Float32Array([0.25, -0.5]).buffer);
    const r = new PcmF32Reader();
    expect(Array.from(r.push(bytes.slice(0, 3)))).toEqual([]);
    expect(Array.from(r.push(bytes.slice(3, 6)))).toEqual([0.25]);
    expect(Array.from(r.push(bytes.slice(6)))).toEqual([-0.5]);
  });
});

describe("CartesiaTokens", () => {
  it("caches until a minute before expiry, and shares one request", async () => {
    let now = 0;
    const fetch = vi.fn(async () => ({ token: `t${fetch.mock.calls.length}`, expiresAt: now + 600_000 }));
    const t = new CartesiaTokens(fetch, () => now);
    expect(await Promise.all([t.get(), t.get()])).toEqual(["t1", "t1"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 530_000;
    expect(await t.get()).toBe("t1");
    now = 545_000;
    expect(await t.get()).toBe("t2");
  });

  it("no account is reported as such; other failures are just null", async () => {
    await expect(new CartesiaTokens(async () => Promise.reject(new Error(NO_ACCOUNT))).get()).rejects.toThrow(NO_ACCOUNT);
    expect(await new CartesiaTokens(async () => Promise.reject(new Error("network"))).get()).toBeNull();
    expect(await new CartesiaTokens(async () => null).get()).toBeNull();
    expect(await new CartesiaTokens(async () => "bare").get()).toBe("bare");
  });
});
