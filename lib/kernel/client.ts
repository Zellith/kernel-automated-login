/**
 * Kernel.sh browser automation client for HRM time-tracking.
 *
 * Uses Agent Browser's native Kernel provider to launch and control a Kernel
 * browser session, while still using the Kernel SDK for session metadata and
 * replay management.
 */

import Kernel from "@onkernel/sdk";
import { BrowserManager } from "agent-browser/dist/browser.js";
import {
  inspectExecutionResultSchema,
  loginExecutionResultSchema,
  timeInOutResultSchema,
  type InspectExecutionResult,
  type LoginExecutionResult,
  type TimeInOutResult,
} from "@/lib/time-in-out";

const DAILY_CHECK_URL = "https://hrm.kalicube.com/wp-admin/admin.php?page=hrm-dailycheck-app";
const LOGIN_URL_MARKERS = ["/wp-login.php", "/hr-login"];

/** Default time-in and time-out values for the daily check. */
export const DEFAULT_TIME_IN = "08:00";
export const DEFAULT_TIME_OUT = "16:00";

export interface RunTimeInOutOptions {
  onSessionReady?: (session: {
    browserLiveViewUrl?: string;
    replayId?: string;
    replayViewUrl?: string;
    replayError?: string;
    headless: boolean;
  }) => void;
}

function getKernelSessionId(manager: BrowserManager): string {
  const sessionId = (manager as unknown as { kernelSessionId?: string | null }).kernelSessionId;

  if (!sessionId) {
    throw new Error("Agent Browser did not expose a Kernel session ID.");
  }

  return sessionId;
}

async function resolveReplayViewUrl(
  kernel: Kernel,
  sessionId: string,
  replayId: string,
  fallback?: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const replays = await kernel.browsers.replays.list(sessionId).catch(() => []);
    const replay = replays.find((item) => item.replay_id === replayId);

    if (replay?.replay_view_url) {
      return replay.replay_view_url;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return fallback;
}

async function withKernelHeadlessEnv<T>(headless: boolean, run: () => Promise<T>): Promise<T> {
  const previousHeadless = process.env.KERNEL_HEADLESS;

  process.env.KERNEL_HEADLESS = String(headless);

  try {
    return await run();
  } finally {
    if (previousHeadless === undefined) {
      delete process.env.KERNEL_HEADLESS;
    } else {
      process.env.KERNEL_HEADLESS = previousHeadless;
    }
  }
}

async function loginToHrm(
  page: Awaited<ReturnType<BrowserManager["getPage"]>>,
  username: string,
  password: string,
): Promise<LoginExecutionResult> {
  await page.goto(DAILY_CHECK_URL, {
    waitUntil: "domcontentloaded",
    timeout: 25000,
  });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  let currentUrl = page.url();
  if (currentUrl.includes("page=hrm-dailycheck-app")) {
    return loginExecutionResultSchema.parse({ success: true, loggedIn: true, url: currentUrl });
  }

  if (!LOGIN_URL_MARKERS.some((marker) => currentUrl.includes(marker))) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      error: "Expected WordPress login redirect but landed elsewhere.",
    });
  }

  await page.waitForSelector('form#loginform, form[name="loginform"]', { timeout: 10000 }).catch(() => {});

  const loginForm = page.locator('form#loginform, form[name="loginform"]').first();
  if ((await loginForm.count().catch(() => 0)) === 0) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      error: "Could not find WordPress login form.",
    });
  }

  const userField = loginForm.locator('#user_login, input[name="log"]').first();
  const passwordField = loginForm.locator('#user_pass, input[name="pwd"]').first();
  const submitButton = loginForm.locator('#wp-submit, button[type="submit"], input[type="submit"]').first();
  const redirectField = loginForm.locator('input[name="redirect_to"]').first();

  if ((await userField.count().catch(() => 0)) === 0) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      error: "Could not find username field on the login page.",
    });
  }

  if ((await passwordField.count().catch(() => 0)) === 0) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      error: "Could not find password field on the login page.",
    });
  }

  await userField.fill(username);
  await passwordField.fill(password);

  if ((await redirectField.count().catch(() => 0)) > 0) {
    await redirectField
      .evaluate((node, value) => {
        const input = node as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, DAILY_CHECK_URL)
      .catch(() => {});
  }

  if ((await submitButton.count().catch(() => 0)) === 0) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      error: "Could not find login submit button.",
    });
  }

  await submitButton.click({ force: true });

  await page
    .waitForURL(
      (url) =>
        url.href.includes("page=hrm-dailycheck-app") ||
        (!url.href.includes("/wp-login.php") && !url.href.includes("/hr-login")),
      { timeout: 20000 },
    )
    .catch(() => {});

  currentUrl = page.url();
  if (currentUrl.includes("page=hrm-dailycheck-app")) {
    return loginExecutionResultSchema.parse({ success: true, loggedIn: true, url: currentUrl });
  }

  const loginError = await page
    .evaluate(() => {
      const node = document.querySelector("#login_error, .login-error, .notice-error, .woocommerce-error");
      return node ? (node.textContent || "").trim() : null;
    })
    .catch(() => null);

  return loginExecutionResultSchema.parse({
    success: true,
    loggedIn: false,
    url: currentUrl,
    error: loginError ?? "Login failed.",
  });
}

