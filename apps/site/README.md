# JustAsk teaching site

A static brochure and lesson for JustAsk, built and deployed with Mana for the hackathon. It contains no product code: no side panel, scanner, planner, pairing form or task list.

- Pages: Home (`/`), Why (`/why`), Use them together (`/together`), Get JustAsk (`/get`), I help someone (`/help`).
- The “I help someone” button leaves for the caregiver app at https://justask-caregiver.vercel.app (its own Vercel project; Convex `SITE_URL` stays that address).
- Get JustAsk teaches building `apps/extension` and loading `apps/extension/.output/chrome-mv3` unpacked. Its `.env` line uses the public production Convex addresses.
- The caregiver app's `VITE_EXTENSION_URL` can point at `/get` on this site.

Deploy: plain static files, no build step. From this folder: `npx vercel deploy --prod`.
