# How JustAsk works

The whole system in short sections. Each one starts with a one-line **TL;DR**. Detail lives in `ARCHITECTURE.md`.

---

## 1. JustAsk in 30 seconds

**TL;DR:** a calm voice that points at the next button. She clicks, JustAsk never does.

- **Who it's for:** adults 65+ who get stuck on everyday sites (pharmacy, email, Zoom).
- **What she does:** presses one big button and says what she wants.
- **What JustAsk does:** puts a glowing box around the next thing and says one short line. When she clicks, it gives the next step.
- **The one rule:** guide only. JustAsk never clicks, types or submits for her.
- **The optional helper:** a caregiver sends tasks and hears when she finishes, if she agrees.

---

## 2. The pieces

**TL;DR:** one extension, one web app, one backend, two AI services.

```
   She uses                         Her helper uses
┌───────────────────┐            ┌──────────────────┐
│ Chrome extension  │            │ Caregiver web app│
│ side panel + box  │            │ (Vercel)         │
└────────┬──────────┘            └────────┬─────────┘
         │ device token                   │ sign-in
         ▼                                ▼
┌─────────────────────────────────────────────────┐
│ Convex backend: accounts, tasks, events, /plan  │
└───────┬─────────────────────────────┬───────────┘
        ▼                             ▼
   Claude (picks the step)     Cartesia (speaks and listens)
```

| Piece | Job, in one line |
|---|---|
| Extension (`apps/extension`) | reads the page, draws the box, speaks, notices her click |
| Caregiver app (`apps/caregiver`) | add a person, send tasks, see outcomes |
| Convex (`packages/backend`) | stores accounts and tasks, holds the API keys, calls Claude |
| Claude | picks one numbered thing on screen and writes the line to say |
| Cartesia | Sonic speaks the line; Ink turns her voice into text |

---

## 3. One step, start to finish

**TL;DR:** read → number → Claude picks a number → safety check → box + voice → her click.

1. **Read.** The content script lists every button, link and box she can see.
2. **Number.** Each one gets a number. Field values are never copied, only "has text: yes/no".
3. **Pick.** Claude gets her request plus the numbered list, and returns one number and one line.
4. **Check.** Code (not Claude) makes sure the number exists, and runs the safety gates below.
5. **Show.** The box pulses around that thing. The line is spoken and shown as a big caption.
6. **Wait.** Her click, typing or choice moves it to the next step. "Say that again" repeats the line.

This repeats until Claude says the task is done: "All done, you did it!"

---

## 4. Her flow (the senior)

**TL;DR:** set up once, then one button.

1. Install the extension. The setup page asks for site access and the mic.
2. Choose **I'm new** or type her helper's 6-digit code.
3. Pick the consent switches: tell my helper when I finish, or when I get stuck.
4. A task card appears: "Sam asked you to: Refill your prescription." She presses **Start**.
5. She follows each step. **Stop**, **Say that again** and **I'm stuck** are always there.
6. "All done, you did it!" Then **I did it** closes the task.

## 5. The helper's flow (caregiver)

**TL;DR:** sign up, connect, send a task, hear back.

1. Sign up with email and password.
2. Add the person. The app shows a 6-digit code to type on her computer.
3. Send a task: a title, what JustAsk should say, an optional recipe of steps and an `https://` start page.
4. Watch the activity feed: "finished" or "got stuck", only if she agreed.
5. The person page shows counts: finished, steps per task, "Say that again", "I'm stuck", typical step time.

---

## 6. Safety

**TL;DR:** the risky decisions are plain code, not left to Claude.

| Rule | How | Where |
|---|---|---|
| She does every click | the core only acts with `allowDrive`; the extension never sets it | `packages/core/src/controller.ts` |
| Private fields stay private | password, code, card, SSN and bank fields are flagged and never read | `packages/page-agent/src/sensitive.ts` |
| No typed values leave the page | the snapshot carries booleans only | `packages/page-agent/src/scanner.ts` |
| Claude can't invent targets | the reply must name a number from this snapshot | `packages/shared/src/step.ts` (`checkStep`) |
| Ask before money or account changes | risk steps show a yes/no question first | `packages/core/src/controller.ts` |
| Scam check | gift card, wire or remote-access requests get one plain question | `packages/core/src/scam.ts` |
| Page text can't give orders | it goes inside `<page_content>`, marked untrusted | `packages/core/src/prompt.ts` |
| Keys never reach the browser | Claude and Cartesia keys live in Convex env | `packages/backend/convex/plan.ts`, `voice.ts` |
| Caregivers can't see her screen | only outcomes and counts, consent-gated | `packages/backend/convex/people.ts`, `sessions.ts` |

---

## 7. Decisions we made

**TL;DR:** every choice favors her safety and a demo that works.

| Decision | Why | What we gave up |
|---|---|---|
| **Guide only**, no "do it for me" | she stays in control; answers "what if it clicks Buy?" | speed for users who'd rather be driven (the code is kept, switched off) |
| **Extension only**, desktop app dropped | one platform done well by the deadline | help inside native apps (Settings, Zoom app) |
| **Convex** backend | auth, data, live updates and the API proxy in one place | portability to another backend |
| Claude returns **numbers, not selectors** | we check them; no made-up CSS | Claude can't target something we didn't list |
| **No field values** leave the page | privacy by construction | Claude can't check what she typed, only "has text" |
| Caregiver **recipes**, not per-site scripts | works on any site; no special cases | the demo leans on a written recipe |
| **6-digit pairing codes**, no senior passwords | she never manages a password | anyone holding a fresh code can link (rate-limited, 15 minutes) |
| **Cartesia** voice, with a caption and typing fallback | voice is the product, but it must never block her | no browser voice as a second engine |
| **Scam check** before acting | fraud targets this group hardest | an occasional extra question on a normal errand |

---

## 8. Not done yet

**TL;DR:** fine for a demo, not yet a store release.

- No Chrome Web Store listing; load it unpacked.
- No email verification or password reset for caregivers.
- The scam check runs on her first request only, not on later answers.
- `about:blank` / `srcdoc` iframes aren't read.
- Not tested on Firefox or Safari.

---

## 9. Where things live

**TL;DR:** apps are what people see; packages are shared logic.

| Folder | One line |
|---|---|
| `apps/extension` | the Chrome extension (side panel, setup page, content script) |
| `apps/caregiver` | the caregiver web app |
| `apps/fixtures` | mock pharmacy and test pages; never special-cased |
| `packages/core` | the step loop, the prompt, the scam check (no browser APIs) |
| `packages/page-agent` | reads the page, draws the box, watches for her action |
| `packages/shared` | the data shapes everyone agrees on (Zod) |
| `packages/voice` | Cartesia speaking and listening |
| `packages/backend` | Convex: data, auth, `/plan`, voice tokens |
| `e2e` | Chrome end-to-end tests |
| `scripts/deploy.mjs` | one-command deploy (`docs/DEPLOY.md`) |
