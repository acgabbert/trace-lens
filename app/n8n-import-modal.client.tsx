"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ExternalPromptCandidate,
  ImportFidelity,
  ImportWarning,
} from "../packages/core/src/external-prompt-import.ts";
import {
  canImportExternalPromptAsTemplate,
} from "../packages/core/src/external-prompt-project.ts";
import {
  loadN8nExecutionDetail,
  loadN8nExecutionLink,
  loadN8nExecutions,
  loadN8nImportStatus,
  loadN8nWorkflows,
} from "./n8n-import.client.ts";
import type {
  N8nExecution,
  N8nImportStatus,
  N8nPromptExtraction,
  N8nSelectedExecution,
  N8nWorkflow,
} from "./n8n-import.client.ts";

type LoadState = "idle" | "loading" | "ready" | "error";
type ReviewTab = "resolved" | "authored" | "bindings" | "warnings";

/** The pair a template recommendation would be recorded against, plus the
 * model the project currently runs, so the modal can state both. The
 * connection name is absent until a project exists to own one. */
export interface N8nRecommendationContext {
  connectionRequirementName?: string;
  projectModel: string;
}

interface N8nImportModalProps {
  open: boolean;
  onClose(): void;
  recommendation?: N8nRecommendationContext;
  onImport(
    candidate: ExternalPromptCandidate,
    mode: "resolved-snapshot" | "reusable-template",
    options: { recommendModel: boolean },
  ): Promise<void>;
}

interface N8nExecutionLinkSelectorProps {
  value: string;
  loading: boolean;
  onChange(value: string): void;
  onSubmit(): void;
}

