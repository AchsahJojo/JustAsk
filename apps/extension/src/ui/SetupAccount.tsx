import { useEffect, useState } from "react";
import { saveSettings, type Settings } from "../lib/config";
import { backend, NOT_PAIRED } from "../lib/backend";
import { codeAttemptMessage, friendlyError } from "../lib/prefs";
import { pullPrefs, pushPrefs } from "../lib/prefsSync";
import { currentDevice } from "../platform/device";
import { useNotPaired } from "./useTaskList";
import { Requests } from "./Requests";

const WAIT_POLL_MS = 3_000;

const NO_SERVER = "Accounts aren't set up on this copy of JustAsk yet. JustAsk still works on this computer without one.";
const digits = (v: string) => v.replace(/\D/g, "");
/**
 * Setup step 3: join the user's account. "I'm new" creates it (accounts:createSelf); "I have a code"
 * redeems a 6-digit code (devices:redeemCode). A `?link=` code from the link page asks first.
 */
export function AccountStep({ s, onChange, linkCode, onLinkDone }: { s: Settings; onChange: (s: Settings) => void; linkCode: string | null; onLinkDone: () => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // A token the server no longer knows (revoked or removed). It stays saved; the user picks a way back in.
  const notPaired = useNotPaired(s.deviceToken);
  // A helper's code typed here while the account is in use on another computer: wait for Allow there.
  const [waitingFor, setWaitingFor] = useState<string | null>(null);

  const connected = async (token: string, displayName: string) => {
    onChange(await saveSettings({ deviceToken: token, displayName }));
    setMsg(displayName ? `Connected. Hi ${displayName}!` : "Connected.");
    onChange(await pullPrefs());
  };

  const waitForAllow = async (token: string, displayName: string) => {
    onChange(await saveSettings({ deviceToken: token, displayName }));
    setMsg("");
    setWaitingFor(displayName || "your JustAsk");
  };

  // Also after the setup page reloads while waiting.
  useEffect(() => {
    if (!s.deviceToken) return;
    let stop = false;
    const check = async () => {
      const r = await backend.joinStatus();
      if (stop || !r) return;
      if (r.status === "waiting") setWaitingFor(r.displayName || "your JustAsk");
      else if (waitingFor !== null) {
        setWaitingFor(null);
        if (r.status === "ready") {
          setMsg(r.displayName ? `Connected. Hi ${r.displayName}!` : "Connected.");
          onChange(await pullPrefs());
        } else {
          onChange(await saveSettings({ deviceToken: null, displayName: "" }));
          setMsg("That computer said no, so this browser isn't connected. Ask your helper for a new code if you meant to connect it.");
        }
      }
    };
    void check();
    const iv = setInterval(() => void check(), WAIT_POLL_MS);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [s.deviceToken, waitingFor]);

  const redeem = async (code: string) => {
    setMsg("");
    if (!s.convexUrl) return setMsg(NO_SERVER);
    setBusy(true);
    try {
      if (s.deviceToken && !notPaired) {
        const joined = await backend.joinWithCode(code);
        if (!joined) setMsg(codeAttemptMessage(null));
        else if (joined.pending) await waitForAllow(s.deviceToken, joined.displayName);
        else await connected(s.deviceToken, joined.displayName);
      } else {
        const r = await backend.redeem(s.convexUrl, code, currentDevice());
        if (!r) setMsg(codeAttemptMessage(null));
        else if (r.pending) await waitForAllow(r.token, r.displayName);
        else await connected(r.token, r.displayName);
      }
    } catch (e) {
      setMsg(codeAttemptMessage(e));
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
    <li className={`step ${s.deviceToken && !notPaired && waitingFor === null ? "ok" : ""}`}>
      <h2>3. Your JustAsk</h2>
      {waitingFor !== null ? (
        <div className="card task" role="status">
          <p className="task-title">Almost there</p>
          <p>
            {waitingFor === "your JustAsk" ? "JustAsk" : `${waitingFor}'s JustAsk`} is already used on another computer. On that computer, open JustAsk and
            press <strong>Allow</strong>. This page will update by itself.
          </p>
        </div>
      ) : s.deviceToken && notPaired ? (
        <>
          <p role="status">{NOT_PAIRED}</p>
          <div className="choice-grid">
            <NewAccount busy={busy} onCreate={create} />
            <HaveCode busy={busy} onRedeem={redeem} />
          </div>
        </>
      ) : s.deviceToken ? (
        <>
          <p className="done">✓ Connected{s.displayName ? ` as ${s.displayName}` : ""}</p>
          <Requests />
          {linkCode && <p className="soft">This browser is already linked{s.displayName ? ` to ${s.displayName}'s JustAsk` : ""}.</p>}
          <HaveCode busy={busy} onRedeem={redeem} />
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
      ) : linkCode ? (
        <LinkConfirm
          convexUrl={s.convexUrl}
          code={linkCode}
          busy={busy}
          onYes={() => void redeem(linkCode).then(onLinkDone)}
          onNo={onLinkDone}
        />
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
      <label htmlFor="pair-code">The 6-digit code from your helper, or from JustAsk on another browser</label>
      <div className="row">
        <input id="pair-code" inputMode="numeric" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" aria-label="Pairing code" autoComplete="one-time-code" />
        <button className="btn dark" type="submit" disabled={!ok || busy}>
          Connect
        </button>
      </div>
    </form>
  );
}

/** "Link to Margaret's JustAsk?" before a code from the link page is used up. */
function LinkConfirm({ convexUrl, code, busy, onYes, onNo }: { convexUrl: string; code: string; busy: boolean; onYes: () => void; onNo: () => void }) {
  const [name, setName] = useState<string | null>(null);
  const [looked, setLooked] = useState(false);
  useEffect(() => {
    if (!convexUrl) return setLooked(true);
    void backend.peekCode(convexUrl, code).then(
      (n) => {
        setName(n);
        setLooked(true);
      },
      () => {
        setName(null);
        setLooked(true);
      },
    );
  }, [convexUrl, code]);
  return (
    <div className="card task">
      <p className="task-title">{name ? `Link to ${name}'s JustAsk?` : "Link this browser to your JustAsk?"}</p>
      {looked && !name ? (
        <p className="note">I couldn't check whose JustAsk this code belongs to. Ask your helper to make a new link code, then try again.</p>
      ) : (
        <p className="soft">Only say yes if you just asked to add this browser.</p>
      )}
      <div className="row">
        <button className="btn primary grow" onClick={onYes} disabled={!looked || !name || busy}>
          Yes, link it
        </button>
        <button className="btn outline grow" onClick={onNo} disabled={busy}>
          No
        </button>
      </div>
    </div>
  );
}
