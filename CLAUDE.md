# DarkLion AI - Project Context

## Deployment
- **Platform**: Railway (auto-deploys from GitHub)
- **Database**: PostgreSQL (hosted, via DATABASE_URL)
- **Domain**: darklion.ai

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
