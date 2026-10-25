// One short-lived Cartesia access token, shared by listening (STT) and speaking (TTS).
// Tokens come from the Convex action voice:cartesiaToken (10 minutes, STT + TTS grants); the
// Cartesia API key never reaches the client.

/** Thrown by a fetcher when this install has no JustAsk account yet, so voice can say so plainly. */
export const NO_ACCOUNT = "no-account";

/** What voice:cartesiaToken returns: `{token, expiresAt}`. A bare token string is accepted too. */
export type TokenReply = { token: string; expiresAt: number } | string | null;

export interface TokenSource {
  /** A usable token, or null when the service can't give one. Throws `Error(NO_ACCOUNT)` with no account. */
  get(): Promise<string | null>;
}

/** Refresh this long before a token expires, so a sentence never starts on a dying token. */
const REFRESH_EARLY_MS = 60_000;
/** Assumed lifetime when the server returns a bare string. */
const DEFAULT_TTL_MS = 9 * 60_000;

/** Caches the token until shortly before it expires; concurrent callers share one request. */
export class CartesiaTokens implements TokenSource {
  private cur: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string | null> | null = null;

  constructor(
    private fetchToken: () => Promise<TokenReply>,
    private now: () => number = () => Date.now(),
  ) {}

  async get(): Promise<string | null> {
    if (this.cur && this.cur.expiresAt - REFRESH_EARLY_MS > this.now()) return this.cur.token;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const r = await this.fetchToken();
        if (typeof r === "string" && r) this.cur = { token: r, expiresAt: this.now() + DEFAULT_TTL_MS };
        else if (r && typeof r === "object" && typeof r.token === "string" && r.token) this.cur = { token: r.token, expiresAt: r.expiresAt };
        else this.cur = null;
        return this.cur?.token ?? null;
      } catch (e) {
        this.cur = null;
        if ((e as Error)?.message === NO_ACCOUNT) throw e;
        return null;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Forget the token (sign-out, or the socket rejected it). */
  clear() {
    this.cur = null;
  }
}
