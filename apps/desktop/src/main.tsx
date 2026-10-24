import { createRoot } from "react-dom/client";

// Placeholder Ask window. The desktop-shell agent builds the real UI (docs/refined-plan-2.md, agent 5).
function App() {
  return <main style={{ fontFamily: "system-ui", padding: 24 }}><h1>JustAsk</h1><p>Desktop app scaffold.</p></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
