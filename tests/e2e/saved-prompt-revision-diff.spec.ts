import { expect, test } from "@playwright/test";

import {
  appendPromptTemplateRevision,
  createProjectFile,
  createPromptTemplate,
} from "../../packages/core/src/project";
import { BUFFERED_FIXTURE_ENDPOINT, importProject, seedProfile, waitForHydration, openMode } from "./support";

test("a historical prompt revision can be edited into a new revision with an exact diff", async ({ page }) => {
  let project = createProjectFile({
    name: "Saved prompt revision fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "saved-prompt-revision",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "triage",
    createdAt: "2026-08-06T12:00:01.000Z",
  });
  const firstRevisionId = project.promptTemplates[0]!.currentRevisionId;
  project = appendPromptTemplateRevision(project, {
    templateId: project.promptTemplates[0]!.id,
    messages: [{ role: "user", content: "Triage {{incident}} carefully." }],
    variableDefaults: { incident: "latency" },
    createdAt: "2026-08-06T12:00:02.000Z",
    idSuffix: "triage-2",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved prompt revision fixture");
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Prompts/ }).click();

  const editor = page.locator(".template-editor");
  const diff = editor.getByRole("region", { name: "Revision diff" });
  const diffToggle = diff.getByRole("button", { name: /Revision diff/ });

  await expect(editor.getByRole("button", { name: "Edit as new revision" })).toHaveCount(0);
  // Editing the current draft: the diff starts collapsed, not competing with the editor.
  await expect(diffToggle).toHaveAttribute("aria-expanded", "false");

  await editor.locator(".template-revision-field select").selectOption(firstRevisionId);
  await expect(editor).toContainText("Read-only revision");
  await expect(editor).toContainText(
    "Copies this revision into an editable draft. Nothing changes until you save.",
  );
  // Browsing a historical revision is history-inspection intent: opens by default.
  await expect(diffToggle).toHaveAttribute("aria-expanded", "true");

  await editor.getByRole("button", { name: "Edit as new revision" }).click();
  await expect(editor.getByRole("button", { name: "Edit as new revision" })).toHaveCount(0);
  await expect(editor).not.toContainText(
    "Copies this revision into an editable draft. Nothing changes until you save.",
  );
  // Editing state collapses it again.
  await expect(diffToggle).toHaveAttribute("aria-expanded", "false");

  await editor.getByLabel("Prompt content").fill("Triage {{incident}} for the on-call engineer.");
  await editor.getByLabel("{{incident}}").fill("database outage");
  await editor.getByRole("button", { name: "Create revision", exact: true }).click();

  // A save forces the diff open once, to confirm what just changed.
  await expect(diffToggle).toHaveAttribute("aria-expanded", "true");
  await expect(diffToggle).toContainText("vs Revision 1");
  await expect(diff).toContainText("Triage {{incident}}.");
  await expect(diff).toContainText("Triage {{incident}} for the on-call engineer.");
  await expect(diff).toContainText("timeout → database outage");

  await editor.locator(".template-revision-field select").selectOption(firstRevisionId);
  await expect(editor.getByLabel("Prompt content")).toHaveValue("Triage {{incident}}.");
  await expect(editor.getByLabel("{{incident}}")).toHaveValue("timeout");
});

