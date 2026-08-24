"use client";

import { useMemo, useRef, useState } from "react";

import type {
  ConnectionRequirement,
  ExternalImportReceipt,
  ProjectTemplateDiagnostic,
  PromptTemplate,
  PromptTemplateMessages,
  PromptTemplateRecommendedTarget,
  PromptTemplateUse,
  EvaluationSuite,
} from "../packages/core/src/project";
import { isSensitiveTemplateVariableName } from "../packages/core/src/project";
import type {
  PromptTemplateId,
  PromptTemplateRevisionId,
} from "../packages/core/src/run-kernel";
import {
  discoverTemplateVariables,
  resolveTemplateValues,
} from "../packages/core/src/template-engine";
import { diffPromptTemplateRevisions } from "../packages/core/src/prompt-template-revision-diff";
import { describeCompatibleSuiteRevision, promptRevisionLabel, summarizeRevisionDiff } from "./templates/prompt-revision-label";
import { DisclosureChevron } from "./disclosure-chevron.client";
import { FocusModeToggle, useFocusMode } from "./focus-mode.client";
import { N8nTemplatePasteDialog } from "./templates/n8n-template-paste-dialog.client";
import { shouldSuggestN8nTemplatePaste } from "./templates/n8n-template-paste";
import { n8nPasteSuggestionsEnabled, setN8nPasteSuggestionsEnabled } from "./templates/n8n-template-paste-preference.client";

type TemplateRole = "system" | "user" | "assistant";

export interface CompatibleEvaluationSuite {
  suite: EvaluationSuite;
  /** The template revision this suite's currently pinned input uses. */
  pinnedRevisionId: PromptTemplateRevisionId;
}

interface ProjectTemplatesPaneProps {
  templates: PromptTemplate[];
  connectionRequirements: ConnectionRequirement[];
  defaultConnectionRequirementId?: ConnectionRequirement["id"];
  usageCounts: ReadonlyMap<PromptTemplateId, number>;
  itemCount: number;
  persistenceStatus?: "saving" | "saved" | "session" | "error";
  n8nImportDisabledReason?: string;
  onOpenN8nImport(): void;
  onCreate(name: string, messages: PromptTemplateMessages): PromptTemplateId;
  onSave(
    templateId: PromptTemplateId,
    name: string,
    messages: PromptTemplateMessages,
    defaults: Record<string, string>,
    recommendedTarget?: PromptTemplateRecommendedTarget,
    revisionName?: string,
  ): PromptTemplateRevisionId;
  onSaveAndInsert(
    templateId: PromptTemplateId,
    name: string,
    messages: PromptTemplateMessages,
    defaults: Record<string, string>,
    recommendedTarget: PromptTemplateRecommendedTarget | undefined,
    revisionName: string | undefined,
    itemIndex: number,
  ): PromptTemplateRevisionId;
  onDraftChange(
    templateId: PromptTemplateId,
    sourceRevisionId: PromptTemplateRevisionId,
    messages: PromptTemplateMessages,
    defaults: Record<string, string>,
    revisionName?: string,
  ): void;
  onRecommendedTargetChange(
    templateId: PromptTemplateId,
    recommendedTarget?: PromptTemplateRecommendedTarget,
  ): void;
  onRename(templateId: PromptTemplateId, name: string): boolean;
  onArchive(templateId: PromptTemplateId, onArchived?: () => void): void;
  onRestore(templateId: PromptTemplateId): void;
  onInsert(templateId: PromptTemplateId, itemIndex: number): void;
  compatibleEvaluationSuitesByTemplate?: ReadonlyMap<PromptTemplateId, readonly CompatibleEvaluationSuite[]>;
  /** Returns false on a rejected mutation so the dialog stays open and shows evaluateRevisionError. */
  onEvaluateRevision?(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId, suiteId?: EvaluationSuite["id"]): boolean;
  /** Opens an already-compatible suite without retargeting it. */
  onOpenEvaluationSuite?(suiteId: EvaluationSuite["id"]): void;
  /** The error from the most recent evaluate-in-a-suite attempt, if any. */
  evaluateRevisionError?: string;
  onDismissEvaluateRevisionError?(): void;
}

function newPrompt(): PromptTemplateMessages {
  return [{ role: "user", content: "Write about {{topic}}." }];
}

function currentRevision(template: PromptTemplate) {
  return template.revisions.find(({ id }) => id === template.currentRevisionId)!;
}

