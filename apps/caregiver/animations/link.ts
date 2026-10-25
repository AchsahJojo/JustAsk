// The caregiver app's pairing picture. Art direction — mode: one object, two ends.
// Verb: connect. Left: the user's JustAsk (coral disc, mic). Right: you (sage disc, person).
// Waiting: dots travel along a dashed line toward the user. Connected: the line draws solid
// sage and a check pops in the middle. Palette: coral #E8654A, sage #3E8E63, cream #FFFBF4,
// line #B9B0A0 (reads on both light and dark pages). No words.
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

const W = 360;
const H = 160;
const CY = H / 2;
const TPS = 240;
const WAIT = 0;
const SEG = 480; // 2 s waiting loop
const LINKED = SEG;
const END = LINKED + 288;

const CORAL = hex("#E8654A");
const SAGE = hex("#3E8E63");
const CREAM = hex("#FFFBF4");
const MUTED = hex("#B9B0A0");

const OUT = { x1: 0.2, y1: 0.45, x2: 0.45, y2: 1 };
const IN_OUT = { x1: 0.45, y1: 0, x2: 0.55, y2: 1 };
const R = 72; // disc diameter
const LX = 84;
const RX = W - 84;
const v3 = (s: number) => ({ x: s, y: s, z: 1 });
const pt = (x: number, y: number) => ({ point: { x, y }, inTangent: { x: 0, y: 0 }, outTangent: { x: 0, y: 0 } });
const LINE_FROM = LX + R / 2 + 14;
const LINE_TO = RX - R / 2 - 14;

function disc(id: string, x: number, color: ReturnType<typeof hex>, pop: number): SceneNode {
  return {
    ...base(id, {
      outTick: END,
      x,
      y: CY,
      scale: keyed(`${id}.scale`, [
        [WAIT, v3(1), IN_OUT],
        [WAIT + 240, v3(1.04), IN_OUT],
        [WAIT + SEG - 4, v3(1), "hold"],
        [LINKED + pop, v3(1), OUT],
        [LINKED + pop + 60, v3(1.08), IN_OUT],
        [LINKED + pop + 120, v3(1), "hold"],
      ]),
    }),
    type: "ellipse",
    size: constant({ width: R, height: R }),
    style: { fill: fill(color) },
  };
}

const nodes: Record<string, SceneNode> = {
  // Dashed line with marching dots while waiting.
  dashes: {
    ...base("dashes", { outTick: LINKED + 48, x: 0, y: 0 }),
    type: "path",
    path: constant({ contours: [{ closed: false, vertices: [pt(LINE_FROM, CY), pt(LINE_TO, CY)] }] }),
    style: {
      stroke: stroke(MUTED, 6, {
        dash: [0.1, 18],
        dashOffset: keyed("dashes.off", [
          [WAIT, 0, "linear"],
          [WAIT + SEG - 4, 18 * 6, "hold"],
        ]),
        opacity: keyed("dashes.op", [
          [WAIT, 1, "hold"],
          [LINKED, 1, OUT],
          [LINKED + 48, 0, "hold"],
        ]),
      }),
    },
  },
  // Solid line drawn from you to the user once connected.
  wire: {
    ...base("wire", { inTick: LINKED, outTick: END, x: 0, y: 0 }),
    type: "path",
    path: constant({ contours: [{ closed: false, vertices: [pt(LINE_TO, CY), pt(LINE_FROM, CY)] }] }),
    style: { stroke: stroke(SAGE, 6) },
    operators: [trim("wire.trim", { end: keyed("wire.end", [[LINKED, 0, OUT], [LINKED + 96, 1, "hold"]]) })],
  },
  user: disc("user", LX, CORAL, 96),
  you: disc("you", RX, SAGE, 0),
  // The user's JustAsk: the mic from the orb.
  micBody: {
    ...base("micBody", { outTick: END, x: LX, y: CY - 7 }),
    type: "rect",
    size: constant({ width: 15, height: 25 }),
    cornerRadius: constant(7.5),
    style: { fill: fill(CREAM) },
  },
  micCup: {
    ...base("micCup", { outTick: END, x: LX, y: CY - 4 }),
    type: "arc",
    radius: constant(14),
    startAngle: constant(0),
    endAngle: constant(180),
    clockwise: true,
    style: { stroke: stroke(CREAM, 4) },
  },
  micStem: {
    ...base("micStem", { outTick: END, x: LX, y: CY + 15 }),
    type: "rect",
    size: constant({ width: 4, height: 8 }),
    cornerRadius: constant(2),
    style: { fill: fill(CREAM) },
  },
  // You: a simple person.
  head: {
    ...base("head", { outTick: END, x: RX, y: CY - 10 }),
    type: "ellipse",
    size: constant({ width: 20, height: 20 }),
    style: { fill: fill(CREAM) },
  },
  body: {
    ...base("body", { outTick: END, x: RX, y: CY + 22 }),
    type: "arc",
    radius: constant(17),
    startAngle: constant(180),
    endAngle: constant(360),
    clockwise: true,
    style: { fill: fill(CREAM) },
  },
  // The check badge.
  badge: {
    ...base("badge", {
      inTick: LINKED + 72,
      outTick: END,
      x: W / 2,
      y: CY,
      scale: keyed("badge.scale", [
        [LINKED + 72, v3(0.2), OUT],
        [LINKED + 132, v3(1.12), IN_OUT],
        [LINKED + 168, v3(1), "hold"],
      ]),
    }),
    type: "ellipse",
    size: constant({ width: 44, height: 44 }),
    style: { fill: fill(SAGE) },
  },
  check: {
    ...base("check", { inTick: LINKED + 72, outTick: END, x: W / 2, y: CY }),
    type: "path",
    path: constant({ contours: [{ closed: false, vertices: [pt(-10, 1), pt(-3, 8), pt(11, -7)] }] }),
    style: { stroke: stroke(CREAM, 5) },
    operators: [trim("check.trim", { end: keyed("check.end", [[LINKED + 72, 0, "hold"], [LINKED + 120, 0, OUT], [LINKED + 200, 1, "hold"]]) })],
  },
};

const scene = withComputedRevision({
  version: ANIMATION_DOCUMENT_VERSION,
  id: "justask-link",
  name: "JustAsk link",
  canvas: { width: W, height: H, pixelAspectRatio: 1, backgroundColor: hex("#00000000") },
  timing: { ticksPerSecond: TPS, frameRate: { numerator: 60, denominator: 1 }, durationTicks: END, displayStartTick: 0 },
  assets: {},
  rootCompositionId: "main",
  components: {},
  compositions: {
    main: { id: "main", name: "Main", width: W, height: H, durationTicks: END, nodes, rootNodeIds: Object.keys(nodes) },
  },
  markers: [marker("waiting", WAIT, { durationTicks: SEG - 4 }), marker("connected", LINKED, { durationTicks: END - LINKED - 4, cut: true })],
  design: { tokens: { looping: false } },
  capabilities: { required: [], optional: [], unsupportedPolicy: "warn" },
} as unknown as AnimationDocument);

const machine = stateMachine({ initial: "waiting" })
  .state("waiting", { marker: "waiting", playback: "loop" })
  .state("connected", { marker: "connected", playback: "once" })
  .when("*", "connected", { input: "connected", operator: "eq", value: 1 })
  .when("*", "waiting", { input: "connected", operator: "eq", value: 0 });

export const link = withStateMachine(scene, machine, {
  inputs: { connected: { kind: "number", minimum: 0, maximum: 1, defaultValue: 0 } },
});
assertValidAnimationDocument(link);
