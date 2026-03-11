/**
 * Kernel.sh browser automation client for HRM time-tracking.
 *
 * Uses Agent Browser's native Kernel provider to launch and control a Kernel
 * browser session, while still using the Kernel SDK for session metadata and
 * replay management.
 */

import Kernel from "@onkernel/sdk";
import { BrowserManager } from "agent-browser/dist/browser.js";
import type { Locator } from "playwright-core";
import {
  inspectExecutionResultSchema,
  loginExecutionResultSchema,
  timeInOutResultSchema,
  type InspectExecutionResult,
  type LoginExecutionResult,
  type TimeInOutResult,
} from "@/lib/time-in-out";

const DAILY_CHECK_URL = "https://hrm.kalicube.com/wp-admin/admin.php?page=hrm-dailycheck-app";
const LOGIN_URL_MARKERS = ["/wp-login", "/hr-login"];
const TUNNEL_CONNECTION_ERROR_MARKER = "ERR_TUNNEL_CONNECTION_FAILED";

/**
 * Ordered list of CSS selectors used to locate the login form.
 * The first matching selector wins.
 */
const LOGIN_FORM_SELECTORS = [
  'form#loginform',
  'form[name="loginform"]',
  'form#login-form',
  'form.login-form',
  'form[action*="wp-login.php"]',
  'form[action*="hr-login"]',
];

/**
 * Ordered list of CSS selectors for the username / email field.
 */
const USERNAME_FIELD_SELECTORS = [
  '#user_login',
  'input[name="log"]',
  'input[name="username"]',
  'input[name="user_login"]',
  'input[id*="user_login"]',
  'input[id*="username"]',
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[type="text"][name*="user"]',
  'input[type="text"][id*="user"]',
];

/**
 * Ordered list of CSS selectors for the password field.
 */
const PASSWORD_FIELD_SELECTORS = [
  '#user_pass',
  'input[name="pwd"]',
  'input[name="password"]',
  'input[name="user_pass"]',
  'input[id*="user_pass"]',
  'input[autocomplete="current-password"]',
  'input[type="password"]',
];

/**
 * Ordered list of CSS selectors for the login submit button.
 */
const SUBMIT_BUTTON_SELECTORS = [
  '#wp-submit',
  'input[type="submit"]',
  'button[type="submit"]',
  '.login-submit input',
  '.login-submit button',
  'button.submit',
];

/**
 * CSS selector for login error / feedback messages shown after a failed attempt.
 */
const LOGIN_ERROR_SELECTOR =
  "#login_error, .login-error, .notice-error, .woocommerce-error, .message, .login-message, .alert-danger, .alert-error";

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

