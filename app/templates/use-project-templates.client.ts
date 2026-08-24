"use client";

import { useEffect, useRef, useState } from "react";
import {
  archivePromptTemplate,
  appendPromptTemplateRevision,
  createPromptTemplate,
  detachPromptTemplateUse,
  findPromptTemplateUsages,
  insertPromptTemplateUse,
  projectDraft,
  removePromptTemplateUse,
  renamePromptTemplate,
  restorePromptTemplate,
  setPromptTemplateRecommendedTarget,
  updateProjectDraft,
  updatePromptTemplateDraft,
  updatePromptTemplateUseToLatest,
  updatePromptTemplateUseValues,
} from "../../packages/core/src/project";
import type {
  ProjectConversationItem,
  ProjectFile,
  PromptTemplateMessages,
  PromptTemplateRecommendedTarget,
  TemplateRunOverrides,
  ToolMock,
} from "../../packages/core/src/project";
import {
  importExternalPromptCandidate,
  importExternalPromptTemplateCandidate,
} from "../../packages/core/src/external-prompt-project";
import type { ExternalPromptCandidate } from "../../packages/core/src/external-prompt-import";
import { createEntityId } from "../../packages/core/src/run-kernel";
import type {
  ConversationMessage,
  ConversationRevisionId,
  MessageId,
  PromptTemplateId,
  PromptTemplateRevisionId,
  PromptTemplateUseId,
  ToolDefinition,
  ToolId,
} from "../../packages/core/src/run-kernel";
import { randomUUID } from "../../packages/core/src/random-id";
import { discoverTemplateVariables } from "../../packages/core/src/template-engine";
import type { ConfirmationDialogRequest } from "../confirmation-dialog.client";
import {
  pendingBranchMessagesAfterItemUpdate,
  projectTemplateWorkbenchView,
} from "./project-template-workbench.client";
import {
  projectForTemplateMutation,
  templateRunOverridesAfterRevisionUpdate,
  templateRunOverridesAfterSave,
  templateRunOverridesAfterUpdate,
} from "./project-template-policy";
import { removeDraftMessage } from "../use-request-draft.client";

/** What an external prompt import landed, reported once when it lands. */
export interface ProjectTemplatesImportNotice {
  name: string;
  variableCount: number;
  template: boolean;
}

/** Stable render snapshots and narrowly named cross-owner commands. */
export interface UseProjectTemplatesInput {
  projectFile: ProjectFile | null;
  projectDirty: boolean;
  messages: ConversationMessage[];
  model: string;
  temperature?: number;
  serializedTools(): ToolDefinition[];
  toolMocks: ToolMock[];
  enabledToolIds: ToolId[];
  branchParentRevisionId?: ConversationRevisionId;
  ensureProjectDocument(): ProjectFile;
  adoptProjectMutation(project: ProjectFile): void;
  replaceProjectDraft(draft: ReturnType<typeof projectDraft>): void;
  markProjectError(message: string | undefined): void;
  resetMessages(messages: ConversationMessage[]): void;
  addDraftMessage(): void;
  updateDraftMessage(id: MessageId, patch: { content?: ConversationMessage["content"]; role?: ConversationMessage["role"] }): void;
  removeDraftMessage(id: MessageId): void;
  clearPendingBranch(): void;
  requestConfirmation(request: ConfirmationDialogRequest): void;
  onImportApplied(): void;
  /**
   * Announces a completed import. The outcome used to be held here as
   * `importNotice` and rendered by the request composer, which meant a
   * confirmation that needed no decision sat in the composer's layout until it
   * was dismissed. It is a toast now, so this hook reports the event and keeps
   * no state about it.
   */
  onImported(notice: ProjectTemplatesImportNotice): void;
}

