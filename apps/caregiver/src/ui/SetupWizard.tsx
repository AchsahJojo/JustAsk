import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api, errorText, type Id } from "../api";
import { go, href } from "../router";

const RELATIONS: Array<{ label: string; call: string }> = [
  { label: "Parent", call: "" },
  { label: "Grandparent", call: "" },
  { label: "Partner", call: "" },
  { label: "Friend", call: "" },
  { label: "Client", call: "" },
];

export function Stepper({ at }: { at: 1 | 2 | 3 }) {
  const steps = ["About them", "Connect their computer", "Send a task"];
  return (
    <ol className="stepper" aria-label="Setup steps">
      {steps.map((s, i) => (
        <li key={s} className={i + 1 < at ? "done" : i + 1 === at ? "on" : ""} aria-current={i + 1 === at ? "step" : undefined}>
          <span className="n">{i + 1 < at ? "✓" : i + 1}</span>
          {s}
          {i === 2 && <span className="opt">optional</span>}
        </li>
      ))}
    </ol>
  );
}

/** Step 1: who they are. Creating the profile makes the pairing code, then step 2 lives on their page. */
export function SetupWizard() {
  const create = useMutation(api.devices.createSeniorWithCode);
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  const [call, setCall] = useState("");
  const [callTouched, setCallTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const firstName = name.trim().split(/\s+/)[0] ?? "";
  const suggested = RELATIONS.find((r) => r.label === relation)?.call || firstName;
  const displayName = callTouched ? call : suggested;

  const pick = (label: string) => setRelation(relation === label ? "" : label);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Add their name.");
    setBusy(true);
    setError("");
    try {
      const { seniorId } = await create({ name: name.trim(), displayName: displayName.trim() || firstName, relation: relation.trim() });
      go({ name: "person", id: seniorId });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="wizard">
      <a className="back" href={href({ name: "home" })}>
        ← People
      </a>
      <Stepper at={1} />
      <form className="card form" onSubmit={submit} onInput={() => setError("")} noValidate>
        <h1>Who are you setting JustAsk up for?</h1>
        <p className="muted">No account or password for them. Their computer connects to you with a one-time code.</p>

        <label className="field">
          <span>Their name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Joan Hill" maxLength={60} autoFocus autoComplete="off" />
        </label>

        <fieldset className="field">
          <legend>They are your…</legend>
          <div className="chips">
            {RELATIONS.map((r) => (
              <button type="button" key={r.label} className={`chip ${relation === r.label ? "on" : ""}`} aria-pressed={relation === r.label} onClick={() => pick(r.label)}>
                {r.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span>What should JustAsk call them?</span>
          <input
            value={displayName}
            onChange={(e) => {
              setCallTouched(true);
              setCall(e.target.value);
            }}
            placeholder={firstName || "Pat"}
            maxLength={40}
          />
          <small>JustAsk says it out loud: “Hi {displayName.trim() || firstName || "Pat"}, what would you like to do?”</small>
        </label>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button className="btn primary big" disabled={busy}>
            {busy ? "Making their code…" : "Continue"}
          </button>
        </div>
      </form>
      <HelperCode />
    </div>
  );
}

/**
 * They already use JustAsk on their own: in their Settings, "Share with my helper" shows a 6-digit
 * code. Typing it here links you to their account (`careLinks:redeemHelperCode`).
 */
function HelperCode() {
  const redeem = useMutation(api.careLinks.redeemHelperCode);
  const pendingList = useQuery(api.careLinks.pendingForMe);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The code worked; the link waits until they say yes on their computer (careLinks:respond).
  const [waiting, setWaiting] = useState<{ seniorId: Id<"seniors">; displayName: string } | null>(null);
  const digits = code.replace(/\D/g, "");

  // They answered: yes opens their page; no (or a day passing) drops the waiting link.
  const people = useQuery(api.people.list);
  // Decide only after the live list has shown the waiting link once, so a slow first update isn't read as a no.
  const seenWaiting = useRef(false);
  useEffect(() => {
    if (!waiting || pendingList === undefined || people === undefined) return;
    if (people.some((p) => p.id === waiting.seniorId)) return go({ name: "person", id: waiting.seniorId });
    if (pendingList.some((p) => p.seniorId === waiting.seniorId)) {
      seenWaiting.current = true;
      return;
    }
    if (seenWaiting.current) {
      seenWaiting.current = false;
      setWaiting(null);
      setBusy(false);
      setError(`${waiting.displayName || "They"} said no on their computer. If that was a mistake, ask them for a new code.`);
    }
  }, [waiting, pendingList, people]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (digits.length !== 6) return setError("Enter the 6 numbers from their screen.");
    setBusy(true);
    setError("");
    try {
      const r = await redeem({ code: digits });
      if (!r) {
        setError("That code didn't work. Codes last 15 minutes and work once. The code on their computer's setup page is typed there, not here.");
        setBusy(false);
      } else if (r.pending) setWaiting({ seniorId: r.seniorId, displayName: r.displayName });
      else go({ name: "person", id: r.seniorId });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form className="card form helper-code" onSubmit={submit} onInput={() => setError("")} noValidate>
      <h2>Do they already use JustAsk?</h2>
      <p className="muted">
        Ask them to open JustAsk's <strong>Settings</strong> and press <strong>Share with my helper</strong>. Then type the code they see.
      </p>
      <div className="code-row">
        <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={7} placeholder="123456" aria-label="Their code" autoComplete="one-time-code" />
        <button className="btn ghost" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
      {waiting && (
        <p className="note" role="status">
          <strong>Now {waiting.displayName || "they"} says yes.</strong> JustAsk is asking on their computer: “Let you help with JustAsk?” This page opens
          their page as soon as they press Yes.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
