import { expect, test } from "@playwright/test";

import {
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import {
  importProject,
  openMode,
  seedProfile,
  stubProjectDirectory,
  waitForHydration,
} from "./support";

test("a new project does not inherit the open project's saved prompts", async ({ page }) => {
  let existing = createProjectFile({
    name: "Existing project",
    request: {
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:44014/v1",
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Existing project message" }],
    },
    idSuffix: "existing-project",
    createdAt: "2026-08-24T12:00:00.000Z",
  });
  existing = createPromptTemplate(existing, {
    name: "Existing saved prompt",
    messages: [{ role: "user", content: "This belongs only to the existing project." }],
    idSuffix: "existing-prompt",
    revisionIdSuffix: "existing-prompt-1",
    createdAt: "2026-08-24T12:00:01.000Z",
  });

  await seedProfile(page);
  await stubProjectDirectory(page, { name: "projects", files: {} });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, existing, "Existing project");

  await page.getByLabel("Project menu").click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create an Inference Lens project" });
  await dialog.getByLabel("Project name").fill("Fresh project");
  await dialog.getByRole("button", { name: "Choose location…" }).click();

  await expect(page.locator(".topbar")).toContainText("Fresh project");
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: "Prompts 0" }).click();
  await expect(page.getByRole("heading", { name: "No active project prompts" })).toBeVisible();
  await expect(page.getByText("Existing saved prompt", { exact: true })).toHaveCount(0);
});
