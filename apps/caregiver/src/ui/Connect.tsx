import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api, errorText, type Id } from "../api";
import { Clay } from "./Clay";
import { useNow } from "./bits";
import link from "../assets/link.json";

const EXTENSION_URL = (import.meta.env.VITE_EXTENSION_URL as string | undefined) || "https://chromewebstore.google.com/";

/** Step 2 of setup: the code to type on their computer, and a live "connected" state. */
export function ConnectPanel({ seniorId, displayName, connected, another }: { seniorId: Id<"seniors">; displayName: string; connected: boolean; another?: boolean }) {
  const active = useQuery(api.devices.activeCode, { seniorId });
  const newCode = useMutation(api.devices.newCode);
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const left = active ? Math.max(0, active.expiresAt - now) : 0;
  const live = active && left > 0;
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);

  const make = async () => {
    setBusy(true);
    setError("");
    try {
      await newCode({ seniorId });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the code is on screen */
    }
  };

  const showDone = connected && !another;

  return (
    <section className={`connect card ${showDone ? "is-done" : ""}`} aria-live="polite">
      <div className="connect-art">
        <Clay
          doc={link}
          width={300}
          height={134}
          inputs={{ connected: showDone ? 1 : 0 }}
          label={showDone ? `Connected to ${displayName}` : `Waiting for ${displayName} to connect`}
        />
        {showDone ? (
          <div>
            <h2>You're connected to {displayName}</h2>
            <p className="muted">You can send tasks now. {displayName} chooses on their computer whether you hear when they finish or get stuck.</p>
          </div>
        ) : (
          <p className="waiting">
            <span className="pulse" aria-hidden="true" />
            {another ? "Waiting for the other computer…" : `Waiting for ${displayName} to type the code…`}
          </p>
        )}
      </div>

      {!showDone && (
        <div className="connect-steps">
          <ol className="numbered">
            <li>
              <strong>On {displayName}'s computer, add JustAsk to Chrome.</strong>
              <span className="muted">
                <a href={EXTENSION_URL} target="_blank" rel="noreferrer">
                  Get JustAsk for Chrome
                </a>{" "}
                · Already have it? Click the JustAsk button, then <em>Settings</em>.
              </span>
            </li>
            <li>
              <strong>Follow the “Set up JustAsk” page.</strong>
              <span className="muted">Turn on JustAsk and the microphone. It opens by itself after installing.</span>
            </li>
            <li>
              <strong>Under “Connect to a helper”, type this code:</strong>
              {active === undefined ? (
                <span className="code-box skeleton" />
              ) : live ? (
                <span className="code-row">
                  <span className="code-box" aria-label={`Code ${active.code.split("").join(" ")}`}>
                    <span>{active.code.slice(0, 3)}</span>
                    <span>{active.code.slice(3)}</span>
                  </span>
                  <span className="code-meta">
                    <button className="btn ghost small" onClick={copy}>
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <span className="muted small" aria-live="off">
                      Works once · expires in {mins}:{String(secs).padStart(2, "0")}
                    </span>
                  </span>
                </span>
              ) : (
                <span className="code-row">
                  <span className="muted">{active ? "That code expired." : "No code right now."} Codes last 15 minutes and work once.</span>
                  <button className="btn primary small" onClick={make} disabled={busy}>
                    {busy ? "Making a code…" : "Make a new code"}
                  </button>
                </span>
              )}
              {live && (
                <button className="linkbtn small" onClick={make} disabled={busy}>
                  Make a different code
                </button>
              )}
            </li>
          </ol>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <p className="note">
            <strong>Already using JustAsk on their own?</strong> Type the same code. Their name, settings and history stay as they are. You just get connected.
          </p>
        </div>
      )}
    </section>
  );
}
