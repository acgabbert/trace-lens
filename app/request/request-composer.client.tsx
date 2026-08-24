"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationMessage, PromptTemplateId, PromptTemplateRevisionId, ToolDefinition, ToolId } from "../../packages/core/src/run-kernel";
import type { EvaluationSuite, ProjectFile, ToolMock } from "../../packages/core/src/project";
import { conversationMessageText } from "../conversation-display";
import { PaneTabs } from "../workbench-shell.client";
import { ProjectTemplatesPane, TemplateUseCard } from "../project-templates-pane.client";
import type { CompatibleEvaluationSuite } from "../project-templates-pane.client";
import { ToolsPane } from "../tools-pane.client";
import { RunReadinessNotice } from "../run-readiness-notice.client";
import { FocusModeToggle, useFocusMode } from "../focus-mode.client";
import type {
  ReadinessDestination,
  RunReadiness,
  RunReadinessAction,
} from "../run-readiness.client";
import type { ProjectTemplatesHandle } from "../templates/use-project-templates.client";
import type { CommandToolsHandle } from "../tools/use-command-tools.client";
import { StatusChip } from "../notifications/status-chip.client";
import { RequestSettings } from "./request-settings.client";
import type { RequestSettingsProps } from "./request-settings.client";

type RequestTab = "messages" | "templates" | "tools";

type RequestPreview =
  | { body: unknown; messages: ConversationMessage[] }
  | { error: string };

/**
 * The request-pane feature owns its local navigation and presentation. Its
 * data remains deliberately owned by the request draft, template workbench,
 * profile, project, and run-readiness features that supply these snapshots.
 */
export interface RequestComposerProps {
  requestDraft: {
    messages: ConversationMessage[];
    tools: ToolDefinition[];
    requestTools: ToolDefinition[];
    enabledToolIds: ToolId[];
    addTool(): void;
    removeTool(id: ToolId): void;
    moveTool(id: ToolId, offset: number): void;
    updateTool(id: ToolId, patch: Partial<ToolDefinition>): void;
    setToolEnabled(id: ToolId, enabled: boolean): void;
    mockForTool(id: ToolId): ToolMock | undefined;
    updateToolMock(id: ToolId, text: string, enabled: boolean): void;
    removeRequestTool(id: ToolId): void;
  };
  /** The command-tool feature owner, for the tools tab's binding surface. */
  commandTools: CommandToolsHandle;
  templates: ProjectTemplatesHandle;
  project:Pick<ProjectFile, "projectId" | "promptTemplates" | "connectionRequirements" | "defaults" | "externalImports" | "conversationRevisions" | "evaluationSuites"> | null;
  projectPersistenceStatus?: "saving" | "saved" | "session" | "error";
  onEvaluatePromptRevision?(templateId: PromptTemplateId, revisionId: PromptTemplateRevisionId, suiteId?: ProjectFile["evaluationSuites"][number]["id"]): boolean;
  /** Opens an already-compatible suite without retargeting it. */
  onOpenEvaluationSuite?(suiteId: EvaluationSuite["id"]): void;
  /** The error from the most recent evaluate-in-a-suite attempt, if any. */
  evaluateRevisionError?: string;
  onDismissEvaluateRevisionError?(): void;
  settings: RequestSettingsProps & {
    toolsEnabled: boolean;
  };
  readiness?: RunReadiness;
  /**
   * Repeating the composed request. It is a second way to start work from this
   * pane rather than the mode's primary action, so it renders beside the
   * request it repeats instead of competing for the topbar's one primary slot.
   */
  repeat: {
    disabled: boolean;
    disabledReason?: string;
    onRepeat(): void;
  };
  pendingDestination?: ReadinessDestination;
  /**
   * Bumped by the route when an imported prompt lands in the message list. The
   * composer returns to Messages so the import is on screen — a rule that used
   * to ride on the presence of the import notice, which is a toast now and
   * holds no state to read.
   */
  importedRevision?: number;
  onReadinessAction(destination: ReadinessDestination): void;
  onDestinationHandled(): void;
  activeProfile: { name: string };
  pendingBranch?: {
    parentRunId: string;
    branchMessageId: string;
    parentTraceNeedsSaving: boolean;
  };
  requestPreview?: RequestPreview;
  n8nImportDisabledReason?: string;
  onOpenConnectionSettings(): void;
  onOpenN8nImport(): void;
  onOpenToolLibrary(): void;
  onSaveParentTrace(): void;
  onDiscardPendingBranch(): void;
}

