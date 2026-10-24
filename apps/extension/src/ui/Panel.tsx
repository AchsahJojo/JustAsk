import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { browser } from "wxt/browser";
import type { SessionView } from "@justask/core";
import { SessionHost } from "../lib/session";
import { BrowserListener } from "../lib/speech";
import { backend, type PendingTask } from "../lib/backend";
import { getSettings } from "../lib/config";
import { pullPrefs } from "../lib/prefsSync";
import { buildCapture, captureFileName } from "../lib/capture";
import { Orb, type OrbMode } from "./Orb";
import { usePendingTasks } from "./usePendingTasks";

const ALL_SITES = { origins: ["<all_urls>"] };
const DEV = import.meta.env.MODE === "development";

/** Steps JustAsk did for her. `actions` is added to SessionView by the core drive-mode work. */
const actionsOf = (v: SessionView) => (v as SessionView & { actions?: number }).actions ?? 0;

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
  const [tasks, setTasks] = usePendingTasks();
  const [resume, setResume] = useState<{ request: string; taskId: string | null } | null>(null);
  const [access, setAccess] = useState(true);
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
    void host.init().then(async () => {
      // A handoff claimed by the background (desktop app -> browser) starts right away.
      if (await browser.permissions.contains(ALL_SITES)) await host.startFromHandoff();
    });
    void getSettings().then((s) => setName(s.displayName));
    void backend.heartbeat();
    void pullPrefs();
    void browser.storage.local.get("resume").then((r) => {
      const res = (r as { resume?: { request: string; taskId: string | null } }).resume;
      if (res && host.controller.state.phase === "idle") setResume(res);
    });
    return off;
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

  const startTask = (t: PendingTask) => {
    setTasks((ts) => ts.filter((x) => x.id !== t.id));
    start(t.spokenPrompt, { recipe: t.recipe, taskId: t.id });
  };

  const onTyped = (e: FormEvent) => {
    e.preventDefault();
    if (running) void host.controller.input(typed);
    else start(typed);
    setTyped("");
  };

  /** Dev only: download the current plan request for the eval harness. Never sent anywhere. */
  const saveSnapshot = () => {
    const capture = buildCapture({ request: view.request, recipe: host.currentRecipe, snapshot: host.controller.currentSnapshot, history: host.controller.currentHistory });
    if (!capture) return setNote("No snapshot yet. Ask for something first.");
    const url = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = captureFileName(capture);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const actions = actionsOf(view);

  return (
    <div className="panel" data-phase={phase}>
      <header className="top">
        <span className="brand">
          <span className="brand-dot" />
          JustAsk
        </span>
        <span className="row">
          {DEV && (
            <button className="link dev-snap" onClick={saveSnapshot} title="Development builds only">
              Save snapshot
            </button>
          )}
          <button className="link" onClick={() => browser.tabs.create({ url: browser.runtime.getURL("/setup.html") })}>
            Settings
          </button>
        </span>
      </header>

      <main className="body">
        {!access && (
          <section className="card task" role="alert">
            <p className="task-title">JustAsk needs your OK to see web pages.</p>
            <p className="soft">It reads the page so it can find the right button. It never reads what you type.</p>
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

            {tasks.slice(0, 1).map((t) => (
              <section key={t.id} className="card task" aria-live="polite">
                <p className="eyebrow">{t.from} asked you to</p>
                <p className="task-title">{t.title}</p>
                <div className="row">
                  <button className="btn primary" onClick={() => startTask(t)}>
                    Start
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setTasks((ts) => ts.filter((x) => x.id !== t.id));
                      void backend.setTaskStatus(t.id, "pending");
                    }}
                  >
                    Later
                  </button>
                </div>
              </section>
            ))}

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
                {(phase === "guiding" || phase === "acting") && <p className="eyebrow accent">Step {view.stepNo}</p>}
                {phase === "confirming" && <p className="eyebrow accent">Check first</p>}
                <p ref={captionRef} tabIndex={-1} className={`caption ${phase === "planning" || phase === "verifying" ? "dim" : ""}`} aria-live="assertive">
                  {view.line}
                </p>
                {view.note && <p className="soft">{view.note}</p>}
              </div>
            </div>

            {phase === "guiding" && <p className="hint">{view.expect === "type" ? "Type in the box with the glowing outline. I can't see what you type." : "Look for the glowing box. Take your time."}</p>}
            {phase === "acting" && <p className="hint">I'm doing this step for you. Watch the glowing box. Press Stop at any time.</p>}
            {phase === "done" &&
              (actions > 0 ? (
                <p className="hint big">
                  I did {actions} {actions === 1 ? "step" : "steps"} for you.
                </p>
              ) : (
                <p className="hint big">
                  You made {view.clicks} {view.clicks === 1 ? "click" : "clicks"} yourself.
                </p>
              ))}

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
              {phase === "acting" && (
                <button className="btn danger huge stop-now" onClick={() => host.controller.stop()} aria-label="Stop. JustAsk will not do anything else.">
                  <StopIcon /> Stop
                </button>
              )}
              {phase === "guiding" && view.expect === "type" && (
                <button className="btn primary huge" onClick={() => host.controller.doneTyping()}>
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
              {phase !== "acting" && (
                <button className="btn ghost stop" onClick={() => host.controller.stop()}>
                  Stop
                </button>
              )}
            </>
          )}
        </footer>
      )}
    </div>
  );
}

function StopIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
    </svg>
  );
}