interface RunTimeInOutAttemptOptions extends RunTimeInOutOptions {
  apiKey: string;
  username: string;
  password: string;
  headless: boolean;
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

function isTunnelConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(TUNNEL_CONNECTION_ERROR_MARKER);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTunnelErrorGuidance(message: string): string {
  return `${message} Kernel could not open the target URL through its current network path. Try running headless, verify there is no proxy attached to the Kernel browser session, and retry with a fresh session.`;
}

async function runTimeInOutAttempt(
  timeIn: string,
  timeOut: string,
  { apiKey, username, password, headless, onSessionReady }: RunTimeInOutAttemptOptions,
): Promise<TimeInOutResult> {
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

    onSessionReady?.({
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
        loginFormHtml: loginData.loginFormHtml,
        loginErrorHtml: loginData.loginErrorHtml,
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
        loginFormHtml: null,
        loginErrorHtml: null,
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
}

/**
 * Find the first visible locator from an ordered list of CSS selectors,
 * scoped within a given parent locator.
 */
async function findFirstLocator(
  parent: Locator,
  selectors: string[],
): Promise<Locator | null> {
  for (const selector of selectors) {
    const loc = parent.locator(selector).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      return loc;
    }
  }
  return null;
}

async function loginToHrm(
  page: Awaited<ReturnType<BrowserManager["getPage"]>>,
  username: string,
  password: string,
): Promise<LoginExecutionResult> {
  await page.goto(DAILY_CHECK_URL, {
    waitUntil: "commit",
    timeout: 25000,
  });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  let currentUrl = page.url();
  if (currentUrl.includes("page=hrm-dailycheck-app")) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: true,
      url: currentUrl,
      loginFormHtml: null,
      loginErrorHtml: null,
    });
  }

  const isLoginPage = LOGIN_URL_MARKERS.some((marker) => currentUrl.includes(marker));
  if (!isLoginPage) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      loginFormHtml: null,
      loginErrorHtml: null,
      error: `Expected a login page redirect but landed on an unexpected URL: ${currentUrl}`,
    });
  }

  // Wait for any of the known login form selectors to appear.
  const combinedFormSelector = LOGIN_FORM_SELECTORS.join(", ");
  await page.waitForSelector(combinedFormSelector, { timeout: 15000 }).catch(() => {});
  // Give JavaScript-driven forms a moment to fully initialise.
  await page.waitForTimeout(500);

  const loginForm = page.locator(combinedFormSelector).first();
  if ((await loginForm.count().catch(() => 0)) === 0) {
    const pageHtml = await page.content().catch(() => null);
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      loginFormHtml: pageHtml,
      loginErrorHtml: null,
      error: `Could not find a login form on ${currentUrl}. Tried selectors: ${combinedFormSelector}`,
    });
  }

  const loginFormHtml = await loginForm.evaluate((node) => node.outerHTML).catch(() => null);

  const userField = await findFirstLocator(loginForm, USERNAME_FIELD_SELECTORS);
  if (!userField) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      loginFormHtml,
      loginErrorHtml: null,
      error: `Could not find a username/email field on ${currentUrl}. Tried selectors: ${USERNAME_FIELD_SELECTORS.join(", ")}`,
    });
  }

  const passwordField = await findFirstLocator(loginForm, PASSWORD_FIELD_SELECTORS);
  if (!passwordField) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      loginFormHtml,
      loginErrorHtml: null,
      error: `Could not find a password field on ${currentUrl}. Tried selectors: ${PASSWORD_FIELD_SELECTORS.join(", ")}`,
    });
  }

  await userField.fill(username);
  await passwordField.fill(password);

  const redirectField = loginForm.locator('input[name="redirect_to"]').first();
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

  const submitButton = await findFirstLocator(loginForm, SUBMIT_BUTTON_SELECTORS);
  if (!submitButton) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: false,
      url: currentUrl,
      loginFormHtml,
      loginErrorHtml: null,
      error: `Could not find a submit button on ${currentUrl}. Tried selectors: ${SUBMIT_BUTTON_SELECTORS.join(", ")}`,
    });
  }

  const waitForLoginResponse = () =>
    page
      .waitForResponse(
        (response) => {
          if (response.request().method() !== "POST") {
            return false;
          }

          return LOGIN_URL_MARKERS.some((marker) => response.url().includes(marker));
        },
        { timeout: 12000 },
      )
      .catch(() => null);

  let loginResponsePromise = waitForLoginResponse();
  await submitButton.click({ force: true }).catch(() => {});
  let loginResponse = await loginResponsePromise;

  if (!loginResponse) {
    loginResponsePromise = waitForLoginResponse();
    await loginForm
      .evaluate((form) => {
        const htmlForm = form as HTMLFormElement;
        if (typeof htmlForm.requestSubmit === "function") {
          htmlForm.requestSubmit();
          return;
        }

        htmlForm.submit();
      })
      .catch(() => {});
    loginResponse = await loginResponsePromise;
  }

  await page
    .waitForURL(
      (url) =>
        url.href.includes("page=hrm-dailycheck-app") ||
        LOGIN_URL_MARKERS.every((marker) => !url.href.includes(marker)),
      { timeout: 20000 },
    )
    .catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  currentUrl = page.url();
  if (currentUrl.includes("page=hrm-dailycheck-app")) {
    return loginExecutionResultSchema.parse({
      success: true,
      loggedIn: true,
      url: currentUrl,
      loginFormHtml,
      loginErrorHtml: null,
    });
  }

  const loginState = await page
    .evaluate((selectors) => {
      const errorNode = document.querySelector(selectors.error);
      const formNode = document.querySelector(selectors.form);
      const title = document.title?.trim() || null;

      return {
        errorText: errorNode ? (errorNode.textContent || "").trim() : null,
        errorHtml: errorNode ? errorNode.outerHTML : null,
        formHtml: formNode ? formNode.outerHTML : null,
        title,
      };
    }, { error: LOGIN_ERROR_SELECTOR, form: combinedFormSelector })
    .catch(() => ({ errorText: null, errorHtml: null, formHtml: null, title: null }));

  const detailParts = [
    loginState.errorText,
    loginResponse ? `login response status ${loginResponse.status()}` : null,
    loginResponse ? `login response url ${loginResponse.url()}` : null,
    loginState.title ? `page title: ${loginState.title}` : null,
    `current url: ${currentUrl}`,
  ].filter(Boolean);

  return loginExecutionResultSchema.parse({
    success: true,
    loggedIn: false,
    url: currentUrl,
    loginFormHtml: loginState.formHtml ?? loginFormHtml,
    loginErrorHtml: loginState.errorHtml,
    error: detailParts.length > 0 ? detailParts.join(" | ") : "Login failed.",
  });
}

