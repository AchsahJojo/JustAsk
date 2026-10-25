declare const __JUSTASK_E2E__: boolean;
interface ImportMetaEnv {
  readonly VITE_PLANNER_URL?: string;
  readonly VITE_CONVEX_URL?: string;
  /** Origin of the JustAsk link page; `#justask-link=<code>` is honoured only there. */
  readonly VITE_LINK_ORIGIN?: string;
  /** Cartesia voice for JustAsk's speech. Optional; defaults to DEFAULT_VOICE_ID in packages/voice. */
  readonly VITE_CARTESIA_VOICE_ID?: string;
}