test("prompt drafts and checkpoint names survive library navigation", async ({ page }) => {
  let project = createProjectFile({
    name: "Saved prompt autosave fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "saved-prompt-autosave",
    createdAt: "2026-08-11T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "autosave-triage",
    revisionIdSuffix: "autosave-triage-1",
    createdAt: "2026-08-11T12:00:01.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Summary",
    messages: [{ role: "user", content: "Summarize this." }],
    idSuffix: "autosave-summary",
    revisionIdSuffix: "autosave-summary-1",
    createdAt: "2026-08-11T12:00:02.000Z",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved prompt autosave fixture");
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Prompts/ }).click();

  const editor = page.locator(".template-editor");
  await editor.getByLabel("Prompt content").fill("Triage {{incident}} without jargon.");
  await editor.getByLabel("{{incident}}").fill("database outage");
  await editor.getByLabel("Revision name").fill("Make triage concise");
  await expect(editor).toContainText("Draft kept in this session");

  await page.locator(".template-list-item", { hasText: "Summary" }).click();
  await page.locator(".template-list-item", { hasText: "Incident triage" }).click();

  await expect(editor.locator(".template-revision-field select")).toHaveValue("draft");
  await expect(editor.getByLabel("Prompt content")).toHaveValue("Triage {{incident}} without jargon.");
  await expect(editor.getByLabel("{{incident}}")).toHaveValue("database outage");
  await expect(editor.getByLabel("Revision name")).toHaveValue("Make triage concise");

  await editor.getByRole("button", { name: "Create revision", exact: true }).click();
  await expect(editor.locator(".template-revision-field select option").first()).toContainText(
    "Make triage concise",
  );
  await expect(editor.locator(".template-revision-field select")).not.toHaveValue("draft");
});

test("adding an autosaved prompt draft creates and pins that draft", async ({ page }) => {
  let project = createProjectFile({
    name: "Saved prompt insertion fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Existing conversation message" }],
    },
    idSuffix: "saved-prompt-insertion",
    createdAt: "2026-08-24T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Draft insertion",
    messages: [{ role: "user", content: "Example prompt content" }],
    idSuffix: "draft-insertion",
    revisionIdSuffix: "draft-insertion-1",
    createdAt: "2026-08-24T12:00:01.000Z",
  });

  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved prompt insertion fixture");
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Prompts/ }).click();

  const editor = page.locator(".template-editor");
  await editor.getByLabel("Prompt content").fill("The autosaved draft content");
  await editor.getByRole("button", { name: "Create revision and add" }).click();

  await expect(page.getByRole("tab", { name: /Messages/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".template-use-card")).toContainText(
    "The autosaved draft content",
  );
  await expect(page.locator(".template-use-card")).not.toContainText(
    "Example prompt content",
  );
});

test("the prompt header keeps its metadata controls usable beside revision actions", async ({ page }) => {
  let project = createProjectFile({
    name: "Saved prompt header fixture",
    request: {
      provider: "openai-compatible",
      endpoint: BUFFERED_FIXTURE_ENDPOINT,
      model: "buffered-test-model",
      messages: [{ role: "user", content: "Hello" }],
    },
    idSuffix: "saved-prompt-header",
    createdAt: "2026-08-06T12:00:00.000Z",
  });
  project = createPromptTemplate(project, {
    name: "Incident triage",
    messages: [{ role: "user", content: "Triage {{incident}}." }],
    variableDefaults: { incident: "timeout" },
    idSuffix: "triage",
    createdAt: "2026-08-06T12:00:01.000Z",
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await seedProfile(page, { instanceId: "profile-instance-buffered" });
  await page.goto("/");
  await waitForHydration(page);
  await importProject(page, project, "Saved prompt header fixture");
  await openMode(page, "Compose");
  await page.getByRole("tab", { name: /Prompts/ }).click();

  const editor = page.locator(".template-editor");
  const header = editor.locator(".template-editor-header");
  const promptName = editor.getByLabel("Prompt name");
  const revision = editor.locator(".template-revision-field select");
  const actions = editor.locator(".template-editor-actions");

  await expect(promptName).toBeInViewport();
  await expect(revision).toBeInViewport();

  const layout = await Promise.all([
    header.boundingBox(),
    promptName.boundingBox(),
    revision.boundingBox(),
    actions.boundingBox(),
  ]);
  const [headerBox, promptNameBox, revisionBox, actionsBox] = layout;
  expect(headerBox).not.toBeNull();
  expect(promptNameBox?.width).toBeGreaterThanOrEqual(160);
  expect(revisionBox?.width).toBeGreaterThanOrEqual(160);
  expect(actionsBox?.x).toBeGreaterThanOrEqual(headerBox!.x);
  expect(actionsBox!.x + actionsBox!.width).toBeLessThanOrEqual(
    headerBox!.x + headerBox!.width,
  );
});
