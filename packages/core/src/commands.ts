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
  // Commands arrive through the same text box/microphone as task requests and answers.
  // Match a whole utterance so words like "cancel" in a request or "stop" in an answer
  // never interrupt the session.
  if (/^(?:again|repeat|what did you say|pardon|didn'?t hear|say that again|can you repeat that|could you repeat that)$/.test(s)) return { kind: "repeat" };
  if (/^(?:stop|cancel|never ?mind)$/.test(s)) return { kind: "stop" };
  if (/^(?:i'?m stuck|stuck|i don'?t see it|can'?t find it)$/.test(s)) return { kind: "stuck" };
  if (/^(?:done typing|i'?m done|finished typing)$/.test(s)) return { kind: "done-typing" };
  if (/^(?:yes|yeah|yep|sure|okay|ok|go ahead)(?: please)?$/.test(s)) return { kind: "yes" };
  if (/^(?:no|nope|don'?t|not now)(?: please)?$/.test(s)) return { kind: "no" };
  return { kind: "text", text: raw.trim() };
}
