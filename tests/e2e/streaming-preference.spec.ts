import { expect, test } from "@playwright/test";

import { seedProfile, waitForHydration } from "./support";

test("a user change wins over a pending streaming preference load", async ({ page }) => {
  await seedProfile(page, { streaming: "buffered" });
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const schedule = window.setTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const source = String(handler);
        const streamingLoad = source.includes("STREAMING_PREFERENCE_STORAGE_KEY") ||
          source.includes("streaming-preference");
        if (streamingLoad) {
          (window as Window & { __streamingPreferenceDelayed?: boolean })
            .__streamingPreferenceDelayed = true;
        }
        return schedule(handler, streamingLoad ? 5_000 : timeout, ...args);
      }) as typeof window.setTimeout;
    }, { once: true });
  });
  await page.goto("/");
  await waitForHydration(page);
  expect(await page.evaluate(() =>
    (window as Window & { __streamingPreferenceDelayed?: boolean })
      .__streamingPreferenceDelayed,
  )).toBe(true);

  const panel = page.locator('[aria-label="Run settings"]');
  const disclosure = panel.locator(".inference-settings-toggle");
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  const streaming = panel.getByLabel("Stream response");
  await expect(streaming).toBeChecked();

  await streaming.uncheck();
  await expect(streaming).not.toBeChecked();
  await streaming.check();
  await expect(streaming).toBeChecked();

  // The delayed initialization represents hydration restoring localStorage
  // after the control is already interactive. It must not undo the user's
  // newer choice.
  await page.waitForTimeout(5_200);
  await expect(streaming).toBeChecked();

  await streaming.uncheck();
  const outgoing = page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/inference",
  );
  await page.getByRole("button", { name: /run request/i }).click();
  const body = (await outgoing).postDataJSON() as {
    execution: { input: { responseMode: string } };
  };
  expect(body.execution.input.responseMode).toBe("buffered");
});