export function RequestComposer({
  requestDraft,
  commandTools,
  templates,
  project,
  projectPersistenceStatus,
  onEvaluatePromptRevision,
  onOpenEvaluationSuite,
  evaluateRevisionError,
  onDismissEvaluateRevisionError,
  settings,
  readiness,
  repeat,
  pendingDestination,
  importedRevision = 0,
  onReadinessAction,
  onDestinationHandled,
  activeProfile,
  pendingBranch,
  requestPreview,
  n8nImportDisabledReason,
  onOpenConnectionSettings,
  onOpenN8nImport,
  onOpenToolLibrary,
  onSaveParentTrace,
  onDiscardPendingBranch,
}: RequestComposerProps) {
  const [tab, setTab] = useState<RequestTab>("messages");
  const [shownImport, setShownImport] = useState(importedRevision);
  // Collapsed by default: the settings summary says what the next run will
  // send, which is what most visits to this pane need, and the message list
  // starts higher up for the visits that do not.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [requestPreviewView, setRequestPreviewView] = useState<"resolved" | "raw">("resolved");
  const [focusMode, setFocusMode] = useState(false);
  const [focusModeTab, setFocusModeTab] = useState<RequestTab>("messages");
  const compatibleEvaluationSuitesByTemplate = useMemo(() => {
    const result = new Map<PromptTemplateId, CompatibleEvaluationSuite[]>();
    if (!project) return result;
    (project.evaluationSuites ?? []).forEach((suite) => {
      const revision = project.conversationRevisions?.find(({ id }) => id === suite.input.conversationRevisionId);
      revision?.items.forEach((item) => {
        if (item.kind !== "template-use") return;
        const current = result.get(item.use.templateId) ?? [];
        result.set(item.use.templateId, [...current, { suite, pinnedRevisionId: item.use.templateRevisionId }]);
      });
    });
    return result;
  }, [project]);
  const composerRef = useRef<HTMLElement>(null);
  const focusToggleRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const selectedProjectToolCount = requestDraft.tools.filter(({ id }) =>
    requestDraft.enabledToolIds.includes(id),
  ).length;
  const selectedToolCount = selectedProjectToolCount + requestDraft.requestTools.length;
  // A newly imported snapshot is always shown. Adjusted during render rather
  // than in an effect, as the focus-mode reset below is, so the tab the import
  // replaced never reaches the DOM.
  if (shownImport !== importedRevision) {
    setShownImport(importedRevision);
    if (tab !== "messages") setTab("messages");
  }
  const activeTab = tab;

  // Focus mode belongs to the messages tab. Leaving it drops the state here
  // rather than at each navigation call site, so a tab change from anywhere —
  // the tab strip, a readiness destination, a notice — cannot leave focus mode
  // latent and reopen it on return. Adjusting during render keeps the discarded
  // state from reaching the DOM at all, unlike a post-commit effect.
  if (focusModeTab !== activeTab) {
    setFocusModeTab(activeTab);
    if (focusMode) setFocusMode(false);
  }

  const requestFocusMode = focusMode && activeTab === "messages";

  const { close: closeFocusMode } = useFocusMode({
    open: requestFocusMode,
    setOpen: setFocusMode,
    containerRef: composerRef,
    triggerRef: focusToggleRef,
    initialFocusSelector: ".message-card textarea:not([disabled])",
  });

  function routeReadinessAction(action: RunReadinessAction): void {
    onReadinessAction(action.destination);
  }

  useEffect(() => {
    if (pendingDestination?.surface !== "request") return;
    if (activeTab !== pendingDestination.tab) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setTab(pendingDestination.tab);
      });
      return () => { cancelled = true; };
    }
    // The model field lives inside the settings disclosure. Readiness routing
    // opens its owner first, then this effect runs again against the mounted
    // control and focuses it.
    if (pendingDestination.control === "model" && !settingsOpen) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setSettingsOpen(true);
      });
      return () => { cancelled = true; };
    }
    const target =
      pendingDestination.control === "model"
        ? modelRef.current
        : pendingDestination.control === "tool-manifest"
          ? composerRef.current?.querySelector<HTMLElement>(
              '[data-readiness-target="tool-manifest"]',
            ) ?? null
          : pendingDestination.control === "prompt-library"
            ? composerRef.current?.querySelector<HTMLElement>(
                '[data-readiness-target="prompt-library"]',
              ) ?? null
            : pendingDestination.entityId
              ? pendingDestination.control === "template-variable" && pendingDestination.fieldName
                ? composerRef.current?.querySelector<HTMLTextAreaElement>(
                    `[data-template-use-id="${pendingDestination.entityId}"] textarea[data-template-variable="${pendingDestination.fieldName}"]`,
                  ) ?? null
                : composerRef.current?.querySelector<HTMLElement>(
                    `[data-template-use-id="${pendingDestination.entityId}"]`,
                  ) ?? null
              : null;
    if (!target) return;
    // A variable row can be collapsed. Opening it through the DOM property
    // fires the toggle event the card listens to, so its own state stays in
    // step with what is now on screen.
    const disclosure = target.closest?.("details");
    if (disclosure && !disclosure.open) disclosure.open = true;
    target.scrollIntoView?.({ block: "center" });
    target.focus();
    onDestinationHandled();
  }, [activeTab, onDestinationHandled, pendingDestination, settingsOpen]);

  return (
    <section
      aria-label={requestFocusMode ? "Request composer focus mode" : undefined}
      aria-modal={requestFocusMode ? "true" : undefined}
      className={requestFocusMode ? "composer focus-mode-surface composer-focus-mode" : "composer"}
      ref={composerRef}
      role={requestFocusMode ? "dialog" : undefined}
    >
      <div className="panel-header request-header">
        <div>
          <span className="eyebrow">Request</span>
          <h2>Composer</h2>
        </div>
        <PaneTabs
          label="Request editor"
          value={activeTab}
          onChange={(value) => setTab(value as RequestTab)}
          tabs={[
            { id: "messages", label: "Messages", count: requestDraft.messages.length },
            { id: "templates", label: "Prompts", count: project?.promptTemplates.filter(({ archivedAt }) => !archivedAt).length ?? 0 },
            { id: "tools", label: "Tools", count: selectedToolCount },
          ]}
        />
        {activeTab !== "messages" ? <div className="request-header-actions">
          {activeTab === "tools" ? (
            <button className="text-button header-text-action" type="button" onClick={requestDraft.addTool}>
              + Add tool
            </button>
          ) : null}
          {/* On every tab, not only Messages: a repeat sends whatever the
              composer currently holds, and which tab is open does not change
              that. */}
          <button
            className="button secondary"
            disabled={repeat.disabled}
            title={repeat.disabled ? repeat.disabledReason : undefined}
            type="button"
            onClick={repeat.onRepeat}
          >
            Repeat…
          </button>
        </div> : null}
      </div>
      <RunReadinessNotice {...(readiness ? { readiness } : {})} onAction={routeReadinessAction} />
      {pendingBranch && (
        <StatusChip
          tone="advisory"
          label="Pending branch"
          detail={<>
            Branching from run <code>{pendingBranch.parentRunId}</code> at message{" "}
            <code>{pendingBranch.branchMessageId}</code>. The original trace is unchanged.
          </>}
          actions={[
            ...(pendingBranch.parentTraceNeedsSaving
              ? [{ key: "save-trace", label: "Save trace…", onSelect: onSaveParentTrace }]
              : []),
            { key: "discard", label: "Discard branch", onSelect: onDiscardPendingBranch },
          ]}
        />
      )}

      <div className="pane-scroll request-content">
        {activeTab === "messages" ? (
          <>
            <div className="run-settings">
              <RequestSettings
                {...settings}
                modelInputRef={modelRef}
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                scopeLabel={project ? "Project settings" : "Profile defaults"}
              />
              {/* Outside the panel deliberately: how many tools accompany the
                  request is not one of the inference options, and its blocked
                  variant must stay readable while the panel is collapsed. */}
              <p className={selectedToolCount > 0 && !settings.toolsEnabled ? "request-tool-line blocked" : "request-tool-line"} role="status">
                <span>
                  {selectedToolCount === 0
                    ? "No tools attached to this request."
                    : !settings.toolsEnabled
                      ? `${selectedToolCount} attached ${selectedToolCount === 1 ? "tool is" : "tools are"} unavailable because this profile does not allow tool calling.`
                      : requestDraft.requestTools.length > 0
                        ? `${selectedToolCount} ${selectedToolCount === 1 ? "tool" : "tools"} attached; ${requestDraft.requestTools.length} ${requestDraft.requestTools.length === 1 ? "is" : "are"} session-only.`
                        : `${selectedToolCount} ${selectedToolCount === 1 ? "tool" : "tools"} attached to this request.`}
                </span>
                <button className="text-button" type="button" onClick={() => setTab("tools")}>
                  {selectedToolCount === 0 ? "Add tools" : "Review"}
                </button>
              </p>
            </div>
            <div className="request-composer-toolbar">
              <button className="button secondary" type="button" onClick={templates.addComposerMessage}>
                + Add message
              </button>
              <div className="request-composer-run-actions">
                <button
                  className="button secondary"
                  disabled={repeat.disabled}
                  title={repeat.disabled ? repeat.disabledReason : undefined}
                  type="button"
                  onClick={repeat.onRepeat}
                >
                  Repeat…
                </button>
                <FocusModeToggle
                  className="request-focus-toggle"
                  open={requestFocusMode}
                  subject="request composer"
                  toggleRef={focusToggleRef}
                  onToggle={() => (requestFocusMode ? closeFocusMode() : setFocusMode(true))}
                />
              </div>
            </div>
            <div className="message-list">
              {templates.templateWorkbench.composerItems.map((item, index) => {
                if (item.kind === "template-use") {
                  const template = project?.promptTemplates.find(({ id }) => id === item.use.templateId);
                  if (!template) return null;
                  return <TemplateUseCard key={item.use.id} use={item.use} template={template}
                    diagnostics={templates.templateWorkbench.resolution?.diagnostics.filter(({ templateUseId }) => templateUseId === item.use.id) ?? []}
                    runOverrides={templates.templateRunOverrides[item.use.id] ?? {}}
                    importedFrom={project?.externalImports.find((receipt) => receipt.projection.kind === "prompt-template" && receipt.projection.templateRevisionId === item.use.templateRevisionId)}
                    onSaveValues={(values) => templates.updateTemplateUseValues(item.use.id, values)}
                    onSaveRunValue={(values, runOverrides) => templates.saveTemplateUseRunValue(item.use.id, values, runOverrides)}
                    onRunOverridesChange={(values) => templates.updateTemplateUseOverride(item.use.id, values)}
                    onUpdateLatest={() => templates.updateTemplateUseToLatestRevision(item.use.id)}
                    onDetach={() => templates.detachTemplateUse(item.use.id)}
                    onRemove={() => templates.removeTemplateUse(item.use.id)} />;
                }
                const message = item.message;
                const importReceipt = item.externalImportId ? project?.externalImports.find(({ id }) => id === item.externalImportId) : undefined;
                const roleIsStructural = message.role === "tool" || (message.role === "assistant" && Boolean(message.toolCalls?.length));
                const text = conversationMessageText(message);
                return <article className="message-card" key={message.id}>
                  <div className="message-toolbar">
                    <select aria-label={`Message ${index + 1} role`} value={message.role} disabled={roleIsStructural} onChange={(event) => templates.updateComposerMessage(message.id, { role: event.target.value as ConversationMessage["role"] })}>
                      <option value="system">System</option><option value="user">User</option><option value="assistant">Assistant</option><option value="tool">Tool</option>
                    </select>
                    {importReceipt && <span className="message-import-provenance" title={`Imported from ${importReceipt.source.adapter} execution ${importReceipt.source.execution?.id ?? "unavailable"} with ${importReceipt.fidelity.replaceAll("-", " ")} fidelity.`}>Imported from {importReceipt.source.adapter}{" · "}{importReceipt.fidelity.replaceAll("-", " ")}</span>}
                    <button aria-label={`Remove message ${index + 1}`} className="remove-button" onClick={() => templates.removeComposerMessage(message.id)}>Remove</button>
                  </div>
                  <textarea aria-label={`Message ${index + 1} content`} value={text} onChange={(event) => templates.updateComposerMessage(message.id, { content: [{ type: "text", text: event.target.value }] })} rows={message.role === "system" ? 4 : 7} />
                  {message.role === "tool" && <small className="message-metadata">Tool result for {message.name ?? "unnamed tool"} ({message.toolCallId})</small>}
                  {message.role === "assistant" && message.toolCalls?.map((call) => <div className="tool-call-card message-tool-call" key={call.id}><div className="tool-call-heading"><div><span className="eyebrow">Tool call</span><h3>{call.name}</h3></div><span className="provider-pill">Read-only</span></div><label>Arguments<pre>{call.arguments.text || "{}"}</pre></label></div>)}
                </article>;
              })}
            </div>
            {requestPreview && <details className="request-preview"><summary>Resolved request preview</summary>{"error" in requestPreview ? <div className="template-diagnostic">{requestPreview.error}</div> : <><>{(templates.templateWorkbench.resolution?.diagnostics.length ?? 0) > 0 && <div className="template-warning" role="status">Preview contains unresolved variables. Running is blocked until they have values.</div>}</><div className="request-preview-tabs"><PaneTabs idPrefix="request-preview" label="Request preview view" value={requestPreviewView} onChange={(value) => setRequestPreviewView(value as "resolved" | "raw")} tabs={[{ id: "resolved", label: "Resolved" }, { id: "raw", label: "Raw" }]} /></div>{requestPreviewView === "resolved" ? <section aria-label="Resolved request" aria-labelledby="request-preview-resolved-tab" id="request-preview-resolved-panel" role="tabpanel"><h3>Resolved messages</h3><div className="request-preview-messages">{requestPreview.messages.map((message, index) => <article className="request-preview-message" key={`${message.role}-${index}`}><span className="eyebrow">{message.role}</span><pre>{conversationMessageText(message)}</pre></article>)}</div></section> : <section className="request-preview-raw" aria-label="Raw OpenAI-compatible request body" aria-labelledby="request-preview-raw-tab" id="request-preview-raw-panel" role="tabpanel"><h3>Raw OpenAI-compatible request body</h3><pre>{JSON.stringify(requestPreview.body, null, 2)}</pre></section>}</>}</details>}
          </>
        ) : activeTab === "templates" ? (
          <ProjectTemplatesPane key={project?.projectId ?? "unsaved-project"} templates={project?.promptTemplates ?? []} connectionRequirements={project?.connectionRequirements ?? []} defaultConnectionRequirementId={project?.defaults.target.connectionRequirementId} usageCounts={templates.templateUsageCounts} itemCount={templates.activeProjectRevision?.items.length ?? requestDraft.messages.length} persistenceStatus={projectPersistenceStatus} n8nImportDisabledReason={n8nImportDisabledReason} onOpenN8nImport={onOpenN8nImport} onCreate={templates.createProjectTemplate} onDraftChange={templates.updateProjectTemplateDraft} onRecommendedTargetChange={templates.updateProjectTemplateRecommendedTarget} onSave={templates.saveProjectTemplate} onSaveAndInsert={(...args) => { const revisionId = templates.saveAndInsertProjectTemplate(...args); setTab("messages"); return revisionId; }} onRename={templates.renameProjectTemplate} onArchive={templates.archiveProjectTemplate} onRestore={templates.restoreProjectTemplate} onInsert={(...args) => { templates.insertProjectTemplate(...args); setTab("messages"); }} compatibleEvaluationSuitesByTemplate={compatibleEvaluationSuitesByTemplate} {...(onEvaluatePromptRevision ? { onEvaluateRevision: onEvaluatePromptRevision } : {})} {...(onOpenEvaluationSuite ? { onOpenEvaluationSuite } : {})} {...(evaluateRevisionError ? { evaluateRevisionError } : {})} {...(onDismissEvaluateRevisionError ? { onDismissEvaluateRevisionError } : {})} />
        ) : (
          <ToolsPane tools={requestDraft.tools} requestTools={requestDraft.requestTools} enabledToolIds={requestDraft.enabledToolIds} activeProfileName={activeProfile.name} toolsEnabled={settings.toolsEnabled} onOpenLibrary={onOpenToolLibrary} onOpenConnectionSettings={onOpenConnectionSettings} onAddTool={requestDraft.addTool} onRemoveTool={requestDraft.removeTool} onMoveTool={requestDraft.moveTool} onUpdateTool={requestDraft.updateTool} onSetToolEnabled={requestDraft.setToolEnabled} mockForTool={requestDraft.mockForTool} onUpdateToolMock={requestDraft.updateToolMock} onRemoveRequestTool={requestDraft.removeRequestTool} commandTools={commandTools} />
        )}
      </div>
    </section>
  );
}
