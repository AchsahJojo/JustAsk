# JustAsk — Refined Plan 1

## Context

This document builds on `docs/initial-plan.md` and does not repeat it. It changes that plan in four ways:

1. **Every major browser, then Mac and Windows apps.** This is a phased roadmap. The hackathon (Oct 23–25 2026) still ships Chrome. The code is split so that each later browser, and the desktop app, is an adapter rather than a rewrite.
2. **Six logic gaps found in review are closed:** typing steps, native pickers, Shadow DOM and iframes, rerenders, new tabs, and user gestures. Review also turned up more gaps (§3.7).
3. **The `planStep` Claude call is corrected** against the current API docs. The fallback feature is beta-only and breaks the loop without its header (§4).
4. **The desktop app has a direction:** first a companion tray app, then guidance for native apps (§5).

Rules from the initial plan that still hold: guide mode only (the user always clicks), no site-specific code, no keys in clients, never capture or send field values, and page text is untrusted.

## Changes to the initial plan

1. **"WXT yes, other browser adapters no" becomes "adapters yes, shipped in phases."** The hackathon build is Chrome only, but all browser API calls go through `apps/extension/src/platform/*` from day one.
2. **The session no longer lives only in the side panel.** Safari, Opera and popup windows have no side panel. The session controller becomes a pure state machine in `packages/core`. It runs in the side panel when one exists and in the background otherwise. Every state change is saved to `storage.session`.
3. **One panel UI, three places to show it.** The same `panel.html` React app renders in the Chrome or Edge side panel, the Firefox sidebar, or a "dock": an extension-page iframe that the content script injects into the page inside a Shadow DOM host.
4. **The step contract grows.** `expect` (click, type, choose, hover or file), `option` and `risk` are new fields, and `wait` is a new kind (§4.1).
5. **The scanner never uses `.value` as a label.** Mana's `readPage` falls back to `el.value`, which leaks typed text. Only button-type inputs (`submit`, `button`, `reset`) may use `value`, because there it is page text.
6. **Elements are matched by fingerprint, not just WeakRef.** This survives React rerenders without a second Claude call (§3.4).

## 1. Portable architecture

### Repo layout (changes from the initial plan)

```
apps/extension/          WXT. entrypoints: background, content, panel (html), setup (tab)
  src/platform/          chromium.ts, firefox.ts, safari.ts: PanelHost, gestures, shadow-root access
apps/caregiver/          unchanged
apps/fixtures/           mock pharmacy + gap fixtures (§8)
apps/desktop/            Phase 4: Tauri 2 companion app (Windows + macOS)
packages/shared/         Zod schemas: PageSnapshot, StepResponse, messages, events
packages/core/           NEW. Session state machine, step loop, interfaces. No browser APIs
packages/page-agent/     NEW. Scanner, ranker, fingerprint, overlay, observers. DOM-only
packages/backend/        Convex
reference/mana/          read-only reference
```

**Port from Mana into `packages/page-agent`:** `colorName`, the clickable selector list (extended in §3.3), and the `describe()` line format. **Into `packages/core`:** the `buildPrompt` structure (it moves server-side into Convex), the `handleCommand` voice-command regexes, the wrong-click reassurance line ("That's all right. The one we want has the glowing box around it."), and the praise lines. **Drop:** `SCRIPT` fallbacks, `parseReply` (replaced by structured output), and the `claude-haiku-4-5` / `max_tokens: 200` call.

### Interfaces in `packages/core`

