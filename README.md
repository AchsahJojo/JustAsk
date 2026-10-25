# JustAsk

**ChatGPT explains the steps. JustAsk walks beside you while you do them.**

JustAsk is a Chrome extension for older adults. They press one big button and say what they want: "help me refill my prescription." JustAsk reads the page, puts a glowing box around the one thing to use next, and says one short line in a calm voice: "Click the big blue Refill button." They click. JustAsk sees it and gives the next step, until "All done, you did it!"

**You click. JustAsk never does.**

A caregiver (an adult child, a nurse) can optionally send them tasks from a web app, add a plain-language recipe, and get a note when they're done: *"Mom finished “Refill a prescription” and did every step themselves."* That note is only sent if they consent.

Start here: **[docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)** covers the whole system in short sections.

---

## Try it

**Judges and testers:** use the extension zip from the release, or build it with `npm run deploy` (see [docs/DEPLOY.md](docs/DEPLOY.md)).

1. Unzip it. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the folder.
2. On the setup page, allow site access and the microphone, then **I'm new: create my JustAsk**.
3. Open the mock pharmacy (fixture site), press the JustAsk button and say "help me refill my prescription."
4. **Caregiver side:** sign up in the caregiver app, add a person, give them the 6-digit code, and send a task.

**Run everything locally** (no keys needed for the tests):

```bash
npm install
npm test                 # unit tests (Vitest)
npm run test:e2e         # builds the extension, runs Chrome end-to-end tests with a scripted planner
npm run fixtures         # mock pharmacy and test sites on :5174 / :5175
npm run caregiver        # caregiver app on :5176
cd packages/backend && npx convex dev   # backend
```

Full local setup and manual checklists: [docs/MANUAL_SETUP.md](docs/MANUAL_SETUP.md).

---

## How we use Cartesia

Voice is how they're guided, so every spoken line goes through Cartesia.

| Feature | Where | Why |
|---|---|---|
| **Sonic** text-to-speech (`sonic-3`) over WebSocket | `packages/voice/src/tts.ts` | streams the line, so speech starts fast; `generation_config.speed` gives a slower voice (three speed settings) |
| **Ink** speech-to-text (`ink-whisper`) over WebSocket | `packages/voice/src/stt.ts` | press-to-talk requests and answers; it finalizes on its own after a pause |
| **Short-lived access tokens** (STT + TTS grants, 10 min) | `packages/backend/convex/voice.ts` | the API key stays in Convex; the extension only gets a token |
| **Say that again** | side panel | replays the line at their pace |

If Cartesia is unavailable, JustAsk keeps working: captions show every line, they can type, and the panel says the voice is off.

## How we use Claude

- Each step, Claude (`claude-opus-5-5`, structured JSON output) gets their request, the steps so far, an optional caregiver recipe, and a **numbered** list of what's on screen.
- It returns one step: an element **number**, never a selector, plus one short line to say.
- Page text is untrusted data inside `<page_content>`. It's never treated as instructions.
- Deterministic code checks every reply before anything is highlighted: the number exists, sensitive fields are never read, money and account steps ask first, and suspicious pages block.
- Calls go through a Convex HTTP action (`/plan`), so the key never reaches the browser.
- Built with Claude Code.

## Safety, in one list

- **Guide only:** JustAsk never clicks, types, chooses or submits for them.
- **Private fields stay private:** password, one-time code, card, SSN and bank fields are never read or stored. It points at them and says "Type your password here. I can't see it."
- **No field values leave the page.** Only booleans do (has text, valid, sensitive).
- **Asks first** before payments, personal details or account changes.
- **Scam check:** a request like "email the gift card codes to the IRS" gets one plain question before anything happens. Pages that look like scams are blocked.
- **No navigation to URLs Claude produces.** It only goes to the caregiver recipe's `https://` start page, links they click, or (on an empty tab, after a yes) a web search.
- **Stop always works.**
- **Caregivers see outcomes and counts only,** never their screen or what they ask for themselves.

## Known limitations

- Chrome desktop only. It's not on the Chrome Web Store yet, so load it unpacked.
- Caregiver accounts have no email verification or password reset yet.
- `about:blank` / `srcdoc` iframes aren't read.
- The scam check runs on the first request, not yet on later answers.
- The demo task runs on our mock pharmacy (a test fixture, labelled as such) for reliability. The same build works on real sites, but results vary with the page.

## Layout

```
apps/extension/      WXT + React: side panel, setup page, content script, background
apps/caregiver/      Vite + React caregiver web app
apps/fixtures/       mock pharmacy + test pages (:5174, :5175) and the scripted test planner
packages/shared/     Zod schemas: PageSnapshot, StepResponse (+ JSON Schema), messages
packages/core/       session state machine and step loop, prompt, scam check. No browser APIs
packages/page-agent/ scanner, ranker, fingerprint, overlay, observers. DOM only
packages/voice/      Cartesia Sonic + Ink over WebSocket
packages/backend/    Convex: accounts, pairing, tasks, events, /plan, voice tokens
e2e/                 Puppeteer end-to-end tests
scripts/deploy.mjs   one-command deploy (docs/DEPLOY.md)
```

Rules for building with Claude Code: [CLAUDE.md](CLAUDE.md).