export function N8nExecutionLinkSelector({
  value,
  loading,
  onChange,
  onSubmit,
}: N8nExecutionLinkSelectorProps) {
  return (
    <section>
      <div className="n8n-selector-heading">
        <strong>Paste execution link</strong>
      </div>
      <form
        className="n8n-link-selector"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <input
          aria-label="n8n execution link"
          disabled={loading}
          placeholder="https://n8n.example/workflow/…/executions/…"
          type="url"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          className="button secondary"
          disabled={!value.trim() || loading}
          type="submit"
        >
          {loading ? "Loading…" : "Review"}
        </button>
      </form>
    </section>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return error instanceof Error ? error.message : fallback;
}

function readableDate(value?: string): string {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : date.toLocaleString();
}

function fidelityCopy(fidelity: ImportFidelity): string {
  switch (fidelity) {
    case "provider-evidence":
      return "The saved execution contains provider-request evidence.";
    case "execution-reconstructed":
      return "Messages were reconstructed from the saved execution and workflow snapshot.";
    case "authored-only":
      return "Only authored n8n fields are available; there is no executable resolved prompt.";
  }
}

function detailAvailabilityCopy(
  availability: N8nSelectedExecution["detailAvailability"] | undefined,
): string | undefined {
  switch (availability) {
    case "not-retained":
      return "n8n did not retain detailed data for this execution.";
    case "omitted-response-too-large":
      return "Full execution data exceeded the configured response limit. Only authored fields are available, without resolved execution values.";
    case "full":
    case undefined:
      return undefined;
  }
}

function invocationLabel(extraction: N8nPromptExtraction): string {
  const invocation =
    extraction.status === "candidate"
      ? extraction.candidate.invocation
      : extraction.invocation;
  const suffix = [
    invocation.runIndex === undefined ? undefined : `run ${invocation.runIndex + 1}`,
    invocation.itemIndex === undefined ? undefined : `item ${invocation.itemIndex + 1}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return suffix ? `${invocation.name} · ${suffix}` : invocation.name;
}

function candidateFor(
  detail: N8nSelectedExecution | undefined,
  index: number | undefined,
): ExternalPromptCandidate | undefined {
  if (index === undefined) return undefined;
  const extraction = detail?.extractions[index];
  return extraction?.status === "candidate"
    ? extraction.candidate
    : undefined;
}

function expressionIssues(
  candidate: ExternalPromptCandidate | undefined,
): ImportWarning[] {
  return candidate?.warnings.filter(
    ({ code }) => code === "invalid-expression-regions",
  ) ?? [];
}

function initialReviewTab(
  candidate: ExternalPromptCandidate | undefined,
): ReviewTab {
  if (expressionIssues(candidate).length > 0) return "warnings";
  return candidate && !candidate.resolved ? "authored" : "resolved";
}

export function N8nImportIssueNotice({
  issues,
}: {
  issues: ImportWarning[];
}) {
  if (issues.length === 0) return null;
  return (
    <div className="n8n-import-issue-notice" role="alert">
      <strong>Expression issue</strong>
      {issues.map((issue, index) => (
        <span key={`${issue.code}-${index}`}>{issue.message}</span>
      ))}
    </div>
  );
}

function defaultExtractionIndex(
  extractions: N8nPromptExtraction[],
): number | undefined {
  const executable = extractions.findIndex(
    (extraction) =>
      extraction.status === "candidate" &&
      Boolean(extraction.candidate.resolved) &&
      extraction.candidate.fidelity !== "authored-only",
  );
  if (executable >= 0) return executable;
  return extractions.length > 0 ? 0 : undefined;
}

function mergeWorkflows(
  current: N8nWorkflow[],
  incoming: N8nWorkflow[],
): N8nWorkflow[] {
  const incomingIds = new Set(incoming.map(({ id }) => id));
  return [
    ...incoming,
    ...current.filter(({ id }) => !incomingIds.has(id)),
  ];
}

export function N8nImportModal({
  open,
  onClose,
  recommendation,
  onImport,
}: N8nImportModalProps) {
  const [statusState, setStatusState] = useState<LoadState>("loading");
  const [configuration, setConfiguration] = useState<N8nImportStatus>();
  const [workflows, setWorkflows] = useState<N8nWorkflow[]>([]);
  const [workflowState, setWorkflowState] = useState<LoadState>("idle");
  const [workflowCursor, setWorkflowCursor] = useState<string>();
  const [workflowQuery, setWorkflowQuery] = useState("");
  const [executionLink, setExecutionLink] = useState("");
  const [linkState, setLinkState] = useState<LoadState>("idle");
  const [selectedWorkflow, setSelectedWorkflow] = useState<N8nWorkflow>();
  const [executions, setExecutions] = useState<N8nExecution[]>([]);
  const [executionState, setExecutionState] = useState<LoadState>("idle");
  const [executionCursor, setExecutionCursor] = useState<string>();
  const [selectedExecution, setSelectedExecution] = useState<N8nExecution>();
  const [detail, setDetail] = useState<N8nSelectedExecution>();
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [selectedExtractionIndex, setSelectedExtractionIndex] =
    useState<number>();
  const [reviewTab, setReviewTab] = useState<ReviewTab>("resolved");
  const [recommendSourceModel, setRecommendSourceModel] = useState(true);
  const [error, setError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const workflowAbortRef = useRef<AbortController | undefined>(undefined);
  const executionAbortRef = useRef<AbortController | undefined>(undefined);
  const detailAbortRef = useRef<AbortController | undefined>(undefined);

  const filteredWorkflows = useMemo(() => {
    const query = workflowQuery.trim().toLocaleLowerCase();
    return query
      ? workflows.filter(({ name, id }) =>
          `${name} ${id}`.toLocaleLowerCase().includes(query),
        )
      : workflows;
  }, [workflowQuery, workflows]);

  const selectedExtraction =
    selectedExtractionIndex === undefined
      ? undefined
      : detail?.extractions[selectedExtractionIndex];
  const candidate = candidateFor(detail, selectedExtractionIndex);
  const resolvedImportable = Boolean(
    candidate?.resolved && candidate.fidelity !== "authored-only",
  );
  const templateImportable = canImportExternalPromptAsTemplate(candidate);
  const candidateExpressionIssues = expressionIssues(candidate);
  const detailAvailabilityMessage = detailAvailabilityCopy(
    detail?.detailAvailability,
  );

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const controller = new AbortController();

    void loadN8nImportStatus(controller.signal)
      .then((next) => {
        setConfiguration(next);
        setStatusState("ready");
        if (next.state !== "configured") return;
        setWorkflowState("loading");
        return loadN8nWorkflows(undefined, controller.signal).then((page) => {
          setWorkflows((current) => mergeWorkflows(current, page.workflows));
          setWorkflowCursor(page.nextCursor);
          setWorkflowState("ready");
        });
      })
      .catch((caught) => {
        const message = errorMessage(
          caught,
          "Could not load the n8n integration.",
        );
        if (!message) return;
        setError(message);
        setStatusState("error");
        setWorkflowState("error");
      });

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !importingRef.current) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      controller.abort();
      workflowAbortRef.current?.abort();
      executionAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open]);

  if (!open) return null;

  async function loadMoreWorkflows(): Promise<void> {
    if (!workflowCursor || workflowState === "loading") return;
    workflowAbortRef.current?.abort();
    const controller = new AbortController();
    workflowAbortRef.current = controller;
    setWorkflowState("loading");
    setError(undefined);
    try {
      const page = await loadN8nWorkflows(workflowCursor, controller.signal);
      setWorkflows((current) => [
        ...current,
        ...page.workflows.filter(
          ({ id }) => !current.some((workflow) => workflow.id === id),
        ),
      ]);
      setWorkflowCursor(page.nextCursor);
      setWorkflowState("ready");
    } catch (caught) {
      const message = errorMessage(caught, "Could not load more workflows.");
      if (!message) return;
      setError(message);
      setWorkflowState("error");
    }
  }

  async function selectWorkflow(workflow: N8nWorkflow): Promise<void> {
    executionAbortRef.current?.abort();
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    executionAbortRef.current = controller;
    setSelectedWorkflow(workflow);
    setExecutions([]);
    setExecutionCursor(undefined);
    setSelectedExecution(undefined);
    setDetail(undefined);
    setSelectedExtractionIndex(undefined);
    setExecutionState("loading");
    setDetailState("idle");
    setError(undefined);
    setLinkState("idle");
    try {
      const page = await loadN8nExecutions(
        workflow.id,
        undefined,
        controller.signal,
      );
      setExecutions(page.executions);
      setExecutionCursor(page.nextCursor);
      setExecutionState("ready");
    } catch (caught) {
      const message = errorMessage(caught, "Could not load executions.");
      if (!message) return;
      setError(message);
      setExecutionState("error");
    }
  }

  async function loadMoreExecutions(): Promise<void> {
    if (
      !selectedWorkflow ||
      !executionCursor ||
      executionState === "loading"
    ) {
      return;
    }
    executionAbortRef.current?.abort();
    const controller = new AbortController();
    executionAbortRef.current = controller;
    setExecutionState("loading");
    setError(undefined);
    try {
      const page = await loadN8nExecutions(
        selectedWorkflow.id,
        executionCursor,
        controller.signal,
      );
      setExecutions((current) => [
        ...current,
        ...page.executions.filter(
          ({ id }) => !current.some((execution) => execution.id === id),
        ),
      ]);
      setExecutionCursor(page.nextCursor);
      setExecutionState("ready");
    } catch (caught) {
      const message = errorMessage(caught, "Could not load more executions.");
      if (!message) return;
      setError(message);
      setExecutionState("error");
    }
  }

  async function selectExecution(execution: N8nExecution): Promise<void> {
    if (!selectedWorkflow) return;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setSelectedExecution(execution);
    setDetail(undefined);
    setSelectedExtractionIndex(undefined);
    setDetailState("loading");
    setReviewTab("resolved");
    setError(undefined);
    setLinkState("idle");
    try {
      const next = await loadN8nExecutionDetail(
        selectedWorkflow.id,
        execution.id,
        controller.signal,
      );
      setDetail(next);
      const extractionIndex = defaultExtractionIndex(next.extractions);
      setSelectedExtractionIndex(extractionIndex);
      const extraction =
        extractionIndex === undefined
          ? undefined
          : next.extractions[extractionIndex];
      setReviewTab(initialReviewTab(
        extraction?.status === "candidate" ? extraction.candidate : undefined,
      ));
      setDetailState("ready");
    } catch (caught) {
      const message = errorMessage(caught, "Could not inspect this execution.");
      if (!message) return;
      setError(message);
      setDetailState("error");
    }
  }

  async function loadLinkedExecution(): Promise<void> {
    const value = executionLink.trim();
    if (!value || linkState === "loading") return;
    executionAbortRef.current?.abort();
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setSelectedWorkflow(undefined);
    setSelectedExecution(undefined);
    setDetail(undefined);
    setSelectedExtractionIndex(undefined);
    setDetailState("idle");
    setLinkState("loading");
    setReviewTab("resolved");
    setError(undefined);
    try {
      const next = await loadN8nExecutionLink(value, controller.signal);
      const extractionIndex = defaultExtractionIndex(next.extractions);
      const extraction =
        extractionIndex === undefined
          ? undefined
          : next.extractions[extractionIndex];
      const candidate =
        extraction?.status === "candidate" ? extraction.candidate : undefined;
      const workflow: N8nWorkflow = {
        id: next.execution.workflowId,
        name:
          candidate?.source.resource.name ??
          `Workflow ${next.execution.workflowId}`,
      };
      setWorkflows((current) => [
        workflow,
        ...current.filter(({ id }) => id !== workflow.id),
      ]);
      setExecutions([next.execution]);
      setExecutionCursor(undefined);
      setSelectedWorkflow(workflow);
      setSelectedExecution(next.execution);
      setDetail(next);
      setSelectedExtractionIndex(extractionIndex);
      setReviewTab(initialReviewTab(candidate));
      setExecutionState("ready");
      setDetailState("ready");
      setLinkState("ready");
    } catch (caught) {
      const message = errorMessage(
        caught,
        "Could not load the linked execution.",
      );
      if (!message) return;
      setError(message);
      setLinkState("error");
    }
  }

  async function importCandidate(
    mode: "resolved-snapshot" | "reusable-template",
  ): Promise<void> {
    if (
      !candidate ||
      importing ||
      (mode === "resolved-snapshot" && !resolvedImportable) ||
      (mode === "reusable-template" && !templateImportable)
    ) {
      return;
    }
    const recommendModel =
      mode === "reusable-template" && Boolean(candidate.resolved?.model) &&
      recommendSourceModel;
    importingRef.current = true;
    setImporting(true);
    setError(undefined);
    try {
      await onImport(candidate, mode, { recommendModel });
    } catch (caught) {
      setError(errorMessage(caught, "Could not import this prompt."));
      importingRef.current = false;
      setImporting(false);
    }
  }

  function retryCurrent(): void {
    if (linkState === "error") {
      void loadLinkedExecution();
    } else if (detailState === "error" && selectedExecution) {
      void selectExecution(selectedExecution);
    } else if (executionState === "error" && selectedWorkflow) {
      void selectWorkflow(selectedWorkflow);
    } else if (
      workflowState === "error" &&
      configuration?.state === "configured"
    ) {
      setWorkflowState("loading");
      setError(undefined);
      void loadN8nWorkflows()
        .then((page) => {
          setWorkflows((current) => mergeWorkflows(current, page.workflows));
          setWorkflowCursor(page.nextCursor);
          setWorkflowState("ready");
          setStatusState("ready");
        })
        .catch((caught) => {
          setError(errorMessage(caught, "Could not load workflows."));
          setWorkflowState("error");
        });
    } else {
      setStatusState("loading");
      setError(undefined);
      void loadN8nImportStatus()
        .then((next) => {
          setConfiguration(next);
          setStatusState("ready");
          if (next.state !== "configured") return;
          setWorkflowState("loading");
          return loadN8nWorkflows().then((page) => {
            setWorkflows((current) => mergeWorkflows(current, page.workflows));
            setWorkflowCursor(page.nextCursor);
            setWorkflowState("ready");
          });
        })
        .catch((caught) => {
          setError(errorMessage(caught, "Could not load the n8n integration."));
          setStatusState("error");
          setWorkflowState("error");
        });
    }
  }

  return (
    <div className="n8n-import-backdrop" role="presentation">
      <section
        aria-labelledby="n8n-import-title"
        aria-modal="true"
        className="n8n-import-modal"
        role="dialog"
      >
        <header className="n8n-import-header">
          <div>
            <span className="eyebrow">External prompt</span>
            <h2 id="n8n-import-title">Import from n8n</h2>
            <p>
              Select a saved execution, inspect its evidence, then import a
              resolved snapshot or a reusable project prompt.
            </p>
          </div>
          <button
            className="button secondary"
            disabled={importing}
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        {error && (
          <div className="n8n-import-error" role="alert">
            <span>{error}</span>
            <button className="text-button" type="button" onClick={retryCurrent}>
              Retry
            </button>
          </div>
        )}

        {statusState === "loading" ? (
          <div className="n8n-import-centered" role="status">
            Checking n8n integration…
          </div>
        ) : configuration?.state === "unavailable" ? (
          <div className="n8n-import-centered">
            <h3>n8n is not configured</h3>
            <p>
              Set <code>INFERENCE_LENS_N8N_BASE_URL</code> and{" "}
              <code>INFERENCE_LENS_N8N_API_KEY</code> on the Inference Lens
              server, then restart it.
            </p>
          </div>
        ) : configuration?.state === "misconfigured" ? (
          <div className="n8n-import-centered">
            <h3>n8n configuration needs attention</h3>
            <p>{configuration.message}</p>
          </div>
        ) : configuration?.state === "configured" ? (
          <>
            <div className="n8n-import-workspace">
              <aside className="n8n-import-selector">
                <N8nExecutionLinkSelector
                  loading={linkState === "loading"}
                  value={executionLink}
                  onChange={setExecutionLink}
                  onSubmit={() => void loadLinkedExecution()}
                />

                <section>
                  <div className="n8n-selector-heading">
                    <span className="n8n-step">1</span>
                    <strong>Workflow</strong>
                    <span className="n8n-loaded-count">
                      {workflows.length} loaded
                    </span>
                  </div>
                  <input
                    aria-label="Filter loaded workflows"
                    placeholder={`Filter ${workflows.length} loaded workflows`}
                    value={workflowQuery}
                    onChange={(event) => setWorkflowQuery(event.target.value)}
                  />
                  <div className="n8n-selector-list-frame workflows">
                    <div className="n8n-selector-list">
                      {workflowState === "loading" && workflows.length === 0 ? (
                        <p role="status">Loading workflows…</p>
                      ) : filteredWorkflows.length === 0 ? (
                        <p>No matching loaded workflows.</p>
                      ) : (
                        filteredWorkflows.map((workflow) => (
                          <button
                            aria-current={selectedWorkflow?.id === workflow.id}
                            className={
                              selectedWorkflow?.id === workflow.id
                                ? "n8n-selector-item selected"
                                : "n8n-selector-item"
                            }
                            key={workflow.id}
                            type="button"
                            onClick={() => void selectWorkflow(workflow)}
                          >
                            <strong>{workflow.name || "Untitled workflow"}</strong>
                            <span>
                              {workflow.active ? "Active" : "Inactive"} ·{" "}
                              {workflow.id}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                    {workflowCursor && (
                      <div className="n8n-list-pagination">
                        <button
                          className="text-button n8n-load-more"
                          disabled={workflowState === "loading"}
                          type="button"
                          onClick={() => void loadMoreWorkflows()}
                        >
                          {workflowState === "loading"
                            ? "Loading…"
                            : "Load more workflows"}
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="n8n-selector-scope">
                    {workflowQuery.trim()
                      ? `${filteredWorkflows.length} matching · `
                      : ""}
                    Filter searches loaded workflows only.
                  </p>
                </section>

                <section>
                  <div className="n8n-selector-heading">
                    <span className="n8n-step">2</span>
                    <strong>Saved execution</strong>
                    {selectedWorkflow && (
                      <span className="n8n-loaded-count">
                        {executions.length} loaded
                      </span>
                    )}
                  </div>
                  {!selectedWorkflow ? (
                    <p>Choose a workflow first.</p>
                  ) : executionState === "loading" &&
                    executions.length === 0 ? (
                    <p role="status">Loading executions…</p>
                  ) : executions.length === 0 ? (
                    <p>No saved executions were returned.</p>
                  ) : (
                    <div className="n8n-selector-list-frame executions">
                      <div className="n8n-selector-list">
                        {executions.map((execution) => (
                          <button
                            aria-current={selectedExecution?.id === execution.id}
                            className={
                              selectedExecution?.id === execution.id
                                ? "n8n-selector-item selected"
                                : "n8n-selector-item"
                            }
                            key={execution.id}
                            type="button"
                            onClick={() => void selectExecution(execution)}
                          >
                            <strong>
                              {execution.status ?? "Unknown status"}
                            </strong>
                            <span>
                              {readableDate(execution.startedAt)} · {execution.id}
                            </span>
                          </button>
                        ))}
                      </div>
                      {executionCursor && (
                        <div className="n8n-list-pagination">
                          <button
                            className="text-button n8n-load-more"
                            disabled={executionState === "loading"}
                            type="button"
                            onClick={() => void loadMoreExecutions()}
                          >
                            {executionState === "loading"
                              ? "Loading…"
                              : "Load more executions"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section>
                  <div className="n8n-selector-heading">
                    <span className="n8n-step">3</span>
                    <strong>AI invocation</strong>
                  </div>
                  {!selectedExecution ? (
                    <p>Choose an execution first.</p>
                  ) : detailState === "loading" ? (
                    <p role="status">Inspecting execution…</p>
                  ) : detail?.discovery.status !== "ready" ? (
                    <p>{detail?.discovery.message ?? "No invocation selected."}</p>
                  ) : (
                    <div className="n8n-selector-list-frame invocations">
                      <div className="n8n-selector-list">
                        {detail.extractions.map((extraction, index) => (
                          <button
                            aria-current={selectedExtractionIndex === index}
                            className={
                              selectedExtractionIndex === index
                                ? "n8n-selector-item selected"
                                : "n8n-selector-item"
                            }
                            key={`${invocationLabel(extraction)}-${index}`}
                            type="button"
                            onClick={() => {
                              setSelectedExtractionIndex(index);
                              setReviewTab(initialReviewTab(
                                extraction.status === "candidate"
                                  ? extraction.candidate
                                  : undefined,
                              ));
                            }}
                          >
                            <strong>{invocationLabel(extraction)}</strong>
                            <span>
                              {extraction.status === "unsupported"
                                ? "Unsupported"
                                : expressionIssues(extraction.candidate).length > 0
                                  ? `Expression issue · ${extraction.candidate.fidelity.replaceAll("-", " ")}`
                                  : extraction.candidate.fidelity.replaceAll("-", " ")}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              </aside>

              <div className="n8n-import-review">
                {!selectedExecution ? (
                  <div className="n8n-import-centered">
                    <h3>Select an execution to review</h3>
                    <p>
                      Detailed execution data is fetched only after you make a
                      selection.
                    </p>
                  </div>
                ) : detailState === "loading" ? (
                  <div className="n8n-import-centered" role="status">
                    Reconstructing prompt evidence…
                  </div>
                ) : selectedExtraction?.status === "unsupported" ? (
                  <div className="n8n-import-centered">
                    <span className="fidelity-pill blocked">Unsupported</span>
                    <h3>{selectedExtraction.invocation.name}</h3>
                    <p>{selectedExtraction.message}</p>
                    <code>{selectedExtraction.code}</code>
                  </div>
                ) : candidate ? (
                  <>
                    <div className="n8n-review-summary">
                      <div>
                        <span className="eyebrow">Selected invocation</span>
                        <h3>{candidate.invocation.name}</h3>
                        <p>
                          {candidate.source.resource.name ??
                            candidate.source.resource.id}
                          {" · "}
                          execution {candidate.source.execution?.id ?? "unavailable"}
                        </p>
                      </div>
                      <span
                        className={
                          candidate.fidelity === "authored-only"
                            ? "fidelity-pill blocked"
                            : "fidelity-pill"
                        }
                      >
                        {candidate.fidelity.replaceAll("-", " ")}
                      </span>
                    </div>
                    <p className="n8n-fidelity-copy">
                      {fidelityCopy(candidate.fidelity)}
                      {candidate.resolved?.model
                        ? ` Source model: ${candidate.resolved.model}.`
                        : ""}
                      {" Your current connection and model will not change."}
                    </p>
                    {detailAvailabilityMessage && (
                      <p className="n8n-fidelity-copy">
                        {detailAvailabilityMessage}
                      </p>
                    )}
                    {templateImportable && candidate.resolved?.model && (
                      <div className="n8n-recommendation-option">
                        <label>
                          <input
                            checked={recommendSourceModel}
                            disabled={importing}
                            type="checkbox"
                            onChange={(event) =>
                              setRecommendSourceModel(event.target.checked)
                            }
                          />
                          <span>
                            Record the source model as this prompt&rsquo;s
                            recommended target
                          </span>
                        </label>
                        {recommendSourceModel && (
                          <p className="n8n-recommendation-detail">
                            {recommendation?.connectionRequirementName
                              ? `Saved as ${recommendation.connectionRequirementName} · ${candidate.resolved.model}.`
                              : `Saved as ${candidate.resolved.model} for this project’s connection.`}
                            {" This is a reminder, not a verified pairing: n8n supplies the model; this project supplies the connection."}
                            {recommendation &&
                            recommendation.projectModel !==
                              candidate.resolved.model
                              ? ` This project uses ${recommendation.projectModel}; runs will flag the difference.`
                              : ""}
                          </p>
                        )}
                      </div>
                    )}
                    <nav
                      aria-label="Import evidence"
                      className="n8n-review-tabs"
                    >
                      {(
                        [
                          ["resolved", "Resolved"],
                          ["authored", "Authored"],
                          ["bindings", "Bindings"],
                          ["warnings", "Warnings"],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          aria-selected={reviewTab === id}
                          className={reviewTab === id ? "active" : undefined}
                          key={id}
                          role="tab"
                          type="button"
                          onClick={() => setReviewTab(id)}
                        >
                          {label}
                          {id === "warnings" && candidate.warnings.length > 0
                            ? ` ${candidate.warnings.length}`
                            : ""}
                        </button>
                      ))}
                    </nav>
                    <div className="n8n-review-content">
                      {reviewTab === "resolved" ? (
                        candidate.resolved ? (
                          <div className="n8n-message-review">
                            {candidate.resolved.messages.map((message, index) => (
                              <article key={`${message.role}-${index}`}>
                                <strong>{message.role}</strong>
                                <pre>{message.content}</pre>
                              </article>
                            ))}
                            {candidate.resolved.options && (
                              <details>
                                <summary>Source inference options</summary>
                                <pre>
                                  {JSON.stringify(
                                    candidate.resolved.options,
                                    null,
                                    2,
                                  )}
                                </pre>
                              </details>
                            )}
                          </div>
                        ) : (
                          <div className="n8n-review-empty">
                            No resolved messages were retained for this execution.
                          </div>
                        )
                      ) : reviewTab === "authored" ? (
                        <div className="n8n-field-review">
                          {candidate.authored.map((field) => (
                            <article key={field.path}>
                              <header>
                                <strong>{field.role ?? "prompt"}</strong>
                                <code>{field.path}</code>
                                <span>{field.syntax.replaceAll("-", " ")}</span>
                              </header>
                              <pre>{field.text}</pre>
                            </article>
                          ))}
                        </div>
                      ) : reviewTab === "bindings" ? (
                        candidate.bindings.length > 0 ? (
                          <div className="n8n-field-review">
                            {candidate.bindings.map((binding, index) => (
                              <article key={`${binding.authoredPath}-${index}`}>
                                <header>
                                  <strong>{binding.status}</strong>
                                  <code>{binding.authoredPath}</code>
                                  <span>{binding.source.kind.replaceAll("-", " ")}</span>
                                </header>
                                <pre>{binding.expression}</pre>
                                <div className="n8n-binding-value">
                                  <span>Captured value</span>
                                  <pre>
                                    {binding.resolvedValue === undefined
                                      ? "No captured value"
                                      : JSON.stringify(
                                          binding.resolvedValue,
                                          null,
                                          2,
                                        )}
                                  </pre>
                                </div>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <div className="n8n-review-empty">
                            This invocation has no expression bindings.
                          </div>
                        )
                      ) : candidate.warnings.length > 0 ? (
                        <div className="n8n-warning-list">
                          {candidate.warnings.map((warning, index) => (
                            <article
                              className={`n8n-warning ${warning.severity}`}
                              key={`${warning.code}-${index}`}
                            >
                              <header>
                                <strong>{warning.severity}</strong>
                                <code>{warning.code}</code>
                              </header>
                              <p>{warning.message}</p>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <div className="n8n-review-empty">
                          No warnings were produced for this invocation.
                        </div>
                      )}
                    </div>
                  </>
                ) : detail?.discovery.status !== "ready" ? (
                  <div className="n8n-import-centered">
                    <h3>Nothing importable was found</h3>
                    <p>{detail?.discovery.message}</p>
                    {detailAvailabilityMessage && (
                      <p>{detailAvailabilityMessage}</p>
                    )}
                  </div>
                ) : (
                  <div className="n8n-import-centered">
                    Select an AI invocation to review.
                  </div>
                )}
              </div>
            </div>
            <footer className="n8n-import-footer">
              {candidateExpressionIssues.length > 0 ? (
                <N8nImportIssueNotice issues={candidateExpressionIssues} />
              ) : (
                <p>
                  {candidate
                    ? templateImportable && resolvedImportable
                      ? "Choose a reusable project prompt or the exact resolved execution snapshot."
                      : templateImportable
                        ? "Import creates a reusable project prompt; unresolved values must be filled before running."
                        : resolvedImportable
                          ? "Import creates a child revision from the resolved execution snapshot."
                          : "This candidate has no safely importable prompt projection."
                    : "Choose a supported execution-backed invocation to continue."}
                </p>
              )}
              <button
                className="button secondary"
                disabled={importing}
                type="button"
                onClick={onClose}
              >
                Cancel
              </button>
              {templateImportable && (
                <button
                  className="button primary"
                  disabled={importing}
                  type="button"
                  onClick={() => void importCandidate("reusable-template")}
                >
                  {importing ? "Importing…" : "Import reusable prompt"}
                </button>
              )}
              {resolvedImportable && (
                <button
                  className={
                    templateImportable ? "button secondary" : "button primary"
                  }
                  disabled={importing}
                  type="button"
                  onClick={() => void importCandidate("resolved-snapshot")}
                >
                  {importing ? "Importing…" : "Import resolved snapshot"}
                </button>
              )}
            </footer>
          </>
        ) : (
          <div className="n8n-import-centered">
            The n8n integration status could not be loaded.
          </div>
        )}
      </section>
    </div>
  );
}
