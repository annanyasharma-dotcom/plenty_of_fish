# Plenty of Fish in the Sea

A satirical dating game. `index.html` is the whole game (no build step). `api/notes.js` runs the shared sticky-note board on the About page.

## Shared notes board
The board works with either database connected to the Vercel project:

- **Supabase** (Vercel → Storage → Supabase). Tables are created automatically on first use, with row-level security on.
- **Upstash Redis** (Vercel → Storage → Upstash for Redis).

After connecting a database, redeploy. Check it at `/api/notes?health=1`, which should show `{"ok":true,...}`.

Optional: add `NOTES_ADMIN_KEY` under Settings → Environment Variables, then visit `/?admin=<that phrase>` to get a × on every note.

Visitors can remove their own notes; each visitor can post 5 notes per 10 minutes.
