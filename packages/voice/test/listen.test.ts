import { afterEach, describe, expect, it, vi } from "vitest";
import { CartesiaListener } from "../src/stt";

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static all: FakeWS[] = [];
  readyState = 0;
  binaryType = "";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {}
}

let node: { port: { onmessage: ((ev: { data: Float32Array }) => void) | null } } | null = null;
class FakeNode {
  port = { onmessage: null as ((ev: { data: Float32Array }) => void) | null };
  constructor() {
    node = this;
  }
  connect() {}
}
class FakeCtx {
  sampleRate = 16_000;
  destination = {};
  audioWorklet = { addModule: async () => {} };
  createMediaStreamSource() {
    return { connect() {} };
  }
  async close() {}
}

function install() {
  FakeWS.all = [];
  node = null;
  vi.stubGlobal("WebSocket", FakeWS);
  vi.stubGlobal("AudioContext", FakeCtx);
  vi.stubGlobal("AudioWorkletNode", FakeNode);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
}
afterEach(() => vi.unstubAllGlobals());

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** One ~100 ms block (1,600 samples at 16 kHz), loud enough to count as speech. */
const loudBlock = () => new Float32Array(1600).fill(0.2);

describe("CartesiaListener.listen", () => {
  it("with no account, says so without asking for the microphone", async () => {
    install();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const errors: string[] = [];
    const listener = new CartesiaListener({ get: async () => Promise.reject(new Error("no-account")) });
    await listener.listen({ onInterim: () => {}, onFinal: () => {}, onError: (m) => errors.push(m), onEnd: () => {} });
    expect(errors[0]).toMatch(/once your JustAsk is set up/);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("records from the press: audio said before Cartesia connects is kept and sent first", async () => {
    install();
    let giveToken!: (t: string) => void;
    const listener = new CartesiaListener({ get: () => new Promise<string>((r) => (giveToken = r)) }, { workletUrl: "worklet.js" });
    const ready = vi.fn();
    void listener.listen({ onReady: ready, onInterim: () => {}, onFinal: () => {}, onError: () => {}, onEnd: () => {} });
    await tick(50); // the mic starts after at most a 30 ms check for a cached token
    expect(ready).toHaveBeenCalled(); // mic live before the token arrived
    node!.port.onmessage!({ data: loudBlock() });
    node!.port.onmessage!({ data: loudBlock() });
    expect(FakeWS.all).toHaveLength(0); // still waiting for the token
    giveToken("tok");
    await tick();
    const ws = FakeWS.all[0];
    ws.open();
    expect(ws.sent).toHaveLength(2); // the start of the sentence went out first
    node!.port.onmessage!({ data: loudBlock() });
    expect(ws.sent).toHaveLength(3);
    listener.cancel();
  });

  it("if the turn ends before the socket opens, the buffered audio is still sent, then closed", async () => {
    install();
    const listener = new CartesiaListener({ get: async () => "tok" }, { workletUrl: "worklet.js", turn: { startMs: 3000, silenceMs: 100, maxMs: 30_000, threshold: 0.01 } });
    void listener.listen({ onInterim: () => {}, onFinal: () => {}, onError: () => {}, onEnd: () => {} });
    await tick(50);
    node!.port.onmessage!({ data: loudBlock() });
    listener.stop(); // the user pressed again before the socket opened
    await tick();
    const ws = FakeWS.all[0];
    ws.open();
    expect(ws.sent.length).toBe(2);
    expect(ws.sent.at(-1)).toBe("close");
    listener.cancel();
  });
});
