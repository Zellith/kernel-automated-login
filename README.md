# kernel-automated-login

A Vercel Next.js app that automates the daily **Time In/Out** entry on [hrm.kalicube.com](https://hrm.kalicube.com/wp-admin/) using [Kernel.sh](https://kernel.sh) browser automation.

## How it works

1. A Vercel Cron Job fires every weekday at **08:00 UTC** and calls `GET /api/time-in-out`.
2. The API route creates a headless browser session via the Kernel.sh SDK (`@onkernel/sdk`).
3. Playwright code is executed remotely on Kernel's infrastructure to:
   - Log into the WordPress admin at `https://hrm.kalicube.com/wp-admin/`
   - Navigate to the **DailyCheck** section
   - Click **Time In/Out** and set the times to **08:00** (in) and **16:00** (out)
   - Submit the form
4. The browser session is destroyed and the result is returned.

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
| `CRON_SECRET` | Secret Vercel sends with cron requests (`Authorization: Bearer <secret>`) |
| `API_SECRET` | Optional secret for direct API calls via `x-api-secret` header |

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
    automation.ts            # Playwright code string builders
    client.ts                # Kernel.sh session management
.env.example                 # Required environment variables
vercel.json                  # Cron job schedule
```
