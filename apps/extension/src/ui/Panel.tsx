import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { browser } from "wxt/browser";
import type { SessionView } from "@justask/core";
import { SessionHost } from "../lib/session";
import { BrowserListener } from "../lib/speech";
import { backend, type PendingTask, type Task, type TaskList } from "../lib/backend";
import { getSettings } from "../lib/config";
import { Orb, type OrbMode } from "./Orb";

const ALL_SITES = { origins: ["<all_urls>"] };

export function Panel({ pinnedTabId }: { pinnedTabId: number | null }) {
  const host = useMemo(() => new SessionHost({ pinnedTabId }), [pinnedTabId]);
  const listener = useMemo(() => new BrowserListener(), []);
  const [view, setView] = useState<SessionView>(host.controller.state);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const [answer, setAnswer] = useState("");
  const [name, setName] = useState("");
  const [tasks, setTasks] = useState<TaskList>({ open: [], done: [] });
  const [resume, setResume] = useState<{ request: string; taskId: string | null } | null>(null);
  const [access, setAccess] = useState(true);
  const [assist, setAssist] = useState<boolean | null>(null);
  const captionRef = useRef<HTMLParagraphElement>(null);

  // Host access is optional and user-revocable. Check it on open and whenever it changes.
  useEffect(() => {
    const check = () => void browser.permissions.contains(ALL_SITES).then(setAccess);
    check();
    browser.permissions.onAdded.addListener(check);
    browser.permissions.onRemoved.addListener(check);
    return () => {
      browser.permissions.onAdded.removeListener(check);
      browser.permissions.onRemoved.removeListener(check);
    };
  }, []);

  useEffect(() => {
    host.speech.onSpeaking = setSpeaking;
    const off = host.controller.subscribe(setView);
    void host.init();
    void getSettings().then((s) => {
      setName(s.displayName);
      setAssist(s.assistTyping);
    });
    const onSettings = (changes: Record<string, unknown>) => {
      if ("settings" in changes) void getSettings().then((s) => setAssist(s.assistTyping));
    };
    browser.storage.onChanged.addListener(onSettings);
    void browser.storage.local.get("resume").then((r) => {
      const res = (r as { resume?: { request: string; taskId: string | null } }).resume;
      if (res && host.controller.state.phase === "idle") setResume(res);
    });
    // Keep the last list when offline, so tasks never blink away.
    const poll = async () => {
      const list = await backend.taskList();
      if (list) setTasks(list);
      void backend.syncAssist(); // a helper may have turned "Type it for me" on or off
    };
    void poll();
    const iv = setInterval(poll, 15_000);
    return () => {
      off();
      clearInterval(iv);
      browser.storage.onChanged.removeListener(onSettings);
    };
  }, [host]);

  // Keep the newest caption in view for screen magnifiers and move focus for screen readers.
  useEffect(() => {
    captionRef.current?.focus({ preventScroll: true });
  }, [view.line]);

  const phase = view.phase;
  const running = !["idle", "done", "blocked"].includes(phase);
  const orbMode: OrbMode = listening ? "listening" : phase === "done" ? "done" : phase === "planning" || phase === "verifying" ? "thinking" : speaking ? "speaking" : "idle";

  const talk = (onText: (t: string) => void) => {
    if (listener.listening) return listener.stop();
    host.speech.stop();
    setNote("");
    setHeard("");
    listener.listen({
      onInterim: setHeard,
      onFinal: (t) => {
        setHeard("");
        onText(t);
      },
      onError: setNote,
      onEnd: () => setListening(false),
    });
    setListening(listener.listening);
  };

  const start = (text: string, opts: { recipe?: PendingTask["recipe"]; taskId?: string | null } = {}) => {
    if (!text.trim() || !access) return;
    setTyped("");
    setResume(null);
    void host.start(text, opts);
  };

  const startTask = (t: Task) => {
    setTasks((ts) => ({ ...ts, open: ts.open.map((x) => (x.id === t.id ? { ...x, status: "active" as const } : x)) }));
    start(t.spokenPrompt, { recipe: t.recipe, taskId: t.id });
  };

  const finishTask = (t: Task, status: "done" | "dismissed") => {
    setTasks((ts) => ({ open: ts.open.filter((x) => x.id !== t.id), done: status === "done" ? [{ ...t, status: "done" }, ...ts.done] : ts.done }));
    void backend.setTaskStatus(t.id, status);
  };

  const typeForMe = async () => {
    setNote("");
    if (!(await host.controller.fillForMe())) setNote("I couldn't type in that box. Please type it yourself.");
  };

  const chooseAssist = async (on: boolean) => {
    setAssist(on);
    await backend.setAssist(on);
    if (on) await typeForMe();
  };

  const onTyped = (e: FormEvent) => {
    e.preventDefault();
    if (running) void host.controller.input(typed);
    else start(typed);
    setTyped("");
  };

  return (
    <div className="panel" data-phase={phase}>
      <header className="top">
        <span className="brand">
          <span className="brand-dot" />
          JustAsk
        </span>
        <button className="link" onClick={() => browser.tabs.create({ url: browser.runtime.getURL("/setup.html") })}>
          Settings
        </button>
      </header>

      <main className="body">
        {!access && (
          <section className="card task" role="alert">
            <p className="task-title">JustAsk needs your OK to see web pages.</p>
            <p className="soft">It reads the page so it can point at the right button. It never reads what you type.</p>
            {/* This click is the user gesture permissions.request needs. Never asked mid-session. */}
            <button className="btn primary huge" onClick={() => void browser.permissions.request(ALL_SITES).then(setAccess)}>
              Turn JustAsk on
            </button>
          </section>
        )}
        {phase === "idle" && (
          <>
            <h1 className="hello">{name ? `Hi ${name}.` : "Hi there."}</h1>
            {view.line && <p className="soft">{view.line}</p>}

            <Tasks list={tasks} onStart={startTask} onFinish={finishTask} />

            {resume && (
              <section className="card">
                <p className="task-title">Want to keep going with “{resume.request}”?</p>
                <div className="row">
                  <button className="btn primary" onClick={() => start(resume.request, { taskId: resume.taskId })}>
                    Yes
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setResume(null);
                      void browser.storage.local.remove("resume");
                    }}
                  >
                    No
                  </button>
                </div>
              </section>
            )}

            <button className={`ask ${listening ? "is-listening" : ""}`} onClick={() => talk((t) => start(t))} aria-label={listening ? "Listening. Press to stop." : "Press and tell me what you want to do"}>
              <Orb mode={orbMode} size={200} />
              <span className="ask-label">{listening ? "I'm listening…" : "Press and tell me what you want to do"}</span>
            </button>
            {heard && <p className="heard">“{heard}”</p>}

            <form className="typed" onSubmit={onTyped}>
              <label htmlFor="typed" className="soft">
                Or type it here
              </label>
              <div className="row">
                <input id="typed" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Help me…" autoComplete="off" />
                <button className="btn dark" type="submit">
                  Go
                </button>
              </div>
            </form>
          </>
        )}

        {phase !== "idle" && (
          <>
            <p className="asked">
              You asked: <strong>“{view.request}”</strong>
            </p>
            <div className="stage">
              <Orb mode={orbMode} size={phase === "done" ? 132 : 96} />
              <div className="stage-text">
                {phase === "guiding" && <p className="eyebrow accent">Step {view.stepNo}</p>}
                {phase === "confirming" && <p className="eyebrow accent">Check first</p>}
                <p ref={captionRef} tabIndex={-1} className={`caption ${phase === "planning" || phase === "verifying" ? "dim" : ""}`} aria-live="assertive">
                  {view.line}
                </p>
                {view.note && <p className="soft">{view.note}</p>}
              </div>
            </div>

            {phase === "guiding" && view.fill && assist === null && (
              <section className="card assist-ask" aria-live="polite">
                <p className="task-title">Want me to type searches for you?</p>
                <p className="soft">I'll put “{view.fill}” in the search box. You still press Search yourself. You can change this in Settings.</p>
                <div className="row">
                  <button className="btn primary" onClick={() => void chooseAssist(true)}>
                    Yes, type for me
                  </button>
                  <button className="btn ghost" onClick={() => void chooseAssist(false)}>
                    No thanks
                  </button>
                </div>
              </section>
            )}

            {phase === "guiding" && <p className="hint">{view.expect === "type" ? "Type in the box with the glowing outline. I can't see what you type." : "Look for the glowing box. Take your time."}</p>}
            {phase === "done" && <p className="hint big">You made {view.clicks} {view.clicks === 1 ? "click" : "clicks"} yourself.</p>}

            {phase === "confirming" && (
              <div className="choices">
                <button className="btn primary huge" onClick={() => host.controller.confirm(true)}>
                  Yes, go ahead
                </button>
                <button className="btn outline huge" onClick={() => host.controller.confirm(false)}>
                  No
                </button>
              </div>
            )}

            {phase === "asking" && (
              <form
                className="typed"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (answer.trim()) void host.controller.answer(answer);
                  setAnswer("");
                }}
              >
                <div className="row">
                  <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Type your answer" aria-label="Your answer" autoFocus />
                  <button className="btn dark" type="submit">
                    OK
                  </button>
                </div>
              </form>
            )}

            {phase === "waiting" && (
              <button className="btn primary huge" onClick={() => host.controller.resume("She said she is ready")}>
                I'm ready
              </button>
            )}

            {phase === "paused" && view.pauseReason === "other-tab" && (
              <div className="choices">
                <button className="btn primary huge" onClick={() => host.continueHere()}>
                  Yes, here
                </button>
                <button className="btn outline huge" onClick={() => host.goBack()}>
                  Go back
                </button>
              </div>
            )}
            {phase === "paused" && view.pauseReason !== "other-tab" && (
              <button className="btn primary huge" onClick={() => host.retry()}>
                Try again
              </button>
            )}

            {heard && <p className="heard">“{heard}”</p>}
          </>
        )}
        {note && <p className="note">{note}</p>}
      </main>

      {phase !== "idle" && (
        <footer className="actions">
          {phase === "done" || phase === "blocked" ? (
            <button className="btn dark huge" onClick={() => host.controller.stop()}>
              Start again
            </button>
          ) : (
            <>
              {phase === "guiding" && view.fill && assist === true && (
                <button className="btn primary huge" onClick={() => void typeForMe()}>
                  Type “{view.fill}” for me
                </button>
              )}
              {phase === "guiding" && view.expect === "type" && (
                <button className={`btn ${view.fill ? "outline" : "primary"} huge`} onClick={() => host.controller.doneTyping()}>
                  I'm done typing
                </button>
              )}
              <button className="btn outline huge" onClick={() => host.controller.repeat()} disabled={phase === "planning" || phase === "verifying"}>
                <SpeakerIcon /> Say that again
              </button>
              <div className="row">
                <button className={`btn soft-btn grow ${listening ? "is-listening" : ""}`} onClick={() => talk((t) => void host.controller.input(t))}>
                  {listening ? "Listening…" : phase === "asking" ? "Answer out loud" : "Talk to me"}
                </button>
                <button className="btn soft-btn" onClick={() => host.controller.stuck()}>
                  I'm stuck
                </button>
              </div>
              <button className="btn ghost stop" onClick={() => host.controller.stop()}>
                Stop
              </button>
            </>
          )}
        </footer>
      )}
    </div>
  );
}

