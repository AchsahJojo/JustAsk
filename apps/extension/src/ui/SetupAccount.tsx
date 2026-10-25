import { useState } from "react";
import { saveSettings, type Settings } from "../lib/config";
import { backend } from "../lib/backend";
import { friendlyError } from "../lib/prefs";
import { pullPrefs, pushPrefs } from "../lib/prefsSync";
import { currentDevice } from "../platform/device";

const WRONG_CODE = "That code didn't work. Ask for a new one.";
const NO_SERVER = "Accounts aren't set up on this copy of JustAsk yet. JustAsk still works on this computer without one.";
const digits = (v: string) => v.replace(/\D/g, "");

/**
 * Setup step 3: join the user's account. "I'm new" creates it (accounts:createSelf); "I have a code"
 * redeems a 6-digit code (devices:redeemCode). A `?link=` code from the link page asks first.
 */
export function AccountStep({ s, onChange }: { s: Settings; onChange: (s: Settings) => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const connected = async (token: string, displayName: string) => {
    onChange(await saveSettings({ deviceToken: token, displayName }));
    setMsg(displayName ? `Connected. Hi ${displayName}!` : "Connected.");
    onChange(await pullPrefs());
  };

  const redeem = async (code: string) => {
    setMsg("");
    if (!s.convexUrl) return setMsg(NO_SERVER);
    setBusy(true);
    try {
      const r = await backend.redeem(s.convexUrl, code, currentDevice());
      if (!r) setMsg(WRONG_CODE);
      else await connected(r.token, r.displayName);
    } catch (e) {
      setMsg(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async (name: string) => {
    setMsg("");
    if (!s.convexUrl) return setMsg(NO_SERVER);
    setBusy(true);
    try {
      const { token } = await backend.createSelf(s.convexUrl, name, currentDevice());
      await connected(token, name);
      // The user's account starts with what they already chose on this browser.
      // Show me instead isn't copied: it stays at the default (JustAsk guides) until someone chooses.
      await pushPrefs({ voice: s.voice, rate: s.rate, consent: s.consent });
    } catch (e) {
      setMsg(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const consent = async (patch: Partial<Settings["consent"]>) => onChange(await pushPrefs({ consent: { ...s.consent, ...patch } }));

  return (
    <li className={`step ${s.deviceToken ? "ok" : ""}`}>
      <h2>3. Your JustAsk</h2>
      {s.deviceToken ? (
        <>
          <p className="done">✓ Connected{s.displayName ? ` as ${s.displayName}` : ""}</p>
          <div className="toggles">
            <label className="toggle">
              <input type="checkbox" checked={s.consent.notifyOnComplete} onChange={(e) => consent({ notifyOnComplete: e.target.checked })} />
              <span>Tell my helper when I finish a task they sent</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={s.consent.notifyOnStuck} onChange={(e) => consent({ notifyOnStuck: e.target.checked })} />
              <span>Tell my helper when I get stuck</span>
            </label>
          </div>
        </>
      ) : (
        <>
          <p>Your JustAsk keeps your settings and lets your helper send you tasks. Pick one.</p>
          <div className="choice-grid">
            <NewAccount busy={busy} onCreate={create} />
            <HaveCode busy={busy} onRedeem={redeem} />
          </div>
        </>
      )}
      {msg && (
        <p className="soft" role="status">
          {msg}
        </p>
      )}
    </li>
  );
}

function NewAccount({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  const clean = name.trim().slice(0, 40);
  return (
    <form
      className="choice"
      onSubmit={(e) => {
        e.preventDefault();
        if (clean) onCreate(clean);
      }}
    >
      <h3>I'm new: create my JustAsk</h3>
      <label htmlFor="first-name">Your first name</label>
      <input id="first-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Margaret" autoComplete="given-name" maxLength={40} />
      <button className="btn primary" type="submit" disabled={!clean || busy}>
        Create my JustAsk
      </button>
    </form>
  );
}

function HaveCode({ busy, onRedeem }: { busy: boolean; onRedeem: (code: string) => void }) {
  const [code, setCode] = useState("");
  const ok = digits(code).length === 6;
  return (
    <form
      className="choice"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onRedeem(digits(code));
      }}
    >
      <h3>I have a code</h3>
      <label htmlFor="pair-code">The 6-digit code from the JustAsk app on your computer, another browser, or your helper</label>
      <div className="row">
        <input id="pair-code" inputMode="numeric" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" aria-label="Pairing code" autoComplete="one-time-code" />
        <button className="btn dark" type="submit" disabled={!ok || busy}>
          Connect
        </button>
      </div>
    </form>
  );
}

