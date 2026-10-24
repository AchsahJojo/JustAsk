// Spoken lines. Short, warm, senior words. Ported from Mana where noted.

export const DONE_LINE = "All done, you did it!";
export const FILLER_LINE = "Let me look at the page.";
export const STILL_LOOKING = "Still looking…";
export const TROUBLE_LINE = "I'm having trouble. Let's try again in a moment.";
// Mana's wrong-click reassurance line.
export const WRONG_CLICK = "That's all right. The one we want has the glowing box around it.";
export const WRONG_TYPING = "You're typing in a different box. The one we want has the glowing outline.";
export const LOST_LINE = "The page changed. Let me look again.";
export const SUSPICIOUS_LINE = "This page might be a trick. Let's stop and check with your helper.";
export const CANT_SEE_PAGE = "I can't see this kind of page. Let's go back to the last page.";
export const NEW_TAB_LINE = "That opened a new tab. I'll keep helping you there.";
export const STUCK_LINE = "That's okay. Let me look again.";
export const TYPING_NOT_DETECTED = "I can't see anything in that box yet. Please type your answer, then tell me when you're done.";
export const STOPPED_LINE = "Okay, I stopped. Press the big button any time.";
export const NO_CHANGE_NOTE = "the page did not change after that";

export const RISK_QUESTION: Record<string, string> = {
  money: "This step will spend money. Do you want to go ahead?",
  personal_info: "This step shares your personal information. Do you want to go ahead?",
  account_change: "This step changes your account. Do you want to go ahead?",
};

// Mana's praise lines.
const PRAISE = ["Good.", "Nice work.", "That's it."];
export const praise = (n: number) => PRAISE[n % PRAISE.length];

export function choiceMismatch(option: string) {
  return `That picked a different one. We want ${option}. Click the box again.`;
}

// ───────────── drive mode (docs/ARCHITECTURE.md §11) ─────────────

/** Caption on the ring while JustAsk is about to act. */
export const ACT_LABEL = "Doing this";
export const LOOKING_NEXT = "Let me look at the next page…";
export const SEE_IT_NOW = "Do you see it now?";
/** History notes (for Claude, not spoken). */
export const ACT_FAILED_NOTE = "JustAsk couldn't do that, so she will";
export const GUIDE_MODE_NOTE = "JustAsk's last 3 actions did not change the page, so from now on she does the steps herself (use guide steps)";
export const SHOW_ME_NOTE = "She chose Show me instead: she does every step herself (use guide steps)";
export const TEXT_DECLINED_NOTE = "She did not want JustAsk to type that, so she will type it herself";

/** Asked before typing text that has words she didn't say. */
export function typeConfirm(text: string) {
  return `I'll type: ${text}. Okay?`;
}

/** The completion line after JustAsk acted at least once. */
export function doneActed(actions: number, guidedSteps = 0) {
  const steps = `${actions} ${actions === 1 ? "step" : "steps"}`;
  return guidedSteps > 0 ? `All done. I did ${steps} for you, and you did ${guidedSteps} ${guidedSteps === 1 ? "step" : "steps"}.` : `All done. I did ${steps} for you.`;
}

/**
 * A guide line for an act step that she does herself instead (Show me instead, a sensitive
 * field, a failed action). `text` is only passed when it is safe to say out loud.
 */
export function guideInstead(expect: string | null, name: string, opts: { text?: string | null; option?: string | null; sensitive?: boolean } = {}) {
  const what = name ? `the one that says ${name.slice(0, 40)}` : "the one with the glowing box";
  switch (expect) {
    case "type":
      if (opts.sensitive) return "Please type this one yourself, in the glowing box. I can't see it.";
      return opts.text ? `Click the glowing box, then type ${opts.text}.` : "Click the glowing box, then type your answer.";
    case "choose":
      return opts.option ? `Click the glowing box, then pick ${opts.option}.` : "Click the glowing box, then pick one.";
    case "submit":
      return "Click the glowing box, then press Enter.";
    case "scroll":
      return "Scroll down a little until you see the glowing box.";
    default:
      return `Please click ${what}. It has the glowing box.`;
  }
}
