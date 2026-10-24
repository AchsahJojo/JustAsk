import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { App } from "./App";
import "./styles.css";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
const root = createRoot(document.getElementById("root")!);

if (!url) {
  root.render(
    <main className="center-page">
      <div className="card narrow">
        <h1>Almost there</h1>
        <p className="muted">
          Set <code>VITE_CONVEX_URL</code> in <code>apps/caregiver/.env.local</code> (copy <code>.env.example</code>), then restart.
        </p>
      </div>
    </main>,
  );
} else {
  const convex = new ConvexReactClient(url);
  root.render(
    <StrictMode>
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    </StrictMode>,
  );
}
