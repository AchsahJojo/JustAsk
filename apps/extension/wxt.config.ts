import { defineConfig } from "wxt";

const E2E = process.env.JUSTASK_E2E === "1";

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  manifest: ({ browser }) => ({
    name: "JustAsk",
    description: "Press one button, say what you want to do, and JustAsk helps you do it, one step at a time.",
    permissions: ["storage", "scripting", "tabs", "webNavigation", "notifications", "alarms", ...(browser === "firefox" ? [] : ["sidePanel"])],
    // Requested once on the setup page (plan: activeTab alone dies on navigation).
    optional_host_permissions: ["<all_urls>"],
    // E2E builds pre-grant host access because automation can't click the permission prompt.
    ...(E2E ? { host_permissions: ["<all_urls>"] } : {}),
    action: { default_title: "JustAsk" },
    icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
    // The Clayzo player compiles its engine with WebAssembly.
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    web_accessible_resources: [{ resources: ["sidepanel.html"], matches: ["<all_urls>"] }],
    ...(browser === "firefox" ? { browser_specific_settings: { gecko: { id: "justask@justask.app" } } } : {}),
  }),
  hooks: {
    // WXT copies runtime content-script matches into host_permissions. Host access must stay
    // optional (granted on the setup page), so strip it outside e2e builds.
    "build:manifestGenerated": (_wxt, manifest) => {
      if (E2E) return;
      delete manifest.host_permissions;
    },
  },
  vite: () => ({
    define: {
      __JUSTASK_E2E__: JSON.stringify(E2E),
      // E2E builds ignore apps/extension/.env: their own mock planner port, and no Convex unless a test sets one.
      ...(E2E ? { "import.meta.env.VITE_PLANNER_URL": JSON.stringify("http://localhost:8788"), "import.meta.env.VITE_CONVEX_URL": JSON.stringify("") } : {}),
    },
  }),
});
