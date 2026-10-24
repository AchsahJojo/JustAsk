import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { getSettings, saveSettings, type Settings } from "../lib/config";
import { backend, type Helper } from "../lib/backend";
import { Orb } from "./Orb";

const ALL_SITES = { origins: ["<all_urls>"] };

/**
 * One-time setup tab: host access (the gesture lives here, never mid-session), the mic
 * prompt (side panels can't show it reliably), her name, and an optional helper with consent.
 * JustAsk works with no helper: this computer gets its own account in the background.
 */
export function Setup() {
  const [s, setS] = useState<Settings | null>(null);
  const [access, setAccess] = useState(false);
  const [mic, setMic] = useState<"unknown" | "on" | "off">("unknown");
  const [code, setCode] = useState("");
  const [pairMsg, setPairMsg] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [helpers, setHelpers] = useState<Helper[]>([]);

  const refreshMe = async () => {
    const me = await backend.me();
    if (!me) return;
    setHelpers(me.helpers);
    setS(await saveSettings({ displayName: me.displayName || (await getSettings()).displayName, consent: me.consent }));
  };

  useEffect(() => {
    void backend.ensureDevice().then(async () => {
      setS(await getSettings());
      await refreshMe();
    });
    void browser.permissions.contains(ALL_SITES).then(setAccess);
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((p) => setMic(p.state === "granted" ? "on" : p.state === "denied" ? "off" : "unknown"))
      .catch(() => {});
  }, []);

  if (!s) return null;
  const update = async (patch: Partial<Settings>) => setS(await saveSettings(patch));
  const setConsent = async (consent: Settings["consent"]) => {
    await update({ consent });
    await backend.setConsent(consent);
  };
  const setName = async (displayName: string) => {
    await update({ displayName });
    await backend.ensureDevice();
    await backend.setDisplayName(displayName);
  };

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
    if (!s.convexUrl) return setPairMsg("Connecting to a helper isn't set up on this copy of JustAsk yet.");
    try {
      const res = await backend.redeem(s.convexUrl, code.replace(/\D/g, ""));
      if (!res.ok) return setPairMsg(res.error);
      await update({ deviceToken: res.token, displayName: res.displayName || s.displayName });
      setCode("");
      await refreshMe();
      setPairMsg(res.displayName ? `Connected. Hi ${res.displayName}!` : "Connected.");
    } catch {
      setPairMsg("JustAsk couldn't reach the internet. Check the connection and try again.");
    }
  };

  const leave = async (h: Helper) => {
    if (!confirm(`Stop getting tasks from ${h.name}? JustAsk keeps working for you.`)) return;
    try {
      await backend.leaveHelpers(h.id);
      await refreshMe();
      setPairMsg(`You're no longer connected to ${h.name}.`);
    } catch {
      setPairMsg("That didn't work. Try again in a moment.");
    }
  };

  const finish = async () => {
    await update({ setupDone: true });
    if (helpers.length) await backend.setConsent(s.consent);
    window.close();
  };

  return (
    <div className="setup">
      <header className="setup-head">
        <Orb mode="idle" size={96} />
        <div>
          <h1>Set up JustAsk</h1>
          <p className="soft">A few quick steps. You can do this on your own or with someone who helps you.</p>
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

        <li className={`step ${s.displayName ? "ok" : ""}`}>
          <h2>3. What should JustAsk call you?</h2>
          <p>Optional. JustAsk uses it to say hello.</p>
          <NameField value={s.displayName} onSave={setName} />
        </li>

        <li className={`step ${helpers.length ? "ok" : ""}`}>
          <h2>4. Connect to a helper (optional)</h2>
          <p>You don't need a helper. JustAsk works on its own. If someone helps you, they can send you tasks. Type the 6-digit code they gave you.</p>
          {helpers.length > 0 && (
            <>
              <p className="done">✓ Connected{s.displayName ? ` as ${s.displayName}` : ""}</p>
              <ul className="helpers">
                {helpers.map((h) => (
                  <li key={h.id}>
                    <span>
                      <strong>{h.name}</strong> can send you tasks
                    </span>
                    <button className="btn ghost small" onClick={() => leave(h)}>
                      Stop
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="row">
            <input
              inputMode="numeric"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && code.replace(/\D/g, "").length === 6 && pair()}
              placeholder="123456"
              aria-label="Pairing code"
            />
            <button className="btn dark" onClick={pair} disabled={code.replace(/\D/g, "").length !== 6}>
              {helpers.length ? "Add helper" : "Connect"}
            </button>
          </div>
          {pairMsg && (
            <p className="soft" role="status">
              {pairMsg}
            </p>
          )}
          {helpers.length > 0 && (
            <div className="toggles">
              <label className="toggle">
                <input type="checkbox" checked={s.consent.notifyOnComplete} onChange={(e) => setConsent({ ...s.consent, notifyOnComplete: e.target.checked })} />
                <span>Tell my helper when I finish a task they sent</span>
              </label>
              <label className="toggle">
                <input type="checkbox" checked={s.consent.notifyOnStuck} onChange={(e) => setConsent({ ...s.consent, notifyOnStuck: e.target.checked })} />
                <span>Tell my helper when I get stuck</span>
              </label>
              <p className="soft small">Your helper never sees the pages you visit, what you type, or what you ask JustAsk yourself.</p>
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
        {helpers.length > 0 && (
          <button className="btn ghost" onClick={() => backend.leaveHelpers().then(refreshMe)}>
            Disconnect from all helpers
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

function NameField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const save = () => v.trim() !== value && onSave(v.trim());
  return (
    <div className="row">
      <input value={v} maxLength={40} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Your first name" aria-label="Your name" />
    </div>
  );
}
