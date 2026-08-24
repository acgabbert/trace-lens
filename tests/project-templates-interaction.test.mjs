import assert from "node:assert/strict";
import test, { after } from "node:test";

import { JSDOM } from "jsdom";
import { ssrLoadModule } from "./support/ssr.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLButtonElement: dom.window.HTMLButtonElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});

after(() => dom.window.close());

const template = {
  id: "template_question",
  name: "Question",
  currentRevisionId: "template-revision_question-1",
  revisions: [
    {
      id: "template-revision_question-1",
      createdAt: "2026-07-31T12:00:00.000Z",
      messages: [{ role: "user", content: "Explain {{topic}}." }],
      variableDefaults: { topic: "branching" },
    },
  ],
};

const templateTwo = {
  id: "template_summary",
  name: "Summary",
  currentRevisionId: "template-revision_summary-1",
  revisions: [
    {
      id: "template-revision_summary-1",
      createdAt: "2026-07-31T12:00:00.000Z",
      messages: [{ role: "user", content: "Summarize {{topic}}." }],
      variableDefaults: {},
    },
  ],
};

async function mount(overrides = {}) {
  const [{ createElement, act }, { createRoot }, { ProjectTemplatesPane }] =
    await Promise.all([
      import("react"),
      import("react-dom/client"),
      ssrLoadModule("/app/project-templates-pane.client.tsx"),
    ]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const noop = () => {};
  await act(async () => {
    root.render(
      createElement(ProjectTemplatesPane, {
        templates: [template],
        connectionRequirements: [],
        usageCounts: new Map(),
        itemCount: 0,
        onOpenN8nImport: noop,
        onCreate: () => "template_new",
        onDraftChange: noop,
        onRecommendedTargetChange: noop,
        onSave: () => template.currentRevisionId,
        onSaveAndInsert: () => template.currentRevisionId,
        onRename: () => true,
        onArchive: (templateId, onArchived) => onArchived?.(),
        onRestore: noop,
        onInsert: noop,
        ...overrides,
      }),
    );
  });
  return {
    act,
    container,
    async click(element) {
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });
    },
    async keydown(key, options = {}) {
      await act(async () => {
        window.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key,
            ...options,
          }),
        );
      });
    },
    async type(input, value) {
      await act(async () => {
        const prototype = input instanceof dom.window.HTMLTextAreaElement
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(
          prototype,
          "value",
        ).set;
        setter.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async blur(element) {
      // React 17+ implements onBlur via the bubbling "focusout" event, not
      // the native non-bubbling "blur" — dispatch the event React listens
      // for so the synthetic handler actually fires.
      await act(async () => {
        element.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
      });
    },
    async settle() {
      await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));
    },
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("starts as one user prompt and reveals message controls on demand", async () => {
  const view = await mount();
  try {
    assert.ok(view.container.querySelector('textarea[aria-label="Prompt content"]'));
    assert.equal(
      view.container.querySelectorAll('[aria-label^="Prompt message"][aria-label$="role"]').length,
      0,
    );
    const addSystem = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Add system instructions"),
    );
    const addMessage = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "+ Add message",
    );
    assert.ok(addSystem);
    assert.ok(addMessage);

    await view.click(addSystem);
    const roleSelectors = view.container.querySelectorAll(
      '[aria-label^="Prompt message"][aria-label$="role"]',
    );
    assert.equal(roleSelectors.length, 2);
    assert.deepEqual(
      [...roleSelectors].map((select) => select.value),
      ["system", "user"],
    );
    assert.equal(
      view.container.querySelector('textarea[aria-label="Prompt message 1 content"]')?.value,
      "",
    );
    assert.equal(
      view.container.querySelector('textarea[aria-label="Prompt message 2 content"]')?.value,
      "Explain {{topic}}.",
    );

    const removeSystem = view.container.querySelector(
      ".template-message-editor .remove-button",
    );
    assert.ok(removeSystem);
    await view.click(removeSystem);
    assert.ok(view.container.querySelector('textarea[aria-label="Prompt content"]'));
  } finally {
    await view.close();
  }
});