/** Her task list. Tasks stay until she finishes or removes them; closing the panel never loses one. */
function Tasks({ list, onStart, onFinish }: { list: TaskList; onStart: (t: Task) => void; onFinish: (t: Task, status: "done" | "dismissed") => void }) {
  const [first, ...rest] = list.open;
  if (!first && list.done.length === 0) return null;
  return (
    <>
      {first && (
        <section className="card task" aria-live="polite">
          <p className="eyebrow">{first.from} asked you to</p>
          <p className="task-title">{first.title}</p>
          {first.status === "active" && <p className="soft">You started this. Pick up where you left off.</p>}
          <div className="row">
            <button className="btn primary" onClick={() => onStart(first)}>
              {first.status === "active" ? "Keep going" : "Start"}
            </button>
            <button className="btn ghost" onClick={() => onFinish(first, "done")}>
              I did it
            </button>
          </div>
        </section>
      )}
      {rest.length > 0 && (
        <section className="tasklist" aria-label="More tasks">
          <p className="eyebrow">Also on your list</p>
          <ul>
            {rest.map((t) => (
              <li key={t.id}>
                <span className="tl-main">
                  <span className="tl-title">{t.title}</span>
                  <span className="soft small">
                    From {t.from}
                    {t.status === "active" ? " · started" : ""}
                  </span>
                </span>
                <button className="btn outline small" onClick={() => onStart(t)}>
                  {t.status === "active" ? "Keep going" : "Start"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(list.done.length > 0 || list.open.length > 0) && (
        <details className="tasklist done-list">
          <summary>
            {list.done.length > 0 ? `Done (${list.done.length})` : "Manage tasks"}
          </summary>
          <ul>
            {list.done.map((t) => (
              <li key={t.id}>
                <span className="tl-check" aria-hidden="true">
                  ✓
                </span>
                <span className="tl-main">
                  <span className="tl-title">{t.title}</span>
                  <span className="soft small">From {t.from}</span>
                </span>
              </li>
            ))}
            {list.open.map((t) => (
              <li key={t.id}>
                <span className="tl-main">
                  <span className="tl-title">{t.title}</span>
                  <span className="soft small">Not done yet</span>
                </span>
                <button
                  className="btn ghost small"
                  onClick={() => {
                    if (confirm(`Remove “${t.title}” from your list? ${t.from} will see that you removed it.`)) onFinish(t, "dismissed");
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function SpeakerIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
    </svg>
  );
}