export interface ProjectTemplatesHandle {
  templateWorkbench: ReturnType<typeof projectTemplateWorkbenchView>;
  activeProjectRevision?: ProjectFile["conversationRevisions"][number];
  activeConnectionRequirement?: ProjectFile["connectionRequirements"][number];
  templateUsageCounts: Map<PromptTemplateId, number>;
  templateRunOverrides: TemplateRunOverrides;
  createProjectTemplate(name: string, messages: PromptTemplateMessages): PromptTemplateId;
  updateProjectTemplateDraft(templateId: PromptTemplateId, sourceRevisionId: PromptTemplateRevisionId, messages: PromptTemplateMessages, defaults: Record<string, string>, revisionName?: string): void;
  updateProjectTemplateRecommendedTarget(templateId: PromptTemplateId, recommendedTarget?: PromptTemplateRecommendedTarget): void;
  saveProjectTemplate(templateId: PromptTemplateId, name: string, messages: PromptTemplateMessages, defaults: Record<string, string>, recommendedTarget?: PromptTemplateRecommendedTarget, revisionName?: string): PromptTemplateRevisionId;
  saveAndInsertProjectTemplate(templateId: PromptTemplateId, name: string, messages: PromptTemplateMessages, defaults: Record<string, string>, recommendedTarget: PromptTemplateRecommendedTarget | undefined, revisionName: string | undefined, itemIndex: number): PromptTemplateRevisionId;
  /** Commits only the label, without touching revision content. Returns false (and leaves the project untouched) for a blank name. */
  renameProjectTemplate(templateId: PromptTemplateId, name: string): boolean;
  archiveProjectTemplate(templateId: PromptTemplateId, onArchived?: () => void): void;
  restoreProjectTemplate(templateId: PromptTemplateId): void;
  insertProjectTemplate(templateId: PromptTemplateId, itemIndex: number): void;
  updateTemplateUseValues(templateUseId: PromptTemplateUseId, values: Record<string, string>): void;
  saveTemplateUseRunValue(templateUseId: PromptTemplateUseId, values: Record<string, string>, useOverrides: Record<string, string>): void;
  updateTemplateUseOverride(templateUseId: PromptTemplateUseId, values: Record<string, string>): void;
  updateTemplateUseToLatestRevision(templateUseId: PromptTemplateUseId): void;
  detachTemplateUse(templateUseId: PromptTemplateUseId): void;
  removeTemplateUse(templateUseId: PromptTemplateUseId): void;
  addComposerMessage(): void;
  updateComposerMessage(id: MessageId, patch: { content?: ConversationMessage["content"]; role?: ConversationMessage["role"] }): void;
  removeComposerMessage(id: MessageId): void;
  importN8nPrompt(candidate: ExternalPromptCandidate, mode: "resolved-snapshot" | "reusable-template", options: { recommendModel: boolean }): Promise<void>;
  clearTransientOverrides(): void;
  markExecutedRevision(revisionId: ConversationRevisionId): void;
}

