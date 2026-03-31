# DarkLion AI - Project Context
> ⚠️ **Read `DARKLION.md` first** — it's the master context document for this project.
> This file has basic setup info but DARKLION.md has everything: architecture, rules, history, shell template rules, known bugs, and session history.



## Deployment
- **Platform**: Railway (auto-deploys from GitHub `main` branch)
- **Database**: PostgreSQL (hosted, via DATABASE_URL)
- **Domain**: darklion.ai
- **Git push restriction**: Claude can only push to `claude/` branches. GitHub Actions deploy to Railway from `claude/**` branches directly.
- **Deploy workflow**: `.github/workflows/deploy-railway.yml` uses `RAILWAY_TOKEN` secret.

## Architecture
- Express.js server (`server/index.js`)
- Static HTML frontend (`public/`)
- PostgreSQL with `pg` driver (`server/db.js`)
- QuickBooks Online OAuth integration

## Key Routes
- `/dashboard` — Protected dashboard (Basic Auth via DASH_USER/DASH_PASS)
- `/connect` — QBO OAuth connect page
- `/callback` — QBO OAuth callback handler
- `/api/*` — Protected API endpoints
- `/auth/callback` — Token exchange endpoint

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string
- `QB_CLIENT_ID` / `QB_CLIENT_SECRET` — QuickBooks OAuth credentials
- `QB_REDIRECT_URI` — OAuth redirect URI
- `DASH_USER` / `DASH_PASS` — Dashboard basic auth
- `PORT` — Server port (default 8080)
