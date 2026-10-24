import { useEffect, useMemo, useState } from "react";
import { DesktopHost, type HostState } from "../host";
import { Ask } from "./Ask";
import { Settings } from "./Settings";
import { Welcome } from "./Welcome";

/** Top level: first-run Welcome until this install is linked, then the Ask window and Settings. */
export function App() {
  const host = useMemo(() => new DesktopHost(), []);
  const [hs, setHs] = useState<HostState>(host.state);
  const [tab, setTab] = useState<"ask" | "settings">("ask");

  useEffect(() => {
    const off = host.subscribe(setHs);
    void host.init();
    return () => {
      off();
      host.dispose();
    };
  }, [host]);

  if (!hs.ready) return null;
  if (!hs.token) return <Welcome host={host} />;

  return (
    <>
      <header className="top">
        <span className="brand">
          <span className="brand-dot" />
          JustAsk
        </span>
        <nav className="tabs" aria-label="JustAsk">
          <button className="tab" aria-current={tab === "ask" ? "page" : undefined} onClick={() => setTab("ask")}>
            Ask
          </button>
          <button className="tab" aria-current={tab === "settings" ? "page" : undefined} onClick={() => setTab("settings")}>
            Settings
          </button>
        </nav>
      </header>
      {tab === "ask" ? <Ask host={host} hs={hs} /> : <Settings host={host} hs={hs} />}
    </>
  );
}
