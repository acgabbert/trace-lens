import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { extractN8nPromptCandidates } from "../../services/api/src/n8n-prompt-extractors.ts";
import { seedProfile, waitForHydration } from "./support";

test("keeps a specific n8n expression issue visible beside the import action", async ({ page }) => {
  const fixtureRoot = path.resolve(
    import.meta.dirname,
    "../fixtures/n8n/captures/2.32.5/basic-llm-chain-success",
  );
  const execution = JSON.parse(
    await readFile(path.join(fixtureRoot, "execution-success.json"), "utf8"),
  );
  const workflow = JSON.parse(
    await readFile(path.join(fixtureRoot, "workflow.json"), "utf8"),
  );
  const node = execution.data.workflowData.nodes.find(
    ({ name }: { name: string }) => name === "Compound prompt cases",
  );
  node.parameters.text = `=Before {{ $json.topic\n${"More context. ".repeat(300)}`;
  const runData = execution.data.resultData.runData;
  runData["Compound prompt cases"][0].data.main[0] =
    runData["Compound prompt cases"][0].data.main[0].slice(0, 1);
  runData["Fixture OpenAI Chat Model"] =
    runData["Fixture OpenAI Chat Model"].slice(0, 1);
  const extractions = await extractN8nPromptCandidates(execution);
  const selected = extractions.find(
    (extraction) =>
      extraction.status === "candidate" &&
      extraction.candidate.invocation.name === "Compound prompt cases",
  );
  expect(selected?.status).toBe("candidate");

  await page.route("**/api/integrations/n8n/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/status")) {
      await route.fulfill({ json: { state: "configured" } });
    } else if (pathname.endsWith("/workflows")) {
      await route.fulfill({
        json: {
          workflows: [{ id: workflow.id, name: workflow.name, active: true }],
        },
      });
    } else if (pathname.endsWith("/executions")) {
      await route.fulfill({
        json: {
          executions: [{
            id: execution.id,
            workflowId: execution.workflowId,
            status: execution.status,
            startedAt: execution.startedAt,
          }],
        },
      });
    } else {
      await route.fulfill({
        json: {
          execution: {
            id: execution.id,
            workflowId: execution.workflowId,
            status: execution.status,
            startedAt: execution.startedAt,
          },
          detailAvailability: "full",
          discovery: { status: "ready" },
          extractions: [selected],
        },
      });
    }
  });

  await seedProfile(page);
  await page.goto("/");
  await waitForHydration(page);
  await page.getByRole("tab", { name: "Prompts" }).click();
  await page.getByRole("button", { name: "Import prompt from n8n…" }).click();

  const dialog = page.getByRole("dialog", { name: "Import from n8n" });
  await dialog.getByRole("button", { name: workflow.name }).click();
  await dialog.getByRole("button", { name: /success/i }).click();

  await expect(dialog.getByRole("tab", { name: /Warnings/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog.getByText(/Expression issue ·/)).toBeVisible();
  const issue = dialog.getByRole("alert");
  await expect(issue).toContainText("parameters.text at character 8");
  await expect(issue).toContainText("missing its closing }} delimiter");

  await dialog.locator(".n8n-import-review").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(issue).toBeInViewport();
  await expect(dialog.getByRole("button", { name: "Import resolved snapshot" }))
    .toBeVisible();
});
