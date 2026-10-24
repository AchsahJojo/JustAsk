import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { getSettings, saveSettings, type Settings } from "../lib/config";
import { pullPrefs } from "../lib/prefsSync";
import { AccountStep } from "./SetupAccount";
import { SettingsStep } from "./SetupSettings";
import { Orb } from "./Orb";

const ALL_SITES = { origins: ["<all_urls>"] };

/** A 6-digit `?link=` code, set when the background saw `#justask-link=` on the link page. */
function linkCodeFromUrl(): string | null {
  const v = new URLSearchParams(location.search).get("link");
  return v && /^\d{6}$/.test(v) ? v : null;
}

/**
 * Setup and settings tab: host access (the gesture lives here, never mid-session), the mic
 * prompt (side panels can't show it reliably), her account, and synced settings.
 */
export function Setup() {
  const [s, setS] = useState<Settings | null>(null);
  const [access, setAccess] = useState(false);
  const [mic, setMic] = useState<"unknown" | "on" | "off">("unknown");
  const [linkCode, setLinkCode] = useState<string | null>(linkCodeFromUrl);

  useEffect(() => {
    void getSettings().then((x) => {
      setS(x);
      if (x.deviceToken) void pullPrefs().then(setS);
    });
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

  const finish = async () => {
    await update({ setupDone: true });
    window.close();
  };

  const linkDone = () => {
    setLinkCode(null);
    history.replaceState(null, "", location.pathname);
  };

  return (
    <div className="setup">
      <header className="setup-head">
        <Orb mode="idle" size={96} />
        <div>
          <h1>Set up JustAsk</h1>
          <p className="soft">A few quick steps. You can do this with your helper.</p>
        </div>
      </header>

      <ol className="steps">
        <li className={`step ${access ? "ok" : ""}`}>
          <h2>1. Let JustAsk see web pages</h2>
          <p>JustAsk reads the page you're on so it can find the right button and press it for you. It never reads what you have typed, and it never types passwords or card numbers.</p>
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

        <AccountStep s={s} onChange={setS} linkCode={linkCode} onLinkDone={linkDone} />
        {s.deviceToken && <SettingsStep s={s} onChange={setS} />}
      </ol>

      <button className="btn dark huge" onClick={finish}>
        All set
      </button>
      <p className="soft center">Then click the JustAsk button at the top right of your browser.</p>
    </div>
  );
}
