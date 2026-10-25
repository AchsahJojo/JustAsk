// Scam check on the user's own words, before JustAsk does anything (docs/STATUS.md, "Scam protection").
// Deterministic and local: no Claude call, nothing leaves the device. It never blocks the user on its
// own; it asks one plain question, and only the user's answer decides.

export type ScamKind = "gift-card" | "send-money" | "remote-access" | "share-code";

export interface ScamFlag {
  kind: ScamKind;
  /** The short question on screen. Answered "Yes, someone asked me" / "No, it's my own idea". */
  question: string;
  /** The fact behind it, shown under the question and spoken before it. */
  fact: string;
}

const GIFT_CARD = /\b(gift ?cards?|(google play|itunes|apple|steam|target|walmart|amazon|ebay|vanilla|visa) (gift )?cards?)\b/;
/** What a scammer asks for: the numbers, a photo, or using cards to pay a debt or an official. */
const CARD_CODE = /\b(codes?|numbers?|pins?|scratch|back of|photos?|pictures?|read (it|them|out)|with (a |the )?gift ?cards?)\b/;
const OFFICIAL_DEBT = /\b(irs|tax(es)?|fines?|bail|warrant|police|sheriff|court|social security|medicare|utility|electric(ity)? bill|refund|fees?|owe|overdue|arrest(ed)?|lawyer|attorney)\b/;

const MONEY_RAIL = /\b(wire|wiring|western union|moneygram|zelle|venmo|cash ?app|paypal|bitcoin|crypto(currency)?|btc|gold bars?|send (cash|money)|transfer money|money order)\b/;
/** Who's asking and how: someone the user hasn't met, an urgent call, an official, a prize or an investment. */
const PRESSURE =
  /\b(stranger|someone i (met|don'?t know|haven'?t met)|met (online|on facebook|on a dating)|online (friend|boyfriend|girlfriend)|he said|she said|they said|told me|asked me|called me|caller|urgent(ly)?|right away|immediately|today or|in jail|bail|lawyer|attorney|arrested|accident|hospital|irs|tax(es)?|warrant|police|fine|refund|overpaid|prize|lottery|sweepstakes|won|winnings|inheritance|customs|release fee|investment|invest|double (my|your) money|guaranteed)\b/;

const REMOTE_TOOL = /\b(anydesk|teamviewer|ultraviewer|logmein|supremo|screenconnect|connectwise|quick ?assist|remote (access|control|desktop))\b/;
const LET_IN = /\b(let|give|allow) (him|her|them|someone|the (technician|tech|caller|agent|support)) (into|in to|access to|control of|on|onto) my (computer|pc|laptop|screen|bank)/;
const FAKE_SUPPORT = /\b(microsoft|apple|windows|amazon|geek squad|norton|mcafee|my bank|the bank)\b.{0,40}\b(called|calling|said|told me|support number|pop.?up)\b|\b(virus|hacked|infected)\b.{0,30}\b(pop.?up|warning|call|number)\b/;

const SHARE_CODE = /\b(give|tell|read|send|share)\b.{0,25}\b(password|passcode|pin|verification code|security code|one.?time (code|password)|the code (they|he|she|it) (sent|texted|emailed))\b/;

/** One short question and one plain fact per kind. No blame. */
export const SCAM_QUESTIONS: Record<ScamKind, { question: string; fact: string }> = {
  "gift-card": {
    question: "Did someone call, text or email asking you to do this?",
    fact: "Real companies, banks and government offices never ask to be paid with gift card numbers.",
  },
  "send-money": {
    question: "Did someone who called or messaged you ask you to send this money?",
    fact: "Scammers often ask for money by wire, payment app or crypto, and say it's urgent.",
  },
  "remote-access": {
    question: "Did someone ask you to do this?",
    fact: "Real support teams don't call you, or pop up, asking to get into your computer.",
  },
  "share-code": {
    question: "Did someone ask you for it?",
    fact: "Never share a password or a code that was sent to you, even with someone who says they're from your bank.",
  },
};

/** A likely scam in what the user asked for, or null. Plain requests ("buy a gift card for my grandson") pass. */
export function scamCheck(request: string): ScamFlag | null {
  const s = request.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
  const flag = (kind: ScamKind): ScamFlag => ({ kind, ...SCAM_QUESTIONS[kind] });
  if (GIFT_CARD.test(s) && (CARD_CODE.test(s) || OFFICIAL_DEBT.test(s))) return flag("gift-card");
  if (REMOTE_TOOL.test(s) || LET_IN.test(s) || FAKE_SUPPORT.test(s)) return flag("remote-access");
  if (SHARE_CODE.test(s)) return flag("share-code");
  if (MONEY_RAIL.test(s) && PRESSURE.test(s)) return flag("send-money");
  return null;
}
