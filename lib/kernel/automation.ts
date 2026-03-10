/**
 * Playwright code generators for HRM (hrm.kalicube.com) automation.
 *
 * Each function returns a code string that executes remotely via
 * kernel.browsers.playwright.execute(). The code has access to
 * `page`, `context`, and `browser` from the Playwright environment.
 *
 * Credentials are embedded via JSON.stringify for safe escaping so
 * special characters never break the generated code string.
 */

/**
 * Generate Playwright code that logs into the WordPress admin at
 * https://hrm.kalicube.com/wp-admin/ using the provided credentials.
 *
 * Returns: { success: boolean; loggedIn: boolean; url: string; error?: string }
 */
export function buildLoginCode(username: string, password: string): string {
  const safeUser = JSON.stringify(username);
  const safePass = JSON.stringify(password);

  return `
    await page.goto('https://hrm.kalicube.com/wp-admin/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Already logged in?
    if (!page.url().includes('/wp-login.php') && page.url().includes('/wp-admin')) {
      return { success: true, loggedIn: true, url: page.url() };
    }

    // Fill WordPress login form
    await page.waitForSelector('#user_login', { timeout: 10000 });
    await page.fill('#user_login', ${safeUser});
    await page.fill('#user_pass', ${safePass});
    await page.click('#wp-submit');

    // Wait for redirect away from login page
    await page.waitForURL(
      (u) => !u.href.includes('/wp-login.php'),
      { timeout: 15000 },
    ).catch(() => {});

    const url = page.url();
    const loggedIn = !url.includes('/wp-login.php');

    if (!loggedIn) {
      // Capture any error message shown on the login page
      const loginError = await page.evaluate(() => {
        const el = document.querySelector('#login_error');
        return el ? el.textContent?.trim() ?? null : null;
      });
      return { success: true, loggedIn: false, url, error: loginError ?? 'Login failed' };
    }

    return { success: true, loggedIn: true, url };
  `;
}

/**
 * Generate Playwright code that navigates to the DailyCheck section,
 * clicks "Time In/Out", fills in 08:00 for time-in and 16:00 for time-out,
 * then saves the entry.
 *
 * Returns: { success: boolean; error?: string }
 */
export function buildTimeInOutCode(timeIn: string, timeOut: string): string {
  const safeTimeIn = JSON.stringify(timeIn);
  const safeTimeOut = JSON.stringify(timeOut);

  return `
    // ── Navigate to DailyCheck ──────────────────────────────────────────────
    // Try the admin menu item first; fall back to a direct URL search.
    const dailyCheckSelectors = [
      '#menu-posts-dailycheck > a',
      'a:has-text("DailyCheck")',
      'a[href*="dailycheck"]',
      'a[href*="daily-check"]',
      'a[href*="daily_check"]',
      '#adminmenu a:has-text("Daily")',
    ];

    let navigatedToDailyCheck = false;
    for (const sel of dailyCheckSelectors) {
      try {
        const el = page.locator(sel);
        if (await el.count() > 0) {
          await el.first().click();
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
          navigatedToDailyCheck = true;
          break;
        }
      } catch {}
    }

    if (!navigatedToDailyCheck) {
      return { success: false, error: 'Could not find DailyCheck menu item. URL: ' + page.url() };
    }

    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // ── Click "Time In/Out" ─────────────────────────────────────────────────
    const timeInOutSelectors = [
      'a:has-text("Time In/Out")',
      'button:has-text("Time In/Out")',
      'a:has-text("Time In")',
      'a[href*="time-in"]',
      'a[href*="timein"]',
      'input[value*="Time In"]',
    ];

    let clickedTimeInOut = false;
    for (const sel of timeInOutSelectors) {
      try {
        const el = page.locator(sel);
        if (await el.count() > 0) {
          await el.first().click();
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
          clickedTimeInOut = true;
          break;
        }
      } catch {}
    }

    if (!clickedTimeInOut) {
      return { success: false, error: 'Could not find Time In/Out button/link. URL: ' + page.url() };
    }

    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);

    // ── Fill time-in field (08:00) ──────────────────────────────────────────
    // WordPress plugins commonly use <input type="time"> or text inputs.
    const timeInSelectors = [
      'input[name*="time_in"]',
      'input[id*="time_in"]',
      'input[placeholder*="Time In" i]',
      'input[placeholder*="time in" i]',
      'input[name*="timein"]',
      'input[id*="timein"]',
      'input[name*="check_in"]',
      'input[id*="check_in"]',
      'input[type="time"]:first-of-type',
    ];

    let timeInFilled = false;
    for (const sel of timeInSelectors) {
      try {
        const el = page.locator(sel);
        if (await el.count() > 0) {
          await el.first().fill(${safeTimeIn});
          timeInFilled = true;
          break;
        }
      } catch {}
    }

    if (!timeInFilled) {
      return { success: false, error: 'Could not find time-in input field. URL: ' + page.url() };
    }

    // ── Fill time-out field (16:00) ─────────────────────────────────────────
    const timeOutSelectors = [
      'input[name*="time_out"]',
      'input[id*="time_out"]',
      'input[placeholder*="Time Out" i]',
      'input[placeholder*="time out" i]',
      'input[name*="timeout"]',
      'input[id*="timeout"]',
      'input[name*="check_out"]',
      'input[id*="check_out"]',
      'input[type="time"]:last-of-type',
    ];

    let timeOutFilled = false;
    for (const sel of timeOutSelectors) {
      try {
        const el = page.locator(sel);
        if (await el.count() > 0) {
          await el.first().fill(${safeTimeOut});
          timeOutFilled = true;
          break;
        }
      } catch {}
    }

    if (!timeOutFilled) {
      return { success: false, error: 'Could not find time-out input field. URL: ' + page.url() };
    }

    await page.waitForTimeout(300);

    // ── Submit / Save ───────────────────────────────────────────────────────
    const submitSelectors = [
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Save")',
      'button:has-text("Submit")',
      'input[value="Save"]',
      'input[value="Submit"]',
      '#publish',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const el = page.locator(sel);
        if (await el.count() > 0) {
          await el.first().click();
          submitted = true;
          break;
        }
      } catch {}
    }

    if (!submitted) {
      return { success: false, error: 'Could not find submit/save button. URL: ' + page.url() };
    }

    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    return { success: true };
  `;
}
