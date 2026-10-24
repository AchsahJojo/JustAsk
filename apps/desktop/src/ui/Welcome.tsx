import { useState, type FormEvent } from "react";
import type { DesktopHost } from "../host";

type Mode = "choose" | "new" | "code";

/** First run: create her JustAsk, or join it with a 6-digit code from another device or a helper. */
export function Welcome({ host }: { host: DesktopHost }) {
  const [mode, setMode] = useState<Mode>("choose");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!host.backend.configured) {
    return (
      <div className="panel">
        <main className="body welcome">
          <h1>Welcome to JustAsk</h1>
          <p className="error" role="alert">
            This copy of JustAsk isn't set up to connect yet. Ask your helper to add the connection settings.
          </p>
        </main>
      </div>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/too many/i.test(msg) ? "Too many tries. Please wait a few minutes and try again." : "That didn't work. Check your internet and try again.");
    } finally {
      setBusy(false);
    }
  };

  const createNew = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Please type your first name.");
    void run(() => host.createAccount(name));
  };

  const redeem = (e: FormEvent) => {
    e.preventDefault();
    const digits = code.replace(/\D/g, "");
    if (digits.length !== 6) return setError("The code has 6 numbers.");
    void run(async () => {
      if (!(await host.redeem(digits))) setError("That code didn't work. Ask for a new one.");
    });
  };

  return (
    <div className="panel">
      <main className="body welcome">
        <h1>Welcome to JustAsk</h1>
        <p className="soft">I help you use your computer. You tell me what you want to do, and I show you or do it with you.</p>

        {mode === "choose" && (
          <div className="choices">
            <button className="btn primary huge" onClick={() => setMode("new")}>
              I'm new: create my JustAsk
            </button>
            <button className="btn outline huge" onClick={() => setMode("code")}>
              I have a code
            </button>
          </div>
        )}

        {mode === "new" && (
          <form className="typed" onSubmit={createNew}>
            <label htmlFor="name" className="field-label">
              What should I call you?
            </label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your first name" autoComplete="off" autoFocus maxLength={40} />
            <button className="btn primary huge" type="submit" disabled={busy}>
              {busy ? "Setting up…" : "Create my JustAsk"}
            </button>
            <button className="btn ghost" type="button" onClick={() => setMode("choose")}>
              Back
            </button>
          </form>
        )}

        {mode === "code" && (
          <form className="typed" onSubmit={redeem}>
            <label htmlFor="code" className="field-label">
              Type the 6-number code
            </label>
            <p className="soft">Get it from JustAsk on another device (Settings, then “Add another device”) or from your helper.</p>
            <input
              id="code"
              className="code-input"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              autoFocus
            />
            <button className="btn primary huge" type="submit" disabled={busy}>
              {busy ? "Checking…" : "Link this computer"}
            </button>
            <button className="btn ghost" type="button" onClick={() => setMode("choose")}>
              Back
            </button>
          </form>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
