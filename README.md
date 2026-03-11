# kernel-automated-login

A Vercel Next.js app that automates the daily **Time In/Out** entry on [hrm.kalicube.com](https://hrm.kalicube.com/wp-admin/admin.php?page=hrm-dailycheck-app) using [Kernel.sh](https://kernel.sh), the [Kernel AI SDK integration for Vercel](https://www.kernel.sh/docs/integrations/vercel/ai-sdk), and GPT-5 via your own OpenAI API key.

## How it works

1. A Vercel Cron Job fires every weekday at **08:00 UTC** and calls `GET /api/time-in-out`.
2. The API route creates a remote Kernel browser session directly through the Kernel SDK.
3. The route uses GPT-5 through Vercel AI SDK and `@onkernel/ai-sdk`'s `playwrightExecuteTool` to run the browser workflow on that session.
4. The generated Playwright code opens the protected Daily Check page, logs in if needed, completes the **Time In/Out** flow, and returns a structured result.
5. The app stores the live view URL and closes the Kernel session when the run finishes.

You can also trigger the automation manually from the web UI or via a direct `POST /api/time-in-out` request.

The web UI now uses the same synchronous `POST /api/time-in-out` route as the manual API call. This avoids unreliable in-memory background jobs in serverless environments and ensures the entered times are submitted by the same code path you use in production.

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
| `OPENAI_API_KEY` | Your OpenAI API key used for GPT-5 orchestration |
| `HRM_USERNAME` | WordPress admin username for hrm.kalicube.com |
| `HRM_PASSWORD` | WordPress admin password |
| `KERNEL_HEADLESS` | Optional. Set to `true` to force headless mode. |
| `KERNEL_HEADFUL` | Optional. Set to `true` only for debugging with live view. Headless mode is more reliable for unattended runs. |
| `KERNEL_STEALTH` | Optional. Kernel stealth mode. Defaults to `true` when unset. |
| `KERNEL_TIMEOUT_SECONDS` | Optional. Remote browser timeout in seconds. Defaults to `300`. |
| `CRON_SECRET` | Secret Vercel sends with cron requests (`Authorization: Bearer <secret>`) |
| `API_SECRET` | Optional secret for direct API calls via `x-api-secret` header |

No extra local browser install step is required for the app's runtime path. The app runs entirely through Kernel's remote browser sessions.

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
    client.ts                # Kernel SDK + GPT-5 orchestration for the HRM workflow
.env.example                 # Required environment variables
vercel.json                  # Cron job schedule
```
