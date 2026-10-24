import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { getSettings, saveSettings, type Settings } from "../lib/config";
import { backend } from "../lib/backend";
import { Orb } from "./Orb";

const ALL_SITES = { origins: ["<all_urls>"] };

/**
 * One-time setup tab: host access (the gesture lives here, never mid-session), the mic
 * prompt (side panels can't show it reliably), pairing, and consent.
 */
export function Setup() {
  const [s, setS] = useState<Settings | null>(null);
  const [access, setAccess] = useState(false);
  const [mic, setMic] = useState<"unknown" | "on" | "off">("unknown");
  const [code, setCode] = useState("");
  const [pairMsg, setPairMsg] = useState("");
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    void getSettings().then(setS);
    void browser.permissions.contains(ALL_SITES).then(setAccess);
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((p) => setMic(p.state === "granted" ? "on" : p.state === "denied" ? "off" : "unknown"))
      .catch(() => {});
  }, []);

  if (!s) return null;
  const update = async (patch: Partial<Settings>) => setS(await saveSettings(patch));

  const turnOn = async () => {
    const ok = await browser.permissions.request(ALL_SITES);
    setAccess(ok);
  };

  const askMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMic("on");
    } catch {
      setMic("off");
    }
  };

  const pair = async () => {
    setPairMsg("");
    if (!s.convexUrl) return setPairMsg("Pairing isn't set up on this copy of JustAsk yet.");
    try {
      const { token, displayName } = await backend.redeem(s.convexUrl, code.replace(/\D/g, ""));
      await update({ deviceToken: token, displayName });
      setPairMsg(`Paired. Hi ${displayName}!`);
    } catch {
      setPairMsg("That code didn't work. Ask for a new one.");
    }
  };

  const finish = async () => {
    await update({ setupDone: true });
    if (s.deviceToken) await backend.setConsent(s.consent);
    window.close();
  };

  return (
    <div className="setup">
      <header className="setup-head">
        <Orb mode="idle" size={96} />
        <div>
          <h1>Set up JustAsk</h1>
          <p className="soft">Three quick steps. You can do this with your helper.</p>
        </div>
      </header>

      <ol className="steps">
        <li className={`step ${access ? "ok" : ""}`}>
          <h2>1. Let JustAsk see web pages</h2>
          <p>JustAsk reads the page you're on so it can point at the right button. It never clicks for you, and it never reads what you type.</p>
          {access ? (
            <p className="done">✓ JustAsk is on</p>
          ) : (
            <button className="btn primary huge" onClick={turnOn}>
              Turn on JustAsk
            </button>
          )}
        </li>

        <li className={`step ${mic === "on" ? "ok" : ""}`}>
          <h2>2. Let JustAsk hear you</h2>
          <p>So you can just say what you want. You can always type instead.</p>
          {mic === "on" ? (
            <p className="done">✓ Microphone is on</p>
          ) : (
            <>
              <button className="btn primary huge" onClick={askMic}>
                Turn on the microphone
              </button>
              {mic === "off" && <p className="note">The microphone is blocked. Click the lock in the address bar and allow it, or just type.</p>}
            </>
          )}
        </li>

        <li className={`step ${s.deviceToken ? "ok" : ""}`}>
          <h2>3. Connect to your helper (optional)</h2>
          <p>If someone helps you, they can send you tasks. Type the 6-digit code they gave you.</p>
          {s.deviceToken ? (
            <p className="done">✓ Connected{s.displayName ? ` as ${s.displayName}` : ""}</p>
          ) : (
            <div className="row">
              <input inputMode="numeric" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" aria-label="Pairing code" />
              <button className="btn dark" onClick={pair} disabled={code.replace(/\D/g, "").length !== 6}>
                Connect
              </button>
            </div>
          )}
          {pairMsg && <p className="soft">{pairMsg}</p>}
          {s.deviceToken && (
            <div className="toggles">
              <label className="toggle">
                <input type="checkbox" checked={s.consent.notifyOnComplete} onChange={(e) => update({ consent: { ...s.consent, notifyOnComplete: e.target.checked } })} />
                <span>Tell my helper when I finish a task they sent</span>
              </label>
              <label className="toggle">
                <input type="checkbox" checked={s.consent.notifyOnStuck} onChange={(e) => update({ consent: { ...s.consent, notifyOnStuck: e.target.checked } })} />
                <span>Tell my helper when I get stuck</span>
              </label>
            </div>
          )}
        </li>
      </ol>

      <button className="btn dark huge" onClick={finish}>
        All set
      </button>
      <p className="soft center">Then click the JustAsk button at the top right of your browser.</p>

      <details className="advanced" open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>For helpers: server settings</summary>
        <SavedField label="Planner address" value={s.plannerUrl} onSave={(v) => update({ plannerUrl: v.trim() })} />
        <SavedField label="Convex address" value={s.convexUrl} onSave={(v) => update({ convexUrl: v.trim() })} placeholder="https://your-deployment.convex.cloud" />
        {s.deviceToken && (
          <button className="btn ghost" onClick={() => update({ deviceToken: null, displayName: "" })}>
            Disconnect from helper
          </button>
        )}
      </details>
    </div>
  );
}

/** Local while typing, saved on blur, so async storage writes can't drop keystrokes. */
function SavedField({ label, value, onSave, placeholder }: { label: string; value: string; onSave: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label>
      {label}
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} placeholder={placeholder} />
    </label>
  );
}
