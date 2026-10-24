# Perekup Control API

Secure server-side player accounts and admin tools. Requires `DATABASE_URL` (Render Postgres connection string) and `ADMIN_SETUP_TOKEN` (random secret in Render environment, **never commit**). Optional: `GAME_ORIGIN` defaults to the existing public game. `GET /api/health` exposes configuration status without secrets. The first administrator is registered at `/admin` using the setup token, after which bootstrap is permanently disabled.

The existing offline-only game continues without registration. Online players create an account in the game to be administered. Account data is saved in Postgres. Free Render Postgres expires and requires upgrade before its expiry date.
