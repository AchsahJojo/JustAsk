// The JustAsk orb: the big button's face. Art direction — mode: one object.
// Verb: listen. Geometry from the nouns "voice" and "button": one coral disc,
// rings that ripple out when listening, an arc that circles while thinking,
// three bars that pulse while speaking, and a check drawn once when done.
// Palette: coral #E8654A, ink #1C1D19, cream #FFFBF4. No words.
import {
  ANIMATION_DOCUMENT_VERSION,
  assertValidAnimationDocument,
  base,
  constant,
  fill,
  hex,
  keyed,
  marker,
  stateMachine,
  stroke,
  trim,
  withComputedRevision,
  withStateMachine,
  type AnimationDocument,
  type SceneNode,
} from "@clayzo/animation/authoring";

const W = 240;
const C = W / 2;
const TPS = 240; // ticks per second; 60 fps = 4 ticks per frame
const SEG = 480; // 2 s per looping state
const IDLE = 0;
const LISTEN = SEG;
const THINK = SEG * 2;
const SPEAK = SEG * 3;
const DONE = SEG * 4;
const END = DONE + 240;

const CORAL = hex("#E8654A");
const CORAL_SOFT = hex("#F3A08C");
const CREAM = hex("#FFFBF4");
const INK = hex("#1C1D19");
const SAGE = hex("#3E8E63");

const IN_OUT = { x1: 0.45, y1: 0, x2: 0.55, y2: 1 };
const OUT = { x1: 0.2, y1: 0.45, x2: 0.45, y2: 1 };
const DISC = 132;

const v3 = (s: number) => ({ x: s, y: s, z: 1 });

// Disc: breathes in idle, holds steady while listening/thinking, pulses lightly while speaking, pops on done.
const discScale = keyed("disc.scale", [
  [IDLE, v3(1), IN_OUT],
  [IDLE + 240, v3(1.04), IN_OUT],
  [IDLE + SEG - 4, v3(1), "hold"],
  [LISTEN, v3(1.06), "hold"],
  [THINK, v3(0.96), "hold"],
  [SPEAK, v3(1), IN_OUT],
  [SPEAK + 120, v3(1.03), IN_OUT],
  [SPEAK + 240, v3(1), IN_OUT],
  [SPEAK + 360, v3(1.03), IN_OUT],
  [SPEAK + SEG - 4, v3(1), "hold"],
  [DONE, v3(0.9), OUT],
  [DONE + 72, v3(1.08), IN_OUT],
  [DONE + 120, v3(1), "hold"],
]);
const discColor = keyed("disc.color", [
  [IDLE, CORAL, "hold"],
  [DONE, CORAL, OUT],
  [DONE + 96, SAGE, "hold"],
]);

function ripple(id: string, delay: number): SceneNode {
  const t0 = LISTEN + delay;
  return {
    ...base(id, {
      inTick: LISTEN,
      outTick: THINK,
      x: C,
      y: C,
      scale: keyed(`${id}.scale`, [...(delay ? ([[LISTEN, v3(1), "hold"]] as const) : []), [t0, v3(1), OUT], [t0 + 360, v3(1.7), "hold"]]),
    }),
    type: "ellipse",
    size: constant({ width: DISC, height: DISC }),
    style: {
      stroke: stroke(CORAL, 6, {
        opacity: keyed(`${id}.op`, [...(delay ? ([[LISTEN, 0, "hold"]] as const) : []), [t0, 0.9, OUT], [t0 + 360, 0, "hold"]]),
      }),
    },
  };
}

function bar(id: string, x: number, phase: number): SceneNode {
  const k = (t: number) => SPEAK + ((t + phase) % SEG);
  const keys: Array<[number, number]> = [
    [0, 26],
    [80, 54],
    [160, 30],
    [240, 60],
    [320, 34],
    [400, 50],
    [476, 26],
  ];
  const sorted = keys.map(([t, h]) => [k(t), h] as const).sort((a, b) => a[0] - b[0]);
  // Snap to the 4-tick frame grid and keep ticks strictly increasing.
  const track: Array<[number, { width: number; height: number }, typeof IN_OUT]> = [];
  for (const [t, h] of sorted) {
    const tick = Math.round(t / 4) * 4;
    if (track.length && tick <= track[track.length - 1][0]) continue;
    track.push([tick, { width: 14, height: h }, IN_OUT]);
  }
  return {
    ...base(id, { inTick: SPEAK, outTick: DONE, x, y: C }),
    type: "rect",
    size: keyed(`${id}.size`, track),
    cornerRadius: constant(7),
    style: { fill: fill(CREAM) },
  };
}

