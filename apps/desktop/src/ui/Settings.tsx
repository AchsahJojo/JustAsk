import { useState } from "react";
import type { DesktopHost, HostState } from "../host";
import { linkUrl } from "../links";
import { openExternal } from "../os";

/** Settings: add another device, link her browsers, sign out. */
export function Settings({ host, hs }: { host: DesktopHost; hs: HostState }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number; forBrowsers: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const linkOrigin = import.meta.env.VITE_LINK_ORIGIN;

  const makeCode = async (forBrowsers: boolean) => {
    setBusy(true);
    setError("");
    try {
      const c = await host.createLinkCode();
      setCode({ ...c, forBrowsers });
      if (forBrowsers && linkOrigin) await openExternal(linkUrl(linkOrigin, c.code));
    } catch {
      setError("I couldn't make a code. Check your internet and try again.");
    } finally {
      setBusy(false);
    }
  };

  const minutes = code ? Math.max(1, Math.round((code.expiresAt - Date.now()) / 60_000)) : 0;

  return (
    <div className="panel">
      <main className="body">
        <h1 className="hello">Settings</h1>
        <p className="soft">{hs.displayName ? `This is ${hs.displayName}'s JustAsk.` : "This computer is linked."}</p>
        <p className={`status ${hs.online ? "" : "off"}`}>{hs.online ? "Connected." : "Not connected right now."}</p>

        <section className="card">
          <p className="task-title">Add another device</p>
          <p className="soft">Get a code to type into JustAsk on another computer, or in your browser.</p>
          <button className="btn primary huge" onClick={() => void makeCode(false)} disabled={busy}>
            Get a code
          </button>
        </section>

        <section className="card">
          <p className="task-title">Link my browsers</p>
          <p className="soft">So JustAsk can help you on websites too.</p>
          <button className="btn outline huge" onClick={() => void makeCode(true)} disabled={busy}>
            Link my browsers
          </button>
        </section>

        {code && (
          <section className="card task" aria-live="polite">
            <p className="eyebrow">Your code</p>
            <p className="big-code" aria-label={`Code ${code.code.split("").join(" ")}`}>
              {code.code}
            </p>
            <p className="soft">
              {code.forBrowsers && linkOrigin
                ? "I opened your browser. If it asks, say yes to link JustAsk."
                : code.forBrowsers
                  ? "In your browser, open JustAsk (click the JustAsk button near the top right), choose “I have a code”, and type these numbers."
                  : "On the other device, choose “I have a code” and type these numbers."}{" "}
              It works once, for about {minutes} {minutes === 1 ? "minute" : "minutes"}.
            </p>
          </section>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button
          className="btn ghost"
          onClick={() => {
            if (confirm("Unlink this computer from your JustAsk?")) void host.signOut();
          }}
        >
          Unlink this computer
        </button>
      </main>
    </div>
  );
}
