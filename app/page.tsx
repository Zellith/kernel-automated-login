"use client";

import { useState } from "react";

interface RunResult {
  success: boolean;
  timeIn?: string;
  timeOut?: string;
  error?: string;
}

export default function Home() {
  const [timeIn, setTimeIn] = useState("08:00");
  const [timeOut, setTimeOut] = useState("16:00");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  async function handleRun() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/time-in-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeIn, timeOut }),
      });
      const data: RunResult = await res.json();
      setResult(data);
    } catch {
      setResult({ success: false, error: "Network error — check console." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-900">
      <main className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm dark:bg-zinc-800">
        <h1 className="mb-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          HRM Daily Check
        </h1>
        <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
          Automates Time In/Out on{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            hrm.kalicube.com
          </span>{" "}
          via{" "}
          <a
            href="https://kernel.sh"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Kernel.sh
          </a>
          .
        </p>

        <div className="mb-4 grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="timeIn"
              className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              Time In
            </label>
            <input
              id="timeIn"
              type="time"
              value={timeIn}
              onChange={(e) => setTimeIn(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-50"
            />
          </div>
          <div>
            <label
              htmlFor="timeOut"
              className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400"
            >
              Time Out
            </label>
            <input
              id="timeOut"
              type="time"
              value={timeOut}
              onChange={(e) => setTimeOut(e.target.value)}
              className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-50"
            />
          </div>
        </div>

        <button
          onClick={handleRun}
          disabled={loading}
          className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {loading ? "Running automation\u2026" : "Run Time In/Out"}
        </button>

        {result && (
          <div
            className={`mt-4 rounded-lg px-4 py-3 text-sm ${
              result.success
                ? "bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                : "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-300"
            }`}
          >
            {result.success ? (
              <>
                \u2713 Time In/Out set to{" "}
                <strong>
                  {result.timeIn} \u2013 {result.timeOut}
                </strong>
              </>
            ) : (
              <>\u2717 {result.error}</>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
          Also runs automatically every weekday at 08:00 via Vercel Cron.
        </p>
      </main>
    </div>
  );
}