export function ProjectTemplatesPane({
  templates,
  connectionRequirements = [],
  defaultConnectionRequirementId,
  usageCounts,
  itemCount,
  persistenceStatus = "saved",
  n8nImportDisabledReason,
  onOpenN8nImport,
  onCreate,
  onSave,
  onSaveAndInsert,
  onDraftChange,
  onRecommendedTargetChange,
  onRename,
  onArchive,
  onRestore,
  onInsert,
  compatibleEvaluationSuitesByTemplate = new Map(),
  onEvaluateRevision,
  onOpenEvaluationSuite,
  evaluateRevisionError,
  onDismissEvaluateRevisionError,
}: ProjectTemplatesPaneProps) {
  const activeTemplates = templates.filter(({ archivedAt }) => !archivedAt);
  const archivedTemplates = templates.filter(({ archivedAt }) => archivedAt);
  const [libraryView, setLibraryView] = useState<"active" | "archived">("active");
  const visibleTemplates =
    libraryView === "active" ? activeTemplates : archivedTemplates;
  const initialTemplate = activeTemplates[0];
  const [selectedId, setSelectedId] = useState<PromptTemplateId | undefined>(
    initialTemplate?.id,
  );
  const selected = visibleTemplates.find(({ id }) => id === selectedId);
  const initialRevision = selected ? currentRevision(selected) : undefined;
  const [viewedRevisionId, setViewedRevisionId] =
    useState<PromptTemplateRevisionId | undefined>(initialRevision?.id);
  const [candidateSourceRevisionId, setCandidateSourceRevisionId] =
    useState<PromptTemplateRevisionId | undefined>(selected?.draft?.sourceRevisionId);
  const [comparedRevisionId, setComparedRevisionId] =
    useState<PromptTemplateRevisionId | undefined>(
      selected?.revisions[selected.revisions.indexOf(initialRevision!) - 1]?.id,
    );
  const [name, setName] = useState(selected?.name ?? "");
  const [messages, setMessages] = useState<PromptTemplateMessages>(
    selected?.draft
      ? structuredClone(selected.draft.messages)
      : initialRevision ? structuredClone(initialRevision.messages) : newPrompt(),
  );
  const [defaults, setDefaults] = useState<Record<string, string>>(
    selected?.draft
      ? { ...selected.draft.variableDefaults }
      : initialRevision ? { ...initialRevision.variableDefaults } : {},
  );
  const [revisionName, setRevisionName] = useState(selected?.draft?.revisionName ?? "");
  const [recommendedModel, setRecommendedModel] = useState(
    selected?.recommendedTarget?.model ?? "",
  );
  const [
    recommendedConnectionRequirementId,
    setRecommendedConnectionRequirementId,
  ] = useState<ConnectionRequirement["id"] | undefined>(
    selected?.recommendedTarget?.connectionRequirementId ??
      defaultConnectionRequirementId,
  );
  const [insertionIndex, setInsertionIndex] = useState(itemCount);
  const [focusMode, setFocusMode] = useState(false);
  const editorRef = useRef<HTMLElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const [n8nSuggestionsEnabled, setN8nSuggestionsEnabled] = useState(
    () => typeof window === "undefined" ? true : n8nPasteSuggestionsEnabled(),
  );
  const [n8nPasteTarget, setN8nPasteTarget] = useState<undefined | {
    messageIndex: number; start: number; end: number; source: string; pastedSource?: string; revisionId?: PromptTemplateRevisionId; textarea: HTMLTextAreaElement; automatic: boolean;
  }>();
  const [evaluateRequest, setEvaluateRequest] = useState<undefined | { templateId: PromptTemplateId; revisionId: PromptTemplateRevisionId }>();
  // Open by default when browsing a historical revision (that's why the user
  // navigated here); collapsed while the current draft is being edited. A
  // save forces it open once, so the diff can confirm what just changed.
  const [diffOpen, setDiffOpen] = useState(false);

  const viewedRevision = selected?.revisions.find(
    ({ id }) => id === viewedRevisionId,
  ) ?? initialRevision;
  const compatibleEvaluationSuiteEntries = selected
    ? compatibleEvaluationSuitesByTemplate.get(selected.id) ?? []
    : [];
  const archived = Boolean(selected?.archivedAt);
  const readOnly = Boolean(
    selected &&
      (archived || (viewedRevision?.id !== selected.currentRevisionId && !candidateSourceRevisionId)),
  );
  const comparedRevision = selected?.revisions.find(
    ({ id }) => id === comparedRevisionId,
  );
  const revisionDiff = viewedRevision && comparedRevision
    ? diffPromptTemplateRevisions(comparedRevision, viewedRevision)
    : undefined;
  const discovery = useMemo(
    () => discoverTemplateVariables(messages),
    [messages],
  );
  const duplicateName = templates.some(
    (template) =>
      template.id !== selected?.id &&
      template.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
  );
  // A secret-like name can never receive a value at any level, so a template
  // that references one is unrunnable however it is saved. Flag it on discovery
  // rather than only when a default is assigned, or the author only finds out
  // at the point the run is refused.
  const sensitiveVariables = discovery.variables.filter(({ name }) =>
    isSensitiveTemplateVariableName(name),
  );
  const draftChanged = Boolean(
    viewedRevision && (
      JSON.stringify(messages) !== JSON.stringify(viewedRevision.messages) ||
      JSON.stringify(defaults) !== JSON.stringify(viewedRevision.variableDefaults)
    ),
  );

  function persistDraft(
    nextMessages: PromptTemplateMessages,
    nextDefaults: Record<string, string>,
    nextRevisionName = revisionName,
  ): void {
    if (!selected || !viewedRevision) return;
    const sourceRevisionId = candidateSourceRevisionId ?? viewedRevision.id;
    const variables = new Set(discoverTemplateVariables(nextMessages).variables.map(({ name }) => name));
    const filteredDefaults = Object.fromEntries(
      Object.entries(nextDefaults).filter(([key]) => variables.has(key)),
    );
    const matchesSource =
      JSON.stringify(nextMessages) === JSON.stringify(viewedRevision.messages) &&
      JSON.stringify(filteredDefaults) === JSON.stringify(viewedRevision.variableDefaults) &&
      !nextRevisionName;
    setCandidateSourceRevisionId(matchesSource ? undefined : sourceRevisionId);
    onDraftChange(
      selected.id,
      sourceRevisionId,
      nextMessages,
      filteredDefaults,
      nextRevisionName,
    );
  }
  function updateN8nSuggestionsEnabled(enabled: boolean): void {
    setN8nSuggestionsEnabled(enabled);
    setN8nPasteSuggestionsEnabled(enabled);
  }

  function openN8nPaste(target: Omit<NonNullable<typeof n8nPasteTarget>, "revisionId">): void {
    setN8nPasteTarget({ ...target, revisionId: viewedRevision?.id });
  }

  function insertAtN8nPasteTarget(content: string): void {
    const target = n8nPasteTarget;
    if (!target || viewedRevision?.id !== target.revisionId || messages[target.messageIndex]?.content !== target.source) return;
    const next = `${target.source.slice(0, target.start)}${content}${target.source.slice(target.end)}`;
    setMessages((current) => current.map((message, index) => index === target.messageIndex ? { ...message, content: next } : message) as PromptTemplateMessages);
    setN8nPasteTarget(undefined);
    queueMicrotask(() => { target.textarea.focus(); target.textarea.setSelectionRange(target.start + content.length, target.start + content.length); });
  }

  const { close: closeFocusMode } = useFocusMode({
    open: focusMode,
    setOpen: setFocusMode,
    containerRef: editorRef,
    triggerRef: focusToggleRef,
    initialFocusSelector: ".template-content-editor textarea:not([disabled])",
  });

  function selectTemplate(template: PromptTemplate): void {
    const revision = currentRevision(template);
    setSelectedId(template.id);
    const draft = template.draft;
    setViewedRevisionId(draft?.sourceRevisionId ?? revision.id);
    setCandidateSourceRevisionId(draft?.sourceRevisionId);
    setComparedRevisionId(template.revisions.at(-2)?.id);
    setDiffOpen(false);
    setName(template.name);
    setMessages(structuredClone(draft?.messages ?? revision.messages));
    setDefaults({ ...(draft?.variableDefaults ?? revision.variableDefaults) });
    setRevisionName(draft?.revisionName ?? "");
    setRecommendedModel(template.recommendedTarget?.model ?? "");
    setRecommendedConnectionRequirementId(
      template.recommendedTarget?.connectionRequirementId ??
        defaultConnectionRequirementId,
    );
  }

  function selectLibraryView(view: "active" | "archived"): void {
    setLibraryView(view);
    const next = view === "active" ? activeTemplates[0] : archivedTemplates[0];
    if (next) selectTemplate(next);
    else setSelectedId(undefined);
  }

  function selectRevision(revisionId: PromptTemplateRevisionId): void {
    if (!selected) return;
    const revision = selected.revisions.find(({ id }) => id === revisionId);
    if (!revision) return;
    setViewedRevisionId(revision.id);
    setCandidateSourceRevisionId(undefined);
    setComparedRevisionId(
      selected.revisions[selected.revisions.indexOf(revision) - 1]?.id,
    );
    setDiffOpen(revision.id !== selected.currentRevisionId);
    setMessages(structuredClone(revision.messages));
    setDefaults({ ...revision.variableDefaults });
    setRevisionName("");
  }

  function selectDraft(): void {
    if (!selected?.draft) return;
    setViewedRevisionId(selected.draft.sourceRevisionId);
    setCandidateSourceRevisionId(selected.draft.sourceRevisionId);
    setDiffOpen(false);
    setMessages(structuredClone(selected.draft.messages));
    setDefaults({ ...selected.draft.variableDefaults });
    setRevisionName(selected.draft.revisionName ?? "");
  }

  function addTemplate(): void {
    const messages = newPrompt();
    const id = onCreate("Untitled prompt", messages);
    setLibraryView("active");
    setSelectedId(id);
    setViewedRevisionId(undefined);
    setCandidateSourceRevisionId(undefined);
    setComparedRevisionId(undefined);
    setDiffOpen(false);
    setName("Untitled prompt");
    setMessages(structuredClone(messages));
    setDefaults({});
    setRevisionName("");
    setRecommendedModel("");
    setRecommendedConnectionRequirementId(defaultConnectionRequirementId);
  }

  return (
    <div className="templates-workspace" data-readiness-target="prompt-library" tabIndex={-1}>
      <aside className="template-sidebar">
        <div className="template-create-actions">
          <button className="button secondary" type="button" onClick={addTemplate}>
            New prompt
          </button>
          <button
            className="button secondary template-import-action"
            disabled={Boolean(n8nImportDisabledReason)}
            title={n8nImportDisabledReason}
            type="button"
            onClick={onOpenN8nImport}
          >
            Import prompt from n8n…
          </button>
        </div>
        <div className="template-library-filter" aria-label="Prompt status">
          <button
            aria-pressed={libraryView === "active"}
            className={
              libraryView === "active"
                ? "template-library-tab selected"
                : "template-library-tab"
            }
            type="button"
            onClick={() => selectLibraryView("active")}
          >
            Active <span>{activeTemplates.length}</span>
          </button>
          {/* Quiet by design: archiving should not read as a peer destination
              to Active, only as a reachable place to look for it later. */}
          <button
            aria-pressed={libraryView === "archived"}
            className={
              libraryView === "archived"
                ? "template-library-archive-link selected"
                : "template-library-archive-link"
            }
            type="button"
            onClick={() => selectLibraryView("archived")}
          >
            Archived <span>{archivedTemplates.length}</span>
          </button>
        </div>
        <div className="template-list">
          {visibleTemplates.length === 0 ? (
            <p className="template-empty">
              {libraryView === "active"
                ? "Create a project-owned prompt."
                : "Archived prompts will appear here."}
            </p>
          ) : (
            visibleTemplates.map((template) => (
              <button
                aria-current={template.id === selected?.id}
                className={template.id === selected?.id ? "template-list-item selected" : "template-list-item"}
                key={template.id}
                type="button"
                onClick={() => selectTemplate(template)}
              >
                <strong>{template.name}</strong>
                <span>
                  {currentRevision(template).messages.length} {currentRevision(template).messages.length === 1 ? "message" : "messages"}
                  {" · "}
                  {usageCounts.get(template.id) ?? 0} uses
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section
        aria-label={focusMode ? "Prompt editor focus mode" : undefined}
        aria-modal={focusMode ? "true" : undefined}
        className={focusMode ? "template-editor focus-mode-surface template-editor-focus-mode" : "template-editor"}
        ref={editorRef}
        role={focusMode ? "dialog" : undefined}
      >
        {!selected || !viewedRevision ? (
          <div className="template-empty-state">
            <h3>
              {libraryView === "active"
                ? "No active project prompts"
                : "No archived prompts"}
            </h3>
            <p>
              {libraryView === "active"
                ? "Prompts are reusable, versioned messages saved with this project. Create one to begin."
                : "Prompts you archive will remain available to historical conversations."}
            </p>
          </div>
        ) : (
          <>
            <header className="template-editor-header">
              <label className="template-name-field">
                Prompt name
                <input
                  disabled={readOnly}
                  value={name}
                  onChange={(event) => {
                    const next = event.target.value;
                    setName(next);
                    if (selected && next.trim()) onRename(selected.id, next.trim());
                  }}
                  onBlur={(event) => {
                    // Non-blank keystrokes already persist so navigating or
                    // closing does not lose them; blur only normalizes display.
                    const trimmed = event.target.value.trim();
                    if (trimmed) setName(trimmed);
                  }}
                />
              </label>
              <label className="template-revision-field">
                Revision
                <select
                  value={candidateSourceRevisionId ? "draft" : viewedRevision.id}
                  onChange={(event) => event.target.value === "draft"
                    ? selectDraft()
                    : selectRevision(event.target.value as PromptTemplateRevisionId)}
                >
                  {(selected.draft || candidateSourceRevisionId) && (
                    <option value="draft">Draft · autosaved</option>
                  )}
                  {[...selected.revisions].reverse().map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      {promptRevisionLabel(selected, revision.id)}
                      {revision.name ? ` — ${revision.name}` : ""}
                      {" · "}
                      {new Date(revision.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              <div className="template-editor-actions">
                {archived ? (
                  <>
                    <span className="provider-pill">Archived</span>
                    <button
                      className="button primary"
                      type="button"
                      onClick={() => {
                        onRestore(selected.id);
                        setLibraryView("active");
                      }}
                    >
                      Restore
                    </button>
                  </>
                ) : (
                  <>
                    {readOnly ? (
                      <>
                        <span className="provider-pill">Read-only revision</span>
                        <div className="template-revision-edit-action">
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => {
                              setCandidateSourceRevisionId(viewedRevision.id);
                              setDiffOpen(false);
                              setMessages(structuredClone(viewedRevision.messages));
                              setDefaults({ ...viewedRevision.variableDefaults });
                            }}
                          >
                            Edit as new revision
                          </button>
                          <small>
                            Copies this revision into an editable draft. Nothing
                            changes until you save.
                          </small>
                        </div>
                      </>
                    ) : (
                      <div className="template-revision-create-action">
                        <label>
                          Revision name <span className="field-optional">Optional</span>
                          <input
                            aria-label="Revision name"
                            placeholder="What changed?"
                            value={revisionName}
                            onChange={(event) => {
                              const next = event.target.value;
                              setRevisionName(next);
                              persistDraft(messages, defaults, next);
                            }}
                          />
                        </label>
                        <button
                          className="button primary"
                          disabled={
                            !draftChanged ||
                            !name.trim() ||
                            discovery.diagnostics.length > 0 ||
                            sensitiveVariables.length > 0
                          }
                          type="button"
                          onClick={() => {
                            const saved = onSave(
                              selected.id,
                              name,
                              messages,
                              Object.fromEntries(
                                discovery.variables.flatMap(({ name }) =>
                                  Object.hasOwn(defaults, name)
                                    ? [[name, defaults[name]!]]
                                    : [],
                                ),
                              ),
                              recommendedModel.trim() &&
                                recommendedConnectionRequirementId
                                ? {
                                    connectionRequirementId:
                                      recommendedConnectionRequirementId,
                                    model: recommendedModel.trim(),
                                  }
                                : undefined,
                              revisionName,
                            );
                            setCandidateSourceRevisionId(undefined);
                            setViewedRevisionId(saved);
                            setComparedRevisionId(viewedRevision.id);
                            setRevisionName("");
                            setDiffOpen(true);
                          }}
                        >
                          Create revision
                        </button>
                        <small aria-live="polite" className={`template-draft-status ${persistenceStatus}`}>
                          {persistenceStatus === "saving"
                            ? "Saving draft…"
                            : persistenceStatus === "error"
                              ? "Draft save failed — your changes remain in this session."
                              : persistenceStatus === "session"
                                ? "Draft kept in this session. Save the project to keep it after closing."
                                : "Draft autosaved."}
                        </small>
                      </div>
                    )}
                    {!archived && viewedRevision && onEvaluateRevision && <button
                      className="button secondary"
                      type="button"
                      onClick={() => {
                        onDismissEvaluateRevisionError?.();
                        setEvaluateRequest({ templateId: selected.id, revisionId: viewedRevision.id });
                      }}
                    >
                      Evaluate in a suite…
                    </button>}
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => {
                        const archivingId = selected.id;
                        onArchive(archivingId, () => {
                          // Archiving stays on the Active tab (dropping into
                          // Archived right after the action reads as "my
                          // prompts are gone"). Fall through to another
                          // active template so the editor doesn't show a
                          // stale, now-archived selection.
                          const fallback = activeTemplates.find(
                            (candidate) => candidate.id !== archivingId,
                          );
                          if (fallback) selectTemplate(fallback);
                          else setSelectedId(undefined);
                        });
                      }}
                    >
                      Archive
                    </button>
                  </>
                )}
              </div>
            </header>

            {(duplicateName ||
              discovery.diagnostics.length > 0 ||
              sensitiveVariables.length > 0) && (
              <div className="template-notices">
                {duplicateName && (
                  <div className="template-warning" role="status">
                    Another prompt has this name. IDs keep the two definitions distinct.
                  </div>
                )}
                {discovery.diagnostics.map((diagnostic) => (
                  <div className="template-diagnostic" key={`${diagnostic.start}-${diagnostic.end}`}>
                    {diagnostic.message}
                  </div>
                ))}
                {sensitiveVariables.map(({ name }) => (
                  <div className="template-diagnostic" key={name}>
                    Secret-like variable <code>{`{{${name}}}`}</code> can never be
                    given a value: defaults, saved use values, and run-only
                    overrides all reject it, so a conversation using this prompt
                    could not run. Rename it — credentials reach the provider
                    through the connection profile, not through project prompts.
                  </div>
                ))}
              </div>
            )}

            <div className="template-editor-body">
              <TemplateMessagesEditor
                messages={messages}
                disabled={readOnly}
                focusMode={focusMode}
                focusToggleRef={focusToggleRef}
                onFocusModeChange={(open) => {
                  if (open) setFocusMode(true);
                  else closeFocusMode();
                }}
                onChange={(next) => {
                  setMessages(next);
                  persistDraft(next, defaults);
                }}
                n8nSuggestionsEnabled={n8nSuggestionsEnabled}
                onOpenN8nPaste={openN8nPaste}
              />

              <aside className="template-variable-rail">
                <div className="template-rail-heading">
                  <span className="eyebrow">Model</span>
                  <h3>Recommended target</h3>
                </div>
                <p className="template-empty">
                  Optional. It does not create a revision or change a run. Shown
                  when it differs from the selected run target.
                </p>
                <label>
                  Connection
                  <select
                    disabled={readOnly || connectionRequirements.length === 0}
                    value={recommendedConnectionRequirementId ?? ""}
                    onChange={(event) => {
                      const next = event.target.value as ConnectionRequirement["id"];
                      setRecommendedConnectionRequirementId(next);
                      onRecommendedTargetChange(
                        selected.id,
                        recommendedModel.trim()
                          ? { connectionRequirementId: next, model: recommendedModel.trim() }
                          : undefined,
                      );
                    }}
                  >
                    {connectionRequirements.map((requirement) => (
                      <option key={requirement.id} value={requirement.id}>
                        {requirement.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Model ID
                  <input
                    aria-label="Recommended model ID"
                    disabled={readOnly}
                    placeholder="No recommendation"
                    value={recommendedModel}
                    onChange={(event) => {
                      const next = event.target.value;
                      setRecommendedModel(next);
                      onRecommendedTargetChange(
                        selected.id,
                        next.trim() && recommendedConnectionRequirementId
                          ? { connectionRequirementId: recommendedConnectionRequirementId, model: next.trim() }
                          : undefined,
                      );
                    }}
                  />
                </label>
                <div className="template-rail-heading">
                  <span className="eyebrow">Variables</span>
                  <h3>Revision defaults</h3>
                </div>
                {discovery.variables.length === 0 ? (
                  <p className="template-empty">
                    No variables discovered. Write <code>{"{{name}}"}</code> in the
                    content to add one.
                  </p>
                ) : (
                  discovery.variables.map((variable) => {
                    const assigned = Object.hasOwn(defaults, variable.name);
                    return (
                      <div className="template-variable-row" key={variable.name}>
                        <label>
                          <code>{`{{${variable.name}}}`}</code>
                          <input
                            disabled={readOnly}
                            placeholder="No default"
                            value={assigned ? defaults[variable.name] : ""}
                            onChange={(event) => {
                              const next = { ...defaults, [variable.name]: event.target.value };
                              setDefaults(next);
                              persistDraft(messages, next);
                            }}
                          />
                        </label>
                        <div className="template-variable-meta">
                          <small>{variable.occurrences.length} location{variable.occurrences.length === 1 ? "" : "s"}</small>
                          {assigned && !readOnly && (
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => {
                                const next = { ...defaults };
                                delete next[variable.name];
                                setDefaults(next);
                                persistDraft(messages, next);
                              }}
                            >
                              Remove default
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </aside>
            </div>

            <section className="template-revision-diff" aria-label="Revision diff">
              <div className="template-revision-diff-heading">
                <button
                  aria-expanded={diffOpen}
                  className="evaluation-section-toggle"
                  type="button"
                  onClick={() => setDiffOpen(!diffOpen)}
                >
                  <DisclosureChevron className="evaluation-section-chevron" />
                  <span className="eyebrow">Revision diff</span>
                  <span className="evaluation-section-facts">
                    {!comparedRevision
                      ? "Save another revision to compare"
                      : `vs ${promptRevisionLabel(selected, comparedRevision.id)}${revisionDiff ? ` — ${summarizeRevisionDiff(revisionDiff)}` : ""}`}
                  </span>
                </button>
              </div>
              {diffOpen && <>
                <label className="template-revision-diff-compare">
                  Compare this revision with
                  <select
                    value={comparedRevision?.id ?? ""}
                    disabled={selected.revisions.length < 2}
                    onChange={(event) =>
                      setComparedRevisionId(event.target.value as PromptTemplateRevisionId)
                    }
                  >
                    {selected.revisions.filter(({ id }) => id !== viewedRevision.id).map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {promptRevisionLabel(selected, revision.id)}
                      </option>
                    ))}
                  </select>
                </label>
                {!revisionDiff ? (
                  <p className="template-empty">Save another revision to compare this prompt’s message and default history.</p>
                ) : revisionDiff.identical ? (
                  <p className="template-empty">These revisions have identical messages, defaults, and import provenance.</p>
                ) : (
                  <RevisionDiffView diff={revisionDiff} />
                )}
              </>}
            </section>

            {!archived && <footer className="template-insert-bar">
              <span className="template-insert-label">Pin into the conversation</span>
              <label>
                Position
                <select
                  value={Math.min(insertionIndex, itemCount)}
                  onChange={(event) => setInsertionIndex(Number(event.target.value))}
                >
                  {Array.from({ length: itemCount + 1 }, (_, index) => (
                    <option key={index} value={index}>
                      {index === 0 ? "At start" : index === itemCount ? "At end" : `After item ${index}`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button primary"
                disabled={
                  draftChanged && (
                    !name.trim() ||
                    discovery.diagnostics.length > 0 ||
                    sensitiveVariables.length > 0
                  )
                }
                type="button"
                onClick={() => {
                  const itemIndex = Math.min(insertionIndex, itemCount);
                  if (!draftChanged) {
                    onInsert(selected.id, itemIndex);
                    return;
                  }
                  const saved = onSaveAndInsert(
                    selected.id,
                    name,
                    messages,
                    Object.fromEntries(
                      discovery.variables.flatMap(({ name }) =>
                        Object.hasOwn(defaults, name)
                          ? [[name, defaults[name]!]]
                          : [],
                      ),
                    ),
                    recommendedModel.trim() &&
                      recommendedConnectionRequirementId
                      ? {
                          connectionRequirementId:
                            recommendedConnectionRequirementId,
                          model: recommendedModel.trim(),
                        }
                      : undefined,
                    revisionName || undefined,
                    itemIndex,
                  );
                  setCandidateSourceRevisionId(undefined);
                  setViewedRevisionId(saved);
                  setComparedRevisionId(viewedRevision.id);
                  setRevisionName("");
                  setDiffOpen(true);
                }}
              >
                {draftChanged ? "Create revision and add" : "Add to conversation"}
              </button>
            </footer>}
          </>
        )}
      </section>
      {n8nPasteTarget && <N8nTemplatePasteDialog
        automatic={n8nPasteTarget.automatic}
        initialSource={n8nPasteTarget.pastedSource ?? n8nPasteTarget.source.slice(n8nPasteTarget.start, n8nPasteTarget.end)}
        suggestionsEnabled={n8nSuggestionsEnabled}
        onSuggestionsEnabledChange={updateN8nSuggestionsEnabled}
        onClose={() => setN8nPasteTarget(undefined)}
        onInsert={insertAtN8nPasteTarget}
        onPasteUnchanged={() => insertAtN8nPasteTarget(n8nPasteTarget.pastedSource ?? n8nPasteTarget.source.slice(n8nPasteTarget.start, n8nPasteTarget.end))}
      />}
      {evaluateRequest && <div className="confirmation-backdrop" role="presentation">
        <section aria-label="Evaluate in a suite" aria-modal="true" className="confirmation-dialog" role="dialog">
          <h2>Evaluate in a suite</h2>
          <p>Choose a compatible suite to keep its cases, checks, and configurations, or start a new suite. Messages will not change. Nothing runs until you start the evaluation.</p>
          {evaluateRevisionError && <div className="template-diagnostic" role="alert">{evaluateRevisionError}</div>}
          {compatibleEvaluationSuiteEntries.length > 0 && <div className="confirmation-dialog-actions confirmation-dialog-suite-rows">
            {compatibleEvaluationSuiteEntries.map(({ suite, pinnedRevisionId }) => {
              const state = describeCompatibleSuiteRevision(selected, pinnedRevisionId, evaluateRequest.revisionId);
              const description = state.kind === "current"
                ? "already pinned to this revision"
                : state.kind === "outdated"
                  ? `currently ${state.pinnedLabel} → will pin ${state.targetLabel}`
                  : "pinned revision unavailable";
              return <div className="confirmation-dialog-suite-row" key={suite.id}>
                <span><strong>{suite.name}</strong> — {description}</span>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => {
                    if (state.kind === "current") {
                      onOpenEvaluationSuite?.(suite.id);
                      setEvaluateRequest(undefined);
                      return;
                    }
                    if (onEvaluateRevision?.(evaluateRequest.templateId, evaluateRequest.revisionId, suite.id) ?? true) {
                      setEvaluateRequest(undefined);
                    }
                  }}
                >
                  {state.kind === "current" ? "Open" : `Use ${suite.name}`}
                </button>
              </div>;
            })}
          </div>}
          <div className="confirmation-dialog-actions"><button className="button primary" type="button" onClick={() => { if (onEvaluateRevision?.(evaluateRequest.templateId, evaluateRequest.revisionId) ?? true) setEvaluateRequest(undefined); }}>Create new suite</button><button className="button secondary" type="button" onClick={() => { onDismissEvaluateRevisionError?.(); setEvaluateRequest(undefined); }}>Cancel</button></div>
        </section>
      </div>}
    </div>
  );
}

function RevisionDiffView({ diff }: { diff: ReturnType<typeof diffPromptTemplateRevisions> }) {
  const changedMessages = diff.messages.filter(({ status }) => status !== "identical");
  const changedDefaults = diff.variableDefaults.filter(({ status }) => status !== "identical");
  return <div className="template-revision-diff-body">
    {changedMessages.length > 0 && <section>
      <h4>Messages</h4>
      {changedMessages.map((message) => <details className="template-diff-message" key={message.index} open>
        <summary>Message {message.index + 1} · {message.status}{message.roleChanged ? ` · ${message.before!.role} → ${message.after!.role}` : ""}</summary>
        {message.content.truncated && <p className="diff-warning">This message exceeded the 4,000-line limit. Showing a whole-block replacement.</p>}
        <pre className="diff-code">{message.content.lines.map((line, index) => <span className={`diff-line ${line.kind}`} key={`${line.kind}-${index}`}><span className="diff-gutter" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span><span>{line.text || " "}</span></span>)}</pre>
      </details>)}
    </section>}
    {changedDefaults.length > 0 && <section>
      <h4>Variable defaults</h4>
      <ul className="template-diff-defaults">{changedDefaults.map((value) => <li key={value.name}><code>{`{{${value.name}}}`}</code> · {value.status}<span>{value.before ?? "No default"} → {value.after ?? "No default"}</span></li>)}</ul>
    </section>}
    {diff.importProvenance.status !== "identical" && <p className="template-diff-provenance">Import provenance {diff.importProvenance.status}: {diff.importProvenance.beforePresent ? "imported" : "not imported"} → {diff.importProvenance.afterPresent ? "imported" : "not imported"}.</p>}
  </div>;
}

function TemplateMessagesEditor({
  messages,
  disabled,
  focusMode,
  focusToggleRef,
  onFocusModeChange,
  onChange,
  n8nSuggestionsEnabled,
  onOpenN8nPaste,
}: {
  messages: PromptTemplateMessages;
  disabled: boolean;
  focusMode: boolean;
  focusToggleRef: React.RefObject<HTMLButtonElement | null>;
  onFocusModeChange(open: boolean): void;
  onChange(messages: PromptTemplateMessages): void;
  n8nSuggestionsEnabled: boolean;
  onOpenN8nPaste(target: { messageIndex: number; start: number; end: number; source: string; pastedSource?: string; textarea: HTMLTextAreaElement; automatic: boolean }): void;
}) {
  const expanded = messages.length > 1 || messages[0].role !== "user";
  const textareas = useRef(new Map<number, HTMLTextAreaElement>());

  function targetFor(textarea: HTMLTextAreaElement, index: number, automatic: boolean, pastedSource?: string) {
    return { messageIndex: index, start: textarea.selectionStart, end: textarea.selectionEnd, source: messages[index]!.content, pastedSource, textarea, automatic };
  }

  function pasteHandler(index: number, event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const source = event.clipboardData.getData("text/plain");
    if (!n8nSuggestionsEnabled || !source || !shouldSuggestN8nTemplatePaste(source)) return;
    event.preventDefault();
    onOpenN8nPaste(targetFor(event.currentTarget, index, true, source));
  }

  function addMessage(role: TemplateRole = "user", index = messages.length): void {
    const next = [...messages];
    next.splice(index, 0, { role, content: "" });
    onChange(next as PromptTemplateMessages);
  }

  function updateMessage(
    index: number,
    patch: Partial<PromptTemplateMessages[number]>,
  ): void {
    onChange(
      messages.map((message, candidateIndex) =>
        candidateIndex === index ? { ...message, ...patch } : message,
      ) as PromptTemplateMessages,
    );
  }

  function moveMessage(index: number, offset: -1 | 1): void {
    const target = index + offset;
    if (target < 0 || target >= messages.length) return;
    const next = [...messages];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next as PromptTemplateMessages);
  }

  return (
    <section className="template-content-editor">
      <div className="template-content-heading">
        <h3>Content</h3>
        <div className="template-content-actions">
          {!disabled && <button className="button secondary" type="button" onClick={() => {
            const textarea = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : textareas.current.get(0);
            if (textarea) onOpenN8nPaste(targetFor(textarea, [...textareas.current.entries()].find(([, value]) => value === textarea)?.[0] ?? 0, false));
          }}>Paste from n8n…</button>}
          <FocusModeToggle
            className="template-focus-toggle"
            open={focusMode}
            subject="prompt editor"
            toggleRef={focusToggleRef}
            onToggle={() => onFocusModeChange(!focusMode)}
          />
        </div>
      </div>
      {!expanded ? (
        <div className="template-fragment-field">
          <textarea
            aria-label="Prompt content"
            disabled={disabled}
            rows={9}
            value={messages[0].content}
            onChange={(event) => updateMessage(0, { content: event.target.value })}
            onPaste={(event) => pasteHandler(0, event)}
            ref={(element) => { if (element) textareas.current.set(0, element); else textareas.current.delete(0); }}
          />
          {!disabled && (
            <span className="template-simple-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => addMessage("system", 0)}
              >
                + Add system instructions
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => addMessage()}
              >
                + Add message
              </button>
            </span>
          )}
        </div>
      ) : (
        <div className="template-message-set">
          {messages.map((message, index) => (
            <article className="template-message-editor message-card" key={index}>
              <div className="message-toolbar">
                <select
                  aria-label={`Prompt message ${index + 1} role`}
                  disabled={disabled}
                  value={message.role}
                  onChange={(event) => updateMessage(index, { role: event.target.value as TemplateRole })}
                >
                  <option value="system">System</option>
                  <option value="user">User</option>
                  <option value="assistant">Assistant</option>
                </select>
                {!disabled && <div className="template-message-actions">
                  <button aria-label={`Move prompt message ${index + 1} up`} className="text-button" disabled={index === 0} type="button" onClick={() => moveMessage(index, -1)}>Up</button>
                  <button aria-label={`Move prompt message ${index + 1} down`} className="text-button" disabled={index === messages.length - 1} type="button" onClick={() => moveMessage(index, 1)}>Down</button>
                  {messages.length > 1 && (
                    <button
                      className="remove-button"
                      type="button"
                      onClick={() => onChange(messages.filter((_, candidateIndex) => candidateIndex !== index) as PromptTemplateMessages)}
                    >
                      Remove
                    </button>
                  )}
                </div>}
              </div>
              <textarea
                aria-label={`Prompt message ${index + 1} content`}
                disabled={disabled}
                rows={5}
                value={message.content}
                onChange={(event) => updateMessage(index, { content: event.target.value })}
                onPaste={(event) => pasteHandler(index, event)}
                ref={(element) => { if (element) textareas.current.set(index, element); else textareas.current.delete(index); }}
              />
            </article>
          ))}
          {!disabled && (
            <div className="template-expanded-actions">
              {!messages.some(({ role }) => role === "system") && (
                <button className="button secondary" type="button" onClick={() => addMessage("system", 0)}>
                  + Add system instructions
                </button>
              )}
              <button className="button secondary" type="button" onClick={() => addMessage()}>
                + Add message
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface TemplateUseCardProps {
  use: PromptTemplateUse;
  template: PromptTemplate;
  diagnostics: ProjectTemplateDiagnostic[];
  runOverrides: Readonly<Record<string, string>>;
  importedFrom?: ExternalImportReceipt;
  onSaveValues(values: Record<string, string>): void;
  onSaveRunValue(
    values: Record<string, string>,
    runOverrides: Record<string, string>,
  ): void;
  onRunOverridesChange(values: Record<string, string>): void;
  onUpdateLatest(): void;
  onDetach(): void;
  onRemove(): void;
}

function effectiveValueLabel(value: string): string {
  return value.length ? value : "(empty)";
}

/**
 * A collapsed variable row has one line to say what the value currently is, so
 * the value is flattened to a single line and clipped. The full text stays
 * available in the row's editor.
 */
function glanceLabel(value: string | undefined): string {
  if (value === undefined) return "Not set";
  if (!value.length) return "(empty)";
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 72 ? `${singleLine.slice(0, 72)}…` : singleLine;
}

function importProvenanceLabel(receipt: ExternalImportReceipt): string {
  const source = receipt.source.adapter.toLowerCase().includes("n8n")
    ? "n8n"
    : receipt.source.adapter;
  const execution = receipt.source.execution;
  if (!execution) return `Imported from ${source}`;
  if (!execution.executedAt) {
    return `Imported from ${source} · execution ${execution.id}`;
  }
  const executionDate = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(execution.executedAt));
  return `Imported from ${source} · execution ${executionDate}`;
}

function TemplateContentPreview({
  messages,
  values,
  view,
}: {
  messages: PromptTemplateMessages;
  values: Readonly<Record<string, string>>;
  view: "template" | "resolved";
}) {
  return (
    <div className="template-content-preview" aria-label={`${view === "template" ? "prompt" : view} preview`}>
      {messages.map((message, messageIndex) => (
        <div className="template-preview-message" key={`${message.role}-${messageIndex}`}>
          <span className="eyebrow">{message.role}</span>
          <div className="template-preview-content">
            {message.content.split(/(\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\})/g).map((part, index) => {
              const match = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(part);
              if (!match) return <span key={index}>{part}</span>;
              const name = match[1]!;
              const value = values[name];
              const missing = value === undefined;
              return (
                <span
                  className={`template-variable-chip${missing ? " missing" : ""}`}
                  key={index}
                  title={missing ? `${name} needs a value` : value}
                >
                  {view === "template" ? `{{${name}}}` : missing ? `{{${name}}}` : effectiveValueLabel(value)}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TemplateUseCard(props: TemplateUseCardProps) {
  // A pinned revision defines the preview, variable set, defaults, and which
  // rows block a run. Treat it as the identity boundary for this card's local
  // summary state so a newly blocking row receives the normal open policy.
  return (
    <TemplateUseCardRevision
      key={props.use.templateRevisionId}
      {...props}
    />
  );
}

function TemplateUseCardRevision({
  use,
  template,
  diagnostics,
  runOverrides,
  importedFrom,
  onSaveValues,
  onSaveRunValue,
  onRunOverridesChange,
  onUpdateLatest,
  onDetach,
  onRemove,
}: TemplateUseCardProps) {
  const [previewView, setPreviewView] = useState<"template" | "resolved">("template");
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [variableFilter, setVariableFilter] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const revision = template.revisions.find(({ id }) => id === use.templateRevisionId)!;
  const discovery = discoverTemplateVariables(revision.messages);
  const effectiveValues = resolveTemplateValues(
    revision.variableDefaults,
    use.values,
    runOverrides,
  );
  const newerRevision = template.currentRevisionId !== revision.id;
  // Resolution can report the same missing variable once per message. The
  // value is authored once, so the card should summarize it once as well.
  const uniqueDiagnostics = [
    ...new Map(
      diagnostics.map(({ diagnostic }) => [diagnostic.message, diagnostic]),
    ).values(),
  ];
  const missingDiagnosticCount = uniqueDiagnostics.filter(
    ({ code }) => code === "missing-template-variable",
  ).length;
  const reportedMissing = new Set(
    uniqueDiagnostics.flatMap((diagnostic) =>
      diagnostic.code === "missing-template-variable" ? [diagnostic.name] : [],
    ),
  );

  const rows = discovery.variables.map((variable) => {
    const sensitive = isSensitiveTemplateVariableName(variable.name);
    const saved = Object.hasOwn(use.values, variable.name);
    const overridden = Object.hasOwn(runOverrides, variable.name);
    const defaulted = Object.hasOwn(revision.variableDefaults, variable.name);
    const needsValue = !saved && !overridden && !defaulted;
    return {
      variable,
      sensitive,
      saved,
      overridden,
      defaulted,
      needsValue,
      effective: effectiveValues[variable.name],
      valueSource: overridden
        ? "Session override"
        : saved
          ? "Saved in project"
          : defaulted
            ? "Prompt default"
            : "Needs a value",
      // A row that blocks the run is never collapsed by default and never
      // hidden by a filter: run readiness deep-links to exactly these fields,
      // so they have to stay reachable whatever the card is filtered to.
      blocking: sensitive || needsValue || reportedMissing.has(variable.name),
    };
  });
  const [openVariables, setOpenVariables] = useState<Record<string, boolean>>(
    () =>
      Object.fromEntries(
        rows.flatMap(({ variable, blocking }) =>
          blocking ? [[variable.name, true] as const] : [],
        ),
      ),
  );
  const attentionCount = rows.filter(({ blocking }) => blocking).length;
  const overrideCount = rows.filter(({ overridden }) => overridden).length;
  const query = variableFilter.trim().toLowerCase();
  const visibleRows = rows.filter(
    (row) =>
      row.blocking ||
      (!attentionOnly &&
        (!query || row.variable.name.toLowerCase().includes(query))),
  );
  const hiddenCount = rows.length - visibleRows.length;
  // Below this a stack of expanded rows is still readable, and the controls
  // would cost more attention than they save.
  const dense = rows.length > 3;
  const allVisibleOpen =
    visibleRows.length > 0 &&
    visibleRows.every(({ variable }) => openVariables[variable.name]);

  function setAllVisible(open: boolean): void {
    setOpenVariables((current) => ({
      ...current,
      ...Object.fromEntries(
        visibleRows.map(({ variable }) => [variable.name, open]),
      ),
    }));
  }

  function updateRecord(
    current: Readonly<Record<string, string>>,
    name: string,
    value: string,
  ): Record<string, string> {
    return { ...current, [name]: value };
  }

  function removeRecordKey(
    current: Readonly<Record<string, string>>,
    name: string,
  ): Record<string, string> {
    const next = { ...current };
    delete next[name];
    return next;
  }

  return (
    <article
      className={diagnostics.length ? "template-use-card unresolved" : "template-use-card"}
      data-template-use-id={use.id}
      tabIndex={-1}
    >
      <header>
        <div>
          <div className="template-use-kicker">
            <span className="eyebrow">Pinned prompt</span>
            {uniqueDiagnostics.length > 0 && (
              <span className="template-issue-count" role="status">
                {missingDiagnosticCount === uniqueDiagnostics.length
                  ? `${missingDiagnosticCount} missing`
                  : `${uniqueDiagnostics.length} ${
                      uniqueDiagnostics.length === 1 ? "issue" : "issues"
                    }`}
              </span>
            )}
          </div>
          <h3>{template.name}</h3>
          {importedFrom && (
            <small>{importProvenanceLabel(importedFrom)}</small>
          )}
        </div>
        <div className="template-use-actions">
          {newerRevision && (
            <button className="button secondary" type="button" onClick={onUpdateLatest}>
              Review latest
            </button>
          )}
          <button className="button secondary" type="button" onClick={onDetach}>
            Detach
          </button>
          <button className="remove-button" type="button" onClick={onRemove}>
            Remove
          </button>
        </div>
      </header>

      <section className="template-use-preview">
        <div className="template-preview-heading">
          <span>Prompt preview</span>
          <div className="template-preview-toggle" aria-label="Prompt preview mode">
            <button
              aria-pressed={previewView === "template"}
              className={previewView === "template" ? "active" : ""}
              onClick={() => setPreviewView("template")}
              type="button"
            >
              Prompt
            </button>
            <button
              aria-pressed={previewView === "resolved"}
              className={previewView === "resolved" ? "active" : ""}
              onClick={() => setPreviewView("resolved")}
              type="button"
            >
              Resolved
            </button>
          </div>
          <button
            aria-expanded={previewExpanded}
            className="text-button"
            type="button"
            onClick={() => setPreviewExpanded((expanded) => !expanded)}
          >
            {previewExpanded ? "Collapse" : "Expand"}
          </button>
        </div>
        <div
          className={
            previewExpanded
              ? "template-preview-body"
              : "template-preview-body clamped"
          }
        >
          <TemplateContentPreview
            messages={revision.messages}
            values={effectiveValues}
            view={previewView}
          />
        </div>
      </section>

      <div className="template-use-values">
        {rows.length > 0 && (
          <div className="template-values-heading">
            <div className="template-values-summary">
              <strong>
                {rows.length} variable{rows.length === 1 ? "" : "s"}
              </strong>
              {attentionCount > 0 && (
                <span className="template-values-attention">
                  {attentionCount} need{attentionCount === 1 ? "s" : ""} attention
                </span>
              )}
              {overrideCount > 0 && (
                <span>
                  {overrideCount} session override
                  {overrideCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {dense && (
              <div className="template-values-controls">
                <input
                  aria-label={`Filter ${template.name} variables`}
                  placeholder="Filter variables"
                  type="search"
                  value={variableFilter}
                  onChange={(event) => setVariableFilter(event.target.value)}
                />
                <label className="template-values-attention-toggle">
                  <input
                    checked={attentionOnly}
                    type="checkbox"
                    onChange={(event) => setAttentionOnly(event.target.checked)}
                  />
                  Needs attention only
                </label>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setAllVisible(!allVisibleOpen)}
                >
                  {allVisibleOpen ? "Collapse all" : "Expand all"}
                </button>
              </div>
            )}
          </div>
        )}
        {visibleRows.map(({
          variable,
          sensitive,
          saved,
          overridden,
          effective,
          valueSource,
          blocking,
        }) => {
          return (
            <details
              className={
                blocking
                  ? "template-use-variable attention"
                  : "template-use-variable"
              }
              key={variable.name}
              open={openVariables[variable.name] ?? false}
              onToggle={(event) => {
                // The updater runs after the event is done with, so the new
                // state has to be read while the target is still attached.
                const open = event.currentTarget.open;
                setOpenVariables((current) => ({
                  ...current,
                  [variable.name]: open,
                }));
              }}
            >
              <summary className="template-use-variable-heading">
                <code>{`{{${variable.name}}}`}</code>
                <span className="template-variable-glance">
                  {sensitive ? "Cannot be given a value" : glanceLabel(effective)}
                </span>
                <small
                  className={
                    blocking
                      ? "template-variable-source attention"
                      : "template-variable-source"
                  }
                >
                  {sensitive ? "Secret-like name" : valueSource}
                </small>
              </summary>
              {sensitive ? (
                <div className="template-diagnostic">
                  Secret-like variables cannot receive portable or run-only
                  values, so this use cannot run. Rename{" "}
                  <code>{`{{${variable.name}}}`}</code> in the template, or
                  detach this use and edit the message directly. Credentials
                  reach the provider through the connection profile.
                </div>
              ) : (
                <div className="template-run-value-editor">
                  <label>
                    Value for run
                    <textarea
                      data-template-variable={variable.name}
                      className={overridden ? "run-override-input" : ""}
                      placeholder="Enter a value"
                      rows={4}
                      value={effective ?? ""}
                      onChange={(event) =>
                        onRunOverridesChange(
                          updateRecord(
                            runOverrides,
                            variable.name,
                            event.target.value,
                          ),
                        )
                      }
                    />
                  </label>
                  <div className="template-run-value-footer">
                    <small>
                      {valueSource} · {variable.occurrences.length} location
                      {variable.occurrences.length === 1 ? "" : "s"}
                    </small>
                    <div className="template-run-value-actions">
                      {overridden && (
                        <>
                          <button
                            className="text-button"
                            type="button"
                            onClick={() =>
                              onSaveRunValue(
                                updateRecord(
                                  use.values,
                                  variable.name,
                                  effective!,
                                ),
                                removeRecordKey(runOverrides, variable.name),
                              )
                            }
                          >
                            Save to project
                          </button>
                          <button
                            className="text-button"
                            type="button"
                            onClick={() =>
                              onRunOverridesChange(
                                removeRecordKey(runOverrides, variable.name),
                              )
                            }
                          >
                            Reset
                          </button>
                        </>
                      )}
                      {saved && !overridden && (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() =>
                            onSaveValues(
                              removeRecordKey(use.values, variable.name),
                            )
                          }
                        >
                          Use default
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </details>
          );
        })}
        {hiddenCount > 0 && (
          <p className="template-values-hidden" role="status">
            {hiddenCount} variable{hiddenCount === 1 ? "" : "s"} hidden by the
            current filter.
          </p>
        )}
      </div>
    </article>
  );
}
