import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SessionView } from "@justask/core";
import type { DesktopHost, HostState } from "../host";
import { Orb, type OrbMode } from "./Orb";

/** The Ask window: one big press-to-talk button, a typed box, and the step caption. */
export function Ask({ host, hs }: { host: DesktopHost; hs: HostState }) {
  const [view, setView] = useState<SessionView>(host.controller.state);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState("");
  const [answer, setAnswer] = useState("");
  const captionRef = useRef<HTMLParagraphElement>(null);
  const typedRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    host.speech.onSpeaking = setSpeaking;
    return host.controller.subscribe(setView);
  }, [host]);

  // Keep the newest caption in view for magnifiers and move focus there for screen readers.
  useEffect(() => {
    captionRef.current?.focus({ preventScroll: true });
  }, [view.line]);

  const phase = view.phase;
  const running = !["idle", "done", "blocked"].includes(phase);
  const busy = phase === "planning" || phase === "verifying";
  const orbMode: OrbMode = listening ? "listening" : phase === "done" ? "done" : busy ? "thinking" : speaking ? "speaking" : "idle";

  /** Press-to-talk. Any voice failure leaves her at the typed box. */
  const talk = (onText: (t: string) => void) => {
    if (host.listener.listening) return host.listener.stop();
    host.speech.stop();
    setNote("");
    setHeard("");
    setListening(true);
    void host.listener.listen({
      onInterim: setHeard,
      onFinal: (t) => {
        setHeard("");
        onText(t);
      },
      onError: (msg) => {
        setNote(msg);
        typedRef.current?.focus();
      },
      onEnd: () => setListening(false),
    });
  };

  const start = (text: string) => {
    if (!text.trim()) return;
    setTyped("");
    void host.start(text);
  };

  const onTyped = (e: FormEvent) => {
    e.preventDefault();
    if (running) void host.controller.input(typed);
    else start(typed);
    setTyped("");
  };

  const stop = () => {
    host.listener.cancel();
    void host.controller.stop();
  };

  return (
    <div className="panel" data-phase={phase}>
      <main className="body">
        {phase === "idle" && (
          <>
            <h1 className="hello">{hs.displayName ? `Hi ${hs.displayName}.` : "Hi there."}</h1>
            {view.line && <p className="soft">{view.line}</p>}

            {hs.tasks.slice(0, 1).map((t) => (
              <section key={t.id} className="card task" aria-live="polite">
                <p className="eyebrow">{t.from} asked you to</p>
                <p className="task-title">{t.title}</p>
                <div className="row">
                  <button className="btn primary grow" onClick={() => void host.startTask(t)}>
                    Start
                  </button>
                  <button className="btn ghost" onClick={() => host.laterTask(t)}>
                    Later
                  </button>
                </div>
              </section>
            ))}

            <button
              className={`ask ${listening ? "is-listening" : ""}`}
              onClick={() => talk((t) => start(t))}
              aria-label={listening ? "Listening. Press to stop." : "Press and tell me what you want to do"}
            >
              <Orb mode={orbMode} size={200} />
              <span className="ask-label">{listening ? "I'm listening… Press when you're done." : "Press and tell me what you want to do"}</span>
            </button>
            {heard && <p className="heard">“{heard}”</p>}
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
                <p ref={captionRef} tabIndex={-1} className={`caption ${busy ? "dim" : ""}`} aria-live="assertive">
                  {view.line}
                </p>
                {view.note && <p className="soft">{view.note}</p>}
              </div>
            </div>

            {phase === "guiding" && (
              <p className="hint">{view.expect === "type" ? "Type in the box with the glowing outline. I can't see what you type." : "Look for the glowing box. Take your time."}</p>
            )}
            {phase === "done" && <p className="hint big">All done.</p>}

            {phase === "confirming" && (
              <div className="choices">
                <button className="btn primary huge" onClick={() => void host.controller.confirm(true)}>
                  Yes, go ahead
                </button>
                <button className="btn outline huge" onClick={() => void host.controller.confirm(false)}>
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
              <button className="btn primary huge" onClick={() => void host.controller.resume("She said she is ready")}>
                I'm ready
              </button>
            )}

            {phase === "paused" && (
              <button className="btn primary huge" onClick={() => void host.controller.resume("She asked to try again")}>
                Try again
              </button>
            )}

            {heard && <p className="heard">“{heard}”</p>}
          </>
        )}

        {phase !== "asking" && (
          <form className="typed" onSubmit={onTyped}>
            <label htmlFor="typed" className="soft">
              {running ? "Or type to me here" : "Or type it here"}
            </label>
            <div className="row">
              <input ref={typedRef} id="typed" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={running ? "Say that again, I'm stuck…" : "Help me…"} autoComplete="off" />
              <button className="btn dark" type="submit">
                Go
              </button>
            </div>
          </form>
        )}

        {note && (
          <p className="note" role="status">
            {note}
          </p>
        )}
      </main>

      {phase !== "idle" && (
        <footer className="actions">
          {phase === "done" || phase === "blocked" ? (
            <button className="btn dark huge" onClick={stop}>
              Start again
            </button>
          ) : (
            <>
              {phase === "guiding" && view.expect === "type" && (
                <button className="btn primary huge" onClick={() => host.controller.doneTyping()}>
                  I'm done typing
                </button>
              )}
              <button className="btn outline huge" onClick={() => host.controller.repeat()} disabled={busy}>
                <SpeakerIcon /> Say that again
              </button>
              <div className="row">
                <button className={`btn soft-btn grow ${listening ? "is-listening" : ""}`} onClick={() => talk((t) => void host.controller.input(t))}>
                  {listening ? "Listening…" : phase === "asking" ? "Answer out loud" : "Talk to me"}
                </button>
                <button className="btn soft-btn" onClick={() => void host.controller.stuck()}>
                  I'm stuck
                </button>
              </div>
              <button className="btn outline huge stop" onClick={stop}>
                Stop
              </button>
            </>
          )}
        </footer>
      )}
    </div>
  );
}

function SpeakerIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5L6 9H3v6h3l5 4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
    </svg>
  );
}
