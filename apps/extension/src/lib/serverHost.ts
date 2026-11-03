/** Host of the account server, so a helper code and this browser can be checked against the same place. */
export function serverHost(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
