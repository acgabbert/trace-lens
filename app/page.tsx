"use client";

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ProviderCapabilities,
  RichInferenceRequest,
} from "../packages/core/src/types";
import { resolveProviderCapabilities } from "../packages/core/src/types";
import {
  createProjectFile,
  updateConnectionRequirementEndpoint,
} from "../packages/core/src/project";
import {
  createEntityId,
  createSingleTurnRunExecution,
} from "../packages/core/src/run-kernel";
import type {
  RunState,
  RunTrace,
  ExperimentCellId,
  ConversationMessage,
  ConversationId,
  MessageId,
  ToolDefinition,
} from "../packages/core/src/run-kernel";
import { buildChatCompletionsRequest } from "../packages/core/src/openai-compatible";
import {
  createInferenceTransport,
  isTauriRuntime,
} from "./tauri-inference-transport.client";
import { AppErrorBoundary } from "./app-error-boundary.client";
import { useInsecureOriginNotice } from "./use-insecure-origin.client";
import { randomUUID } from "../packages/core/src/random-id.ts";
import { projectFolderAccessAvailable, readEvaluationCaseSourcesWorkspace, readRunTraceWorkspace, saveEvaluationCaseSourcesWorkspace } from "./project-workspace.client";
import { promoteTraceToEvaluationCase } from "../packages/core/src/evaluation-case-promotion.ts";
import { upsertEvaluationCaseSource } from "../packages/core/src/evaluation-case-sources.ts";
import type { EvaluationCaseSource } from "../packages/core/src/evaluation-case-sources.ts";
import { emptyToolRegistry } from "../packages/core/src/tool-registry";
import type {
  ToolRegistryV1,
} from "../packages/core/src/tool-registry";
import {
  readToolRegistry,
  writeToolRegistry,
} from "./tool-registry-store.client";
import { ToolRegistryModal } from "./tool-registry-modal.client";
import { N8nImportModal } from "./n8n-import-modal.client";
import { ProjectCreationDialog } from "./project-creation-dialog.client";
import { useModelDiscovery } from "./use-model-discovery.client";
import { useConnectionProfiles } from "./use-connection-profiles.client";
import { toggleFavoriteModel } from "./profile-store.client";
import { useRequestDraft } from "./use-request-draft.client";
import { useProjectWorkspace } from "./use-project-workspace.client";
import { ConnectionDrawer } from "./connection-drawer.client";
import { Topbar } from "./topbar.client";
import { ResponseOutput } from "./response-output.client";
import { WorkbenchShell } from "./workbench-shell.client";
import type { WorkbenchView } from "./workbench-shell.client";
import { RunTracePanel } from "./run-trace-panel.client";
import { parseRunTraceJson, traceFileName } from "../packages/core/src/run-trace";
import { RunHistoryDrawer } from "./run-history-drawer.client";
import type { EvaluationSuiteHistoryHandle } from "./evaluations/evaluation-suite-history.client";
import { useEvaluationBaselines } from "./evaluations/use-evaluation-baselines.client";
import type {
  ProjectExperimentHistoryItem,
  ProjectRunHistoryItem,
} from "./use-project-run-history.client";
import { useProjectRunHistory } from "./use-project-run-history.client";
import {
  ConfirmationDialog,
} from "./confirmation-dialog.client";
import { runEmptyStatePresentation, runReadiness } from "./run-readiness.client";
import type { ReadinessDestination } from "./run-readiness.client";
import { RUN_READINESS_SUMMARY_ID } from "./run-readiness-notice.client";
import type {
  ConfirmationDialogRequest,
} from "./confirmation-dialog.client";
import {
  prepareWorkbenchRun,
  type WorkbenchBranchContext,
} from "./run/prepare-workbench-run.client";
import { useRunSession } from "./run/use-run-session.client";
import { toolBindingFor } from "./run/run-session-state.client";
import { useCommandTools } from "./tools/use-command-tools.client";
import { commandToolUnavailableMessage } from "./tools/command-tool-availability.client";
import { listExperimentToolBindings } from "./run/experiment-tool-bindings.client";
import { useRepeatedExperimentSession } from "./run/use-repeated-experiment-session.client";
import { RepeatedExperimentDialog } from "./run/repeated-experiment-dialog.client";
import { useProjectTemplates } from "./templates/use-project-templates.client";
import { RequestComposer } from "./request/request-composer.client";
import { useEvaluationSuiteAuthoring } from "./evaluations/use-evaluation-suite-authoring.client";
import { useEvaluationReassessment } from "./evaluations/use-evaluation-reassessment.client";
import {
  createEvaluationStartDraft,
  evaluationStartReadiness,
  resolveEvaluationLocalTargets,
} from "./evaluations/evaluation-start.client";
import { useEvaluationExecutionSession } from "./evaluations/use-evaluation-execution-session.client";
import { EvaluationStartDialog } from "./evaluations/evaluation-start-dialog.client";
import { PromoteTraceToCaseDialog } from "./evaluations/promote-trace-to-case-dialog.client";
import type { EvaluationComparisonReturnTarget } from "./evaluations/evaluation-comparison-workspace.client";
import { EVALUATION_PREFLIGHT_SUMMARY_ID } from "./evaluations/evaluation-suite-editor.client";
import type { EvaluationSuiteExecutionActions } from "./evaluations/evaluation-suite-editor.client";
import { evaluationExperimentAggregate } from "../packages/core/src/experiment";
import {
  evaluationPassSummary,
  evaluationPassTone,
} from "./evaluations/evaluation-history-format.client";
import type { EvaluationPassTone } from "./evaluations/evaluation-history-format.client";
import type { AppMode, ModeIndicator, ModeIndicatorTone } from "./modes/app-mode";
import { EvaluationsMode } from "./modes/evaluations-mode.client";
import { RunsMode } from "./modes/runs-mode.client";
import { useToasts } from "./notifications/use-toasts.client";
import { ToastRegion } from "./notifications/toast-region.client";
import { AppBanner } from "./notifications/app-banner.client";
import { chooseAppBanner } from "./notifications/banner-priority.client";
import type { AppBanner as AppBannerCandidate } from "./notifications/banner-priority.client";

const inferenceTransport = createInferenceTransport();

const MARKDOWN_PREVIEW_STORAGE_KEY = "inference-lens:markdown-preview:v1";
const STREAMING_PREFERENCE_STORAGE_KEY =
  "inference-lens:streaming-preference:v1";

interface BranchContext extends WorkbenchBranchContext {
  parentTraceNeedsSaving: boolean;
}

/**
 * A batch that finished in this session and has not been announced yet.
 *
 * Held as a small queue rather than announced from the session hook directly:
 * the hook reports completion in the same tick it stores the result, so the
 * pass rate the toast wants is not readable until React has committed. The
 * effect that drains this runs after that commit and derives the summary from
 * the same execution state the Runs indicator reads, which is what keeps the
 * two from disagreeing about the same batch.
 */
type FinishedBatch =
  | { kind: "evaluation"; experimentId: string }
  | { kind: "repeated"; experimentId: string; repetitions: number };

/**
 * `pending` and `unscored` both mean the batch decided nothing — interrupted,
 * or an aggregate that could not be derived. Neither is a failure, so neither
 * gets a failure colour on the strip.
 */
const indicatorToneForPassTone: Record<EvaluationPassTone, ModeIndicatorTone> = {
  passed: "passed",
  partial: "partial",
  failed: "failed",
  pending: "neutral",
  unscored: "neutral",
};

function subscribeToDesktopRuntime(): () => void {
  return () => {};
}

function serverDesktopRuntime(): boolean {
  return false;
}

function useDesktopRuntime(): boolean {
  return useSyncExternalStore(
    subscribeToDesktopRuntime,
    isTauriRuntime,
    serverDesktopRuntime,
  );
}

function useProjectFolderAccess(): boolean {
  return useSyncExternalStore(
    subscribeToDesktopRuntime,
    projectFolderAccessAvailable,
    serverDesktopRuntime,
  );
}

const defaultUserPrompts = [
  "Write a tiny mystery set in a lighthouse, ending with an unexpected kindness, in two sentences.",
  "Describe the first sunrise on Mars from the perspective of a botanist in two sentences.",
  "Invent a folktale explaining why thunder always follows lightning in two sentences.",
  "Write a product launch announcement for a backpack that can translate bird songs in two sentences.",
  "Explain the tradeoff between a cache and a database index to a new engineer in two sentences.",
  "Suggest a graceful recovery plan for a web app whose payment API has begun timing out in two sentences.",
  "Write a TypeScript function that returns the unique values in an array, then explain its time complexity in two sentences.",
  "Describe how you would make a command-line tool feel friendly to a first-time user in two sentences.",
  "Compare event-driven and polling-based systems through the lens of a busy restaurant in two sentences.",
  "Propose a concise commit message and pull-request summary for fixing an off-by-one pagination bug in two sentences.",
  "Write a detective's field note about a suspiciously helpful houseplant in two sentences.",
  "Explain how a password manager improves security without using technical jargon in two sentences.",
] as const;

function createInitialMessages(
  userPrompt: string = defaultUserPrompts[0],
): ConversationMessage[] {
  return [
    {
      id: createEntityId("message", randomUUID()),
      role: "system",
      content: [{ type: "text", text: "You are a concise, thoughtful assistant." }],
    },
    {
      id: createEntityId("message", randomUUID()),
      role: "user",
      content: [{ type: "text", text: userPrompt }],
    },
  ];
}

function chooseDefaultUserPrompt(): string {
  return defaultUserPrompts[
    Math.floor(Math.random() * defaultUserPrompts.length)
  ];
}

type DisplayStatus = "idle" | "running" | "waiting" | "complete" | "failed";
function displayStatus(state: RunState | null): DisplayStatus {
  if (!state) return "idle";
  switch (state.status.kind) {
    case "completed":
      return "complete";
    case "awaiting_tool_results":
      return "waiting";
    case "paused":
      return state.status.reason === "attempt_failed" ? "failed" : "waiting";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "running";
  }
}

