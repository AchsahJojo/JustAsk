import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api, errorText } from "../api";
import { go } from "../router";

export function Account() {
  const me = useQuery(api.caregivers.me);
  const rename = useMutation(api.caregivers.rename);
  const { signOut } = useAuthActions();
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  if (!me) return null;
  const value = name ?? me.name;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    setError("");
    try {
      await rename({ name: value });
      setName(null);
      setMsg("Saved.");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="narrow-page">
      <h1>Your account</h1>
      <form className="card form" onSubmit={save} noValidate>
        <label className="field">
          <span>Your name</span>
          <input value={value} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <small>People you help hear it on tasks: “{value.trim() || "Sam"} sent you a task.”</small>
        </label>
        <label className="field">
          <span>Email</span>
          <input value={me.email} disabled />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {msg && (
          <p className="ok-text" role="status">
            {msg}
          </p>
        )}
        <div className="actions">
          <button className="btn primary" disabled={value.trim() === me.name}>
            Save
          </button>
        </div>
      </form>
      <section className="card">
        <h2>Sign out</h2>
        <p className="muted small">The people you help keep using JustAsk while you're signed out. Tasks you sent stay on their computer.</p>
        <button
          className="btn ghost"
          onClick={() => {
            go({ name: "home" });
            void signOut();
          }}
        >
          Sign out
        </button>
      </section>
    </div>
  );
}
