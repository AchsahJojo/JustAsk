/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Convex client URL (https://<deployment>.convex.cloud). */
  readonly VITE_CONVEX_URL?: string;
  /** Planner base URL: the Convex HTTP actions URL (https://<deployment>.convex.site) or the local dev planner. */
  readonly VITE_PLANNER_URL?: string;
  /** Origin of the JustAsk link page used by "Link my browsers". Optional. */
  readonly VITE_LINK_ORIGIN?: string;
  /** Cartesia voice for JustAsk's speech. Optional; defaults to DEFAULT_VOICE_ID in packages/voice. */
  readonly VITE_CARTESIA_VOICE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