function HomeContent() {
  // Keep the server render and the browser's first render identical. The
  // Tauri bridge exists only in the browser, so checking it during render
  // would otherwise change the hydrated markup.
  const isDesktopRuntime = useDesktopRuntime();
  const folderAccessAvailable = useProjectFolderAccess();
  // Declared before model discovery below, which reads `credential.prepare`
  // during render.
  const {
    profiles,
    profilesLoaded,
    activeProfile,
    capabilities: activeCapabilities,
    selectProfile,
    addProfile,
    updateActiveProfile,
    activeProfileDeletionRefusal,
    removeActiveProfile,
    setCapabilityOverride,
    serverDefault,
    serverDefaultProfileNotice,
    adoptServerDefaultProfile,
    dismissServerDefaultProfileNotice,
    credential,
  } = useConnectionProfiles({ isDesktopRuntime });
  const originNotice = useInsecureOriginNotice(serverDefault.containerized);
  // The transient tier. Publication is threaded into the feature hooks below as
  // an ordinary callback, the same way `onError` and `onTraceSaved` already
  // are, so every toast in the app has a reviewable path from cause to message.
  const toasts = useToasts();
  const finishedBatchesRef = useRef<FinishedBatch[]>([]);
  const [finishedBatchCount, setFinishedBatchCount] = useState(0);
  const [toolRegistry, setToolRegistry] = useState<ToolRegistryV1>(
    emptyToolRegistry(),
  );
  const [toolRegistryLoaded, setToolRegistryLoaded] = useState(false);
  const [toolRegistryOpen, setToolRegistryOpen] = useState(false);
  const [n8nImportOpen, setN8nImportOpen] = useState(false);
  const [confirmation, setConfirmation] =
    useState<ConfirmationDialogRequest>();
  const [projectCreationMode, setProjectCreationMode] =
    useState<"new" | "save">();
  const [connectionDrawerOpen, setConnectionDrawerOpen] = useState(false);
  const [pendingReadinessDestination, setPendingReadinessDestination] =
    useState<ReadinessDestination>();
  const [runHistoryOpen, setRunHistoryOpen] = useState(false);
  // Set once the suite editor's past-execution list has been expanded. Listing
  // costs a full parse of every artifact in the project folder, so neither
  // surface being open means no listing happens at all.
  const [suiteHistoryRequested, setSuiteHistoryRequested] = useState(false);
  // Separate from the latch above: the listing stays cached once requested, but
  // the disclosure can be closed again, and it has to survive the Evaluations
  // mode unmounting while another mode is on screen.
  const [suiteHistoryExpanded, setSuiteHistoryExpanded] = useState(false);
  // The Evaluations mode's own open regions, held here for the same reason as
  // the disclosure above: the mode unmounts whenever another one is on screen.
  const [evaluationSetupOpen, setEvaluationSetupOpen] = useState(true);
  const [evaluationPreviewOpen, setEvaluationPreviewOpen] = useState(true);
  const [savedRunVersion, setSavedRunVersion] = useState(0);
  // Bumped when an import lands in the composer's message list, so the composer
  // returns to Messages and the newly imported snapshot is on screen. This used
  // to ride on the presence of the import notice, which stopped being possible
  // once that notice became a toast with no state behind it.
  const [importedRevision, setImportedRevision] = useState(0);
  const clearTemplateOverridesRef = useRef<() => void>(() => {});
  const [workbenchView, setWorkbenchView] =
    useState<WorkbenchView>("request");
  // Navigation state, deliberately transient: a reload lands on Compose rather
  // than reopening onto a project that may no longer hold what was selected.
  // Each mode's sub-state lives in the feature hooks above this line, so
  // switching modes and back is lossless for as long as the app is open.
  const [mode, setMode] = useState<AppMode>("compose");
  // The batch the user has actually looked at in Runs. Without this a finished
  // batch is signalled only by the running dot disappearing, which is
  // indistinguishable from nothing having happened.
  const [viewedExperimentId, setViewedExperimentId] = useState<string>();
  const [traceOpen, setTraceOpen] = useState(false);
  // A comparison is unmounted while its evidence is read in Compose. Retain
  // this tiny target at the route boundary so closing that trace returns to
  // the same case and repetition instead of silently resetting to repetition 1.
  const [comparisonReturnTarget, setComparisonReturnTarget] = useState<EvaluationComparisonReturnTarget>();
  const [comparisonTraceOpen, setComparisonTraceOpen] = useState(false);
  const [promotion, setPromotion] = useState<{ trace: RunTrace; experimentCellId?: string }>();
  const [caseSource, setCaseSource] = useState<EvaluationCaseSource>();
  const [outputFollowing, setOutputFollowing] = useState(true);
  const [markdownPreview, setMarkdownPreview] = useState(true);
  const [markdownPreviewLoaded, setMarkdownPreviewLoaded] = useState(false);
  const [streamingPreferred, setStreamingPreferred] = useState(true);
  const [streamingPreferenceLoaded, setStreamingPreferenceLoaded] =
    useState(false);
  const streamingPreferenceChangedRef = useRef(false);
  const project = useProjectWorkspace({
    activeProfile,
    profiles,
    profilesLoaded,
    onActivateProfile: selectProfile,
    folderAccessAvailable,
    createFreshProject() {
      return createProjectFile({
        name: "Untitled Inference Lens project",
        request: {
          provider: "openai-compatible",
          endpoint: activeProfile.endpoint,
          model: activeProfile.model,
          messages: createInitialMessages(chooseDefaultUserPrompt()),
          temperature: activeProfile.temperature,
          responseMode: activeResponseMode,
          capabilities: activeCapabilities,
        },
      });
    },
    createProject() {
      return createProjectFile({
        name: "Untitled Inference Lens project",
        request: currentRequest(),
      });
    },
    currentDraft() {
      const activeRevision = projectFile?.conversationRevisions.find(
        ({ id }) => id === projectFile.defaults.conversationRevisionId,
      );
      return {
        messages,
        ...(activeRevision ? { items: activeRevision.items } : {}),
        model: activeModel,
        temperature: activeTemperature,
        tools: serializedTools(),
        toolMocks,
        enabledToolIds,
      };
    },
    onApplyDraft(draft) {
      replaceProjectDraft(draft);
      clearTemplateOverridesRef.current();
      setBranchContext(null);
      setSessionModel(draft.model);
      setSessionTemperature(draft.temperature);
      runSession.reset();
    },
    onSaved({ name, destination }) {
      toasts.publish({
        key: "project-saved",
        title: `Saved “${name}”`,
        detail:
          destination === "folder"
            ? "Written to the project folder."
            : "Downloaded as a project file.",
        durableHome: "the project name in the topbar, which drops its unsaved marker",
      });
    },
  });
  const {
    projectFile,
    projectWorkspace,
    projectDirty,
    projectError,
    projectErrorKind,
    mappedProfileIds,
  } = project;
  const runHistory = useProjectRunHistory(
    projectWorkspace,
    runHistoryOpen || suiteHistoryRequested,
    savedRunVersion,
  );
  // Named baselines are annotations over the same artifacts the history
  // listing reads, so they share its reader rather than opening the folder a
  // second time with its own idea of what is in it.
  const evaluationBaselines = useEvaluationBaselines({
    workspace: projectWorkspace,
    readExperiment: runHistory.readExperiment,
    findExperiment: (baseline) =>
      runHistory.experiments.find(
        (item): item is Extract<typeof item, { kind: "evaluation" }> =>
          item.kind === "evaluation" && item.experimentId === baseline.experimentId,
      ),
  });
  const {
    messages,
    tools,
    toolMocks,
    enabledToolIds,
    requestTools,
    serializedTools,
    resolvedTools,
    resetMessages,
    addMessage,
    removeMessage,
    updateMessage,
    addTool,
    updateTool,
    removeTool,
    moveTool,
    setToolEnabled,
    mockForTool,
    updateToolMock,
    attachRegistryToolToProject,
    attachRegistryToolToRequest,
    removeRequestTool,
    clearRequestTools,
    replaceProjectDraft,
  } = useRequestDraft({
    initialMessages: createInitialMessages(),
    onProjectDirty: project.markDirty,
    onProjectError: project.setError,
  });
  // Device-local execution capability. Owned here only long enough to be
  // joined with the project's mocks below: what serves a tool is one question,
  // and the run session must not have to ask it twice.
  const commandTools = useCommandTools();
  const runSession = useRunSession({
    transport: inferenceTransport,
    prepareCredential: credential.prepare,
    tools,
    bindingForTool: (toolId) =>
      toolBindingFor(toolId, mockForTool(toolId), commandTools.bindingFor(toolId)),
    readTrace: runHistory.readTrace,
    onShowResponse() {
      setWorkbenchView("response");
      setOutputFollowing(true);
    },
    onOpenTrace() {
      setWorkbenchView("inspect");
      setTraceOpen(true);
    },
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    onResetBranch() { setBranchContext(null); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onClearError() { project.setError(undefined, { clearKind: true }); },
  });
  const { runState, isRequestActive, toolResultDrafts, traceStorage,
    hasDiagnosticCapture, visibleBranchProvenance, parentTrace, transcript } = runSession;
  const repeatedExperiment = useRepeatedExperimentSession({
    transport: inferenceTransport,
    prepareCredential: credential.prepare,
    bindingForTool: (toolId) =>
      toolBindingFor(toolId, mockForTool(toolId), commandTools.bindingFor(toolId)),
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onOpenTrace(trace, origin) { runSession.adoptTrace(trace, origin); },
    onFinished({ experimentId, repetitions }) {
      finishedBatchesRef.current.push({ kind: "repeated", experimentId, repetitions });
      setFinishedBatchCount((current) => current + 1);
    },
  });
  const evaluationExecution = useEvaluationExecutionSession({
    transport: inferenceTransport,
    prepareCredential(target) {
      const profile = profiles.find(
        ({ id }) => createEntityId("profile", id) === target.profileId,
      );
      if (!profile) return Promise.reject(new Error(`No mapped profile exists for ${target.profileId}.`));
      return credential.prepareForProfile(profile.id, target.endpoint);
    },
    onTraceSaved() { setSavedRunVersion((current) => current + 1); },
    onError(message) { project.setError(message, { clearKind: true }); },
    onOpenTrace(trace, origin) { runSession.adoptTrace(trace, origin); },
    onFinished({ experimentId }) {
      finishedBatchesRef.current.push({ kind: "evaluation", experimentId });
      setFinishedBatchCount((current) => current + 1);
    },
  });
  // Reinterpreting a finished evaluation is its own feature with its own state,
  // so the route only joins it to the execution it reads and the project it can
  // write a correction into.
  const evaluationReassessment = useEvaluationReassessment({
    ...(evaluationExecution.execution ? { execution: evaluationExecution.execution } : {}),
    project: projectFile,
    adoptProjectMutation: project.adoptProjectMutation,
  });
  const [sessionModel, setSessionModel] = useState<string>();
  const [sessionTemperature, setSessionTemperature] = useState<number>();
  const adHocConversationIdRef = useRef<ConversationId | null>(null);
  const outputScrollRef = useRef<HTMLDivElement | null>(null);
  const [branchContext, setBranchContext] = useState<BranchContext | null>(null);
  const nonBranchableMessageIds = new Set(
    runState?.input?.templateResolutions.flatMap((resolution) =>
      resolution.outputMessageIds.slice(0, -1),
    ) ?? [],
  );

  useEffect(() => {
    const promptId = window.setTimeout(() => {
      resetMessages(createInitialMessages(chooseDefaultUserPrompt()));
    }, 0);
    return () => window.clearTimeout(promptId);
  }, [resetMessages]);

  useEffect(() => {
    const registryId = window.setTimeout(() => {
      setToolRegistry(readToolRegistry());
      setToolRegistryLoaded(true);
    }, 0);
    return () => window.clearTimeout(registryId);
  }, []);

  useEffect(() => {
    const previewId = window.setTimeout(() => {
      const saved = window.localStorage.getItem(MARKDOWN_PREVIEW_STORAGE_KEY);
      if (saved === "raw") setMarkdownPreview(false);
      setMarkdownPreviewLoaded(true);
    }, 0);
    return () => window.clearTimeout(previewId);
  }, []);

  useEffect(() => {
    const preferenceId = window.setTimeout(() => {
      const saved = window.localStorage.getItem(
        STREAMING_PREFERENCE_STORAGE_KEY,
      );
      if (!streamingPreferenceChangedRef.current && saved === "buffered") {
        setStreamingPreferred(false);
      }
      setStreamingPreferenceLoaded(true);
    }, 0);
    return () => window.clearTimeout(preferenceId);
  }, []);

  useEffect(() => {
    if (!markdownPreviewLoaded) return;
    window.localStorage.setItem(
      MARKDOWN_PREVIEW_STORAGE_KEY,
      markdownPreview ? "markdown" : "raw",
    );
  }, [markdownPreview, markdownPreviewLoaded]);

  useEffect(() => {
    if (!streamingPreferenceLoaded) return;
    window.localStorage.setItem(
      STREAMING_PREFERENCE_STORAGE_KEY,
      streamingPreferred ? "streaming" : "buffered",
    );
  }, [streamingPreferred, streamingPreferenceLoaded]);

  function changeStreamingPreference(streaming: boolean): void {
    streamingPreferenceChangedRef.current = true;
    setStreamingPreferred(streaming);
  }

  useEffect(() => {
    if (!toolRegistryLoaded) return;
    writeToolRegistry(toolRegistry);
  }, [toolRegistry, toolRegistryLoaded]);

  const activeModel = sessionModel ?? activeProfile.model;
  const activeTemperature = projectFile
    ? sessionTemperature
    : activeProfile.temperature;
  const activeResponseMode =
    streamingPreferred && activeCapabilities.streaming
      ? "streaming"
      : "buffered";
  const selectedProjectToolCount = tools.filter(({ id }) =>
    enabledToolIds.includes(id),
  ).length;
  const selectedToolCount = selectedProjectToolCount + requestTools.length;
  const unservableToolNames = unservableTools().map(({ name }) => name);
  const { discovery: activeModelDiscovery, loadModels } = useModelDiscovery({
    profileId: activeProfile.id,
    endpoint: activeProfile.endpoint,
    capabilities: activeCapabilities,
    transport: inferenceTransport,
    prepareCredential: credential.prepare,
  });

  function ensureProjectDocument() {
    return projectFile
      ? project.currentProjectDocument()
      : project.materializeProject();
  }

  const projectTemplates = useProjectTemplates({
    projectFile,
    projectDirty,
    messages,
    model: activeModel,
    temperature: activeTemperature,
    serializedTools,
    toolMocks,
    enabledToolIds,
    branchParentRevisionId: branchContext?.parentConversationRevisionId,
    ensureProjectDocument,
    adoptProjectMutation: project.adoptProjectMutation,
    replaceProjectDraft,
    markProjectError: project.setError,
    resetMessages,
    addDraftMessage: addMessage,
    updateDraftMessage: updateMessage,
    removeDraftMessage: removeMessage,
    clearPendingBranch: () => setBranchContext(null),
    requestConfirmation: setConfirmation,
    onImportApplied() {
      setMode("compose");
      setWorkbenchView("request");
      setImportedRevision((current) => current + 1);
      setN8nImportOpen(false);
    },
    onImported({ name, template, variableCount }) {
      toasts.publish({
        key: "prompt-imported",
        title: `Imported prompt “${name}”${template ? "" : " into Messages"}`,
        detail: template
          ? `${variableCount} ${variableCount === 1 ? "variable" : "variables"} imported from the saved execution.`
          : "Execution messages imported into the composer.",
        durableHome: template
          ? "the prompt, in Compose → Prompts"
          : "the imported messages, in Compose → Messages",
        ...(template
          ? {
              action: {
                label: "View prompt",
                onSelect: () =>
                  resolveReadiness({
                    surface: "request",
                    tab: "templates",
                    control: "prompt-library",
                  }),
              },
            }
          : {}),
      });
    },
  });
  const evaluationAuthoring = useEvaluationSuiteAuthoring({
    project: projectFile,
    adoptProjectMutation: project.adoptProjectMutation,
    requestConfirmation: setConfirmation,
    onNotify({ templateName, messageCount, variableCount }) {
      toasts.publish({
        key: "evaluation-input-changed",
        title: `Evaluation input now uses “${templateName}”`,
        detail: `It pins ${messageCount} ${messageCount === 1 ? "message" : "messages"} and ${
          variableCount === 0
            ? "no variables"
            : `${variableCount} ${variableCount === 1 ? "variable" : "variables"}`
        }. Messages was not changed.`,
        durableHome: "the suite's revision picker, which now names this prompt",
      });
    },
  });
  const selectedEvaluationSuite = projectFile?.evaluationSuites.find(
    ({ id }) => id === evaluationAuthoring.suiteId,
  );
  useEffect(() => {
    const suiteId = evaluationAuthoring.suiteId;
    const caseId = evaluationAuthoring.focusedCaseId;
    if (!projectWorkspace || !suiteId || !caseId) {
      return;
    }
    let current = true;
    void readEvaluationCaseSourcesWorkspace(projectWorkspace)
      .then(async (file) => {
        const source = file.sources.find((item) => item.suiteId === suiteId && item.caseId === caseId);
        if (!source) return undefined;
        const trace = parseRunTraceJson(await readRunTraceWorkspace(projectWorkspace, traceFileName(source.runId)));
        if (trace.runId !== source.runId) throw new Error("The source annotation points to a different trace.");
        return source;
      })
      .then((source) => {
        if (current) setCaseSource(source);
      })
      .catch((error) => {
        if (!current) return;
        setCaseSource(undefined);
        toasts.publish({
          key: "evaluation-case-source-unreadable",
          title: "Case source link is unavailable",
          detail: error instanceof Error ? error.message : "The local source annotation or its trace could not be read.",
          durableHome: "the portable case, which remains valid without local evidence",
        });
      });
    return () => { current = false; };
  }, [evaluationAuthoring.focusedCaseId, evaluationAuthoring.suiteId, projectFile, projectWorkspace, toasts.publish]);
  useEffect(() => {
    clearTemplateOverridesRef.current = projectTemplates.clearTransientOverrides;
  }, [projectTemplates.clearTransientOverrides]);

  const { output, reasoning, status } = (() => {
    const attempts =
      runState?.turns.flatMap((turn) => {
        const latest = turn.attempts.at(-1);
        return latest ? [latest] : [];
      }) ?? [];
    return {
      output: attempts.map((attempt) => attempt.text).join(""),
      reasoning: attempts.map((attempt) => attempt.reasoning).join(""),
      status: displayStatus(runState),
    };
  })();

  const completedToolCalls = runState?.turns.flatMap(
    (turn) => turn.attempts.at(-1)?.completedToolCalls ?? [],
  ) ?? [];

  useEffect(() => {
    if (!outputFollowing) return;
    const frame = window.requestAnimationFrame(() => {
      const element = outputScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [completedToolCalls.length, output, outputFollowing, reasoning]);

  function updateOutputFollowState(): void {
    const element = outputScrollRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setOutputFollowing(distanceFromBottom < 56);
  }

  function jumpToLatestOutput(): void {
    const element = outputScrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setOutputFollowing(true);
  }

  function currentRequest(): RichInferenceRequest {
    return {
      provider: "openai-compatible",
      endpoint: activeProfile.endpoint,
      model: activeModel,
      messages,
      temperature: activeTemperature,
      responseMode: activeResponseMode,
      capabilities: activeCapabilities,
    };
  }

  function templateRequestPreview():
    | { body: unknown; messages: ConversationMessage[] }
    | { error: string }
    | undefined {
    if (!projectFile || !projectTemplates.activeProjectRevision) {
      return undefined;
    }
    if (projectTemplates.templateWorkbench.resolutionError) {
      return { error: projectTemplates.templateWorkbench.resolutionError };
    }
    const resolution = projectTemplates.templateWorkbench.resolution;
    if (!resolution) return undefined;
    try {
      const request = {
        ...currentRequest(),
        messages: resolution.messages,
      };
      const execution = createSingleTurnRunExecution(
        request,
        {
          conversationId: projectTemplates.activeProjectRevision.conversationId,
          conversationRevisionId: projectTemplates.activeProjectRevision.id,
        },
        "template-preview",
        "1970-01-01T00:00:00.000Z",
        [...resolvedTools(), ...requestTools],
        resolution.templateResolutions,
      );
      return {
        messages: resolution.messages,
        body: buildChatCompletionsRequest({
          runId: execution.runId,
          turnId: execution.turnId,
          exchangeId: execution.exchangeId,
          attempt: execution.attempt,
          input: execution.turnInput,
        }).body,
      };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Could not build request preview.",
      };
    }
  }

  function editFromHere(messageId: MessageId): void {
    if (!runState || !["completed", "cancelled", "failed"].includes(runState.status.kind)) {
      return;
    }
    const index = transcript.findIndex(({ message }) => message.id === messageId);
    if (index < 0) return;
    resetMessages(
      structuredClone(transcript.slice(0, index + 1).map(({ message }) => message)),
    );
    setBranchContext({
      parentRunId: runState.runId,
      parentConversationRevisionId: runState.input?.conversationRevisionId,
      branchMessageId: messageId,
      parentTraceNeedsSaving:
        traceStorage?.kind === "unsaved" || traceStorage?.kind === "error",
    });
    setWorkbenchView("request");
  }

  function setEditorModel(model: string): void {
    if (projectFile) {
      setSessionModel(model);
      project.markDirty();
    } else {
      updateActiveProfile({ model });
    }
  }

  function setEditorTemperature(temperature: number | undefined): void {
    if (projectFile) {
      setSessionTemperature(temperature);
      project.markDirty();
    } else {
      updateActiveProfile({ temperature });
    }
  }

  function chooseProfile(profileId: string): void {
    if (!profiles.some(({ id }) => id === profileId)) return;
    selectProfile(profileId);
  }

  /**
   * Deletion is confirmed rather than undoable: the profile's credential is
   * destroyed with it, and nothing in the UI could put a keychain secret back.
   */
  function confirmDeleteActiveProfile(): void {
    const profileId = activeProfile.id;
    setConfirmation({
      title: `Delete "${activeProfile.name || "Untitled profile"}"?`,
      description:
        "This connection and any credential stored for it on this device are removed. Saved run traces keep the connection they recorded.",
      confirmLabel: "Delete profile",
      destructive: true,
      details: [
        { label: "Endpoint", value: activeProfile.endpoint },
        { label: "Model", value: activeProfile.model || "none" },
      ],
      onConfirm() {
        removeActiveProfile();
        // A project mapped to this profile is left unmapped, which restores the
        // prompt to choose one instead of running against a connection the user
        // never picked.
        project.unmapProfile(profileId);
      },
    });
  }

  /**
   * Re-points the project's declared connection at the mapped profile, after
   * showing what is being replaced. The declaration travels in the shared
   * project file and the previous value is not recoverable from the UI, so the
   * old and new endpoints are put side by side before the write.
   */
  function confirmUpdateProjectEndpoint(requirementId: string): void {
    const requirement = projectFile?.connectionRequirements.find(({ id }) => id === requirementId);
    const mappedProfile = profiles.find(({ id }) => id === mappedProfileIds[requirementId]);
    if (!requirement || !mappedProfile) return;
    const endpoint = mappedProfile.endpoint;
    setConfirmation({
      title: "Update the project's declared endpoint?",
      description:
        "The project file records the new endpoint. Anyone you share it with sees this connection instead. Credentials are never written to the project.",
      confirmLabel: "Update project",
      details: [
        { label: "Currently declares", value: requirement.endpoint },
        { label: "Change to", value: endpoint },
      ],
      onConfirm() {
        try {
          project.adoptProjectMutation(
            updateConnectionRequirementEndpoint(
              project.currentProjectDocument(),
              requirement.id,
              endpoint,
            ),
          );
        } catch (error) {
          project.setError(
            error instanceof Error
              ? error.message
              : "Could not update the project's declared endpoint.",
          );
        }
      },
    });
  }

  function changeCapability(
    key: keyof ProviderCapabilities,
    enabled: boolean,
  ): void {
    setCapabilityOverride(key, enabled);
    // Allowing tools resolves the only project failure the toggle can cause.
    if (key === "tools" && enabled) project.clearToolsDisabledError();
  }

  async function run() {
    repeatedExperiment.clear();
    evaluationExecution.clear();
    project.clearErrorKind();
    const activeRequirementId = projectTemplates.activeConnectionRequirement?.id;
    const mappedProfileId = activeRequirementId ? mappedProfileIds[activeRequirementId] : undefined;
    if (projectFile && mappedProfileId !== activeProfile.id) {
      project.setError(
        mappedProfileId
          ? "Activate this project's mapped connection before running."
          : "Map this project's connection to a local profile before running.",
      );
      return;
    }
    const requestSnapshot = currentRequest();
    const prepared = prepareWorkbenchRun({
      request: requestSnapshot,
      project: projectFile ?? undefined,
      projectTools: resolvedTools(),
      requestTools,
      capabilities: activeCapabilities,
      profileName: activeProfile.name,
      branchContext: branchContext ?? undefined,
      templateRunOverrides: projectTemplates.templateRunOverrides,
      adHocConversationId: adHocConversationIdRef.current ?? undefined,
    });
    if (!prepared.ok) {
      if (prepared.errorKind === "tools-disabled") {
        project.setToolsDisabledError(prepared.message);
      } else {
        project.setError(prepared.message);
      }
      return;
    }
    if (prepared.projectMutation) project.adoptBranchRevision(prepared.projectMutation);
    if (prepared.executedRevisionId) {
      projectTemplates.markExecutedRevision(prepared.executedRevisionId);
    }
    if (prepared.adHocConversationId) {
      adHocConversationIdRef.current = prepared.adHocConversationId;
    }
    if (prepared.consumesPendingBranch) setBranchContext(null);
    const input = prepared.input;
    const branchedFrom = prepared.branchedFrom;
    const request = {
      ...requestSnapshot,
      messages: input.messages,
    };
    input.target.profileId = createEntityId("profile", activeProfile.id);
    const sessionStart = runSession.start(input, {
      request,
      workspace: projectWorkspace,
      ...(branchedFrom ? { branchedFrom } : {}),
    });
    clearRequestTools();
    await sessionStart;
  }

  /**
   * The exposed tools nothing on this device can serve.
   *
   * A batch answers its own tool calls, so a tool with no binding would stop
   * every repetition at a call nobody is watching. This is the gate the plan
   * calls "every exposed tool has an automatically resolvable binding" — mock
   * or command; MCP will satisfy it later without changing this.
   */
  function unservableTools(): ToolDefinition[] {
    return [...resolvedTools(), ...requestTools].filter(
      ({ id }) => !toolBindingFor(id, mockForTool(id), commandTools.bindingFor(id)),
    );
  }

  function unservableToolsMessage(unservable: readonly ToolDefinition[]): string {
    const names = unservable.map(({ name }) => name).join(", ");
    // The shell statement is inherited, not restated: a repetition that would
    // run a command tool cannot run at all where nothing can spawn.
    const shell = commandToolUnavailableMessage(commandTools);
    return `A repeated experiment answers its own tool calls, and nothing on this device serves ${names}. Enable a mock or grant a command tool first.${shell ? ` ${shell}` : ""}`;
  }

  function repeat(): void {
    evaluationExecution.clear();
    project.clearErrorKind();
    const unservable = unservableTools();
    if (unservable.length > 0) {
      project.setError(unservableToolsMessage(unservable));
      return;
    }
    const activeRequirementId = projectTemplates.activeConnectionRequirement?.id;
    const mappedProfileId = activeRequirementId ? mappedProfileIds[activeRequirementId] : undefined;
    if (projectFile && mappedProfileId !== activeProfile.id) {
      project.setError(
        mappedProfileId
          ? "Activate this project's mapped connection before running."
          : "Map this project's connection to a local profile before running.",
      );
      return;
    }
    const requestSnapshot = currentRequest();
    const prepared = prepareWorkbenchRun({
      request: requestSnapshot,
      project: projectFile ?? undefined,
      projectTools: resolvedTools(),
      requestTools,
      capabilities: activeCapabilities,
      profileName: activeProfile.name,
      branchContext: branchContext ?? undefined,
      templateRunOverrides: projectTemplates.templateRunOverrides,
      adHocConversationId: adHocConversationIdRef.current ?? undefined,
    });
    if (!prepared.ok) {
      if (prepared.errorKind === "tools-disabled") project.setToolsDisabledError(prepared.message);
      else project.setError(prepared.message);
      return;
    }
    const input = {
      ...prepared.input,
      target: {
        ...prepared.input.target,
        profileId: createEntityId("profile", activeProfile.id),
      },
    };
    repeatedExperiment.begin(input, activeProfile.name || "Untitled profile", () => {
      if (prepared.projectMutation) project.adoptBranchRevision(prepared.projectMutation);
      if (prepared.executedRevisionId) projectTemplates.markExecutedRevision(prepared.executedRevisionId);
      if (prepared.adHocConversationId) adHocConversationIdRef.current = prepared.adHocConversationId;
      if (prepared.consumesPendingBranch) setBranchContext(null);
      clearRequestTools();
      runSession.reset();
      setTraceOpen(false);
      // A batch's results are read in the Runs mode, so the batch opens there
      // rather than displacing whatever the current pane was showing.
      setMode("runs");
    });
  }

  function startEvaluation(): void {
    project.clearErrorKind();
    if (evaluationStartDisabledReason) {
      project.setError(evaluationStartDisabledReason);
      return;
    }
    if (!projectFile || !selectedEvaluationSuite || !evaluationAuthoring.revisionId) return;
    try {
      evaluationExecution.begin(createEvaluationStartDraft({
        project: projectFile,
        suiteId: selectedEvaluationSuite.id,
        selectedCaseIds: [...evaluationAuthoring.selectedCaseIds],
        selectedVariantIds: [...evaluationAuthoring.selectedVariantIds],
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          endpoint: profile.endpoint,
          capabilities: resolveProviderCapabilities(profile.provider, profile.capabilityOverrides),
        })),
        mappedProfileIds,
        durable: Boolean(projectWorkspace),
        bindingForTool: (toolId) =>
          toolBindingFor(toolId, mockForTool(toolId), commandTools.bindingFor(toolId)),
      }));
    } catch (error) {
      project.setError(error instanceof Error ? error.message : "Could not prepare the evaluation.");
    }
  }

  function confirmEvaluation(): void {
    runSession.reset();
    repeatedExperiment.clear();
    setTraceOpen(false);
    setMode("runs");
    void evaluationExecution.confirm(projectWorkspace);
  }

  async function continueRun(): Promise<void> {
    return runSession.continueRun();
  }

  async function retryRun(): Promise<void> {
    return runSession.retry();
  }

  function stop() {
    runSession.stop();
  }

  function downloadDiagnostics() {
    runSession.downloadDiagnostics();
  }
  async function openHistoryTrace(item: ProjectRunHistoryItem): Promise<void> {
    const workspace = projectWorkspace;
    if (!workspace) throw new Error("The project folder is no longer open.");
    runSession.adoptTrace(await runHistory.readTrace(item.fileName), {
      workspace,
      fileName: item.fileName,
    });
    repeatedExperiment.clear();
    evaluationExecution.clear();
    // A single saved run reads in the response pane, which belongs to Compose.
    setMode("compose");
    setRunHistoryOpen(false);
  }
  async function openHistoryExperiment(item: ProjectExperimentHistoryItem): Promise<void> {
    const workspace = projectWorkspace;
    if (!workspace) throw new Error("The project folder is no longer open.");
    const opened = await runHistory.readExperiment(item);
    if (opened.plan.kind === "evaluation") {
      evaluationExecution.openSaved({ ...opened, plan: opened.plan }, workspace);
      repeatedExperiment.clear();
    } else {
      repeatedExperiment.openSaved(opened, workspace);
      evaluationExecution.clear();
    }
    runSession.reset();
    setMode("runs");
    setRunHistoryOpen(false);
  }
  /**
   * Releases a finished batch from the response pane. A durable batch is
   * written to the project folder and reopens from run history, so dismissing
   * it is navigation. An unsaved one exists only in this session's state, and
   * clearing it is the last copy — that case is confirmed first.
   */
  function dismissFinishedExperiment(kind: "evaluation" | "repeated"): void {
    const session = kind === "evaluation" ? evaluationExecution : repeatedExperiment;
    // Releasing a batch leaves the Runs mode with nothing to show, so it also
    // returns to wherever the batch was started from.
    const clear = () => {
      session.clear();
      setMode(kind === "evaluation" ? "evaluations" : "compose");
    };
    if (!session.execution || session.execution.storage === "durable") {
      clear();
      return;
    }
    setConfirmation({
      title: kind === "evaluation" ? "Discard these evaluation results?" : "Discard these experiment results?",
      description:
        "This batch was never saved to a project folder, so its runs cannot be reopened from run history once they are cleared.",
      confirmLabel: "Discard results",
      destructive: true,
      onConfirm: clear,
    });
  }
  const experimentActive = repeatedExperiment.isRunning || evaluationExecution.isRunning;
  const openExperimentId =
    evaluationExecution.execution?.plan.experimentId ??
    repeatedExperiment.execution?.plan.experimentId;
  // "Unread" is which batch was last seen, not a flag raised when one finishes.
  // A flag would have to be lowered by an effect and would re-raise itself
  // every time the user left Runs; identity cannot drift that way.
  //
  // Adjusted during render rather than in an effect, as the composer does for
  // its focus mode: while Runs is on screen and nothing is still running, what
  // it shows is by definition read, and the discarded state never reaches the
  // DOM.
  if (mode === "runs" && !experimentActive && openExperimentId !== viewedExperimentId) {
    setViewedExperimentId(openExperimentId);
  }
  const runsUnread =
    Boolean(openExperimentId) && !experimentActive && openExperimentId !== viewedExperimentId;

  const runReachedTerminalStatus = Boolean(
    runState &&
      ["completed", "cancelled", "failed"].includes(runState.status.kind),
  );
  const requestPreview = templateRequestPreview();
  const composerItems = projectTemplates.templateWorkbench.composerItems;
  const readiness = runReadiness({
    projectOpen: Boolean(projectFile),
    connectionMapped: projectTemplates.activeConnectionRequirement
      ? mappedProfileIds[projectTemplates.activeConnectionRequirement.id] === activeProfile.id
      : true,
    activeProfileName: activeProfile.name,
    activeProfileEndpoint: activeProfile.endpoint,
    activeProfileModel: activeModel,
    selectedToolCount,
    toolsEnabled: activeCapabilities.tools,
    ...(projectTemplates.activeConnectionRequirement
      ? {
          requiredEndpoint: projectTemplates.activeConnectionRequirement.endpoint,
          activeConnectionRequirementId: projectTemplates.activeConnectionRequirement.id,
        }
      : {}),
    ...(projectTemplates.templateWorkbench.resolutionError
      ? { templateResolutionError: projectTemplates.templateWorkbench.resolutionError }
      : {}),
    templateIssues:
      projectTemplates.templateWorkbench.resolution?.diagnostics.map(
        ({ templateUseId, diagnostic }) => ({
          templateUseId,
          ...(diagnostic.code === "missing-template-variable"
            ? { variableName: diagnostic.name }
            : {}),
        }),
      ) ?? [],
    templateTargets:
      composerItems.flatMap((item) => {
        if (item.kind !== "template-use") return [];
        const template = projectFile?.promptTemplates.find(
          ({ id }) => id === item.use.templateId,
        );
        const target = template?.recommendedTarget;
        if (!template || !target) return [];
        const requirement = projectFile?.connectionRequirements.find(
          ({ id }) => id === target.connectionRequirementId,
        );
        return [
          {
            templateName: template.name,
            connectionRequirementId: target.connectionRequirementId,
            connectionRequirementName:
              requirement?.name ?? target.connectionRequirementId,
            model: target.model,
          },
        ];
      }) ?? [],
  });

  function resolveReadiness(destination: ReadinessDestination): void {
    setPendingReadinessDestination(destination);
    if (destination.surface === "connections") {
      setConnectionDrawerOpen(true);
    } else {
      // Every request-surface destination names a control in the composer, so
      // the routing has to cross the mode boundary before it can focus one.
      setMode("compose");
      setWorkbenchView("request");
    }
  }
  const responseEmptyState = runEmptyStatePresentation(readiness);
  // The device-local half of a suite's tool exposure, joined once for the three
  // surfaces that need it: the editor's listing, the start gate, and the
  // confirmation. Every project tool is resolved, not only the exposed ones, so
  // the editor can say what a tool would be served by before it is checked.
  const evaluationSuiteToolBindings = listExperimentToolBindings(
    projectFile?.tools ?? [],
    (toolId) => toolBindingFor(toolId, mockForTool(toolId), commandTools.bindingFor(toolId)),
  );
  const commandToolsUnavailableReason = commandToolUnavailableMessage(commandTools);
  const evaluationLocalProfiles = profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    endpoint: profile.endpoint,
    capabilities: resolveProviderCapabilities(profile.provider, profile.capabilityOverrides),
  }));
  const evaluationLocalTargets = projectFile && selectedEvaluationSuite
    ? resolveEvaluationLocalTargets({
        project: projectFile,
        suiteId: selectedEvaluationSuite.id,
        selectedVariantIds: [...evaluationAuthoring.selectedVariantIds],
        profiles: evaluationLocalProfiles,
        mappedProfileIds,
      })
    : [];
  const evaluationStartDisabledReason = evaluationStartReadiness({
    projectOpen: Boolean(projectFile),
    suiteSelected: Boolean(evaluationAuthoring.suiteId),
    revisionSelected: Boolean(evaluationAuthoring.revisionId),
    revisionAvailable: Boolean(projectFile?.conversationRevisions.some(
      ({ id }) => id === evaluationAuthoring.revisionId,
    )),
    diagnostics: evaluationAuthoring.diagnostics,
    selectedCaseCount: evaluationAuthoring.selectedCaseIds.size,
    selectedVariantCount: evaluationAuthoring.selectedVariantIds.size,
    repetitions: selectedEvaluationSuite?.execution.repetitions ?? 1,
    toolBindings: evaluationSuiteToolBindings
      .filter(({ tool }) => selectedEvaluationSuite?.execution.toolIds.includes(tool.id))
      .map(({ tool, binding }) => ({ name: tool.name, bound: Boolean(binding) })),
    ...(commandToolsUnavailableReason ? { commandToolsUnavailableReason } : {}),
    ...(selectedEvaluationSuite?.execution.turnCeiling === undefined
      ? {}
      : { turnCeiling: selectedEvaluationSuite.execution.turnCeiling }),
    targets: evaluationLocalTargets,
    activityInProgress: isRequestActive || repeatedExperiment.isRunning || evaluationExecution.isRunning,
  }).blockedReason;

  // One object, two panes: the composer's preflight and the response pane's
  // provider-input preview must report the same target and settings, so they
  // read the same value rather than each assembling their own.
  const evaluationExecutionActions: EvaluationSuiteExecutionActions = {
    storage: projectWorkspace ? "durable" : "unsaved",
    running: evaluationExecution.isRunning,
    preview: {
      targets: evaluationLocalTargets.map((target) => ({
        variantId: target.variantId,
        variantName: target.variantName,
        requirementName: target.requirementName,
        ...(target.profile
          ? { targetName: target.profile.name || "Untitled profile", endpoint: target.profile.endpoint }
          : {}),
        protocol: "openai-compatible-chat-completions",
        model: target.model,
        responseMode: target.responseMode,
        options: target.options,
        streamingAvailable: target.profile?.capabilities.streaming ?? false,
      })),
    },
    ...(evaluationStartDisabledReason ? { disabledReason: evaluationStartDisabledReason } : {}),
    onStart: startEvaluation,
    toolBindings: evaluationSuiteToolBindings,
    ...(commandToolsUnavailableReason ? { commandToolsUnavailableReason } : {}),
  };

  // Cross-feature adapter: saved executions are project-workspace evidence and
  // the suite being authored is authoring state, so scoping one to the other
  // belongs to the route rather than to either owner. Executions are matched by
  // suite identity across every input revision — a run against an older
  // revision is still this suite's evidence, and the editor marks it as drifted
  // rather than hiding it.
  const evaluationHistory: EvaluationSuiteHistoryHandle | undefined = projectWorkspace
    ? {
        status: runHistory.status,
        executions: runHistory.experiments.filter(
          (item): item is Extract<typeof item, { kind: "evaluation" }> =>
            item.kind === "evaluation" && item.evaluation.suiteId === selectedEvaluationSuite?.id,
        ),
        ...(runHistory.error ? { error: runHistory.error } : {}),
        ...(evaluationAuthoring.revisionId
          ? { currentRevisionId: evaluationAuthoring.revisionId }
          : {}),
        expanded: suiteHistoryExpanded,
        onExpandedChange: setSuiteHistoryExpanded,
        onExpand: () => {
          setSuiteHistoryRequested(true);
          evaluationBaselines.load();
        },
        onRefresh: () => void runHistory.refresh(),
        onOpen: (item) => openHistoryExperiment(item),
        baselines: {
          items: evaluationBaselines.forSuite(selectedEvaluationSuite?.id),
          ...(evaluationBaselines.error ? { error: evaluationBaselines.error } : {}),
          busy: evaluationBaselines.comparing,
          onPin: (item, variantId, name) => evaluationBaselines.pin(item, variantId, name),
          onUnpin: (baselineId) => evaluationBaselines.unpin(baselineId),
          onCompare: async (baseline, candidate, candidateVariantId) => {
            await evaluationBaselines.compare(baseline, candidate, candidateVariantId);
            // A comparison is a results surface, so anything else holding the
            // Runs mode is released the same way opening a saved execution does.
            repeatedExperiment.clear();
            evaluationExecution.clear();
            runSession.reset();
            setMode("runs");
          },
        },
      }
    : undefined;

  const onContextualRunShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
    event.preventDefault();
    if (
      confirmation ||
      repeatedExperiment.draft ||
      evaluationExecution.draft ||
      isRequestActive ||
      repeatedExperiment.isRunning ||
      evaluationExecution.isRunning
    ) return;
    // Each mode's primary action is what the shortcut fires. Runs has none:
    // it is where results are read, not where work is started.
    if (mode === "evaluations") {
      if (!evaluationStartDisabledReason) startEvaluation();
      return;
    }
    if (mode !== "compose") return;
    if (readiness?.blocked) return;
    if (runState?.status.kind === "paused" && runState.status.reason === "attempt_failed") {
      void retryRun();
    } else if (runState?.status.kind !== "awaiting_tool_results") {
      void run();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onContextualRunShortcut);
    return () => window.removeEventListener("keydown", onContextualRunShortcut);
  }, []);

  /**
   * What the Runs dot says. A running batch outranks an unread one because it
   * is the thing still changing; an unread evaluation is coloured by its own
   * pass rate, and anything that decided nothing — an interrupted batch, a
   * repeated experiment, a comparison — stays neutral rather than borrowing a
   * verdict it does not have.
   */
  function runsIndicator(): ModeIndicator | undefined {
    if (experimentActive) return { tone: "running", label: "running" };
    if (!runsUnread) return undefined;
    const evaluation = evaluationExecution.execution;
    if (evaluation && !evaluation.error) {
      try {
        const score = evaluationExperimentAggregate(
          evaluation.plan,
          evaluation.result,
          evaluation.states,
        );
        const active = score.variants[0];
        return active ? {
          tone: indicatorToneForPassTone[evaluationPassTone(active)],
          label: score.variants.length === 1
            ? `finished, ${evaluationPassSummary(active)}, not yet viewed`
            : `finished, ${active.variant.name}: ${evaluationPassSummary(active)}, not yet viewed`,
        } : { tone: "neutral", label: "finished, not yet viewed" };
      } catch {
        // An aggregate that cannot be derived is not a failed batch. The dot
        // says there is something to read and lets the workspace explain it.
        return { tone: "neutral", label: "finished, not yet viewed" };
      }
    }
    return { tone: "neutral", label: "finished, not yet viewed" };
  }

  /**
   * Tells the user a batch they started has finished, and offers the one
   * click that gets them to it.
   *
   * This is the affordance the Runs mode was made conditional on: results no
   * longer appear in the pane the user was looking at, so a batch that finishes
   * while they are composing would otherwise be signalled only by a dot on the
   * mode strip. Nothing here is the sole carrier — the dot is still there, and
   * it does not expire — but the dot cannot interrupt and this can.
   *
   * Suppressed while Runs is already on screen: the results are being watched
   * live, and an action that navigates to where the user already is would be a
   * message about nothing.
   */
  const announceFinishedBatch = useEffectEvent((batch: FinishedBatch) => {
    if (mode === "runs") return;
    const viewResults = {
      label: "View results",
      onSelect: () => setMode("runs"),
    };
    if (batch.kind === "repeated") {
      toasts.publish({
        key: `batch-finished:${batch.experimentId}`,
        title: "Repeated experiment finished",
        detail: `${batch.repetitions} ${batch.repetitions === 1 ? "repetition" : "repetitions"} completed.`,
        action: viewResults,
        durableHome: "the Runs mode indicator, until the results are opened",
      });
      return;
    }
    const evaluation = evaluationExecution.execution;
    let detail = "Every selected case has a verdict.";
    if (evaluation?.plan.experimentId === batch.experimentId) {
      try {
        const assessment = evaluationExperimentAggregate(evaluation.plan, evaluation.result, evaluation.states);
        detail = assessment.variants.length
          ? `${assessment.variants.map((variant) => `${variant.variant.name}: ${evaluationPassSummary(variant)}`).join(" · ")}.`
          : detail;
      } catch {
        // An aggregate that cannot be derived is not a failed batch. The toast
        // says there is something to read and lets the workspace explain it.
      }
    }
    toasts.publish({
      key: `batch-finished:${batch.experimentId}`,
      title: "Evaluation finished",
      detail,
      action: viewResults,
      durableHome: "the Runs mode indicator, which also carries the pass rate",
    });
  });
  // The counter is the trigger and the ref is the payload: draining the ref
  // rather than clearing state keeps this effect from scheduling a render of
  // its own, and makes a repeated invocation a no-op because the queue is
  // already empty by then.
  useEffect(() => {
    finishedBatchesRef.current.splice(0).forEach(announceFinishedBatch);
  }, [finishedBatchCount]);

  /**
   * The one banner slot, in priority order.
   *
   * A failure that refuses the user's work outranks an advisory about the
   * environment, which outranks an offer they can take at leisure. Whichever
   * loses is counted by `chooseAppBanner` rather than dropped, and returns to
   * the slot on its own once what outranked it is resolved or dismissed.
   */
  function projectErrorBanner(): AppBannerCandidate | undefined {
    if (!projectError) return undefined;
    return {
      id: "project-error",
      tone: "failure",
      title: projectError,
      actions: [
        ...(projectErrorKind === "workspace-reconnect"
          ? [{
              key: "reconnect",
              label: "Reconnect",
              primary: true,
              onSelect: () => void project.reconnectProjectWorkspace(),
            }]
          : []),
        ...(projectErrorKind === "tools-disabled"
          ? [{
              key: "connection-settings",
              label: "Open connection settings",
              primary: true,
              onSelect: () => setConnectionDrawerOpen(true),
            }]
          : []),
        { key: "dismiss", label: "Dismiss", onSelect: () => project.dismissError() },
      ],
    };
  }

  function insecureOriginBanner(): AppBannerCandidate | undefined {
    const notice = originNotice.notice;
    if (!notice) return undefined;
    return {
      id: "insecure-origin",
      tone: "advisory",
      title: notice.headline,
      detail: notice.detail,
      actions: [
        ...(notice.suggestedUrl
          ? [{
              key: "open",
              label: "Open it",
              primary: true,
              href: notice.suggestedUrl,
              onSelect: originNotice.dismiss,
            }]
          : []),
        { key: "dismiss", label: "Dismiss", onSelect: originNotice.dismiss },
      ],
    };
  }

  function serverDefaultBanner(): AppBannerCandidate | undefined {
    if (!serverDefaultProfileNotice) return undefined;
    return {
      id: "server-default-profile",
      tone: "advisory",
      title: "Server default connection available",
      detail:
        "A profile using this server's configured endpoint was added to Connections.",
      actions: [
        { key: "use", label: "Use it", primary: true, onSelect: adoptServerDefaultProfile },
        {
          key: "review",
          label: "Review",
          onSelect: () => {
            dismissServerDefaultProfileNotice();
            setConnectionDrawerOpen(true);
          },
        },
        { key: "dismiss", label: "Dismiss", onSelect: dismissServerDefaultProfileNotice },
      ],
    };
  }

  const appBanner = chooseAppBanner([
    projectErrorBanner(),
    insecureOriginBanner(),
    serverDefaultBanner(),
  ]);

  function saveOrChooseProjectLocation(): void {
    if (projectWorkspace || !folderAccessAvailable) {
      void project.saveProject();
      return;
    }
    setProjectCreationMode("save");
  }

  // The single-run response and its trace panel are one surface with one
  // owner, mounted by Compose and reused by the Runs mode when a run is
  // selected out of a batch. Composing them once here is what keeps the app
  // from growing a second response implementation.
  const responseSurface = (
    <section className="result">
      <ResponseOutput
        output={output}
        reasoning={reasoning}
        status={status}
        runState={runState}
        isRequestActive={isRequestActive}
        markdownPreview={markdownPreview}
        outputFollowing={outputFollowing}
        outputScrollRef={outputScrollRef}
        completedToolCalls={completedToolCalls}
        toolResultDrafts={toolResultDrafts}
        traceStorage={traceStorage}
        transcript={transcript}
        nonBranchableMessageIds={nonBranchableMessageIds}
        branchedFrom={visibleBranchProvenance}
        emptyState={responseEmptyState}
        onMarkdownPreviewChange={setMarkdownPreview}
        onOutputScroll={updateOutputFollowState}
        onJumpToLatest={jumpToLatestOutput}
        onToolResultDraftChange={runSession.updateToolResultDraft}
        onContinue={() => void continueRun()}
        onRetry={() => void retryRun()}
        onDiscardFailedRun={stop}
        onSaveTrace={() => void runSession.exportTrace()}
        onEditFromHere={editFromHere}
        onEmptyStateAction={() => {
          if (responseEmptyState.action) {
            resolveReadiness(responseEmptyState.action.destination);
          }
        }}
      />
    </section>
  );
  const traceSurface = (
    <RunTracePanel
      open={traceOpen}
      runState={runState}
      branchedFrom={visibleBranchProvenance}
      parentTrace={parentTrace}
      onLoadParentTrace={() => void runSession.loadParentTrace()}
      onOpenChange={(open) => {
        setTraceOpen(open);
        if (!open && comparisonTraceOpen) {
          setComparisonTraceOpen(false);
          setMode("runs");
        }
      }}
      {...(projectFile ? { onPromoteTrace: (trace: RunTrace) => setPromotion({ trace }) } : {})}
    />
  );
  const n8nImportDisabledReason = branchContext
    ? "Finish or discard the pending branch before importing a prompt."
    : Boolean(runState) && !runReachedTerminalStatus
      ? "Finish or stop the current run before importing a prompt."
      : undefined;

  return (
    <main
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          saveOrChooseProjectLocation();
        }
      }}
    >
      <Topbar
        profiles={profiles}
        activeProfile={activeProfile}
        hasCredential={credential.hasCredential}
        projectName={projectFile?.name}
        projectDirty={projectDirty}
        folderAccessAvailable={folderAccessAvailable}
        hasDiagnosticCapture={hasDiagnosticCapture}
        hasRunTrace={runReachedTerminalStatus}
        hasProjectWorkspace={Boolean(projectWorkspace)}
        runHistoryBlocked={(Boolean(runState) && !runReachedTerminalStatus) || repeatedExperiment.isRunning || evaluationExecution.isRunning}
        isRequestActive={isRequestActive}
        isExperimentActive={repeatedExperiment.isRunning || evaluationExecution.isRunning}
        mode={mode}
        onModeChange={setMode}
        modeIndicators={(() => {
          const runs = runsIndicator();
          return runs ? { runs } : {};
        })()}
        awaitingToolResults={runState?.status.kind === "awaiting_tool_results"}
        retryableFailure={
          runState?.status.kind === "paused" &&
          runState.status.reason === "attempt_failed"
        }
        runDisabled={Boolean(readiness?.blocked)}
        runDisabledReasonId={RUN_READINESS_SUMMARY_ID}
        evaluationStartDisabled={Boolean(evaluationStartDisabledReason)}
        evaluationStartDisabledReasonId={EVALUATION_PREFLIGHT_SUMMARY_ID}
        onChooseProfile={chooseProfile}
        onOpenConnections={() => setConnectionDrawerOpen(true)}
        onNewProject={() => setProjectCreationMode("new")}
        onOpenProject={() => void project.openProjectWorkspace()}
        onSaveProject={saveOrChooseProjectLocation}
        onImportProject={(event) => void project.importProject(event)}
        onExportProject={project.exportProject}
        {...(n8nImportDisabledReason ? { n8nImportDisabledReason } : {})}
        onOpenN8nImport={() => setN8nImportOpen(true)}
        onDownloadDiagnostics={downloadDiagnostics}
        onDownloadRunTrace={() => void runSession.exportTrace()}
        onImportRunTrace={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void runSession.importTrace(file);
          }
          event.target.value = "";
        }}
        onOpenRunHistory={() => setRunHistoryOpen(true)}
        onStop={stop}
        onStopExperiment={evaluationExecution.isRunning ? evaluationExecution.cancel : repeatedExperiment.cancel}
        onRun={() => void run()}
        onStartEvaluation={startEvaluation}
      />

      <AppBanner {...(appBanner ? { selection: appBanner } : {})} />

      <ConnectionDrawer
        open={connectionDrawerOpen}
        onClose={() => setConnectionDrawerOpen(false)}
        profiles={profiles}
        activeProfile={activeProfile}
        capabilities={activeCapabilities}
        credential={credential}
        serverDefault={serverDefault}
        isDesktopRuntime={isDesktopRuntime}
        onSelectProfile={chooseProfile}
        onAddProfile={() => {
          addProfile();
        }}
        onDeleteProfile={confirmDeleteActiveProfile}
        deleteProfileRefusal={activeProfileDeletionRefusal}
        onUpdateProfile={updateActiveProfile}
        onCapabilityChange={changeCapability}
        connectionRequirements={projectFile?.connectionRequirements}
        mappedProfileIds={mappedProfileIds}
        onMapProfile={(requirementId, profileId) => {
          const profile = profiles.find(({ id }) => id === profileId);
          if (profile) project.mapProfile(requirementId, profile);
        }}
        onUpdateProjectEndpoint={confirmUpdateProjectEndpoint}
        pendingDestination={pendingReadinessDestination}
        onDestinationHandled={() => setPendingReadinessDestination(undefined)}
      />

      <RunHistoryDrawer
        open={runHistoryOpen}
        projectName={projectFile?.name}
        selectedRunId={runState?.runId}
        selectedExperimentId={evaluationExecution.execution?.plan.experimentId ?? repeatedExperiment.execution?.plan.experimentId}
        history={runHistory}
        onClose={() => setRunHistoryOpen(false)}
        onSelect={(item) => openHistoryTrace(item)}
        onSelectExperiment={(item) => openHistoryExperiment(item)}
      />

      {mode === "compose" ? (
      <WorkbenchShell
        view={workbenchView}
        onViewChange={setWorkbenchView}
        inspectAvailable={Boolean(runState && runState.status.kind !== "not_started")}
        responseStatus={status}
        request={
        <RequestComposer
          requestDraft={{
            messages, tools, requestTools, enabledToolIds, addTool, removeTool, moveTool, updateTool,
            setToolEnabled, mockForTool, updateToolMock, removeRequestTool,
          }}
          commandTools={commandTools}
          templates={projectTemplates}
          project={projectFile}
          projectPersistenceStatus={
            projectErrorKind === "auto-save"
              ? "error"
              : !projectWorkspace
                ? projectDirty ? "session" : "saved"
                : projectDirty ? "saving" : "saved"
          }
          onEvaluatePromptRevision={(templateId, revisionId, suiteId) => {
            const succeeded = evaluationAuthoring.evaluatePromptRevision(templateId, revisionId, suiteId);
            if (!succeeded) return false;
            setMode("evaluations");
            setEvaluationSetupOpen(true);
            return true;
          }}
          onOpenEvaluationSuite={(suiteId) => {
            evaluationAuthoring.selectSuite(suiteId);
            setMode("evaluations");
          }}
          evaluateRevisionError={evaluationAuthoring.savedPromptError}
          onDismissEvaluateRevisionError={evaluationAuthoring.dismissPromptError}
          settings={{
            model: activeModel,
            temperature: activeTemperature,
            responseMode: activeResponseMode,
            streamingAvailable: activeCapabilities.streaming,
            toolsEnabled: activeCapabilities.tools,
            modelDiscovery: activeModelDiscovery,
            favoriteModels: activeProfile.favoriteModels ?? [],
            onModelChange: setEditorModel,
            onTemperatureChange: setEditorTemperature,
            onStreamingPreferenceChange: changeStreamingPreference,
            onLoadModels: (force) => void loadModels(force),
            onToggleFavoriteModel: (model) =>
              updateActiveProfile({
                favoriteModels: toggleFavoriteModel(
                  activeProfile.favoriteModels,
                  model,
                ),
              }),
            ...(projectFile
              ? {
                  inherited: {
                    label: "profile defaults",
                    value: {
                      model: activeProfile.model,
                      temperature: activeProfile.temperature,
                      responseMode: activeResponseMode,
                    },
                  },
                }
              : {}),
          }}
          {...(readiness ? { readiness } : {})}
          repeat={{
            disabled: Boolean(readiness?.blocked) || unservableToolNames.length > 0,
            ...(readiness?.blocked
              ? { disabledReason: readiness.summary }
              : unservableToolNames.length > 0
                ? { disabledReason: `Nothing on this device serves ${unservableToolNames.join(", ")}.` }
                : {}),
            onRepeat: repeat,
          }}
          pendingDestination={pendingReadinessDestination}
          importedRevision={importedRevision}
          onReadinessAction={resolveReadiness}
          onDestinationHandled={() => setPendingReadinessDestination(undefined)}
          activeProfile={activeProfile}
          {...(branchContext ? { pendingBranch: branchContext } : {})}
          {...(requestPreview ? { requestPreview } : {})}
          {...(n8nImportDisabledReason ? { n8nImportDisabledReason } : {})}
          onOpenConnectionSettings={() => setConnectionDrawerOpen(true)}
          onOpenN8nImport={() => setN8nImportOpen(true)}
          onOpenToolLibrary={() => setToolRegistryOpen(true)}
          onSaveParentTrace={() => void runSession.exportTrace()}
          onDiscardPendingBranch={() => setBranchContext(null)}
        />
        }
        response={responseSurface}
        inspect={traceSurface}
      />
      ) : mode === "evaluations" ? (
        <EvaluationsMode
          authoring={evaluationAuthoring}
          execution={evaluationExecutionActions}
          {...(evaluationHistory ? { history: evaluationHistory } : {})}
          layout={{
            setupOpen: evaluationSetupOpen,
            onSetupOpenChange: setEvaluationSetupOpen,
            previewOpen: evaluationPreviewOpen,
            onPreviewOpenChange: setEvaluationPreviewOpen,
          }}
          modelFavorites={{
            models: activeProfile.favoriteModels ?? [],
            onToggle: (model) =>
              updateActiveProfile({
                favoriteModels: toggleFavoriteModel(activeProfile.favoriteModels, model),
              }),
          }}
          onOpenTemplates={() =>
            resolveReadiness({ surface: "request", tab: "templates", control: "prompt-library" })
          }
          {...(projectWorkspace && evaluationAuthoring.suiteId && evaluationAuthoring.focusedCaseId && caseSource
            ? { caseSource }
            : {})}
          onOpenSourceTrace={(source) => {
            if (!projectWorkspace) return;
            void readRunTraceWorkspace(projectWorkspace, traceFileName(source.runId))
              .then((contents) => {
                const trace = parseRunTraceJson(contents);
                if (trace.runId !== source.runId) throw new Error("The saved source trace contains a different run.");
                runSession.adoptTrace(trace, { workspace: projectWorkspace, fileName: traceFileName(source.runId) });
                setTraceOpen(true);
                setMode("compose");
                setWorkbenchView("inspect");
              })
              .catch((error) => toasts.publish({ key: "evaluation-case-source-open-failed", title: "Could not open source trace", detail: error instanceof Error ? error.message : "The saved source trace could not be read.", durableHome: "the case remains valid without its optional source annotation" }));
          }}
        />
      ) : (
        <RunsMode
          {...(evaluationBaselines.comparison && !evaluationExecution.execution && !repeatedExperiment.execution
            ? {
                comparison: {
                  loaded: evaluationBaselines.comparison,
                  // Same rule as a dismissed batch: releasing the last thing in
                  // the Runs mode returns to where it was started from.
                  onDismiss: () => {
                    evaluationBaselines.clearComparison();
                    setComparisonReturnTarget(undefined);
                    setMode("evaluations");
                  },
                  onOpenTrace: (side, runId, target) => {
                    const trace = side.traces.get(runId);
                    if (!trace || !projectWorkspace) return;
                    setComparisonReturnTarget(target);
                    setComparisonTraceOpen(true);
                    runSession.adoptTrace(trace, {
                      workspace: projectWorkspace,
                      fileName: side.traceFileNames.get(runId) ?? traceFileName(runId),
                      source: "experiment",
                    });
                    setTraceOpen(true);
                    setMode("compose");
                    setWorkbenchView("inspect");
                  },
                  onPromoteCandidate: (trace, experimentCellId) => setPromotion({ trace, experimentCellId }),
                  ...(comparisonReturnTarget ? { returnTarget: comparisonReturnTarget } : {}),
                  onReturnTargetChange: setComparisonReturnTarget,
                },
              }
            : {})}
          {...(evaluationExecution.execution
            ? {
                evaluation: {
                  execution: evaluationExecution.execution,
                  onStop: evaluationExecution.cancel,
                  onOpenTrace: evaluationExecution.openTrace,
                  onPromoteTrace: (trace, experimentCellId) => setPromotion({ trace, experimentCellId }),
                  onReturnToList: evaluationExecution.returnToEvaluation,
                  onDismiss: () => dismissFinishedExperiment("evaluation"),
                  reassessment: evaluationReassessment,
                },
              }
            : {})}
          {...(repeatedExperiment.execution
            ? {
                repeated: {
                  execution: repeatedExperiment.execution,
                  onStop: repeatedExperiment.cancel,
                  onOpenTrace: repeatedExperiment.openTrace,
                  onReturnToList: repeatedExperiment.returnToRequest,
                  onDismiss: () => dismissFinishedExperiment("repeated"),
                },
              }
            : {})}
          detail={
            <>
              {responseSurface}
              {traceSurface}
            </>
          }
          onStartSomething={() => setMode("evaluations")}
        />
      )}
      {toolRegistryOpen && (
        <ToolRegistryModal
          open
          registry={toolRegistry}
          onChange={setToolRegistry}
          onAttachToProject={attachRegistryToolToProject}
          onAttachToRequest={attachRegistryToolToRequest}
          requestConfirmation={setConfirmation}
          onClose={() => setToolRegistryOpen(false)}
        />
      )}
      {n8nImportOpen && (
        <N8nImportModal
          open
          onClose={() => setN8nImportOpen(false)}
          recommendation={{
            ...(projectTemplates.activeConnectionRequirement
              ? { connectionRequirementName: projectTemplates.activeConnectionRequirement.name }
              : {}),
            projectModel: activeModel,
          }}
          onImport={projectTemplates.importN8nPrompt}
        />
      )}
      {projectCreationMode && (
        <ProjectCreationDialog
          initialName={
            projectCreationMode === "new"
              ? "Untitled Inference Lens project"
              : projectFile?.name ?? "Untitled Inference Lens project"
          }
          onClose={() => setProjectCreationMode(undefined)}
          onCreate={(options) => {
            if (projectCreationMode === "new") {
              void project.newProjectFolder(options);
            } else {
              void project.saveProject(options);
            }
          }}
        />
      )}
      {repeatedExperiment.draft && (
        <RepeatedExperimentDialog
          draft={repeatedExperiment.draft}
          settings={{
            streamingAvailable: activeCapabilities.streaming,
            modelDiscovery: activeModelDiscovery,
            favoriteModels: activeProfile.favoriteModels ?? [],
            onLoadModels: (force) => void loadModels(force),
            onToggleFavoriteModel: (model) =>
              updateActiveProfile({
                favoriteModels: toggleFavoriteModel(
                  activeProfile.favoriteModels,
                  model,
                ),
              }),
          }}
          onCountChange={repeatedExperiment.setRepetitionCount}
          onTurnCeilingChange={repeatedExperiment.setTurnCeiling}
          onSettingsChange={repeatedExperiment.updateSettings}
          onCancel={repeatedExperiment.dismissDialog}
          onConfirm={() => void repeatedExperiment.confirm(projectWorkspace)}
        />
      )}
      {evaluationExecution.draft && (
        <EvaluationStartDialog
          draft={evaluationExecution.draft}
          onCancel={evaluationExecution.dismissDialog}
          onConfirm={confirmEvaluation}
        />
      )}
      {promotion && projectFile && (
        <PromoteTraceToCaseDialog
          project={projectFile}
          trace={promotion.trace}
          onCancel={() => setPromotion(undefined)}
          onPromote={(suiteId, name) => {
            try {
              const promoted = promoteTraceToEvaluationCase(projectFile, { suiteId, trace: promotion.trace, name });
              project.adoptProjectMutation(promoted.project);
              evaluationAuthoring.selectSuite(suiteId);
              evaluationAuthoring.focusCase(promoted.caseId);
              setPromotion(undefined);
              setMode("evaluations");
              toasts.publish({ key: "evaluation-case-promoted", title: `Promoted “${name.trim()}” to a case`, detail: "Checks still need to be authored.", durableHome: "the evaluation suite’s focused case" });
              if (projectWorkspace) void (async () => {
                try {
                  const sources = await readEvaluationCaseSourcesWorkspace(projectWorkspace);
                  const source = {
                    suiteId, caseId: promoted.caseId, runId: promotion.trace.runId, capturedAt: new Date().toISOString(),
                    ...(promotion.experimentCellId ? { experimentCellId: promotion.experimentCellId as ExperimentCellId } : {}),
                  };
                  await saveEvaluationCaseSourcesWorkspace(projectWorkspace, upsertEvaluationCaseSource(sources, source));
                  setCaseSource(source);
                } catch {
                  toasts.publish({ key: "evaluation-case-source-unsaved", title: "Case promoted, but source link was not saved", detail: "The portable case is safe; reopen the trace if you need to keep its evidence link.", durableHome: "the promoted case, which remains valid without the local annotation" });
                }
              })();
            } catch (error) {
              toasts.publish({ key: "evaluation-case-promotion-failed", title: "Could not promote trace", detail: error instanceof Error ? error.message : "The trace could not be promoted.", durableHome: "the evaluation result evidence" });
            }
          }}
        />
      )}
      {confirmation && (
        <ConfirmationDialog
          request={confirmation}
          onClose={() => setConfirmation(undefined)}
        />
      )}
      <ToastRegion
        toasts={toasts.toasts}
        onDismiss={toasts.dismiss}
        onPausedChange={toasts.setPaused}
      />
    </main>
  );
}

export default function Home() {
  return (
    <AppErrorBoundary>
      <HomeContent />
    </AppErrorBoundary>
  );
}
