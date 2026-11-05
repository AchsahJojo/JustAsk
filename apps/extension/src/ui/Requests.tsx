import { useEffect, useState } from "react";
import { backend, type Helper, type PendingDevice } from "../lib/backend";

const POLL_MS = 10_000;

/**
 * "Let Sam help you?" and "A new computer wants to join your JustAsk" (devices:me). Nothing gets access until the
 * user says yes here, so someone who talked them into reading a code out can't get in without them seeing it.
 */
export function Requests() {
  const [helpers, setHelpers] = useState<Helper[]>([]);
  const [devices, setDevices] = useState<PendingDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    const me = await backend.me();
    setHelpers(me?.pendingHelpers ?? []);
    setDevices(me?.pendingDevices ?? []);
  };

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(iv);
  }, []);

  const answer = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch {
      setError("That didn't go through. Check the internet and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!helpers.length && !devices.length) return null;
  return (
    <section className="requests" aria-live="polite">
      {helpers.map((h) => (
        <div className="card task request" key={`h-${h.id}`}>
          <p className="task-title">Let {h.name} help you with JustAsk?</p>
          <p className="soft">
            {h.name} typed your helper code. They could send you tasks. Only say yes if you know {h.name} and asked them to help. JustAsk staff never ask
            for this.
          </p>
          <div className="row">
            <button className="btn primary grow" disabled={busy} onClick={() => void answer(() => backend.answerHelper(h.id, true))}>
              Yes, I know them
            </button>
            <button className="btn outline grow" disabled={busy} onClick={() => void answer(() => backend.answerHelper(h.id, false))}>
              No
            </button>
          </div>
        </div>
      ))}
      {devices.map((d) => (
        <div className="card task request" key={`d-${d.deviceId}`}>
          <p className="task-title">A new computer wants to join your JustAsk</p>
          <p className="soft">
            “{d.label}” used a code from your helper. Only allow it if it's your own computer, or you asked for this. It could see your tasks and settings.
          </p>
          <div className="row">
            <button className="btn primary grow" disabled={busy} onClick={() => void answer(() => backend.answerDevice(d.deviceId, true))}>
              Allow
            </button>
            <button className="btn outline grow" disabled={busy} onClick={() => void answer(() => backend.answerDevice(d.deviceId, false))}>
              No, remove it
            </button>
          </div>
        </div>
      ))}
      {error && (
        <p className="note" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
