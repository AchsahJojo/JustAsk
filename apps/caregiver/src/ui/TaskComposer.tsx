import { useMemo, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { CartesiaListener, CartesiaTokens } from "@justask/voice";
import { isSafeStartUrl, TASK_CHECK_LIMITS, TASK_LIMITS, type TaskCheckTurn, type TaskDraft } from "@justask/shared";
import { api, errorText, type Id } from "../api";

const IDEAS = [
  "Refill her blood pressure pills on CVS.com",
  "Join Sunday's family Zoom call from the link in her email",
  "Reply to Aunt Ruth's email about Thanksgiving",
];

type Phase = "describe" | "asking" | "review";

/**
 * Send a task, held until it's clear. The caregiver describes it (typing or speaking); JustAsk asks
 * one question at a time until it knows what, which one and where; then the caregiver reviews the
 * finished task and sends it. Only a draft the check called clear can be sent (tasks:assign).
 */
export function TaskComposer({ seniorId, displayName, onSent, onCancel }: { seniorId: Id<"seniors">; displayName: string; onSent: (title: string) => void; onCancel: () => void }) {
  const review = useAction(api.taskCheck.review);
  const assign = useMutation(api.tasks.assign);
  const [phase, setPhase] = useState<Phase>("describe");
  const [request, setRequest] = useState("");
  const [turns, setTurns] = useState<TaskCheckTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [checkId, setCheckId] = useState<Id<"taskChecks"> | null>(null);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const startOver = () => {
    setPhase("describe");
    setTurns([]);
    setQuestion("");
    setAnswer("");
    setDraft(null);
    setCheckId(null);
    setEdited(false);
    setError("");
  };

  /** One round of the check. Shows the next question, or the finished task. */
  const check = async (nextTurns: TaskCheckTurn[], editedDraft?: TaskDraft) => {
    setBusy(true);
    setError("");
    try {
      const r = await review({ seniorId, request: request.trim(), answers: nextTurns, ...(editedDraft ? { editedDraft } : {}) });
      setTurns(nextTurns);
      if (r.status === "error") return setError(r.message);
      if (r.status === "question") {
        setQuestion(r.question);
        setAnswer("");
        setCheckId(null);
        setPhase("asking");
        return;
      }
      setDraft(r.draft);
      setCheckId(r.checkId);
      setEdited(false);
      setPhase("review");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!checkId || !draft) return;
    setBusy(true);
    setError("");
    try {
      await assign({ seniorId, checkId });
      onSent(draft.title);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const editDraft = (patch: Partial<TaskDraft>) => {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
    setEdited(true);
  };
  const cleanDraft = (d: TaskDraft): TaskDraft => ({ ...d, title: d.title.trim(), spokenPrompt: d.spokenPrompt.trim(), startUrl: d.startUrl?.trim() || null, steps: d.steps.map((s) => s.trim()).filter(Boolean) });
  const urlError = draft?.startUrl?.trim() && !(draft.startUrl.trim().startsWith("https://") && isSafeStartUrl(draft.startUrl.trim())) ? "Use a full web address that starts with https://" : "";

  return (
    <section className="card form composer" aria-live="polite">
      <h2>Send {displayName} a task</h2>

      {phase === "describe" && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!request.trim()) return setError(`Tell JustAsk what ${displayName} should do.`);
            void check([]);
          }}
          noValidate
        >
          <div className="chips" aria-label="Ideas">
            {IDEAS.map((t) => (
              <button type="button" className="chip" key={t} onClick={() => setRequest(t)}>
                {t}
              </button>
            ))}
          </div>
          <label className="field">
            <span>What should {displayName} do?</span>
            <SpeakableText value={request} onChange={setRequest} max={TASK_CHECK_LIMITS.request} rows={3} placeholder="Buy the new Kristin Hannah book on Amazon, the paperback" />
            <small>Say what, which one, and where. If anything is missing, JustAsk will ask you before it sends.</small>
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button className="btn primary" disabled={busy}>
              {busy ? "Checking…" : "Next"}
            </button>
            <button type="button" className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {phase === "asking" && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!answer.trim()) return setError("Type or say your answer.");
            void check([...turns, { question, answer: answer.trim() }]);
          }}
          noValidate
        >
          <ol className="chat" aria-label="Your task so far">
            <li className="you">{request.trim()}</li>
            {turns.map((t, i) => (
              <li key={i} className="pair">
                <span className="ja">{t.question}</span>
                <span className="you">{t.answer}</span>
              </li>
            ))}
            <li className="ja now">
              <strong>JustAsk asks:</strong> {question}
            </li>
          </ol>
          <label className="field">
            <span>Your answer</span>
            <SpeakableText value={answer} onChange={setAnswer} max={TASK_CHECK_LIMITS.answer} rows={2} autoFocus />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button className="btn primary" disabled={busy}>
              {busy ? "Checking…" : "Answer"}
            </button>
            <button type="button" className="btn ghost" onClick={startOver}>
              Start over
            </button>
          </div>
        </form>
      )}

      {phase === "review" && draft && (
        <div className="composer">
          <p className="ok-text">This task is clear. Check it, then send it to {displayName}.</p>
          <label className="field">
            <span>Task</span>
            <input value={draft.title} onChange={(e) => editDraft({ title: e.target.value })} maxLength={TASK_LIMITS.title} />
            <small>{displayName} sees this on a card with a Start button.</small>
          </label>
          <label className="field">
            <span>What JustAsk will help with</span>
            <input value={draft.spokenPrompt} onChange={(e) => editDraft({ spokenPrompt: e.target.value })} maxLength={TASK_LIMITS.spokenPrompt} />
          </label>
          <div className="recipe">
            <label className="field">
              <span>
                Start page <em className="opt">optional</em>
              </span>
              <input type="url" value={draft.startUrl ?? ""} onChange={(e) => editDraft({ startUrl: e.target.value })} placeholder="https://www.example.com" maxLength={TASK_LIMITS.startUrl} aria-invalid={!!urlError} />
              {urlError ? <small className="error-text">{urlError}</small> : <small>JustAsk offers to open this page for {displayName}. Check the address is right.</small>}
            </label>
            <div className="field">
              <span>Steps</span>
              <ol className="steps-edit">
                {draft.steps.map((s, i) => (
                  <li key={i}>
                    <span className="n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <input value={s} onChange={(e) => editDraft({ steps: draft.steps.map((x, j) => (j === i ? e.target.value : x)) })} maxLength={TASK_LIMITS.step} aria-label={`Step ${i + 1}`} />
                    <button type="button" className="icon-btn" aria-label={`Remove step ${i + 1}`} onClick={() => editDraft({ steps: draft.steps.filter((_, j) => j !== i) })}>
                      ×
                    </button>
                  </li>
                ))}
              </ol>
              {draft.steps.length < TASK_LIMITS.steps && (
                <button type="button" className="linkbtn small" onClick={() => editDraft({ steps: [...draft.steps, ""] })}>
                  + Add a step
                </button>
              )}
            </div>
          </div>
          {edited && <p className="note">You changed the task. JustAsk checks it again before it can be sent.</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            {edited ? (
              <button className="btn primary" disabled={busy || !!urlError} onClick={() => void check(turns, cleanDraft(draft))}>
                {busy ? "Checking…" : "Check again"}
              </button>
            ) : (
              <button className="btn primary" disabled={busy || !checkId} onClick={() => void send()}>
                {busy ? "Sending…" : "Send task"}
              </button>
            )}
            <button type="button" className="btn ghost" onClick={startOver}>
              Start over
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** A text box with a mic button: speak instead of typing (Cartesia, listening only). */
function SpeakableText({ value, onChange, max, rows, placeholder, autoFocus }: { value: string; onChange: (v: string) => void; max: number; rows: number; placeholder?: string; autoFocus?: boolean }) {
  const tokenAction = useAction(api.voice.caregiverToken);
  const tokenRef = useRef(tokenAction);
  tokenRef.current = tokenAction;
  const listener = useMemo(() => (CartesiaListener.supported() ? new CartesiaListener(new CartesiaTokens(() => tokenRef.current({}))) : null), []);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState("");
  const valueRef = useRef(value);
  valueRef.current = value;

  const toggle = () => {
    if (!listener) return;
    if (listener.listening) return listener.stop();
    setNote("");
    setHeard("");
    setListening(true);
    void listener.listen({
      onInterim: setHeard,
      onFinal: (t) => {
        const cur = valueRef.current.trim();
        onChange(`${cur ? `${cur} ` : ""}${t.trim()}`.slice(0, max));
      },
      onError: setNote,
      onEnd: () => {
        setListening(false);
        setHeard("");
      },
    });
  };

  return (
    <span className="speakable">
      <textarea value={value} onChange={(e) => onChange(e.target.value)} maxLength={max} rows={rows} placeholder={placeholder} autoFocus={autoFocus} />
      {listener && (
        <button type="button" className={`btn small ${listening ? "primary" : "ghost"} mic`} onClick={toggle} aria-pressed={listening}>
          {listening ? "Done talking" : "🎤 Speak instead"}
        </button>
      )}
      {listening && <small aria-live="polite">{heard ? `“${heard}”` : "Listening…"}</small>}
      {note && <small className="error-text">{note}</small>}
    </span>
  );
}
