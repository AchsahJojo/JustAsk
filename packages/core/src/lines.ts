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
export const CANT_SEE_PAGE = "I can't see this kind of page. Open a website, then press Try again.";
export const NEW_TAB_LINE = "That opened a new tab. I'll keep helping you there.";
export const STUCK_LINE = "That's okay. Let me look again.";
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