test("focus mode expands the live editor and restores focus when dismissed", async () => {
  const view = await mount();
  try {
    const expand = view.container.querySelector(
      '[aria-label="Open prompt editor in focus mode"]',
    );
    assert.ok(expand);

    await view.click(expand);
    await view.settle();

    const dialog = view.container.querySelector(
      '[role="dialog"][aria-label="Prompt editor focus mode"]',
    );
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-modal"), "true");
    assert.ok(dialog.classList.contains("focus-mode-surface"));
    assert.ok(dialog.classList.contains("template-editor-focus-mode"));
    assert.equal(document.body.style.overflow, "hidden");
    assert.equal(
      document.activeElement,
      dialog.querySelector('textarea[aria-label="Prompt content"]'),
    );
    const close = dialog.querySelector(
      '[aria-label="Exit prompt editor focus mode"]',
    );
    assert.ok(close);
    assert.equal(close.textContent, "×");

    await view.keydown("Escape");
    await view.settle();

    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(document.body.style.overflow, "");
    assert.equal(
      document.activeElement,
      view.container.querySelector(
        '[aria-label="Open prompt editor in focus mode"]',
      ),
    );
  } finally {
    await view.close();
  }
});

test("focus mode has an explicit close button", async () => {
  const view = await mount();
  try {
    await view.click(
      view.container.querySelector(
        '[aria-label="Open prompt editor in focus mode"]',
      ),
    );
    await view.settle();

    const close = view.container.querySelector(
      '[aria-label="Exit prompt editor focus mode"]',
    );
    assert.ok(close);
    await view.click(close);
    await view.settle();

    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(document.body.style.overflow, "");
    // Dismissing with the pointer restores focus exactly as Escape does.
    assert.equal(
      document.activeElement,
      view.container.querySelector(
        '[aria-label="Open prompt editor in focus mode"]',
      ),
    );
  } finally {
    await view.close();
  }
});

test("focus mode traps keyboard focus within the editor", async () => {
  const view = await mount();
  try {
    await view.click(
      view.container.querySelector(
        '[aria-label="Open prompt editor in focus mode"]',
      ),
    );
    await view.settle();

    const dialog = view.container.querySelector('[role="dialog"]');
    const focusable = dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const last = focusable[focusable.length - 1];
    last.focus();
    await view.keydown("Tab");

    assert.equal(document.activeElement, focusable[0]);
  } finally {
    await view.close();
  }
});

test("persists a renamed template as it is typed without requiring a revision", async () => {
  const renamed = [];
  const view = await mount({
    onRename: (templateId, name) => {
      renamed.push([templateId, name]);
      return true;
    },
  });
  try {
    const nameInput = view.container.querySelector(".template-name-field input");
    assert.equal(nameInput.value, "Question");

    await view.type(nameInput, "Explain it simply");
    await view.blur(nameInput);

    assert.deepEqual(renamed, [["template_question", "Explain it simply"]]);
  } finally {
    await view.close();
  }
});

test("does not commit an unchanged or blank name on blur", async () => {
  const renamed = [];
  const view = await mount({
    onRename: (templateId, name) => {
      renamed.push([templateId, name]);
      return true;
    },
  });
  try {
    const nameInput = view.container.querySelector(".template-name-field input");

    // Blurring without editing should not fire a rename.
    await view.blur(nameInput);
    assert.deepEqual(renamed, []);

    // A blank name is left uncommitted rather than saved empty.
    await view.type(nameInput, "   ");
    await view.blur(nameInput);
    assert.deepEqual(renamed, []);
  } finally {
    await view.close();
  }
});