async function setTimeInOut(
  page: Awaited<ReturnType<BrowserManager["getPage"]>>,
  timeIn: string,
  timeOut: string,
): Promise<InspectExecutionResult> {
  if (!page.url().includes("page=hrm-dailycheck-app")) {
    await page.goto(DAILY_CHECK_URL, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    });
  }

  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(500);

  const roleButton = page.getByRole("button", { name: "Time In/Out" }).first();
  const fallbackButton = page
    .locator('button[onclick*="openModal(\'roam_time_modal\')"], .roam-footer-banner .footer-left button:first-child')
    .first();

  let foundTimeInOutButton = false;
  let buttonHtml: string | null = null;

  if ((await roleButton.count().catch(() => 0)) > 0) {
    buttonHtml = await roleButton.evaluate((node) => node.outerHTML).catch(() => null);
    await roleButton.click().catch(() => {});
    foundTimeInOutButton = true;
  } else if ((await fallbackButton.count().catch(() => 0)) > 0) {
    buttonHtml = await fallbackButton.evaluate((node) => node.outerHTML).catch(() => null);
    await fallbackButton.click().catch(() => {});
    foundTimeInOutButton = true;
  }

  if (!foundTimeInOutButton) {
    return inspectExecutionResultSchema.parse({
      success: false,
      foundTimeInOutButton: false,
      buttonHtml,
      modalHtml: null,
      pageUrl: page.url(),
      error: "Could not find Time In/Out button.",
    });
  }

  const modal = page.locator("#roam_time_modal");
  await modal.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const modalHtml = await modal.evaluate((node) => node.outerHTML).catch(() => null);

  const [startHour, startMinute] = timeIn.split(":");
  const [endHour, endMinute] = timeOut.split(":");

  await page.locator("#start_hh").selectOption(startHour);
  await page.locator("#start_mm").selectOption(startMinute);
  await page.locator("#end_hh").selectOption(endHour);
  await page.locator("#end_mm").selectOption(endMinute);

  const selectedValues = await page.evaluate(() => ({
    startHour: document.querySelector<HTMLSelectElement>("#start_hh")?.value ?? null,
    startMinute: document.querySelector<HTMLSelectElement>("#start_mm")?.value ?? null,
    endHour: document.querySelector<HTMLSelectElement>("#end_hh")?.value ?? null,
    endMinute: document.querySelector<HTMLSelectElement>("#end_mm")?.value ?? null,
  }));

  if (
    selectedValues.startHour !== startHour ||
    selectedValues.startMinute !== startMinute ||
    selectedValues.endHour !== endHour ||
    selectedValues.endMinute !== endMinute
  ) {
    return inspectExecutionResultSchema.parse({
      success: false,
      foundTimeInOutButton: true,
      buttonHtml,
      modalHtml,
      pageUrl: page.url(),
      error: `Time values were not applied correctly: ${JSON.stringify(selectedValues)}`,
    });
  }

  const ajaxResponsePromise = page
    .waitForResponse(
      (response) => response.url().includes("/wp-admin/admin-ajax.php") && response.request().method() === "POST",
      { timeout: 10000 },
    )
    .catch(() => null);

  page.once("dialog", (dialog) => {
    void dialog.accept().catch(() => {});
  });

  await page.locator("#btn_save_time").click();
  await ajaxResponsePromise;
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1500);

  return inspectExecutionResultSchema.parse({
    success: true,
    foundTimeInOutButton: true,
    buttonHtml,
    modalHtml,
    pageUrl: page.url(),
    error: undefined,
  });
}

