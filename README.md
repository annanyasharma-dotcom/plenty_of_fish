# Plenty of Fish in the Sea

A satirical dating game. `index.html` is the whole game (no build step). `api/notes.js` runs the shared sticky-note board on the About page.

## Turn on the shared notes board
1. In your Vercel project, open **Storage** → **Create Database** (or **Marketplace**) → **Upstash for Redis** → free plan → connect it to this project.
   Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` to the project automatically.
2. Optional: under **Settings → Environment Variables**, add `NOTES_ADMIN_KEY` with any secret phrase.
   Visit `https://your-site/?admin=<that phrase>` to get a × on every note so you can remove anything.
3. Redeploy (Deployments → ⋯ → Redeploy).

Until storage is connected, the board falls back to saving notes in each visitor's own browser.
Visitors can remove their own notes; each IP can post 5 notes per 10 minutes.