export function useProjectTemplates(input: UseProjectTemplatesInput): ProjectTemplatesHandle {
  const [templateRunOverrides, setTemplateRunOverrides] = useState<TemplateRunOverrides>({});
  const executedRevisionIdsRef = useRef(new Set<ConversationRevisionId>());
  useEffect(() => {
    if (input.projectFile && !input.projectDirty) {
      executedRevisionIdsRef.current.add(input.projectFile.defaults.conversationRevisionId);
    }
  }, [input.projectDirty, input.projectFile]);

  const activeProjectRevision = input.projectFile?.conversationRevisions.find(
    ({ id }) => id === input.projectFile!.defaults.conversationRevisionId,
  );
  const templateWorkbench = projectTemplateWorkbenchView({
    project: input.projectFile,
    messages: input.messages,
    runOverrides: templateRunOverrides,
    branchParentRevisionId: input.branchParentRevisionId,
  });
  const activeConnectionRequirement = input.projectFile?.connectionRequirements.find(
    ({ id }) => id === input.projectFile!.defaults.target.connectionRequirementId,
  );
  const templateUsageCounts = new Map<PromptTemplateId, number>();
  input.projectFile?.promptTemplates.forEach((template) => {
    templateUsageCounts.set(template.id, findPromptTemplateUsages(input.projectFile!, template.id).length);
  });

  function adoptAuthoredProject(project: ProjectFile, overrides = templateRunOverrides): void {
    input.adoptProjectMutation(project);
    input.replaceProjectDraft(projectDraft(project, overrides));
  }

  function projectForUseMutation(): { project: ProjectFile; revisionId: ConversationRevisionId } {
    return projectForTemplateMutation({
      project: input.ensureProjectDocument(),
      executedRevisionIds: executedRevisionIdsRef.current,
      runOverrides: templateRunOverrides,
    });
  }

  function createProjectTemplate(name: string, messages: PromptTemplateMessages): PromptTemplateId {
    const suffix = randomUUID();
    adoptAuthoredProject(createPromptTemplate(input.ensureProjectDocument(), { name, messages, idSuffix: suffix, revisionIdSuffix: `${suffix}-1` }));
    return createEntityId("template", suffix);
  }
  function updateProjectTemplateDraft(templateId: PromptTemplateId, sourceRevisionId: PromptTemplateRevisionId, messages: PromptTemplateMessages, defaults: Record<string, string>, revisionName?: string): void {
    adoptAuthoredProject(updatePromptTemplateDraft(input.ensureProjectDocument(), {
      templateId,
      sourceRevisionId,
      revisionName,
      messages,
      variableDefaults: defaults,
    }));
  }
  function updateProjectTemplateRecommendedTarget(templateId: PromptTemplateId, recommendedTarget?: PromptTemplateRecommendedTarget): void {
    adoptAuthoredProject(setPromptTemplateRecommendedTarget(input.ensureProjectDocument(), templateId, recommendedTarget));
  }
  function saveProjectTemplate(templateId: PromptTemplateId, name: string, messages: PromptTemplateMessages, defaults: Record<string, string>, recommendedTarget?: PromptTemplateRecommendedTarget, revisionName?: string): PromptTemplateRevisionId {
    let next = renamePromptTemplate(input.ensureProjectDocument(), templateId, name);
    next = setPromptTemplateRecommendedTarget(next, templateId, recommendedTarget);
    next = appendPromptTemplateRevision(next, { templateId, messages, variableDefaults: defaults, name: revisionName });
    adoptAuthoredProject(next);
    return next.promptTemplates.find(({ id }) => id === templateId)!.currentRevisionId;
  }
  function saveAndInsertProjectTemplate(templateId: PromptTemplateId, name: string, messages: PromptTemplateMessages, defaults: Record<string, string>, recommendedTarget: PromptTemplateRecommendedTarget | undefined, revisionName: string | undefined, itemIndex: number): PromptTemplateRevisionId {
    const { project, revisionId: conversationRevisionId } = projectForUseMutation();
    let next = renamePromptTemplate(project, templateId, name);
    next = setPromptTemplateRecommendedTarget(next, templateId, recommendedTarget);
    next = appendPromptTemplateRevision(next, {
      templateId,
      messages,
      variableDefaults: defaults,
      name: revisionName,
    });
    const templateRevisionId = next.promptTemplates.find(
      ({ id }) => id === templateId,
    )!.currentRevisionId;
    next = insertPromptTemplateUse(next, {
      conversationRevisionId,
      templateId,
      itemIndex,
    });
    adoptAuthoredProject(next);
    return templateRevisionId;
  }
  // Renaming is committed on its own, decoupled from "Save template", so that
  // editing just the name (the most common one-field edit) persists without
  // requiring the explicit save affordance that also mints a new revision.
  function renameProjectTemplate(templateId: PromptTemplateId, name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const project = input.ensureProjectDocument();
    const template = project.promptTemplates.find(({ id }) => id === templateId);
    if (!template || template.name === trimmed) return true;
    adoptAuthoredProject(renamePromptTemplate(project, templateId, trimmed));
    return true;
  }
  function archiveProjectTemplate(templateId: PromptTemplateId, onArchived?: () => void): void {
    const project = input.ensureProjectDocument();
    const template = project.promptTemplates.find(({ id }) => id === templateId);
    if (!template || template.archivedAt) return;
    const usageCount = findPromptTemplateUsages(project, templateId).length;
    input.requestConfirmation({
      title: `Archive "${template.name}"?`,
      description: "It will move to Archived and cannot be added to new conversations. Existing pinned uses and saved traces will keep working.",
      confirmLabel: "Archive template",
      details: [
        { label: "Revisions retained", value: String(template.revisions.length) },
        { label: "Existing uses retained", value: String(usageCount) },
      ],
      onConfirm() {
        adoptAuthoredProject(archivePromptTemplate(input.ensureProjectDocument(), templateId));
        onArchived?.();
      },
    });
  }
  function restoreProjectTemplate(templateId: PromptTemplateId): void {
    adoptAuthoredProject(restorePromptTemplate(input.ensureProjectDocument(), templateId));
  }
  function insertProjectTemplate(templateId: PromptTemplateId, itemIndex: number): void {
    const { project, revisionId } = projectForUseMutation();
    adoptAuthoredProject(insertPromptTemplateUse(project, { conversationRevisionId: revisionId, templateId, itemIndex }));
  }
  function updateTemplateUseValues(templateUseId: PromptTemplateUseId, values: Record<string, string>): void {
    const { project, revisionId } = projectForUseMutation();
    adoptAuthoredProject(updatePromptTemplateUseValues(project, { conversationRevisionId: revisionId, templateUseId, values }));
  }
  function updateTemplateUseOverride(templateUseId: PromptTemplateUseId, values: Record<string, string>): void {
    const overrides = templateRunOverridesAfterUpdate(templateRunOverrides, templateUseId, values);
    setTemplateRunOverrides(overrides);
    if (input.projectFile) input.replaceProjectDraft(projectDraft(input.projectFile, overrides));
  }
  function saveTemplateUseRunValue(templateUseId: PromptTemplateUseId, values: Record<string, string>, useOverrides: Record<string, string>): void {
    const { project, revisionId } = projectForUseMutation();
    const next = updatePromptTemplateUseValues(project, { conversationRevisionId: revisionId, templateUseId, values });
    const overrides = templateRunOverridesAfterSave(templateRunOverrides, templateUseId, useOverrides);
    setTemplateRunOverrides(overrides);
    adoptAuthoredProject(next, overrides);
  }
  function mutateAuthoredItems(update: (items: ProjectConversationItem[]) => ProjectConversationItem[]): void {
    if (input.branchParentRevisionId) {
      if (!input.projectFile) return;
      try { input.resetMessages(pendingBranchMessagesAfterItemUpdate({ project: input.projectFile, messages: input.messages, runOverrides: templateRunOverrides, parentRevisionId: input.branchParentRevisionId, update })); input.markProjectError(undefined); }
      catch (error) { input.markProjectError(error instanceof Error ? error.message : "Could not update the pending branch."); }
      return;
    }
    const { project, revisionId } = projectForUseMutation();
    const revision = project.conversationRevisions.find(({ id }) => id === revisionId)!;
    adoptAuthoredProject(updateProjectDraft(project, { messages: input.messages, items: update(structuredClone(revision.items)), model: input.model, temperature: input.temperature, tools: input.serializedTools(), toolMocks: input.toolMocks, enabledToolIds: input.enabledToolIds }));
  }
  function addComposerMessage(): void {
    if (!input.projectFile) return input.addDraftMessage();
    mutateAuthoredItems((items) => [...items, { kind: "message", message: { id: createEntityId("message", randomUUID()), role: "user", content: [{ type: "text", text: "" }] } }]);
  }
  function updateComposerMessage(id: MessageId, patch: { content?: ConversationMessage["content"]; role?: ConversationMessage["role"] }): void {
    if (!input.projectFile) return input.updateDraftMessage(id, patch);
    mutateAuthoredItems((items) => items.map((item) => {
      if (item.kind !== "message" || item.message.id !== id) return item;
      const message = item.message; const content = patch.content ?? message.content;
      if (message.role === "tool" || (message.role === "assistant" && message.toolCalls?.length)) return { ...item, message: { ...message, content } };
      return { ...item, message: { id: message.id, role: patch.role ?? message.role, content } as ConversationMessage };
    }));
  }
  function removeComposerMessage(id: MessageId): void {
    if (!input.projectFile) return input.removeDraftMessage(id);
    const remainingIds = new Set(removeDraftMessage(input.messages, id).map((message) => message.id));
    mutateAuthoredItems((items) => items.filter((item) => item.kind === "template-use" || remainingIds.has(item.message.id)));
  }
  function updateTemplateUseToLatestRevision(templateUseId: PromptTemplateUseId): void {
    const currentProject = input.ensureProjectDocument(); const currentRevision = currentProject.conversationRevisions.find(({ id }) => id === currentProject.defaults.conversationRevisionId)!;
    const item = currentRevision.items.find((candidate) => candidate.kind === "template-use" && candidate.use.id === templateUseId);
    if (!item || item.kind !== "template-use") return;
    const template = currentProject.promptTemplates.find(({ id }) => id === item.use.templateId)!;
    const pinned = template.revisions.find(({ id }) => id === item.use.templateRevisionId)!; const latest = template.revisions.find(({ id }) => id === template.currentRevisionId)!;
    const vars = (messages: PromptTemplateMessages) => discoverTemplateVariables(messages).variables.map(({ name }) => name).join(", ") || "none";
    const describe = (messages: PromptTemplateMessages) => messages.map(({ role, content: text }) => `${role}: ${text}`).join("\n");
    input.requestConfirmation({ title: `Update "${template.name}"?`, description: "The use will pin the latest immutable revision. Values for variables that still exist will be kept; assignments and session overrides for removed variables will be cleared.", confirmLabel: "Update to latest", details: [{ label: "From", value: pinned.id }, { label: "To", value: latest.id }, { label: "Variables", value: `${vars(pinned.messages)} → ${vars(latest.messages)}` }, { label: "Current content", value: describe(pinned.messages) }, { label: "Latest content", value: describe(latest.messages) }], onConfirm() { const { project, revisionId } = projectForUseMutation(); const count = latest.messages.length; const next = updatePromptTemplateUseToLatest(project, { conversationRevisionId: revisionId, templateUseId, newOutputMessageIdSuffixes: Array.from({ length: Math.max(0, count - item.use.outputMessageIds.length) }, () => randomUUID()) }); const overrides = templateRunOverridesAfterRevisionUpdate(templateRunOverrides, templateUseId, latest.messages); setTemplateRunOverrides(overrides); adoptAuthoredProject(next, overrides); } });
  }
  function detachTemplateUse(templateUseId: PromptTemplateUseId): void {
    input.requestConfirmation({
      title: "Detach this template use?",
      description: "Its currently resolved values, including run-only overrides, will become ordinary literal messages with the same message IDs.",
      confirmLabel: "Detach",
      onConfirm() {
        try {
          const { project, revisionId } = projectForUseMutation();
          const next = detachPromptTemplateUse(project, {
            conversationRevisionId: revisionId,
            templateUseId,
            runOverrides: templateRunOverrides,
          });
          const overrides = { ...templateRunOverrides };
          delete overrides[templateUseId];
          setTemplateRunOverrides(overrides);
          adoptAuthoredProject(next, overrides);
        } catch (error) {
          input.markProjectError(
            error instanceof Error
              ? error.message
              : "Could not detach this template use.",
          );
        }
      },
    });
  }
  function removeTemplateUse(templateUseId: PromptTemplateUseId): void { input.requestConfirmation({ title: "Remove this template use?", description: "The pinned use and all messages it generates will be removed from this conversation revision.", confirmLabel: "Remove use", destructive: true, onConfirm() { const { project, revisionId } = projectForUseMutation(); const next = removePromptTemplateUse(project, revisionId, templateUseId); const overrides = { ...templateRunOverrides }; delete overrides[templateUseId]; setTemplateRunOverrides(overrides); adoptAuthoredProject(next, overrides); } }); }
  async function importN8nPrompt(candidate: ExternalPromptCandidate, mode: "resolved-snapshot" | "reusable-template", { recommendModel }: { recommendModel: boolean }): Promise<void> {
    const imported = mode === "reusable-template" ? await importExternalPromptTemplateCandidate(input.ensureProjectDocument(), candidate, { recommendModel }) : await importExternalPromptCandidate(input.ensureProjectDocument(), candidate);
    input.adoptProjectMutation(imported.project); input.replaceProjectDraft(projectDraft(imported.project)); setTemplateRunOverrides({}); input.clearPendingBranch(); input.onImportApplied();
    const receipt = imported.project.externalImports.find(({ id }) => id === imported.externalImportId);
    input.onImported({ name: candidate.invocation.name, variableCount: receipt?.projection.kind === "prompt-template" ? receipt.projection.variables.length : 0, template: mode === "reusable-template" });
  }
  return { templateWorkbench, activeProjectRevision, activeConnectionRequirement, templateUsageCounts, templateRunOverrides, createProjectTemplate, updateProjectTemplateDraft, updateProjectTemplateRecommendedTarget, saveProjectTemplate, saveAndInsertProjectTemplate, renameProjectTemplate, archiveProjectTemplate, restoreProjectTemplate, insertProjectTemplate, updateTemplateUseValues, saveTemplateUseRunValue, updateTemplateUseOverride, updateTemplateUseToLatestRevision, detachTemplateUse, removeTemplateUse, addComposerMessage, updateComposerMessage, removeComposerMessage, importN8nPrompt, clearTransientOverrides: () => setTemplateRunOverrides({}), markExecutedRevision: (id) => executedRevisionIdsRef.current.add(id) };
}
