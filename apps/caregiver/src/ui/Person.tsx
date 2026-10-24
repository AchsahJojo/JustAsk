import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { isSafeStartUrl, TASK_LIMITS, type CaregiverTaskStatus } from "@justask/shared";
import { api, errorText, type Id } from "../api";
import { go, href } from "../router";
import { ConnectPanel } from "./Connect";
import { Stepper } from "./SetupWizard";
import { ago, initials, Spinner, useNow } from "./bits";

export function Person({ id }: { id: string }) {
  return (
    <NotFoundBoundary key={id}>
      <PersonPage id={id as Id<"seniors">} />
    </NotFoundBoundary>
  );
}

/** Convex queries throw on "not your senior": show a friendly page instead of a blank one. */
class NotFoundBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card narrow center-block">
        <h1>We can't find that person</h1>
        <p className="muted">They may have been removed, or they disconnected from you on their computer.</p>
        <a className="btn primary" href={href({ name: "home" })}>
          Back to people
        </a>
      </section>
    );
  }
}

function PersonPage({ id }: { id: Id<"seniors"> }) {
  const got = useQuery(api.people.get, { seniorId: id });
  const p = got && !got.moved ? got : undefined;
  const [addComputer, setAddComputer] = useState(false);
  const prevDevices = useRef<number | null>(null);

  useEffect(() => {
    if (!p) return;
    if (addComputer && prevDevices.current !== null && p.devices > prevDevices.current) setAddComputer(false);
    prevDevices.current = p.devices;
  }, [p, addComputer]);

  const movedTo = got?.moved ? got.movedTo : null;
  useEffect(() => {
    if (movedTo) location.replace(href({ name: "person", id: movedTo }));
  }, [movedTo]);

  if (p === undefined) return <Spinner label="Loading" />;

  const connected = p.devices > 0;
  // Until the first task is sent, the page keeps walking them through setup.
  const firstRun = !connected || p.tasks.length === 0;

  return (
    <div className="person">
      <a className="back" href={href({ name: "home" })}>
        ← People
      </a>
      <header className="person-head">
        <span className="avatar-lg" aria-hidden="true">
          {initials(p.name)}
        </span>
        <div>
          <h1>{p.name}</h1>
          <p className="muted">
            {p.relation ? `${p.relation} · ` : ""}JustAsk calls them “{p.displayName}”
          </p>
        </div>
        {connected ? <span className="pill ok">Connected</span> : <span className="pill warn">Not connected yet</span>}
      </header>

      {firstRun && <Stepper at={connected ? 3 : 2} />}
      {(firstRun || addComputer) && <ConnectPanel seniorId={p.id} displayName={p.displayName} connected={connected} another={addComputer} />}

      {connected && (
        <div className="person-grid">
          <div className="col">
            <TaskComposer seniorId={p.id} displayName={p.displayName} open={firstRun} />
            <TaskList tasks={p.tasks} consent={p.consent.notifyOnComplete} displayName={p.displayName} />
          </div>
          <div className="col side">
            <Sharing displayName={p.displayName} consent={p.consent} stats={p.stats} />
            <section className="card">
              <h2>Computers</h2>
              <p className="muted small">
                {p.devices === 1 ? "1 computer is" : `${p.devices} computers are`} connected to {p.displayName}'s JustAsk.
                {p.otherHelpers > 0 && ` ${p.otherHelpers} other ${p.otherHelpers === 1 ? "helper is" : "helpers are"} connected too.`}
              </p>
              {!addComputer && (
                <button className="btn ghost small" onClick={() => setAddComputer(true)}>
                  Add another computer
                </button>
              )}
            </section>
            <Details p={p} connected={connected} />
          </div>
        </div>
      )}
      {!connected && <Details p={p} connected={connected} />}
    </div>
  );
}

const TEMPLATES = [
  { title: "Join a video call", spoken: "help me join the video call" },
  { title: "Refill a prescription", spoken: "help me refill my prescription" },
  { title: "Reply to an email", spoken: "help me reply to an email" },
];

