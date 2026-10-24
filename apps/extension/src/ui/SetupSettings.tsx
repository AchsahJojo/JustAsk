import { useEffect, useState } from "react";
import { saveSettings, type Settings } from "../lib/config";
import { backend } from "../lib/backend";
import { friendlyError, seenAgo, spacedCode, type DeviceRow } from "../lib/prefs";
import { pushPrefs } from "../lib/prefsSync";

const SPEEDS = [
  { label: "Slower", rate: 0.75 },
  { label: "Normal", rate: 0.9 },
  { label: "Faster", rate: 1.1 },
];

/** Setup step 4 (once connected): synced preferences, linked devices and the helper code. */
export function SettingsStep({ s, onChange }: { s: Settings; onChange: (s: Settings) => void }) {
  const set = async (patch: Parameters<typeof pushPrefs>[0]) => onChange(await pushPrefs(patch));
  return (
    <li className="step">
      <h2>4. Your settings</h2>
      <p>These follow you to every computer and browser where you use JustAsk.</p>

      <div className="toggles">
        <label className="toggle">
          <input type="checkbox" checked={s.showMeInstead} onChange={(e) => set({ showMeInstead: e.target.checked })} />
          <span>
            <strong>Show me instead</strong>
            <br />
            <span className="soft">JustAsk shows you where to click instead of doing it.</span>
          </span>
        </label>
      </div>

      <fieldset className="speeds">
        <legend>How fast JustAsk talks</legend>
        <div className="row">
          {SPEEDS.map((sp) => (
            <button key={sp.label} type="button" className={`btn grow ${Math.abs(s.rate - sp.rate) < 0.05 ? "dark" : "soft-btn"}`} aria-pressed={Math.abs(s.rate - sp.rate) < 0.05} onClick={() => set({ rate: sp.rate })}>
              {sp.label}
            </button>
          ))}
        </div>
      </fieldset>

      <CodeSection
        title="Add another device"
        button="Add another device"
        explain="Type this code on your other computer or browser. It works for 15 minutes."
        make={async () => (await backend.createLinkCode()).code}
      />

      <Devices onSelfRemoved={async () => onChange(await saveSettings({ deviceToken: null, displayName: "" }))} />

      <CodeSection
        title="Share with my helper"
        button="Share with my helper"
        explain="Only give this to someone you trust. They will be able to send you tasks."
        make={() => backend.createHelperCode()}
      />
    </li>
  );
}

/** A button that mints a 6-digit code and shows it very large. */
function CodeSection({ title, button, explain, make }: { title: string; button: string; explain: string; make: () => Promise<string> }) {
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setMsg("");
    setBusy(true);
    try {
      setCode(await make());
    } catch (e) {
      setMsg(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="sub" aria-label={title}>
      <h3>{title}</h3>
      {code ? (
        <>
          <p className="bigcode" aria-label={`Code ${code.split("").join(" ")}`}>
            {spacedCode(code)}
          </p>
          <p>{explain}</p>
          <button className="btn ghost" onClick={go} disabled={busy}>
            Get a new code
          </button>
        </>
      ) : (
        <button className="btn outline" onClick={go} disabled={busy}>
          {button}
        </button>
      )}
      {msg && (
        <p className="soft" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}

/** Linked installs, each with Remove behind an inline confirm. */
function Devices({ onSelfRemoved }: { onSelfRemoved: () => void }) {
  const [rows, setRows] = useState<DeviceRow[] | null>(null);
  const [msg, setMsg] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = async () => {
    try {
      setRows(await backend.listDevices());
      setMsg("");
    } catch (e) {
      setRows([]);
      setMsg(friendlyError(e));
    }
  };
  useEffect(() => void load(), []);

  const remove = async (d: DeviceRow) => {
    setConfirming(null);
    try {
      await backend.revokeDevice(d.id);
      if (d.current) return onSelfRemoved();
      await load();
    } catch (e) {
      setMsg(friendlyError(e));
    }
  };

  return (
    <section className="sub" aria-label="Your devices">
      <h3>Your devices</h3>
      {rows === null && <p className="soft">Looking…</p>}
      {rows && rows.length > 0 && (
        <ul className="devices">
          {rows.map((d) => (
            <li key={d.id} className="device">
              <div className="grow">
                <strong>{d.label}</strong>
                {d.current && <span className="soft"> (this one)</span>}
                {d.lastSeenAt !== null && <p className="soft">{seenAgo(d.lastSeenAt)}</p>}
              </div>
              {confirming === d.id ? (
                <div className="confirm" role="group" aria-label={`Remove ${d.label}?`}>
                  <p>Remove {d.label}? It will stop using your JustAsk.</p>
                  <div className="row">
                    <button className="btn primary" onClick={() => void remove(d)}>
                      Yes, remove
                    </button>
                    <button className="btn outline" onClick={() => setConfirming(null)}>
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn outline" onClick={() => setConfirming(d.id)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && (
        <p className="soft" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
