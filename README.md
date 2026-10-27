# SYNTRIX – Live Event Scoreboard
Node.js + Express + Supabase PostgreSQL (`pg`) + Socket.IO. Vanilla JS front end (no build step).

## Run locally (Node 20.6+)
    npm install
    Copy-Item .env.example .env
    # Set DATABASE_URL, JWT_SECRET, ADMIN_USER, and ADMIN_PASSWORD in .env
    npm start                 # http://localhost:3000

Admin account is created/updated from ADMIN_USER / ADMIN_PASSWORD at startup (password stored as a bcrypt hash; change the env value and restart to reset it).
Pages: `/#/board` (public, read-only, projector mode), `/#/results`, `/#/login` → Dashboard, Teams, Rounds, Marks.

## Database
Create the tables once by running [sql.md](./sql.md) in the Supabase SQL Editor. Set `DATABASE_URL` to the project's PostgreSQL connection string; URL-encode special characters in the database password. Keep this value server-side and never put it in `public/` or expose it to the browser. The app uses its own admin login, so the Supabase publishable key is not needed.

To move existing scoreboard data, sign in to the old app and download a backup from Dashboard → Backup before switching deployments. After setting up the Supabase schema and launching this version, sign in with `ADMIN_USER` / `ADMIN_PASSWORD` and restore that JSON file from Dashboard → Restore backup. Admin credentials are configured separately and are not included in scoreboard backups.

## Deploy
Use any host that runs Node (Render, Railway, Fly.io, VPS): set the environment variables from `.env.example`, `NODE_ENV=production`, and start command `npm start`; serve over HTTPS. PostgreSQL is hosted by Supabase, so the app does not need a persistent local disk. Socket.IO updates are in-process, so run one app instance unless you add a shared Socket.IO adapter.

## Test
Log in, add teams/rounds, enter marks on `/#/marks`, and watch `/#/board` update in a second window; try `/api/export.csv` while logged in (401 when logged out).
