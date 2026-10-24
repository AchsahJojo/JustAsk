# Test JustAsk yourself (about 20 minutes)

These steps use the dev Convex deployment `aromatic-salamander-969`. It already has the latest functions, the Anthropic key and the Convex Auth keys. The env files are already filled in, so you don't need any keys. For deeper checks, see `docs/MANUAL_SETUP.md`.

Use **PowerShell** for every command below. If you see "running scripts is disabled", use `npm.cmd` instead of `npm`.

## 1. Browser extension (Chrome)

1. Build it: `npm run build -w @justask/extension`.
2. Open `chrome://extensions` and turn on **Developer mode**.
   - If JustAsk is already loaded, click its reload arrow.
   - If not, click **Load unpacked** and pick `apps/extension/.output/chrome-mv3`.
3. Setup opens in a new tab.
   1. Click **Turn JustAsk on** and **Turn on the microphone**, and allow both.
   2. Choose **I'm new: create my JustAsk** and enter a first name.
4. **Push the latest Convex functions first.** The deployed planner must match the new step schema (no `act`, no `text`). Run `cd packages/backend` and then `npx convex dev`, and leave it running.
5. **Guide only, on the fixture site (works offline):**
   1. Run `npm run fixtures`.
   2. Open `http://localhost:5174/` and ask "refill my prescription".
   3. Expect a green ring with "Click here", and a spoken line telling *you* what to click.
   4. Wait a few seconds. Nothing clicks, types or scrolls by itself.
   5. Click the ringed button yourself. JustAsk praises you and shows the next ring.
   6. Settings has no **Show me instead** toggle.
   7. Then try `http://localhost:5174/gaps/` for the edge-case pages.
6. **A real site:**
   1. Open a store site (for example target.com), click the JustAsk toolbar icon, and say or type "help me buy a water bottle".
   2. Expect it to ring the search box and tell you to type "water bottle". It must not type anything itself.
   3. Expect it to ask "Check first…" before anything that spends money. Answer **No**: nothing is highlighted and the step ends.
7. **Secrets:**
   1. Open a sign-in page and ask "help me sign in".
   2. It must ring the password box and say "I can't see it." It must never type there.
8. **Post box (the old "still opening" bug):** on a social site, ask "help me write a post". When the post box opens, it should continue on its own, without waiting forever.

## 2. Caregiver web app (Amelie's)

1. Run `npm run caregiver`, open `http://localhost:5176`, and create an account.
2. Click **Set up JustAsk for someone** and note the 6-digit code.
3. In the extension settings, choose **I have a code from my helper** and enter the code.
4. Send a task from the web app. It should appear in the extension panel. Press **Start**.

## 3. Desktop app (Windows)

1. Run `npm run tauri -w @justask/desktop -- dev`. The first run compiles Rust for a few minutes. Rust build output goes to `C:\cargo-target`, outside OneDrive.
2. Create an account, or use **Add another device** in the extension to get a code.
3. Open Windows **Settings → Accessibility → Text size**. In JustAsk, ask "make the text bigger". JustAsk rings the next thing to use in Settings. You click it.
4. **Tray:** closing the window hides it to the tray. Use **Quit** from the tray icon.
5. **Guide only in Notepad:**
   1. Open Notepad, then click into JustAsk and ask "help me save this file".
   2. A ring appears in Notepad. Focus stays in JustAsk, and the Notepad window does not jump forward.
   3. Click the ringed item yourself. JustAsk moves to the next step.
   4. Click somewhere else in Notepad. JustAsk says "That's all right. The one we want has the glowing box around it." The ring stays.
   5. For a typing step, type in Notepad, then press **I'm done typing** in JustAsk.
6. **Opening the browser:**
   1. In Notepad, ask "find a banana bread recipe".
   2. JustAsk says "Please open your web browser, like Chrome or Edge. I'll wait." Nothing opens by itself.
   3. Open Edge yourself. JustAsk continues there.
   4. This needs the latest Convex functions. If JustAsk acts strangely, run `cd packages/backend` and then `npx convex dev` once.

## Report what you find

Write down the page, what you asked, and what JustAsk said or did. Add it to `docs/possible_bugs.md`, and I'll turn it into fixes and tests.

## Known issues

- On the desktop, the Settings app shows up as `ApplicationFrameHost` instead of "Settings".
- Electron apps (VS Code, new Outlook, Teams) expose very few controls to Windows UI Automation, so JustAsk sees only their window buttons.
- `docs/possible_bugs.md` lists older findings. Some are already fixed. Check them again as you test.
