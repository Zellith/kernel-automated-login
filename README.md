# kernel-automated-login

A Vercel Next.js app that automates the daily **Time In/Out** entry on [hrm.kalicube.com](https://hrm.kalicube.com/wp-admin/admin.php?page=hrm-dailycheck-app) using [Kernel.sh](https://kernel.sh) through [Agent Browser's native Kernel integration](https://www.kernel.sh/docs/integrations/agent-browser).

## How it works

1. A Vercel Cron Job fires every weekday at **08:00 UTC** and calls `GET /api/time-in-out`.
2. The API route launches Agent Browser with the native `kernel` provider.
3. Agent Browser creates the remote Kernel browser session and runs the automation steps to:
  - Open the protected DailyCheck page
  - Log into WordPress with the configured username and password
  - Click **Time In/Out** and set the times to **08:00** (in) and **16:00** (out)
  - Submit the form
4. The app uses the Kernel SDK for session metadata and replay handling, then Agent Browser closes the session.

You can also trigger the automation manually from the web UI or via a direct `POST /api/time-in-out` request.

## Setup

### 1. Clone & install

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

| Variable | Description |
|---|---|
| `KERNEL_API_KEY` | Your Kernel.sh API key (from [kernel.sh](https://kernel.sh)) |
| `HRM_USERNAME` | WordPress admin username for hrm.kalicube.com |
| `HRM_PASSWORD` | WordPress admin password |
| `KERNEL_HEADLESS` | Optional. Set to `true` to force headless mode. |
| `KERNEL_HEADFUL` | Optional. Set to `true` to force headful mode in app-level config. |
| `KERNEL_STEALTH` | Optional. Kernel stealth mode. Agent Browser defaults this to `true`. |
| `KERNEL_TIMEOUT_SECONDS` | Optional. Remote browser timeout in seconds. Defaults to `300`. |
| `CRON_SECRET` | Secret Vercel sends with cron requests (`Authorization: Bearer <secret>`) |
| `API_SECRET` | Optional secret for direct API calls via `x-api-secret` header |

No extra local browser install step is required for the app's runtime path. The app uses Agent Browser as a library and launches Kernel's remote browser provider directly.

### 3. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — you'll see a simple UI to trigger and test the automation.

### 4. Deploy to Vercel

```bash
vercel deploy
```

Add all environment variables in **Vercel Dashboard → Project Settings → Environment Variables**.

The `vercel.json` cron config will automatically schedule the job at `0 8 * * 1-5` (08:00 UTC, Mon–Fri).

## Manual API call

```bash
# With API_SECRET set
curl -X POST https://your-app.vercel.app/api/time-in-out \
  -H "Content-Type: application/json" \
  -H "x-api-secret: your-api-secret" \
  -d '{"timeIn": "08:00", "timeOut": "16:00"}'
```

## Project structure

```
app/
  api/time-in-out/route.ts   # API endpoint (POST + GET)
  page.tsx                   # Web UI
  layout.tsx
lib/
  kernel/
    client.ts                # Native Kernel Agent Browser automation + Kernel session metadata
.env.example                 # Required environment variables
vercel.json                  # Cron job schedule
```
