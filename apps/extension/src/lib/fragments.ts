// Pure URL-fragment parsing for handoffs and link codes (ARCHITECTURE.md §8, §9).
// Fragments never reach the server that hosts the page, so they are safe carriers for ids.

const HANDOFF_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LINK_CODE = /^\d{6}$/;

function fragmentParams(url: string | undefined): URLSearchParams | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  const hash = parsed.hash.replace(/^#/, "");
  return hash ? new URLSearchParams(hash) : null;
}

/** `#justask=<handoffId>` on any web page. Returns the id, or null. */
export function parseHandoffFragment(url: string | undefined): string | null {
  const id = fragmentParams(url)?.get("justask")?.trim();
  return id && HANDOFF_ID.test(id) ? id : null;
}

/**
 * `#justask-link=<6-digit code>`, honoured only on the JustAsk link origin.
 * An unset or invalid `linkOrigin` disables link fragments entirely.
 */
export function parseLinkFragment(url: string | undefined, linkOrigin: string | undefined): string | null {
  if (!linkOrigin) return null;
  let origin: string;
  try {
    origin = new URL(linkOrigin).origin;
  } catch {
    return null;
  }
  const params = fragmentParams(url);
  if (!params || new URL(url!).origin !== origin) return null;
  const code = params.get("justask-link")?.replace(/\D/g, "");
  return code && LINK_CODE.test(code) ? code : null;
}
