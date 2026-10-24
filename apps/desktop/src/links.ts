// URLs the desktop app opens in the user's default browser.

/** Desktop -> browser handoff: the recipe start page with `#justask=<handoffId>` (replaces any existing hash). */
export function handoffUrl(startUrl: string, handoffId: string): string {
  const u = new URL(startUrl);
  u.hash = `justask=${encodeURIComponent(handoffId)}`;
  return u.toString();
}

/** "Link my browsers": the JustAsk link page with the 6-digit code in the fragment (never sent to a server). */
export function linkUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/link#justask-link=${encodeURIComponent(code)}`;
}

/** Only http(s) start pages are opened. */
export function isOpenableUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}
