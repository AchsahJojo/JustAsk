// Turning her request into words for a web search, when she starts on an empty tab.

const LEAD = /^(?:please|ok(?:ay)?|hey|so|um+|can you|could you|would you|will you|help me(?: to)?|i want to|i'd like to|i would like to|i need to|i wanna|i'm trying to|how (?:do|can|would) i|show me how to|let's|lets|go to|take me to|open)\b[\s,]*/i;
const TAIL = /[\s,]*\b(?:please|for me|thanks|thank you)[.!?]*$/i;

/**
 * The words to search for: her request without "help me", "can you", "please" and the like.
 * Built only from her words, never by Claude. Falls back to the whole request.
 */
export function searchQueryFor(request: string): string {
  let q = request.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    const next = q.replace(LEAD, "").replace(TAIL, "").trim();
    if (next === q) break;
    q = next;
  }
  q = q.replace(/[.!?]+$/, "").trim();
  return (q || request.trim()).slice(0, 100);
}
