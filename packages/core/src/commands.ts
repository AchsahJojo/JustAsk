// Voice-command regexes, ported from Mana's handleCommand.

export type Command =
  | { kind: "repeat" }
  | { kind: "stop" }
  | { kind: "stuck" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "done-typing" }
  | { kind: "text"; text: string };

export function parseCommand(raw: string): Command {
  const s = raw.toLowerCase().trim();
  if (/again|repeat|what did you say|pardon|didn.?t hear|say that/.test(s)) return { kind: "repeat" };
  if (/\b(stop|cancel|never ?mind)\b/.test(s)) return { kind: "stop" };
  if (/\b(i'?m stuck|stuck|i don'?t see it|can'?t find)\b/.test(s)) return { kind: "stuck" };
  if (/\b(done typing|i'?m done|finished typing)\b/.test(s)) return { kind: "done-typing" };
  if (/^(yes|yeah|yep|sure|okay|ok|go ahead)\b/.test(s)) return { kind: "yes" };
  if (/^(no|nope|don'?t|not now)\b/.test(s)) return { kind: "no" };
  return { kind: "text", text: raw.trim() };
}
