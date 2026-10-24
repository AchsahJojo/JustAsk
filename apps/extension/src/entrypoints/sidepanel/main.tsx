import { createRoot } from "react-dom/client";
import { Panel } from "../../ui/Panel";
import "../../ui/styles.css";

// ?tabId=N pins the session to a tab: used by dock mode and by e2e tests that open the panel as a page.
const pinned = new URLSearchParams(location.search).get("tabId");
createRoot(document.getElementById("root")!).render(<Panel pinnedTabId={pinned ? Number(pinned) : null} />);