const nodes: Record<string, SceneNode> = {
  halo: {
    ...base("halo", { outTick: END, x: C, y: C }),
    type: "ellipse",
    size: constant({ width: DISC + 44, height: DISC + 44 }),
    style: { fill: fill(CORAL_SOFT, keyed("halo.op", [[IDLE, 0.22, IN_OUT], [IDLE + 240, 0.34, IN_OUT], [IDLE + SEG - 4, 0.22, "hold"], [DONE, 0.22, OUT], [DONE + 96, 0, "hold"]])) },
  },
  r1: ripple("r1", 0),
  r2: ripple("r2", 120),
  disc: {
    ...base("disc", { outTick: END, x: C, y: C, scale: discScale }),
    type: "ellipse",
    size: constant({ width: DISC, height: DISC }),
    style: { fill: fill(discColor) },
  },
  // Idle + listening glyph: a simple mic, cream on coral.
  micBody: {
    ...base("micBody", { outTick: THINK, x: C, y: C - 10 }),
    type: "rect",
    size: constant({ width: 26, height: 44 }),
    cornerRadius: constant(13),
    style: { fill: fill(CREAM) },
  },
  micCup: {
    ...base("micCup", { outTick: THINK, x: C, y: C - 6 }),
    type: "arc",
    radius: constant(24),
    startAngle: constant(0),
    endAngle: constant(180),
    clockwise: true,
    style: { stroke: stroke(CREAM, 6) },
  },
  micStem: {
    ...base("micStem", { outTick: THINK, x: C, y: C + 26 }),
    type: "rect",
    size: constant({ width: 6, height: 14 }),
    cornerRadius: constant(3),
    style: { fill: fill(CREAM) },
  },
  // Thinking: a cream arc circling inside the disc.
  orbit: {
    ...base("orbit", {
      inTick: THINK,
      outTick: SPEAK,
      x: C,
      y: C,
      rotation: keyed("orbit.rot", [
        [THINK, { x: 0, y: 0, z: 0 }, "linear"],
        [THINK + SEG - 4, { x: 0, y: 0, z: 357 }, "hold"],
      ]),
    }),
    type: "arc",
    radius: constant(36),
    startAngle: constant(-90),
    endAngle: constant(60),
    clockwise: true,
    style: { stroke: stroke(CREAM, 9) },
  },
  b1: bar("b1", C - 24, 0),
  b2: bar("b2", C, 160),
  b3: bar("b3", C + 24, 320),
  check: {
    ...base("check", { inTick: DONE, outTick: END, x: C, y: C }),
    type: "path",
    path: constant({
      contours: [
        {
          closed: false,
          vertices: [
            { point: { x: -28, y: 2 }, inTangent: { x: 0, y: 0 }, outTangent: { x: 0, y: 0 } },
            { point: { x: -9, y: 21 }, inTangent: { x: 0, y: 0 }, outTangent: { x: 0, y: 0 } },
            { point: { x: 30, y: -20 }, inTangent: { x: 0, y: 0 }, outTangent: { x: 0, y: 0 } },
          ],
        },
      ],
    }),
    style: { stroke: stroke(CREAM, 11) },
    operators: [trim("check.trim", { end: keyed("check.end", [[DONE, 0, "hold"], [DONE + 40, 0, OUT], [DONE + 140, 1, "hold"]]) })],
  },
};

const markers = [
  marker("idle", IDLE, { durationTicks: SEG - 4 }),
  marker("listening", LISTEN, { durationTicks: SEG - 4, cut: true }),
  marker("thinking", THINK, { durationTicks: SEG - 4, cut: true }),
  marker("speaking", SPEAK, { durationTicks: SEG - 4, cut: true }),
  marker("done", DONE, { durationTicks: END - DONE - 4, cut: true }),
];

const scene = withComputedRevision({
  version: ANIMATION_DOCUMENT_VERSION,
  id: "justask-orb",
  name: "JustAsk orb",
  canvas: { width: W, height: W, pixelAspectRatio: 1, backgroundColor: hex("#00000000") },
  timing: { ticksPerSecond: TPS, frameRate: { numerator: 60, denominator: 1 }, durationTicks: END, displayStartTick: 0 },
  assets: {},
  rootCompositionId: "main",
  components: {},
  compositions: {
    main: { id: "main", name: "Main", width: W, height: W, durationTicks: END, nodes, rootNodeIds: Object.keys(nodes) },
  },
  markers,
  design: { tokens: { looping: false } },
  capabilities: { required: [], optional: [], unsupportedPolicy: "warn" },
} as unknown as AnimationDocument);

const machine = stateMachine({ initial: "idle" })
  .state("idle", { marker: "idle", playback: "loop" })
  .state("listening", { marker: "listening", playback: "loop" })
  .state("thinking", { marker: "thinking", playback: "loop" })
  .state("speaking", { marker: "speaking", playback: "loop" })
  .state("done", { marker: "done", playback: "once" })
  .when("*", "listening", { input: "mode", operator: "eq", value: 1 })
  .when("*", "thinking", { input: "mode", operator: "eq", value: 2 })
  .when("*", "speaking", { input: "mode", operator: "eq", value: 3 })
  .when("*", "done", { input: "mode", operator: "eq", value: 4 })
  .when("*", "idle", { input: "mode", operator: "eq", value: 0 });

export const orb = withStateMachine(scene, machine, {
  inputs: { mode: { kind: "number", minimum: 0, maximum: 4, defaultValue: 0 } },
});
assertValidAnimationDocument(orb);
INK; // ink is the page's text colour; kept here so the palette is in one place.