| Interface | What it does | Chrome / Edge | Firefox | Safari | Desktop (Phase 5) |
|---|---|---|---|---|---|
| `PanelHost` | show, focus and close the panel | `sidePanel` | `sidebarAction` | dock iframe | app window |
| `PageBridge` | scan, highlight, observe, resolve | content script | content script | content script | UIA / AX |
| `SpeechOut` | speak, stop | speechSynthesis → Cartesia | same | same | same |
| `SpeechIn` | listen | Web Speech (Chrome, Edge) or Cartesia STT | Cartesia STT | Cartesia STT | Cartesia STT |
| `Store` | session and local state | `storage.session` / `local` | same | same | app storage |
| `Notifier` | badge, toast | `action` + `notifications` | same | badge only | OS notifications |
| `TabWatcher` | new tabs, navigation | `tabs` + `webNavigation` | same | same (verify) | n/a |

**Where the controller runs.** In panel mode it runs in the panel page, which lives through navigations. In dock mode it runs in the background (a Chrome service worker or Firefox event page). The open port from the dock keeps the background alive, and state is saved at every transition, so a restart resumes at the current step. The loop is event-driven (one short request per step), so neither home has to stay up for long.

## 2. Browser support

### Matrix

Items marked *verify* must be tested on day one of that phase. Don't trust this table over a quick test.

| Browser | Panel | Background | Voice in | Closed shadow roots | Store | Phase |
|---|---|---|---|---|---|---|
| Chrome | `chrome.sidePanel` (114+) | service worker | Web Speech in panel | `chrome.dom.openOrClosedShadowRoot` | Chrome Web Store | 0 |
| Edge | `chrome.sidePanel` (*verify* version) | service worker | Web Speech (*verify* in panel) | same | Edge Add-ons (same zip) | 0 (load-test), 1 (publish) |
| Brave | `chrome.sidePanel` (*verify*) | service worker | **No Web Speech.** Use Cartesia STT | same | Chrome Web Store | 1 |
| Opera | no `chrome.sidePanel` (*verify*). Use dock | service worker | Cartesia STT | same | Opera add-ons | 1 |
| Vivaldi, Arc, others | *verify*. Dock fallback | service worker | Cartesia STT | same | Chrome Web Store | 1 (best effort) |
| Firefox | `sidebar_action` | event page (`background.scripts`) | **No Web Speech recognition.** Use Cartesia STT | `element.openOrClosedShadowRoot` | AMO | 2 |
| Safari (macOS) | **none.** Use dock | non-persistent background (*verify*) | Cartesia STT | **not available.** Open roots only | Mac App Store via Xcode wrapper | 3 |

Text-to-speech (`speechSynthesis`) works everywhere. Cartesia Sonic is the same everywhere because it is a WebSocket plus WebAudio.

### Per-browser notes

- **WXT builds every target:** `wxt build -b chrome|edge|firefox|safari|opera`. Per-browser manifest differences go in `wxt.config.ts` keyed by `browser`: `side_panel` vs `sidebar_action`, `browser_specific_settings.gecko.id`, and background type. Use WXT's `browser` global, not `chrome.*` directly, outside `src/platform/`.
- **Feature detection beats browser sniffing.** For example: `if (browser.sidePanel) … else if (browser.sidebarAction) … else dock`. Opera and Arc then fall into the right path automatically.
- **Firefox:** MV3 background is an event page, so no `chrome.offscreen`. Host permissions are user-revocable. Request them in setup and re-check before every session. AMO needs the readable source uploaded with each version, because WXT output is bundled. Check AMO's current rules on data-collection consent, since JustAsk sends page text to a server and must say so in the manifest and listing.
- **Safari:** package with Xcode's Safari web extension packager. The containing macOS app is required, and it later becomes the macOS companion app (§5). This needs a paid Apple Developer account. Safari asks per site for host access, so the setup copy must walk the user (or the caregiver) through "Always allow on every website." There are no closed shadow roots, so some web components will be invisible and get a `blocked` reply.
- **Dock mode:** the content script inserts a fixed host on the right edge with Shadow DOM. Inside is an `<iframe src=chrome-extension://…/panel.html>` listed in `web_accessible_resources`, so the panel runs as an extension page with extension permissions. The dock is rebuilt after every navigation and rehydrates from `storage.session`. Mic in the iframe: *verify*. The page's Permissions-Policy may block it. Typed input and the big buttons always work.