/**
 * Run the full HRM time-in/out automation using a Kernel.sh browser session.
 */
export async function runTimeInOut(
  timeIn: string = DEFAULT_TIME_IN,
  timeOut: string = DEFAULT_TIME_OUT,
  options: RunTimeInOutOptions = {},
): Promise<TimeInOutResult> {
  const apiKey = process.env.KERNEL_API_KEY;
  const username = process.env.HRM_USERNAME;
  const password = process.env.HRM_PASSWORD;

  if (!apiKey) throw new Error("KERNEL_API_KEY environment variable is not set");
  if (!username) throw new Error("HRM_USERNAME environment variable is not set");
  if (!password) throw new Error("HRM_PASSWORD environment variable is not set");

  const headlessEnv = process.env.KERNEL_HEADLESS?.trim().toLowerCase();
  const headfulEnv = process.env.KERNEL_HEADFUL?.trim().toLowerCase();
  const headless = headfulEnv === "true" ? false : headlessEnv === "true";

  const kernel = new Kernel({ apiKey });
  const manager = new BrowserManager();

  let sessionId: string | undefined;
  let browserLiveViewUrl: string | undefined;
  let replayId: string | undefined;
  let replayViewUrl: string | undefined;
  let replayError: string | undefined;
  let result: TimeInOutResult | null = null;

  try {
    await withKernelHeadlessEnv(headless, async () => {
      await manager.launch({
        id: "time-in-out",
        action: "launch",
        provider: "kernel",
      });
    });

    sessionId = getKernelSessionId(manager);

    const browser = await kernel.browsers.retrieve(sessionId).catch(() => null);
    browserLiveViewUrl = browser?.browser_live_view_url;

    if (!headless) {
      try {
        const replayStart = await kernel.browsers.replays.start(sessionId);
        replayId = replayStart.replay_id;
        replayViewUrl = replayStart.replay_view_url;
      } catch (error) {
        replayError =
          error instanceof Error ? error.message : `Failed to start replay: ${String(error)}`;
      }
    }

    options.onSessionReady?.({
      browserLiveViewUrl,
      replayId,
      replayViewUrl,
      replayError,
      headless,
    });

    const page = manager.getPage();
    const loginData = await loginToHrm(page, username, password);

    if (!loginData.loggedIn) {
      result = {
        success: false,
        replayId,
        replayViewUrl,
        replayError,
        browserLiveViewUrl,
        headless,
        error: `HRM login failed: ${loginData.error ?? "credentials rejected"}`,
      };
      return result;
    }

    const timeData = await setTimeInOut(page, timeIn, timeOut);
    if (!timeData.success) {
      result = {
        success: false,
        replayId,
        replayViewUrl,
        replayError,
        browserLiveViewUrl,
        headless,
        error: `Time In/Out failed: ${timeData.error ?? "unknown error"}`,
      };
      return result;
    }

    result = timeInOutResultSchema.parse({
      success: true,
      foundTimeInOutButton: timeData.foundTimeInOutButton,
      buttonHtml: timeData.buttonHtml,
      modalHtml: timeData.modalHtml,
      pageUrl: timeData.pageUrl,
      replayId,
      replayViewUrl,
      replayError,
      browserLiveViewUrl,
      headless,
    });
    return result;
  } finally {
    if (sessionId && replayId) {
      try {
        await kernel.browsers.replays.stop(replayId, { id: sessionId });
      } catch (error) {
        replayError ??=
          error instanceof Error ? error.message : `Failed to stop replay: ${String(error)}`;
      }

      try {
        replayViewUrl = await resolveReplayViewUrl(kernel, sessionId, replayId, replayViewUrl);
      } catch (error) {
        replayError ??=
          error instanceof Error ? error.message : `Failed to resolve replay URL: ${String(error)}`;
      }
    }

    await manager.close().catch(() => {
      // Agent Browser may already have closed the Kernel session.
    });
  }

  if (result === null) {
    throw new Error("Kernel automation completed without returning a result");
  }

  return timeInOutResultSchema.parse({
    ...result,
    replayId,
    replayViewUrl,
    replayError,
    browserLiveViewUrl,
    headless,
  });
}
