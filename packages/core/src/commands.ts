// Voice-command regexes, ported from Mana's handleCommand.

export type Command =
  | { kind: "repeat" }
  | { kind: "stop" }
  | { kind: "stuck" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "done-typing" }
  | { kind: "thanks" }
  | { kind: "text"; text: string };

export function parseCommand(raw: string): Command {
  // Typed answers often end with a full stop ("Yes." / "Thank you!").
  const s = raw.toLowerCase().trim().replace(/[.!?,]+$/, "").trim();
  // Commands arrive through the same text box/microphone as task requests and answers.
  // Match a whole utterance so words like "cancel" in a request or "stop" in an answer
  // never interrupt the session.
  if (/^(?:again|repeat|what did you say|pardon|didn'?t hear|say that again|can you repeat that|could you repeat that)$/.test(s)) return { kind: "repeat" };
  if (/^(?:stop|cancel|never ?mind)$/.test(s)) return { kind: "stop" };
  if (/^(?:i'?m stuck|stuck|i don'?t see it|can'?t find it)$/.test(s)) return { kind: "stuck" };
  if (/^(?:done typing|i'?m done|finished typing)$/.test(s)) return { kind: "done-typing" };
  if (/^(?:yes|yeah|yep|sure|okay|ok|go ahead)(?: please)?$/.test(s)) return { kind: "yes" };
  if (/^(?:no|nope|don'?t|not now|not yet|later|maybe later|i'?ll do it later)(?: please| thanks| thank you)?$/.test(s)) return { kind: "no" };
  // Closing words after a task ("thank you", "that's all") are not a new request.
  if (/^(?:(?:ok(?:ay)?,? )?(?:thanks|thank you)(?: so much| very much)?|that'?s all|that'?s it|bye|goodbye|great|perfect|all good)$/.test(s)) return { kind: "thanks" };
  return { kind: "text", text: raw.trim() };
}