async function setTimeInOut(
  page: Awaited<ReturnType<BrowserManager["getPage"]>>,
  timeIn: string,
  timeOut: string,
): Promise<InspectExecutionResult> {
  if (!page.url().includes("page=hrm-dailycheck-app")) {
    await page.goto(DAILY_CHECK_URL, {
      waitUntil: "commit",
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
  const ajaxResponse = await ajaxResponsePromise;

  if (!ajaxResponse) {
    return inspectExecutionResultSchema.parse({
      success: false,
      foundTimeInOutButton: true,
      buttonHtml,
      modalHtml,
      pageUrl: page.url(),
      error: "The save request was never sent after clicking the Time In/Out submit button.",
    });
  }

  if (!ajaxResponse.ok()) {
    return inspectExecutionResultSchema.parse({
      success: false,
      foundTimeInOutButton: true,
      buttonHtml,
      modalHtml,
      pageUrl: page.url(),
      error: `The save request failed with status ${ajaxResponse.status()}.`,
    });
  }

  const ajaxResponseText = (await ajaxResponse.text().catch(() => "")).trim();
  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const pageFeedback = await page
    .evaluate(() => {
      const selectors = [
        ".notice-error",
        ".alert-danger",
        ".swal2-container .swal2-popup",
        ".toast-error",
        ".woocommerce-error",
      ];

      for (const selector of selectors) {
        const node = document.querySelector(selector);
        const text = node?.textContent?.trim();
        if (text) {
          return text;
        }
      }

      return null;
    })
    .catch(() => null);

  if (pageFeedback) {
    return inspectExecutionResultSchema.parse({
      success: false,
      foundTimeInOutButton: true,
      buttonHtml,
      modalHtml,
      pageUrl: page.url(),
      error: pageFeedback,
    });
  }

  if (
    ajaxResponseText &&
    /error|failed|invalid|denied|forbidden/i.test(ajaxResponseText) &&
    ajaxResponseText !== "1"
  ) {
    return inspectExecutionResultSchema.parse({
      success: false,
      foundTimeInOutButton: true,
      buttonHtml,
      modalHtml,
      pageUrl: page.url(),
      error: `The save request returned an error response: ${ajaxResponseText}`,
    });
  }

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

  try {
    return await runTimeInOutAttempt(timeIn, timeOut, {
      apiKey,
      username,
      password,
      headless,
      ...options,
    });
  } catch (error) {
    if (!headless && isTunnelConnectionError(error)) {
      try {
        return await runTimeInOutAttempt(timeIn, timeOut, {
          apiKey,
          username,
          password,
          headless: true,
          ...options,
        });
      } catch (retryError) {
        return timeInOutResultSchema.parse({
          success: false,
          loginFormHtml: null,
          loginErrorHtml: null,
          headless: true,
          error: withTunnelErrorGuidance(
            `Initial headful session failed with ${TUNNEL_CONNECTION_ERROR_MARKER}, and the automatic headless retry also failed: ${toErrorMessage(retryError)}.`,
          ),
        });
      }
    }

    if (isTunnelConnectionError(error)) {
      return timeInOutResultSchema.parse({
        success: false,
        loginFormHtml: null,
        loginErrorHtml: null,
        headless,
        error: withTunnelErrorGuidance(toErrorMessage(error)),
      });
    }

    throw error;
  }
}
