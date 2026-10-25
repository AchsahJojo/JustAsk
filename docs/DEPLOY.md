# Deploying JustAsk

**TL;DR:** set up once (about 10 minutes), then `npm run deploy -- --vercel` ships everything.

What gets deployed:

| Piece | Where | Built from |
|---|---|---|
| Backend (data, auth, `/plan`, voice tokens) | Convex production deployment | `packages/backend` |
| Caregiver web app | Vercel (static) | `apps/caregiver` |
| Fixture sites (mock pharmacy, test pages) | Vercel (static) | `apps/fixtures/public` |
| Chrome extension | a `.zip` you hand out or load unpacked | `apps/extension` |

No API keys go in the repo, the extension or the web app. They live only in Convex env.

---

## One-time setup

**1. Log in.**

```bash
npx convex login
npx vercel login
```

**2. Create the production deployment.** From `packages/backend`:

```bash
cd packages/backend
npx convex deploy          # first run creates prod and prints its URL: https://<name>.convex.cloud
```

**3. Set up sign-in for caregivers** (JWT keys and `SITE_URL`):

```bash
npx @convex-dev/auth --prod
```

When it asks for the site URL, give the caregiver app's Vercel URL. If you don't have it yet, rerun this after step 6.

**4. Add the keys** (prod only, never in a file):

```bash
npx convex env set --prod ANTHROPIC_API_KEY sk-ant-...
npx convex env set --prod CARTESIA_API_KEY sk_car_...
```

Without `CARTESIA_API_KEY`, JustAsk still works but is silent. The panel says "JustAsk's voice is off" and the captions carry on.

**5. Tell the deploy script where prod is.** Create `.env.deploy` at the repo root. It's gitignored, and the URL is public, not a secret.

```bash
JUSTASK_CONVEX_URL=https://<name>.convex.cloud
# optional: where caregivers get the extension (shown in their setup steps)
JUSTASK_EXTENSION_URL=https://github.com/AchsahJojo/JustAsk/releases
```

**6. First Vercel publish.** It asks you to link or create a project for each folder: `caregiver` and `fixtures`.

```bash
npm run deploy -- --vercel
```

---

## Every deploy after that

```bash
npm run deploy -- --vercel
```

| Flag | Does |
|---|---|
| (none) | deploy the backend, build the extension zip and the caregiver app |
| `--vercel` | also publish the caregiver app and the fixtures to Vercel |
| `--skip-backend` | rebuild the front ends only |

The script prints where everything ended up. The extension zip is at `apps/extension/.output/justask-<version>-chrome.zip`.

## Installing the extension (judges and testers)

1. Unzip the file.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.
4. The setup page opens. Allow site access and the microphone, then create an account or enter a helper's code.

## Not set up (known limitations)

- No email verification or password reset for caregivers (it needs Resend and a verified domain).
- The extension is not on the Chrome Web Store. Load it unpacked.
- Per-IP rate limits on public endpoints. Limits today are global and per code.