test("persists prompt content as a draft before navigating to another prompt", async () => {
  const drafts = [];
  const view = await mount({
    templates: [template, templateTwo],
    onDraftChange: (...args) => drafts.push(args),
  });
  try {
    const content = view.container.querySelector('textarea[aria-label="Prompt content"]');
    await view.type(content, "Explain {{topic}} without jargon.");
    await view.click([...view.container.querySelectorAll(".template-list-item")].find(
      (button) => button.textContent.includes("Summary"),
    ));

    assert.equal(drafts.length, 1);
    assert.equal(drafts[0][0], "template_question");
    assert.equal(drafts[0][1], "template-revision_question-1");
    assert.equal(drafts[0][2][0].content, "Explain {{topic}} without jargon.");
  } finally {
    await view.close();
  }
});

test("creates a checkpoint with an optional revision name", async () => {
  const saves = [];
  const view = await mount({
    templates: [{
      ...template,
      draft: {
        sourceRevisionId: template.currentRevisionId,
        messages: [{ role: "user", content: "Explain {{topic}} clearly." }],
        variableDefaults: { topic: "branching" },
      },
    }],
    onSave: (...args) => {
      saves.push(args);
      return "template-revision_question-2";
    },
  });
  try {
    const revisionName = view.container.querySelector('input[aria-label="Revision name"]');
    assert.ok(revisionName);
    await view.type(revisionName, "Clarify the request");
    await view.click([...view.container.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Create revision",
    ));

    assert.equal(saves.length, 1);
    assert.equal(saves[0].at(-1), "Clarify the request");
  } finally {
    await view.close();
  }
});

test("creates a revision before adding an autosaved draft to the conversation", async () => {
  const savesAndInserts = [];
  const view = await mount({
    templates: [{
      ...template,
      draft: {
        sourceRevisionId: template.currentRevisionId,
        messages: [{ role: "user", content: "Explain {{topic}} clearly." }],
        variableDefaults: { topic: "branching" },
      },
    }],
    onSaveAndInsert: (...args) => {
      savesAndInserts.push(args);
      return "template-revision_question-2";
    },
  });
  try {
    const insert = view.container.querySelector(".template-insert-bar button");
    assert.equal(insert?.textContent.trim(), "Create revision and add");

    await view.click(insert);

    assert.equal(savesAndInserts.length, 1);
    assert.equal(savesAndInserts[0][0], template.id);
    assert.deepEqual(savesAndInserts[0][2], [
      { role: "user", content: "Explain {{topic}} clearly." },
    ]);
    assert.equal(savesAndInserts[0].at(-1), 0);
  } finally {
    await view.close();
  }
});

test("archiving stays on the Active tab and selects a remaining active template", async () => {
  const view = await mount({ templates: [template, templateTwo] });
  try {
    const activeTab = () => view.container.querySelector(".template-library-tab.selected");
    const archiveLink = () => view.container.querySelector(".template-library-archive-link.selected");
    assert.ok(activeTab()?.textContent.startsWith("Active"));
    assert.equal(archiveLink(), null);

    const archiveButton = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Archive",
    );
    assert.ok(archiveButton);
    await view.click(archiveButton);

    // Still on the Active tab: an archive action never reads as "your prompts
    // are gone" by dropping the author into the Archived view.
    assert.ok(activeTab()?.textContent.startsWith("Active"));
    assert.equal(archiveLink(), null);

    // Selection falls through to the other active template instead of
    // leaving the now-archived one showing (or an empty state) behind.
    const nameInput = view.container.querySelector(".template-name-field input");
    assert.equal(nameInput.value, "Summary");
  } finally {
    await view.close();
  }
});

test("the Archived toggle reads as a quiet secondary control, not a peer tab", async () => {
  const view = await mount();
  try {
    const activeTab = view.container.querySelector(".template-library-tab");
    const archiveLink = view.container.querySelector(".template-library-archive-link");
    assert.ok(activeTab);
    assert.ok(archiveLink);
    // The two controls are visually distinct classes, not the same segmented
    // "tab" styling applied to both sides.
    assert.notEqual(activeTab.className, archiveLink.className);
    assert.ok(!archiveLink.className.includes("template-library-tab"));
  } finally {
    await view.close();
  }
});