function TaskComposer({ seniorId, displayName, open: startOpen }: { seniorId: Id<"seniors">; displayName: string; open: boolean }) {
  const assign = useMutation(api.tasks.assign);
  const me = useQuery(api.caregivers.me);
  const [open, setOpen] = useState(startOpen);
  const [title, setTitle] = useState("");
  const [spoken, setSpoken] = useState("");
  const [withRecipe, setWithRecipe] = useState(false);
  const [startUrl, setStartUrl] = useState("");
  const [steps, setSteps] = useState<string[]>([""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");

  const reset = () => {
    setTitle("");
    setSpoken("");
    setWithRecipe(false);
    setStartUrl("");
    setSteps([""]);
  };

  const urlError = withRecipe && startUrl.trim() && !isSafeStartUrl(startUrl.trim()) ? "Use a full web address, like https://www.example.com" : "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!title.trim()) return setError("Give the task a short name.");
    if (urlError) return setError(urlError);
    setBusy(true);
    try {
      const cleanSteps = steps.map((s) => s.trim()).filter(Boolean);
      const url = startUrl.trim();
      await assign({
        seniorId,
        title: title.trim(),
        ...(spoken.trim() ? { spokenPrompt: spoken.trim() } : {}),
        ...(withRecipe && (cleanSteps.length || url) ? { recipe: { steps: cleanSteps, ...(url ? { startUrl: url } : {}) } } : {}),
      });
      setSent(title.trim());
      reset();
      setOpen(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <section className="card composer-closed">
        <div>
          <h2>Send a task</h2>
          <p className="muted small">{sent ? `Sent “${sent}”. ${displayName} will see it next time they open JustAsk.` : `It shows up on ${displayName}'s computer with a Start button.`}</p>
        </div>
        <button
          className="btn primary"
          onClick={() => {
            setSent("");
            setOpen(true);
          }}
        >
          New task
        </button>
      </section>
    );

  return (
    <form className="card form composer" onSubmit={submit} onInput={() => setError("")} noValidate>
      <h2>Send {displayName} a task</h2>
      <div className="chips" aria-label="Ideas">
        {TEMPLATES.map((t) => (
          <button
            type="button"
            className="chip"
            key={t.title}
            onClick={() => {
              setTitle(t.title);
              setSpoken(t.spoken);
            }}
          >
            {t.title}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Task</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Refill your prescription" maxLength={TASK_LIMITS.title} />
        <small>
          They'll see “{me?.name ?? "You"} asked you to: {title.trim() || "…"}” with a Start button.
        </small>
      </label>
      <label className="field">
        <span>
          What JustAsk should help with <em className="opt">optional</em>
        </span>
        <input value={spoken} onChange={(e) => setSpoken(e.target.value)} placeholder="help me refill my prescription" maxLength={TASK_LIMITS.spokenPrompt} />
        <small>Written as if they asked JustAsk themselves. Leave empty to use the task name.</small>
      </label>

      <label className="check">
        <input type="checkbox" checked={withRecipe} onChange={(e) => setWithRecipe(e.target.checked)} />
        <span>
          <strong>Add steps</strong>
          <span className="muted small"> A plain-language recipe makes JustAsk more reliable on tricky sites.</span>
        </span>
      </label>

      {withRecipe && (
        <div className="recipe">
          <label className="field">
            <span>
              Start page <em className="opt">optional</em>
            </span>
            <input
              type="url"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              placeholder="https://www.mypharmacy.com"
              maxLength={TASK_LIMITS.startUrl}
              aria-invalid={!!urlError}
            />
            {urlError ? <small className="error-text">{urlError}</small> : <small>JustAsk offers to open this page for them. It only ever opens pages you set here.</small>}
          </label>
          <div className="field">
            <span>Steps</span>
            <ol className="steps-edit">
              {steps.map((s, i) => (
                <li key={i}>
                  <span className="n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <input
                    value={s}
                    onChange={(e) => setSteps(steps.map((x, j) => (j === i ? e.target.value : x)))}
                    placeholder={i === 0 ? "Click Refill a prescription" : "Next step"}
                    maxLength={TASK_LIMITS.step}
                    aria-label={`Step ${i + 1}`}
                  />
                  <button type="button" className="icon-btn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => setSteps(move(steps, i, i - 1))}>
                    ↑
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Remove step ${i + 1}`} disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </li>
              ))}
            </ol>
            {steps.length < TASK_LIMITS.steps ? (
              <button type="button" className="linkbtn small" onClick={() => setSteps([...steps, ""])}>
                + Add a step
              </button>
            ) : (
              <small>That's the most steps a task can have.</small>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button className="btn primary" disabled={busy}>
          {busy ? "Sending…" : "Send task"}
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            reset();
            setError("");
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function move<T>(arr: T[], from: number, to: number): T[] {
  const a = [...arr];
  const [x] = a.splice(from, 1);
  a.splice(to, 0, x);
  return a;
}

const STATUS: Record<CaregiverTaskStatus, { label: string; cls: string }> = {
  sent: { label: "Sent", cls: "" },
  started: { label: "In progress", cls: "warn" },
  done: { label: "Done", cls: "ok" },
  dismissed: { label: "Dismissed", cls: "" },
};

type TaskRow = { id: Id<"tasks">; title: string; createdAt: number; status: CaregiverTaskStatus; canCancel: boolean; recipe: { startUrl?: string; steps: string[] } | null };

function TaskList({ tasks, consent, displayName }: { tasks: TaskRow[]; consent: boolean; displayName: string }) {
  const cancel = useMutation(api.tasks.cancel);
  const now = useNow(60_000);
  const [error, setError] = useState("");
  if (tasks.length === 0) return null;
  return (
    <section className="card">
      <h2>Tasks you sent</h2>
      {!consent && <p className="muted small">{displayName} hasn't chosen to share results, so tasks show as Sent.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="tasks">
        {tasks.map((t) => (
          <li key={t.id}>
            <div>
              <span className="task-title">{t.title}</span>
              <span className="muted small">
                {ago(t.createdAt, now)}
                {t.recipe && t.recipe.steps.length > 0 && ` · ${t.recipe.steps.length} ${t.recipe.steps.length === 1 ? "step" : "steps"}`}
              </span>
            </div>
            <span className="task-side">
              <span className={`pill ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span>
              {t.canCancel && (
                <button
                  className="linkbtn small"
                  onClick={async () => {
                    if (!confirm(`Take back “${t.title}”?`)) return;
                    setError("");
                    try {
                      await cancel({ taskId: t.id });
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                >
                  Take back
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Sharing({
  displayName,
  consent,
  stats,
}: {
  displayName: string;
  consent: { notifyOnComplete: boolean; notifyOnStuck: boolean };
  stats: { finished: number; stuck: number | null; medianStepMs: number | null } | null;
}) {
  return (
    <section className="card">
      <h2>What {displayName} shares with you</h2>
      <ul className="share">
        <li>
          <span className={`sw ${consent.notifyOnComplete ? "on" : ""}`} aria-hidden="true" />
          <span>Finishes a task you sent</span>
          <strong>{consent.notifyOnComplete ? "On" : "Off"}</strong>
        </li>
        <li>
          <span className={`sw ${consent.notifyOnStuck ? "on" : ""}`} aria-hidden="true" />
          <span>Gets stuck</span>
          <strong>{consent.notifyOnStuck ? "On" : "Off"}</strong>
        </li>
      </ul>
      <p className="muted small">Only {displayName} can change this, on their computer. You never see their screen, what they type, or what they ask JustAsk themselves.</p>
      {stats && (
        <dl className="stats">
          <div>
            <dt>Finished</dt>
            <dd>{stats.finished}</dd>
          </div>
          {stats.stuck !== null && (
            <div>
              <dt>“I'm stuck”</dt>
              <dd>{stats.stuck}</dd>
            </div>
          )}
          {stats.medianStepMs !== null && (
            <div>
              <dt>Typical step</dt>
              <dd>{(stats.medianStepMs / 1000).toFixed(1)}s</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

function Details({ p, connected }: { p: { id: Id<"seniors">; name: string; displayName: string; relation: string }; connected: boolean }) {
  const update = useMutation(api.people.update);
  const remove = useMutation(api.people.remove);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [displayName, setDisplayName] = useState(p.displayName);
  const [relation, setRelation] = useState(p.relation);
  const [error, setError] = useState("");

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await update({ seniorId: p.id, name, displayName, relation });
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const stop = async () => {
    const msg = connected
      ? `Stop helping ${p.name}? Their JustAsk keeps working for them. They just won't get tasks from you, and you'll lose this page.`
      : `Remove ${p.name}? Their code stops working.`;
    if (!confirm(msg)) return;
    go({ name: "home" });
    try {
      await remove({ seniorId: p.id });
    } catch (err) {
      alert(errorText(err));
    }
  };

  return (
    <section className="card details">
      <h2>Details</h2>
      {editing ? (
        <form className="form" onSubmit={save} onInput={() => setError("")} noValidate>
          <label className="field">
            <span>Their name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          <label className="field">
            <span>They are your…</span>
            <input value={relation} onChange={(e) => setRelation(e.target.value)} maxLength={40} />
          </label>
          <label className="field">
            <span>What JustAsk calls them</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} disabled={connected} />
            {connected && <small>Now that they're connected, they choose this on their computer.</small>}
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button className="btn primary small">Save</button>
            <button type="button" className="btn ghost small" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button className="btn ghost small" onClick={() => setEditing(true)}>
            Edit details
          </button>
          <button className="btn danger small" onClick={stop}>
            {connected ? "Stop helping" : "Remove"}
          </button>
        </div>
      )}
    </section>
  );
}
