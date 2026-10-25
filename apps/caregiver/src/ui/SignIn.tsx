import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Brand } from "./bits";
import { Clay } from "./Clay";
import link from "../assets/link.json";

/** The name typed at sign-up, picked up by `caregivers:ensureProfile` once the session exists. */
export const PENDING_NAME_KEY = "justask.pendingName";

type Flow = "signUp" | "signIn";

function authError(e: unknown, flow: Flow): string {
  const data = (e as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  const msg = e instanceof Error ? e.message : String(e);
  if (/already exists/i.test(msg)) return "There's already an account with that email. Sign in instead.";
  if (/InvalidSecret|InvalidAccountId|Invalid credentials/i.test(msg)) return "That email and password don't match.";
  if (/TooManyFailedAttempts|rate/i.test(msg)) return "Too many tries. Wait a few minutes and try again.";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "Can't reach JustAsk. Check your connection.";
  const m = msg.match(/Uncaught (?:Convex)?Error: (.+?)(?:\n|$)/);
  if (m && !/^Server Error/.test(m[1])) return m[1];
  // Anything else is on our side (a server error), never something they typed. Say so plainly.
  return flow === "signUp"
    ? "JustAsk couldn't create your account because of a problem on our side, not anything you typed. Try again in a minute."
    : "JustAsk couldn't sign you in because of a problem on our side. Try again in a minute.";
}

export function SignIn() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<Flow>("signUp");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const em = email.trim().toLowerCase();
    if (flow === "signUp" && !name.trim()) return setError("Add your name. It's what they'll see on tasks you send.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return setError("Enter a valid email address.");
    if (flow === "signUp" && password.length < 8) return setError("Use at least 8 characters for your password.");
    if (!password) return setError("Enter your password.");
    setBusy(true);
    try {
      if (flow === "signUp") {
        try {
          sessionStorage.setItem(PENDING_NAME_KEY, name.trim());
        } catch {
          /* storage blocked: the email's first part is used instead */
        }
      }
      await signIn("password", { email: em, password, flow, ...(flow === "signUp" ? { name: name.trim() } : {}) });
    } catch (err) {
      setError(authError(err, flow));
      setBusy(false);
    }
  };

  const switchTo = (f: Flow) => {
    setFlow(f);
    setError("");
  };

  return (
    <div className="auth">
      <section className="auth-hero" aria-hidden="true">
        <Brand />
        <div className="auth-hero-body">
          <Clay doc={link} width={360} height={160} inputs={{ connected: 0 }} className="hero-clay" />
          <h2>Help from a distance, without taking over.</h2>
          <p>
            JustAsk shows the person you help where to click, one step at a time, by voice. You can set it up for them, send them tasks, and hear when
            they're done.
          </p>
          <ul className="ticks">
            <li>They do every click themselves</li>
            <li>You never see their screen or what they type</li>
            <li>JustAsk works for them with or without you</li>
          </ul>
        </div>
      </section>

      <section className="auth-form-wrap">
        <form className="auth-form card" onSubmit={submit} onInput={() => setError("")} noValidate>
          <div className="mobile-brand">
            <Brand />
          </div>
          <div className="seg" role="tablist" aria-label="Account">
            <button type="button" role="tab" aria-selected={flow === "signUp"} className={flow === "signUp" ? "on" : ""} onClick={() => switchTo("signUp")}>
              Create account
            </button>
            <button type="button" role="tab" aria-selected={flow === "signIn"} className={flow === "signIn" ? "on" : ""} onClick={() => switchTo("signIn")}>
              Sign in
            </button>
          </div>
          <h1>{flow === "signUp" ? "Create your helper account" : "Welcome back"}</h1>
          <p className="muted">
            {flow === "signUp"
              ? "For family, friends and carers. The person you help doesn't need an account or a password."
              : "Sign in to see the people you help."}
          </p>

          {flow === "signUp" && (
            <label className="field">
              <span>Your name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Sam" maxLength={60} />
              <small>They'll hear it: "Sam sent you a task."</small>
            </label>
          )}
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" />
          </label>
          <label className="field">
            <span>Password</span>
            <span className="pw">
              <input
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={flow === "signUp" ? "new-password" : "current-password"}
                placeholder={flow === "signUp" ? "At least 8 characters" : ""}
              />
              <button type="button" className="pw-toggle" onClick={() => setShow(!show)} aria-pressed={show}>
                {show ? "Hide" : "Show"}
              </button>
            </span>
            {flow === "signUp" && password.length > 0 && (
              <small className={password.length >= 8 ? "ok-text" : ""} aria-live="polite">
                {password.length >= 8 ? "Long enough." : `${password.length} of 8 characters. Add ${8 - password.length} more.`}
              </small>
            )}
          </label>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <button className="btn primary block" disabled={busy}>
            {busy ? (flow === "signUp" ? "Creating account…" : "Signing in…") : flow === "signUp" ? "Create account" : "Sign in"}
          </button>
          <p className="muted small center">
            {flow === "signUp" ? (
              <>
                Already have an account?{" "}
                <button type="button" className="linkbtn" onClick={() => switchTo("signIn")}>
                  Sign in
                </button>
              </>
            ) : (
              <>
                New here?{" "}
                <button type="button" className="linkbtn" onClick={() => switchTo("signUp")}>
                  Create an account
                </button>
              </>
            )}
          </p>
        </form>
      </section>
    </div>
  );
}