## 3. Gaps closed

### 3.1 Typing steps

- `expect: "type"` targets a text field, textarea, `contenteditable` or `role=textbox`.
- The content script tracks **only a local boolean**, `hasValue` (`el.value !== ""`, or non-empty `textContent` for contenteditable). It never stores, logs or sends the value, its length or its characters.
- **The step advances** when `hasValue` is true and any of these happens: `change`, `blur`, or Enter. The panel also shows a big **I'm done typing** button. Enter may submit the form. That counts as success, and the normal page-change check runs next.
- **Typing in the wrong box** (input events on a different field): "You're typing in a different box. The one we want has the glowing outline." Nothing about the text is read.
- **Autofill** fires `input` and `change`, so it advances the same way. `hasValue` is also re-checked at verify time.
- **Snapshot fields:** each field gets `hasValue: boolean` and `valid: boolean` (from `validity.valid`). **Never send `validationMessage`.** Chrome's message can quote the typed value ("'bob' is missing an '@'").
- **Passwords and one-time codes:** same flow. The caption says "Type your password here. I can't see it."

### 3.2 Native `<select>`, date pickers, file pickers, custom dropdowns

- **Native `<select>`** (the popup is drawn by the browser and can't be highlighted). The snapshot sends option labels, up to 30. If there are more, it sends the first 10 plus a count, and Claude can say "type 'Ari' to jump to Arizona." Claude returns `expect: "choose"` and `option: "<exact option text>"`. The content script compares the selected option to `option` on `change` and reports only `matched: true|false`. The selected value never leaves the page. On a mismatch: "That picked a different one. We want Arizona. Click the box again."
- **Date, time and month inputs:** the native picker is outside the DOM. Use `expect: "type"` with a format hint taken from the field's locale ("month, then day, then year"). Advance on `change` with `valid`.
- **File inputs:** `expect: "file"`. "A window will open. Find your photo and click Open." Advance on `change` with `files.length > 0`. File names are never read.
- **Custom dropdowns** (`role=combobox|listbox|option|menu|menuitem`) are normal DOM, so this is two click steps. The options often render in a portal at the end of `<body>`. Elements added since the last scan get a ranking boost (§3.3), so the options make the cut.

### 3.3 Shadow DOM, iframes, and ranking before the cap

**Shadow DOM.** The scanner walks the composed tree. For each element, it recurses into `el.shadowRoot` (open roots). It also recurses into closed roots through the platform adapter: `chrome.dom.openOrClosedShadowRoot(el)` on Chromium and `el.openOrClosedShadowRoot` on Firefox. Safari has none. Accessible names resolve `aria-labelledby` inside the same root. Overlay positions use `getBoundingClientRect`, which is already in viewport coordinates, so shadow depth doesn't matter.

**Selector list** (extends Mana's `SEL`): `a[href], button, input, select, textarea, summary, [contenteditable=true], [tabindex]:not([tabindex="-1"])`, plus roles `button, link, tab, menuitem, checkbox, radio, switch, option, combobox, textbox, listbox, treeitem`.

**Iframes.**
- Inject with `scripting.executeScript({target: {tabId, allFrames: true}, … })`, with `matchOriginAsFallback` / `match_about_blank` so `about:blank` and `srcdoc` frames are covered. `<all_urls>` host permission covers cross-origin frames.
- Each frame scans its own document and reports with its `frameId` (from `sender.frameId`). The controller merges the reports into **one** numbered list and keeps a map from each number to `(frameId, localId)`. Claude still sees plain numbers.
- Each frame draws its own overlay and observes its own clicks, so there is no cross-frame coordinate math.
- Skip frames smaller than 50×50 px or hidden. The parent frame reports which of its iframes are visible.
- **Payment iframes** (Stripe and similar) work like any other frame. Values are never read anywhere, so no special case is needed.

**Ranking before cutting to 150.** Score each element, keep the top 150, and send `omitted: {count, regions}` so Claude knows more exist.

| Signal | Score |
|---|---|
| Inside an open modal (`dialog[open]`, `[aria-modal=true]`) | +5. If modal, elements outside it are **dropped** |
| Appeared since the last scan (MutationObserver `addedNodes`) | +4 |
| In the viewport now | +3 |
| In `main` / `[role=main]` | +2 |
| Shares words with the request, the current recipe step or the last spoken line | +2 |
| Big, or has a solid background color (looks like a primary button) | +1 |
| In `nav`, `footer` or `aside` | −1 (kept, since "Sign in" often lives there) |
| Disabled | −1 (kept and marked disabled) |
| Duplicate (same role, text and href) | collapsed into one |

Form fields in the form that holds focus are always kept.

### 3.4 Rerenders

- **Fingerprint** each element as a hash of `role + normalized text + accessible name + nearest heading text + landmark + ordinal among identical siblings`. Keep it next to the WeakRef.
- **Resolve order** (before highlighting, while it shows, and on click):
  1. The WeakRef is alive and `isConnected`. Use it.
  2. Otherwise rescan the frame. If exactly one element has the same fingerprint, rebind silently, with no new Claude call.
  3. Otherwise, if exactly one element has the same role and text, rebind.
  4. Otherwise re-plan with the history note "the page changed before the click."
- **Overlay:** a MutationObserver on the target's subtree, plus a 250 ms check, triggers resolve when the target disconnects.
- **Click check:** listen on `window` in the capture phase for both `pointerdown` and `click`, so we hear the click before page handlers can call `stopPropagation`. Success if `composedPath()` contains the current target **or** a node with the target's fingerprint. React may swap the node between pointerdown and click. Some sites act on `pointerdown` and cancel the click, so either event counts. The page-change check still confirms progress.

### 3.5 New tabs and windows

- **Follow automatically** when a tab is created with `openerTabId === sessionTabId` (or via `webNavigation.onCreatedNavigationTarget`) within 5 s after a click in the session tab. Move the session there, inject the content script, and say "That opened a new tab. I'll keep helping you there."
- **The user switches tabs on their own:** pause. The panel asks "Keep helping on this tab?" with **Yes, here** and **Go back** buttons. "Go back" calls `tabs.update(sessionTabId, {active: true})`.
- **Session tab closed:** pause. If a followed child tab exists, offer to continue there.
- **Popup windows** (`window.open` with window features, such as sign-in popups): side panels don't show in popup windows, so use dock mode in that window. When the popup closes, return focus to the opener tab and rescan.
- **Pages we can't inject into** (`chrome://`, store pages, the built-in PDF viewer, `file://`): say "I can't see this kind of page. Let's go back to the last page." and wait until the user does.
- A recipe `startUrl` opens in the session tab, not a new one.

### 3.6 User gestures

**Gesture-gated actions:**

| Action | Needs a gesture | Where we do it |
|---|---|---|
| `sidePanel.open()` (Chrome) | yes | toolbar click, notification click, in-page banner button. All *verify* |
| `sidebarAction.open()` (Firefox) | yes | toolbar click |
| `permissions.request()` (host access) | yes | **setup tab only**, on the "Turn on JustAsk" button during pairing |
| Mic permission | prompt must come from an extension page | setup tab (as in the initial plan) |
| Audio playback (`AudioContext.resume`, first `speechSynthesis`) | usually | the first press of the big button unlocks audio for the session |

**Fallback ladder for "Sam sent you a task":**
1. Call `sidePanel.setPanelBehavior({openPanelOnActionClick: true})` at install, so the toolbar icon always opens the panel without our code.
2. On a toast click, try `sidePanel.open({windowId})`. If it throws, focus the window and leave the badge on. The toast text already says "Click the JustAsk button at the top right."
3. The content script shows an in-page banner with **Start**. Its click goes through `runtime.sendMessage` to the background, which calls `sidePanel.open`. If the gesture didn't carry over, start the session in **dock mode** on that page.

Never ask for permissions in the middle of a session. If host access was revoked, the panel shows one big **Turn JustAsk back on** button, and that button is the gesture.

### 3.7 More gaps found in review

- **Top-layer elements** (`<dialog>.showModal()`, popovers) render above any z-index. Put the overlay host in the top layer too (`popover="manual"` + `showPopover()`). Call it again whenever the page opens a new top-layer element, because the newest one wins.
- **Strict CSP sites** (Gmail, GitHub): apply overlay styles with `adoptedStyleSheets` or `scripting.insertCSS`, not `<style>` tags. *Verify* on both sites.
- **Hover menus:** `expect: "hover"` ("Move your mouse over Account"). Advance on `pointerenter`, then rescan after 300 ms.
- **Waiting steps:** `kind: "wait"` covers "Check your phone for a code" and "the page is loading." There is no timeout, the mic stays available, and it resumes on a page change or the user's voice.
- **Money and personal-info steps:** Claude flags `risk: money|personal_info|account_change`. The panel then asks "This step will spend money. Do you want to go ahead?" with big **Yes** / **No** buttons before highlighting.
- **Scam signals** (gift cards, remote-access downloads, "call this number now," urgency): `risk: "suspicious"`. JustAsk says "This page might be a trick. Let's stop and check with Sam." The session ends `blocked`, and a stuck note goes to the caregiver if `consent.notifyOnStuck` is on.
- **Cookie banners:** this is a choice, so `clarify`. Either answer is fine.
- **Canvas-heavy apps** (Google Docs editor, maps): the scanner finds little, so reply `blocked` with a plain line. A later, opt-in fallback sends a screenshot (`tabs.captureVisibleTab`) with the rectangles of sensitive fields blacked out before it leaves the device. This is not in the hackathon.
- **Resume after a browser restart:** `storage.session` is cleared on restart. Keep `{request, taskId, stepCount}` in `storage.local` (no page data) and offer "Want to keep going with refilling your prescription?"
- **Slow or failed steps:** a 10 s timeout per step. "Still looking…" shows at 3 s. Retry once, then "I'm having trouble. Let's try again in a moment."
- **Runaway cost:** a per-device rate limit in Convex (for example 60 steps per hour), plus a step cap per session.
- **Reduced motion:** when `prefers-reduced-motion` is set, the pulse becomes a thick steady outline.
- **No page data in Convex storage:** snapshots go to Claude and are never written to tables or logs. Only `events` are stored.

## 4. `planStep` contract and Claude API (corrected)

### 4.1 StepResponse (Zod in `packages/shared`; JSON Schema derived from it)

```json
{
  "kind": "guide | clarify | wait | done | blocked",
  "say": "Click the white box under Email, then type your email.",
  "target": 7,
  "expect": "click | type | choose | hover | file | null",
  "option": "Arizona or null",
  "risk": "none | money | personal_info | account_change | suspicious"
}
```

- Every field is required. Nullable fields use `anyOf: [{…}, {"type": "null"}]`. Every object has `additionalProperties: false`.
- The schema can't use `minimum`, `maximum`, `minLength` or `maxLength`, so our validator checks the rest after parsing:
  - `guide` needs `target` and `expect`.
  - `target` must be a number in the current snapshot.
  - `choose` needs an `option` that exactly matches one of that element's options.
  - `say` must be 20 words or fewer.
- The server adds `snapshotId`. A failed check gets one re-plan, then `blocked`.

### 4.2 Request shape (Convex action, `"use node"`)

```ts
const res = await client.beta.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 4096,                       // covers thinking + reply
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  output_config: {
    effort: "low",
    format: { type: "json_schema", schema: STEP_JSON_SCHEMA },
  },
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: buildTurn(request, history, recipe, snapshot) }],
});
```

**Rules for whoever builds this (C):**
- **`fallbacks: "default"` is beta.** It only works through `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]`. Without the header the API returns a 400 and the loop breaks.
- **Don't send `thinking`.** Opus 5.5 always thinks, and `thinking: {type: "disabled"}` returns a 400. Effort is the only control. Opus 5.5's default effort is `medium`, so set `low` explicitly. `effort` needs no beta header.
- **Don't send `temperature`, `top_p` or `top_k`.** Opus 5.5 rejects them. Also, `@anthropic-ai/sdk` 1.x sends API version `anthropic-version: 2026-10-21` by default, and that version rejects them on every model.
- **`max_tokens` covers thinking and the reply.** The team note suggested about 2048. Start at 4096 so low-effort thinking doesn't get cut off. Log `usage.output_tokens` in the eval and lower the cap if it's safe.
- **Structured output** uses `output_config.format`, not the deprecated `output_format`.
- **Handle `stop_reason`:**
  - `refusal` (HTTP 200): a refusal that reaches us is final. Either the fallback model also refused, or the category is never retried (for example `reasoning_extraction`). Map to `blocked` and discard any partial output. Log `stop_details.category` (not the page) for the eval.
  - `max_tokens`: retry once, then `blocked`.
  - `end_turn`: parse and validate.
- **Zod helper:** `client.messages.parse()` with `zodOutputFormat()` from `@anthropic-ai/sdk/helpers/zod` is the non-beta helper. The docs don't show whether a beta `parse` works together with `fallbacks`. Spike it. If it doesn't, call `beta.messages.create` with the JSON Schema derived from the Zod schema, then run `StepResponse.parse(JSON.parse(text))`. Either way, the Zod schema in `packages/shared` is the single source.
- **Prompt caching:**
  - `cache_control` goes on the system block, and the cached prefix must be at least **512 tokens**. Make the system prompt plus a few worked examples longer than that.
  - Keep model, effort and schema fixed. Changing any of them resets the cache.
  - Confirm caching works with `usage.cache_read_input_tokens > 0` on the second call.
- **SDK:** pin `@anthropic-ai/sdk` to `^1.3.0` (from team research, not checked against a changelog). In the **first hour on Friday**, smoke-test it inside a Convex `"use node"` action. If the SDK won't run there, call `/v1/messages` with raw `fetch` from the same action. Send the same body and the headers `anthropic-version: 2026-10-21` and `anthropic-beta: server-side-fallback-2026-07-01`, so behavior matches the SDK.
- **Client options:** `timeout: 10_000` (milliseconds in TypeScript), `maxRetries: 1`.

### 4.3 Model choice

- **Default:** `claude-opus-5-5` at `effort: "low"`.
- **Speed:** the docs rate Opus 5.5 "Moderate" and `claude-sonnet-5-5` "Fast." Run both on the prompt eval (accuracy, median and p90 latency) and pick by data. Sonnet 5.5 supports `fallbacks: "default"` on the Claude API.
- **Haiku 5.5** is fastest but has **no server-side fallback**. If we use it, remove `fallbacks` and the beta header from its requests: `"default"` does nothing there, and a list of fallback models returns a 400. `refusal` then maps straight to `blocked`.

### 4.4 Prompt additions (on top of the initial plan's rules)

- Pick `expect` to match the control. For a native select, return the exact option text.
- Set `risk` honestly. Use `suspicious` for gift cards, remote-access software, urgent "call now" pages, or requests for passwords outside a sign-in the user asked for.
- Never ask the user to read a code, password or number out loud.
- Use `wait` when the user has to do something away from the page.
- The snapshot's `omitted` count means more controls exist. Prefer guiding the user to scroll or open a menu over guessing.

## 5. Mac and Windows apps

### Phase 4: Companion app (Tauri 2, `apps/desktop`)

Tauri is chosen over Electron for small signed installers and Rust access to OS APIs. Speech recognition doesn't work in either webview, so voice uses Cartesia either way.

- **Tray / menu-bar icon** with a big **Ask** window. It starts at login.
- **Task alerts with the browser closed:** the app holds the Convex subscription and shows OS notifications for "Sam sent you a task." Clicking **Start** opens the user's default browser to the recipe `startUrl`, or to the last page.
- **Pairing once:** the app pairs with the 6-digit code and hands the device token to the extension over **native messaging** (`runtime.connectNative`). The installer registers the host manifest in each browser's location: registry keys on Windows for Chrome and Edge, JSON files in each browser's NativeMessagingHosts folder on macOS, and Firefox's own location.
- **On macOS the Safari extension's containing app *is* this app,** so Phase 3 and Phase 4 share one Xcode target.
- **Voice in the app** (optional): a steadier mic than browser panels. The extension still owns highlighting.
- **Signing and updates:** Windows needs Authenticode (Azure Trusted Signing, or an EV certificate to avoid SmartScreen warnings). macOS needs Developer ID plus notarization. Both use Tauri's updater with signed manifests.
- **Installer** detects installed browsers and opens the right store page for the extension.

### Phase 5: Native-app guidance

The step loop is the same. Only `PageBridge` changes.

- **Scanner:** Windows UI Automation (Rust `windows` / `uiautomation` crates) or the macOS Accessibility API (`AXUIElement`). Map their roles to the same snapshot vocabulary and add `surface: "web" | "native"` to `PageSnapshot`.
- **Overlay:** a transparent, click-through, always-on-top window per monitor, placed from element screen rects.
- **Click observation:** UIA Invoke events and a low-level mouse hook (`WH_MOUSE_LL`) on Windows. AX notifications and a `CGEventTap` on macOS. macOS needs the Accessibility permission (and possibly Input Monitoring), so setup must explain it plainly.
- **Privacy:** never read secure fields (`IsPassword` in UIA, `AXSecureTextField` in AX). Same `hasValue`-only rule.
- **Coverage varies.** Apps with poor accessibility trees get `blocked`. The opt-in screenshot fallback from §3.7 applies here too.
- First targets: Zoom desktop, Mail / Outlook, and System Settings / Windows Settings.

## 6. Store and distribution checklist

| Store | Needs |
|---|---|
| Chrome Web Store | single-purpose statement, justification for `<all_urls>` (optional host permission; expect in-depth review), privacy policy, Limited Use disclosure for page content |
| Edge Add-ons | same zip and same privacy answers |
| AMO (Firefox) | readable source plus build steps, `gecko.id`, data-collection disclosure (check current AMO policy) |
| Mac App Store (Safari) | Apple Developer account, Xcode wrapper app, App Privacy label, review notes explaining the guide-only design |
| Windows / macOS direct download (desktop) | code signing, notarization (macOS), signed updater feed |

All stores get one privacy policy: page text goes to Claude through Convex for the current step only. It isn't stored. Field values are never collected. Caregivers see outcomes only.

## 7. Roadmap

### Phase 0: Hackathon (Oct 23–25) — changes to the initial checkpoints

| When | Checkpoint | Added to the initial plan |
|---|---|---|
| Fri, first hour | **Spikes** (§9) | SDK in Convex, beta fallbacks plus structured output, gesture tests. C: API. A: gestures |
| Fri 10 PM | CP1, one page | `packages/core` and `packages/page-agent` split; fingerprint stored with WeakRef |
| Fri midnight | CP2, multi-step | `expect: type` and `choose`; fingerprint rebinding; new-tab follow |
| Sat 1 PM | CP3, real sites | open shadow roots plus `chrome.dom` closed roots; same-origin iframes; ranking; top-layer overlay. Cross-origin iframes as a stretch goal |
| Sat 2–6 PM | CP4, accounts | `risk` confirmations; notification fallback ladder (§3.6) |
| Sat 6 PM | Feature freeze | **Load-unpacked smoke test in Edge** (no code changes expected) |

Not in the hackathon: dock mode, Firefox, Safari, desktop, screenshot fallback.

### After the hackathon

| Phase | Scope | Exit check |
|---|---|---|
| 1 | Dock mode; Cartesia STT as the default where Web Speech is missing; publish to Chrome Web Store and Edge Add-ons; Brave, Opera and Vivaldi checks | fixture suite passes in Chrome, Edge, Brave and Opera |
| 2 | Firefox adapter (sidebar, event page), AMO listing | fixture suite passes under `web-ext run` |
| 3 | Safari macOS (dock mode, Xcode wrapper), App Store | fixture suite passes in Safari; review approved |
| 4 | Tauri companion app for Windows and macOS, native messaging, signed installers | task alert with the browser closed → Start → guided in browser |
| 5 | Native-app guidance through UIA and AX | 3 target apps finish one task each |
| Later | Opt-in screenshot fallback, other languages, iPad/iOS Safari, Firefox for Android | — |

## 8. Verification (added to the initial plan)

- **New fixtures in `apps/fixtures`** (still test-only, never special-cased):
  - a React page that rerenders its buttons every 500 ms
  - web components with open **and** closed shadow roots
  - same-origin and cross-origin iframes (second localhost port)
  - a form with text, password, `<select>` (50 options), date and file fields
  - a `target=_blank` link and a `window.open` popup
  - a `<dialog>.showModal()` page
  - a page with 1,000 links where the right button is below the fold
- **Leak test (unit and e2e):** type the sentinel string `SENTINEL-7Q2` into every field (including date and contenteditable) and pick a select option. Assert the sentinel and the selected value appear in **no** snapshot JSON, `postMessage`, Convex request or Convex log. Also check that `validationMessage` is never sent.
- **Unit tests (Vitest + happy-dom):**
  - fingerprint matching (unique, ambiguous, none)
  - ranker order and the modal-only rule
  - the `hasValue` state machine
  - select `matched` logic
  - StepResponse validator rules (§4.1)
- **E2E:** Playwright with a persistent Chromium context loading the built extension for Chrome. `web-ext run` for Firefox in Phase 2.
- **Prompt eval additions:** a case for each new `expect` type, `risk` and `suspicious` cases (including the Mana gift-card injection banner), and `omitted` handling. Report accuracy, latency and `cache_read_input_tokens` for Opus 5.5 vs Sonnet 5.5.
- **Cross-browser build:** `wxt build -b <each target>` in CI from Phase 1, even before a browser is officially supported.

## 9. Day-one spikes (Friday, first hour)

1. `@anthropic-ai/sdk@^1.3.0` runs inside a Convex `"use node"` action.
2. `beta.messages.create` with `fallbacks: "default"` + the beta header + `output_config.format` + `effort: "low"` returns valid JSON. Check whether `beta.messages.parse` with `zodOutputFormat` also works.
3. A second identical call shows `cache_read_input_tokens > 0`.
4. Chrome: `sidePanel.open()` from (a) `notifications.onClicked` and (b) a content-script button relayed through `runtime.sendMessage`. Record which ones work.
5. Chrome: `chrome.dom.openOrClosedShadowRoot` from the content script on a closed-root fixture.
6. Edge: load the CP1 build unpacked and confirm the side panel and Web Speech work.

## Open questions

- Should a `risk: money` step also notify the caregiver (with consent), or only ask the user?
- Who owns Apple Developer and Windows code-signing accounts after the hackathon?
- Should the screenshot fallback (§3.7) be allowed at all, given the privacy promise? It defaults to off and is caregiver-enabled.
