import {
  createExternalPromptCandidate,
  type AuthoredPromptField,
  type ExternalInvocationRef,
  type ExternalPromptCandidate,
  type ExternalPromptCandidateEvidence,
  type ExpressionBinding,
  type ImportWarning,
  type ResolvedPromptSnapshot,
} from "../../../packages/core/src/external-prompt-import.ts";

import type {
  N8nDetailAvailability,
  N8nExecutionDetail,
  N8nWorkflowDetail,
} from "./n8n-integration.ts";
import {
  scanN8nExpressionRegions,
  type N8nExpressionScan,
} from "../../../packages/n8n/src/expression-regions.ts";

export { scanN8nExpressionRegions } from "../../../packages/n8n/src/expression-regions.ts";
export type {
  N8nExpressionRegion,
  N8nExpressionScan,
} from "../../../packages/n8n/src/expression-regions.ts";

const BASIC_LLM_CHAIN_TYPE = "@n8n/n8n-nodes-langchain.chainLlm";
const BASIC_LLM_CHAIN_VERSION = 1.9;
const AI_AGENT_TYPE = "@n8n/n8n-nodes-langchain.agent";
const AI_AGENT_VERSIONS = [2.2, 3, 3.1] as const;
const MESSAGE_A_MODEL_TYPE = "@n8n/n8n-nodes-langchain.openAi";
const MESSAGE_A_MODEL_VERSIONS = [1.2, 1.3] as const;
const OPENAI_CHAT_MODEL_TYPE = "@n8n/n8n-nodes-langchain.lmChatOpenAi";
const OPENAI_CHAT_MODEL_VERSIONS = [1.2, 1.3] as const;
const AUTHORED_TEXT_PATH = "parameters.text";

export interface N8nNodeSnapshot {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  parameters: Record<string, unknown>;
}

/**
 * A node that could not be read as a full snapshot but still carries enough
 * identity to be reported to the user.
 */
export interface N8nUnparsedNode {
  id: string;
  name: string;
  type: string;
}

export interface N8nWorkflowSnapshot {
  id: string;
  name: string;
  nodes: N8nNodeSnapshot[];
  /**
   * Nodes skipped by {@link parseN8nWorkflowSnapshot}. A workflow may legally
   * contain nodes this importer cannot read; those must not make the rest of
   * the workflow unimportable.
   */
  unparsedNodes: N8nUnparsedNode[];
  connections: Record<string, unknown>;
}

export interface N8nExtractionContext {
  workflow: N8nWorkflowSnapshot;
  execution: N8nExecutionDetail;
  workflowSnapshotSource: "execution" | "current-workflow";
  detailAvailability: N8nDetailAvailability;
}

export type N8nPromptExtraction =
  | {
      status: "candidate";
      candidate: ExternalPromptCandidate;
    }
  | {
      status: "unsupported";
      invocation: ExternalInvocationRef;
      code:
        | "unsupported-node-version"
        | "unsupported-node-configuration"
        | "incompatible-node-snapshot";
      message: string;
    };

export interface N8nPromptExtractor {
  readonly id: string;
  /**
   * Whether this extractor handles the node's kind at all. Implementations must
   * depend only on `node.type`, so recognition can also be tested against a
   * node whose parameters could not be read.
   */
  recognizes(node: N8nNodeSnapshot): boolean;
  /**
   * Whether this extractor handles the node's specific `typeVersion`. Several
   * extractors may recognize one type while each supports a different version.
   */
  supports(node: N8nNodeSnapshot): boolean;
  extract(
    context: N8nExtractionContext,
    node: N8nNodeSnapshot,
  ): Promise<N8nPromptExtraction[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseNode(value: unknown): N8nNodeSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    !isRecord(value.parameters)
  ) {
    return undefined;
  }
  if (
    value.typeVersion !== undefined &&
    typeof value.typeVersion !== "number"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    ...(value.typeVersion === undefined
      ? {}
      : { typeVersion: value.typeVersion }),
    parameters: value.parameters,
  };
}

function parseUnparsedNode(value: unknown): N8nUnparsedNode | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    !value.id ||
    !value.name ||
    !value.type
  ) {
    return undefined;
  }
  return { id: value.id, name: value.name, type: value.type };
}

/**
 * Reads the workflow envelope. An unreadable envelope is a genuine
 * incompatibility, but an individual unreadable node is not: workflows mix node
 * types freely and only the ones an extractor recognizes are ever inspected.
 * Unreadable nodes are therefore collected rather than failing the workflow.
 */
export function parseN8nWorkflowSnapshot(
  value: unknown,
): N8nWorkflowSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Array.isArray(value.nodes) ||
    !isRecord(value.connections)
  ) {
    return undefined;
  }
  const nodes: N8nNodeSnapshot[] = [];
  const unparsedNodes: N8nUnparsedNode[] = [];
  for (const entry of value.nodes) {
    const node = parseNode(entry);
    if (node) {
      nodes.push(node);
      continue;
    }
    const identity = parseUnparsedNode(entry);
    if (identity) unparsedNodes.push(identity);
  }
  return {
    id: value.id,
    name: value.name,
    nodes,
    unparsedNodes,
    connections: value.connections,
  };
}

function executionWorkflowSnapshot(
  execution: N8nExecutionDetail,
): N8nWorkflowSnapshot | undefined {
  const nested = isRecord(execution.data)
    ? parseN8nWorkflowSnapshot(execution.data.workflowData)
    : undefined;
  return nested ?? parseN8nWorkflowSnapshot(execution.workflowData);
}

function currentWorkflowSnapshot(
  workflow: N8nWorkflowDetail,
): N8nWorkflowSnapshot | undefined {
  return parseN8nWorkflowSnapshot(workflow);
}

function invocationFor(
  node: N8nNodeSnapshot,
  runIndex?: number,
  itemIndex?: number,
): ExternalInvocationRef {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(node.typeVersion === undefined
      ? {}
      : { version: String(node.typeVersion) }),
    ...(runIndex === undefined ? {} : { runIndex }),
    ...(itemIndex === undefined ? {} : { itemIndex }),
  };
}

function authoredField(node: N8nNodeSnapshot): AuthoredPromptField | undefined {
  return authoredTextField(
    AUTHORED_TEXT_PATH,
    "user",
    node.parameters.text,
  );
}

function authoredTextField(
  path: string,
  role: AuthoredPromptField["role"],
  value: unknown,
): AuthoredPromptField | undefined {
  const text = value;
  if (typeof text !== "string") return undefined;
  const externalExpression = text.startsWith("=");
  return {
    path,
    role,
    syntax: externalExpression ? "external-expression" : "literal",
    text,
    ...(externalExpression
      ? {
          contentSpan: {
            startOffset: 1,
            endOffset: text.length,
          },
        }
      : {}),
  };
}

interface N8nExpressionIssue {
  authoredPath: string;
  character: number;
  reason: string;
}

export interface N8nExpressionRegionScan {
  bindings: ExpressionBinding[];
  issues: N8nExpressionIssue[];
}

/**
 * Finds n8n expression regions without evaluating JavaScript. The scanner
 * understands strings, template literals, comments, and nested object braces;
 * malformed input fails closed instead of inventing a partial projection.
 */
function scanExpressionBindings(
  authored: AuthoredPromptField,
): N8nExpressionRegionScan {
  if (authored.syntax !== "external-expression") {
    return { bindings: [], issues: [] };
  }
  const contentStart = authored.contentSpan?.startOffset ?? 0;
  const contentEnd = authored.contentSpan?.endOffset ?? authored.text.length;
  const scan: N8nExpressionScan = scanN8nExpressionRegions(
    authored.text.slice(contentStart, contentEnd),
  );
  if (!scan.ok) {
    return {
      bindings: [],
      issues: [{
        authoredPath: authored.path,
        character: scan.errorOffset + 1,
        reason: scan.reason,
      }],
    };
  }
  return {
    bindings: scan.regions.map((region) => ({
      authoredPath: authored.path,
      expression: region.expression,
      source: {
        kind: "expression-span",
        startOffset: contentStart + region.startOffset,
        endOffset: contentStart + region.endOffset,
      },
      status: "missing",
    })),
    issues: [],
  };
}

function invalidExpressionWarnings(
  issues: N8nExpressionIssue[],
): ImportWarning[] {
  return issues.map((issue) =>
    warning(
      "invalid-expression-regions",
      `Expression issue in ${issue.authoredPath} at character ${issue.character}: ${issue.reason} Reusable template import is unavailable.`,
    ),
  );
}

function sourceEvidence(
  context: N8nExtractionContext,
  node: N8nNodeSnapshot,
  authored: AuthoredPromptField | AuthoredPromptField[],
  warnings: ImportWarning[],
  {
    runIndex,
    itemIndex,
    resolved,
    bindings = [],
  }: {
    runIndex?: number;
    itemIndex?: number;
    resolved?: ResolvedPromptSnapshot;
    bindings?: ExpressionBinding[];
  } = {},
): ExternalPromptCandidateEvidence {
  return {
    source: {
      adapter: "n8n",
      resource: {
        kind: "workflow",
        id: context.workflow.id,
        name: context.workflow.name,
      },
      execution: {
        id: context.execution.id,
        ...(context.execution.startedAt
          ? { executedAt: context.execution.startedAt }
          : {}),
      },
    },
    invocation: invocationFor(node, runIndex, itemIndex),
    authored: Array.isArray(authored) ? authored : [authored],
    ...(resolved ? { resolved } : {}),
    bindings,
    fidelity: resolved ? "execution-reconstructed" : "authored-only",
    warnings,
  };
}

function warning(
  code: string,
  message: string,
  severity: ImportWarning["severity"] = "warning",
): ImportWarning {
  return { code, severity, message };
}

async function authoredOnlyCandidate(
  context: N8nExtractionContext,
  node: N8nNodeSnapshot,
  authored: AuthoredPromptField | AuthoredPromptField[],
  code: string,
  message: string,
  runIndex?: number,
): Promise<N8nPromptExtraction> {
  const detailWasOmitted =
    code === "execution-detail-unavailable" &&
    context.detailAvailability === "omitted-response-too-large";
  const warnings = [
    warning(
      detailWasOmitted ? "execution-detail-omitted-response-too-large" : code,
      detailWasOmitted
        ? "Full execution data exceeded the configured response limit, so only authored prompt fields can be reviewed."
        : message,
    ),
  ];
  if (context.workflowSnapshotSource === "current-workflow") {
    warnings.push(
      warning(
        "current-workflow-snapshot",
        "The saved execution did not contain a workflow snapshot, so the authored text comes from the current workflow and may differ from what ran.",
      ),
    );
  }
  const authoredFields = Array.isArray(authored) ? authored : [authored];
  const expressionScans = authoredFields.map(scanExpressionBindings);
  warnings.push(...invalidExpressionWarnings(
    expressionScans.flatMap(({ issues }) => issues),
  ));
  return {
    status: "candidate",
    candidate: await createExternalPromptCandidate(
      sourceEvidence(context, node, authored, warnings, {
        ...(runIndex === undefined ? {} : { runIndex }),
        bindings: expressionScans.flatMap(({ bindings }) => bindings),
      }),
    ),
  };
}

function runData(
  execution: N8nExecutionDetail,
): Record<string, unknown> | undefined {
  if (!isRecord(execution.data)) return undefined;
  const resultData = execution.data.resultData;
  if (!isRecord(resultData) || !isRecord(resultData.runData)) return undefined;
  return resultData.runData;
}

function connectedModelNodes(
  workflow: N8nWorkflowSnapshot,
  chain: N8nNodeSnapshot,
): N8nNodeSnapshot[] {
  return workflow.nodes.filter((node) => {
    const fromNode = workflow.connections[node.name];
    if (!isRecord(fromNode) || !Array.isArray(fromNode.ai_languageModel)) {
      return false;
    }
    return fromNode.ai_languageModel.some(
      (output) =>
        Array.isArray(output) &&
        output.some(
          (connection) =>
            isRecord(connection) &&
            connection.node === chain.name &&
            connection.type === "ai_languageModel",
        ),
    );
  });
}

function supportsOpenAiChatModel(node: N8nNodeSnapshot): boolean {
  return (
    node.type === OPENAI_CHAT_MODEL_TYPE &&
    OPENAI_CHAT_MODEL_VERSIONS.some(
      (version) => node.typeVersion === version,
    )
  );
}

function supportedOpenAiChatModelLabel(): string {
  return OPENAI_CHAT_MODEL_VERSIONS.map(
    (version) => `${OPENAI_CHAT_MODEL_TYPE}@${version}`,
  ).join(" or ");
}

function parentItemCount(run: unknown): number | undefined {
  if (!isRecord(run) || !isRecord(run.data)) return undefined;
  const main = run.data.main;
  if (
    !Array.isArray(main) ||
    !Array.isArray(main[0])
  ) {
    return undefined;
  }
  return main[0].length;
}

function modelRunsForParent(
  value: unknown,
  parentName: string,
  parentRunIndex: number,
): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((run) => {
    if (!isRecord(run) || !Array.isArray(run.source)) return false;
    return run.source.some(
      (source) =>
        isRecord(source) &&
        source.previousNode === parentName &&
        source.previousNodeRun === parentRunIndex,
    );
  });
}

interface EffectiveModelInput {
  content: string;
  evidencePath: string;
  model?: string;
  temperature?: number;
}

interface SavedModelInput {
  messages: string[];
  evidencePath: string;
  model?: string;
  temperature?: number;
}

function savedModelInput(
  run: unknown,
  modelName: string,
  modelRunIndex: number,
): SavedModelInput | undefined {
  if (!isRecord(run) || !isRecord(run.inputOverride)) return undefined;
  const languageModel = run.inputOverride.ai_languageModel;
  if (
    !Array.isArray(languageModel) ||
    !Array.isArray(languageModel[0]) ||
    !isRecord(languageModel[0][0]) ||
    !isRecord(languageModel[0][0].json)
  ) {
    return undefined;
  }
  const payload = languageModel[0][0].json;
  if (
    !Array.isArray(payload.messages) ||
    payload.messages.length === 0 ||
    !payload.messages.every((message) => typeof message === "string")
  ) {
    return undefined;
  }
  const options = isRecord(payload.options) ? payload.options : undefined;
  return {
    messages: payload.messages,
    evidencePath:
      `data.resultData.runData[${JSON.stringify(modelName)}]` +
      `[${modelRunIndex}].inputOverride.ai_languageModel[0][0].json.messages`,
    ...(typeof options?.model === "string" ? { model: options.model } : {}),
    ...(typeof options?.temperature === "number"
      ? { temperature: options.temperature }
      : {}),
  };
}

function effectiveModelInput(
  run: unknown,
  modelName: string,
  modelRunIndex: number,
): EffectiveModelInput | undefined {
  const saved = savedModelInput(run, modelName, modelRunIndex);
  if (
    !saved ||
    saved.messages.length !== 1 ||
    !saved.messages[0]!.startsWith("Human: ")
  ) {
    return undefined;
  }
  return {
    content: saved.messages[0]!.slice("Human: ".length),
    evidencePath: `${saved.evidencePath}[0]`,
    ...(saved.model ? { model: saved.model } : {}),
    ...(saved.temperature === undefined
      ? {}
      : { temperature: saved.temperature }),
  };
}

const basicLlmChainExtractor: N8nPromptExtractor = {
  id: "basic-llm-chain-1-9",

  recognizes(node) {
    return node.type === BASIC_LLM_CHAIN_TYPE;
  },

  supports(node) {
    return node.typeVersion === BASIC_LLM_CHAIN_VERSION;
  },

  async extract(context, node) {
    const authored = authoredField(node);
    if (!authored || node.parameters.promptType !== "define") {
      return [
        {
          status: "unsupported",
          invocation: invocationFor(node),
          code: "unsupported-node-configuration",
          message:
            'Basic LLM Chain import currently requires promptType "define" and a text parameter.',
        },
      ];
    }

    const allRunData = runData(context.execution);
    const parentRuns = allRunData?.[node.name];
    if (!Array.isArray(parentRuns) || parentRuns.length === 0) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "execution-detail-unavailable",
          "No saved run data was available for this node, so only its authored prompt can be reviewed.",
        ),
      ];
    }
    if (parentRuns.length !== 1) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "multiple-node-runs",
          `This node ran ${parentRuns.length} times. The initial importer cannot safely associate repeated runs with model evidence.`,
        ),
      ];
    }

    const parentRunIndex = 0;
    const items = parentItemCount(parentRuns[parentRunIndex]);
    if (items !== 1) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          items === undefined
            ? "execution-detail-unavailable"
            : "multiple-input-items",
          items === undefined
            ? "The saved parent run did not contain a supported item shape, so only the authored prompt can be reviewed."
            : `This node processed ${items} items. n8n's saved model sub-runs do not identify item indexes, so the initial importer will not guess their association.`,
          parentRunIndex,
        ),
      ];
    }

    const connectedModels = connectedModelNodes(context.workflow, node);
    if (connectedModels.length !== 1) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "model-connection-ambiguous",
          `Expected one connected chat model but found ${connectedModels.length}.`,
          parentRunIndex,
        ),
      ];
    }
    const modelNode = connectedModels[0]!;
    if (!supportsOpenAiChatModel(modelNode)) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "unsupported-model-node",
          `The Basic LLM Chain importer supports only ${supportedOpenAiChatModelLabel()}.`,
          parentRunIndex,
        ),
      ];
    }

    const allModelRuns = Array.isArray(allRunData?.[modelNode.name])
      ? allRunData![modelNode.name] as unknown[]
      : [];
    const matchingRuns = modelRunsForParent(
      allModelRuns,
      node.name,
      parentRunIndex,
    );
    if (matchingRuns.length !== 1) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "model-evidence-ambiguous",
          `Expected one attributable saved model sub-run but found ${matchingRuns.length}.`,
          parentRunIndex,
        ),
      ];
    }
    const modelRunIndex = allModelRuns.indexOf(matchingRuns[0]);
    const effective = effectiveModelInput(
      matchingRuns[0],
      modelNode.name,
      modelRunIndex,
    );
    if (!effective) {
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "model-evidence-incompatible",
          "The saved model sub-run did not contain the supported single Human message shape.",
          parentRunIndex,
        ),
      ];
    }

    const resolved: ResolvedPromptSnapshot = {
      messages: [{ role: "user", content: effective.content }],
      ...(effective.model ? { model: effective.model } : {}),
      ...(effective.temperature === undefined
        ? {}
        : { options: { temperature: effective.temperature } }),
    };
    const expressionScan = scanExpressionBindings(authored);
    const semanticText = authored.text.slice(
      authored.contentSpan?.startOffset ?? 0,
      authored.contentSpan?.endOffset ?? authored.text.length,
    );
    const soleExpression = expressionScan.bindings[0];
    const bindings =
      expressionScan.issues.length === 0 &&
      expressionScan.bindings.length === 1 &&
      soleExpression &&
      semanticText.trim() === soleExpression.expression
        ? [
            {
              ...soleExpression,
              resolvedValue: effective.content,
              status: "resolved" as const,
              valueEvidence: {
                kind: "saved-parameter-value" as const,
                path: effective.evidencePath,
              },
            },
          ]
        : expressionScan.bindings;
    const warnings: ImportWarning[] = [
      warning(
        "provider-request-unavailable",
        "n8n saved the effective model message but not a raw provider request, so this prompt is reconstructed from execution evidence.",
        "info",
      ),
    ];
    if (
      authored.syntax === "external-expression" &&
      bindings.some(({ status }) => status !== "resolved")
    ) {
      warnings.push(
        warning(
          "expression-values-unavailable",
          "Individual n8n expression results are not attributable in the saved execution; unresolved regions will become native template variables without saved values.",
          "info",
        ),
      );
    }
    warnings.push(...invalidExpressionWarnings(expressionScan.issues));
    return [
      {
        status: "candidate",
        candidate: await createExternalPromptCandidate(
          sourceEvidence(context, node, authored, warnings, {
            runIndex: parentRunIndex,
            itemIndex: 0,
            resolved,
            bindings,
          }),
        ),
      },
    ];
  },
};

function expressionEvidence(
  authoredFields: AuthoredPromptField[],
  resolvedMessages: ResolvedPromptSnapshot["messages"],
  evidencePath: string,
): {
  bindings: ExpressionBinding[];
  issues: N8nExpressionRegionScan["issues"];
} {
  const scans = authoredFields.map(scanExpressionBindings);
  const bindings = scans.flatMap((scan, fieldIndex) => {
    const authored = authoredFields[fieldIndex]!;
    const resolvedForRole = resolvedMessages.filter(
      ({ role }) => role === authored.role,
    );
    const resolved =
      resolvedForRole.length === 1 ? resolvedForRole[0] : undefined;
    const semanticText = authored.text.slice(
      authored.contentSpan?.startOffset ?? 0,
      authored.contentSpan?.endOffset ?? authored.text.length,
    );
    const soleExpression = scan.bindings[0];
    if (
      resolved &&
      scan.issues.length === 0 &&
      scan.bindings.length === 1 &&
      soleExpression &&
      semanticText.trim() === soleExpression.expression
    ) {
      return [
        {
          ...soleExpression,
          resolvedValue: resolved.content,
          status: "resolved" as const,
          valueEvidence: {
            kind: "saved-parameter-value" as const,
            path: evidencePath,
          },
        },
      ];
    }
    return scan.bindings;
  });
  return {
    bindings,
    issues: scans.flatMap(({ issues }) => issues),
  };
}

function parseAgentSavedMessages(
  messages: string[],
): ResolvedPromptSnapshot["messages"] | undefined {
  if (messages.length !== 1) return undefined;
  const serialized = messages[0]!;
  if (serialized.startsWith("Human: ")) {
    return [{ role: "user", content: serialized.slice("Human: ".length) }];
  }
  if (!serialized.startsWith("System: ")) return undefined;

  const delimiter = "\nHuman: ";
  const boundary = serialized.indexOf(delimiter);
  if (boundary < 0 || boundary !== serialized.lastIndexOf(delimiter)) {
    return undefined;
  }
  return [
    {
      role: "system",
      content: serialized.slice("System: ".length, boundary),
    },
    {
      role: "user",
      content: serialized.slice(boundary + delimiter.length),
    },
  ];
}

function agentAuthoredFields(
  node: N8nNodeSnapshot,
): AuthoredPromptField[] | undefined {
  const user = authoredField(node);
  if (!user || node.parameters.promptType !== "define") return undefined;
  const options = isRecord(node.parameters.options)
    ? node.parameters.options
    : {};
  const system = authoredTextField(
    "parameters.options.systemMessage",
    "system",
    options.systemMessage,
  );
  return system ? [system, user] : [user];
}

function messageAuthoredFields(
  node: N8nNodeSnapshot,
): AuthoredPromptField[] | undefined {
  if (
    (node.parameters.resource !== undefined &&
      node.parameters.resource !== "text") ||
    (node.parameters.operation !== undefined &&
      node.parameters.operation !== "message")
  ) {
    return undefined;
  }
  const messages = node.parameters.messages;
  if (!isRecord(messages) || !Array.isArray(messages.values)) return undefined;

  const authored: AuthoredPromptField[] = [];
  for (const [index, value] of messages.values.entries()) {
    if (!isRecord(value)) return undefined;
    const role = value.role ?? "user";
    if (!["system", "user", "assistant"].includes(String(role))) {
      return undefined;
    }
    const field = authoredTextField(
      `parameters.messages.values[${index}].content`,
      role as AuthoredPromptField["role"],
      value.content,
    );
    if (!field) return undefined;
    authored.push(field);
  }
  return authored.length > 0 ? authored : undefined;
}

function createAiAgentExtractor(version: number): N8nPromptExtractor {
  return {
    id: `ai-agent-${String(version).replace(".", "-")}`,

    recognizes(node) {
      return node.type === AI_AGENT_TYPE;
    },

    supports(node) {
      return node.typeVersion === version;
    },

    async extract(context, node) {
      const authored = agentAuthoredFields(node);
      if (!authored) {
        return [
          {
            status: "unsupported",
            invocation: invocationFor(node),
            code: "unsupported-node-configuration",
            message:
              'AI Agent import currently requires promptType "define" and a text parameter.',
          },
        ];
      }

      const allRunData = runData(context.execution);
      const parentRuns = allRunData?.[node.name];
      if (!Array.isArray(parentRuns) || parentRuns.length === 0) {
        return [
          await authoredOnlyCandidate(
            context,
            node,
            authored,
            "execution-detail-unavailable",
            "No saved run data was available for this AI Agent, so only its authored messages can be reviewed.",
          ),
        ];
      }
      if (parentRuns.length !== 1) {
        return [
          await authoredOnlyCandidate(
            context,
            node,
            authored,
            "multiple-node-runs",
            `This AI Agent ran ${parentRuns.length} times. The importer cannot safely associate repeated runs with model evidence.`,
          ),
        ];
      }

      const parentRunIndex = 0;
      const items = parentItemCount(parentRuns[parentRunIndex]);
      if (items !== 1) {
        return [
          await authoredOnlyCandidate(
            context,
            node,
            authored,
            items === undefined
              ? "execution-detail-unavailable"
              : "multiple-input-items",
            items === undefined
              ? "The saved AI Agent run did not contain a supported item shape, so only its authored messages can be reviewed."
              : `This AI Agent produced ${items} items. The importer will not guess how model sub-runs map to them.`,
            parentRunIndex,
          ),
        ];
      }

      const connectedModels = connectedModelNodes(context.workflow, node);
      if (connectedModels.length !== 1) {
        return [
          await authoredOnlyCandidate(
            context,
            node,
            authored,
            "model-connection-ambiguous",
            `Expected one connected chat model but found ${connectedModels.length}.`,
            parentRunIndex,
          ),
        ];
      }
      const modelNode = connectedModels[0]!;
      if (!supportsOpenAiChatModel(modelNode)) {
        return [
          await authoredOnlyCandidate(
            context,
            node,
            authored,
            "unsupported-model-node",
            `The AI Agent importer supports only ${supportedOpenAiChatModelLabel()}.`,
            parentRunIndex,
          ),
        ];
      }

      const allModelRuns = Array.isArray(allRunData?.[modelNode.name])
        ? allRunData![modelNode.name] as unknown[]
        : [];
      const matchingRuns = modelRunsForParent(
        allModelRuns,
        node.name,
        parentRunIndex,
      );
      if (matchingRuns.length !== 1) {
        return [
          await authoredOnlyCandidate(
            context,
            node,
            authored,
            "model-evidence-ambiguous",
            `Expected one attributable saved model sub-run but found ${matchingRuns.length}.`,
            parentRunIndex,
          ),
        ];
      }

      const modelRunIndex = allModelRuns.indexOf(matchingRuns[0]);
      const saved = savedModelInput(
        matchingRuns[0],
        modelNode.name,
        modelRunIndex,
      );
      const resolvedMessages = saved
        ? parseAgentSavedMessages(saved.messages)
        : undefined;
      if (!saved || !resolvedMessages) {
        return [
          await authoredOnlyCandidate(
            context,
            node,
            authored,
            "model-evidence-incompatible",
            "The saved model sub-run did not contain an unambiguous System/Human message shape.",
            parentRunIndex,
          ),
        ];
      }

      const resolved: ResolvedPromptSnapshot = {
        messages: resolvedMessages,
        ...(saved.model ? { model: saved.model } : {}),
        ...(saved.temperature === undefined
          ? {}
          : { options: { temperature: saved.temperature } }),
      };
      const expression = expressionEvidence(
        authored,
        resolvedMessages,
        `${saved.evidencePath}[0]`,
      );
      const warnings: ImportWarning[] = [
        warning(
          "provider-request-unavailable",
          "n8n saved the effective agent messages but not a raw provider request, so this prompt is reconstructed from execution evidence.",
          "info",
        ),
      ];
      if (context.workflowSnapshotSource === "current-workflow") {
        warnings.push(
          warning(
            "current-workflow-snapshot",
            "The saved execution did not contain a workflow snapshot, so the authored fields come from the current workflow and may differ from what ran.",
          ),
        );
      }
      if (
        authored.some(({ syntax }) => syntax === "external-expression") &&
        expression.bindings.some(({ status }) => status !== "resolved")
      ) {
        warnings.push(
          warning(
            "expression-values-unavailable",
            "Individual n8n expression results are not attributable in the saved execution; unresolved regions will become native template variables without saved values.",
            "info",
          ),
        );
      }
      warnings.push(...invalidExpressionWarnings(expression.issues));
      return [
        {
          status: "candidate",
          candidate: await createExternalPromptCandidate(
            sourceEvidence(context, node, authored, warnings, {
              runIndex: parentRunIndex,
              itemIndex: 0,
              resolved,
              bindings: expression.bindings,
            }),
          ),
        },
      ];
    },
  };
}

function createMessageAModelExtractor(version: number): N8nPromptExtractor {
  return {
    id: `message-a-model-${String(version).replace(".", "-")}`,

    recognizes(node) {
      return node.type === MESSAGE_A_MODEL_TYPE;
    },

    supports(node) {
      return node.typeVersion === version;
    },

    async extract(context, node) {
      const authored = messageAuthoredFields(node);
      if (!authored) {
        return [
          {
            status: "unsupported",
            invocation: invocationFor(node),
            code: "unsupported-node-configuration",
            message:
              "Message a Model import currently requires the Text / Message a Model operation with string message content.",
          },
        ];
      }

      const parentRuns = runData(context.execution)?.[node.name];
      if (Array.isArray(parentRuns) && parentRuns.length > 1) {
        return [
          await authoredOnlyCandidate(
            context,
            node,
            authored,
            "multiple-node-runs",
            `This Message a Model node ran ${parentRuns.length} times. Only its authored messages can be reviewed.`,
          ),
        ];
      }
      const singleRun =
        Array.isArray(parentRuns) && parentRuns.length === 1
          ? parentRuns[0]
          : undefined;
      const runIndex = singleRun === undefined ? undefined : 0;
      const items =
        singleRun === undefined ? undefined : parentItemCount(singleRun);
      if (items !== undefined && items !== 1) {
        return [
          await authoredOnlyCandidate(
            context,
            node,
            authored,
            "multiple-input-items",
            `This Message a Model node produced ${items} items. Only its authored messages can be reviewed.`,
            runIndex,
          ),
        ];
      }
      return [
        await authoredOnlyCandidate(
          context,
          node,
          authored,
          "provider-request-unavailable",
          "n8n did not retain the effective provider request for this Message a Model execution, so only its authored messages can be reviewed.",
          runIndex,
        ),
      ];
    },
  };
}

export const defaultN8nPromptExtractors: readonly N8nPromptExtractor[] = [
  basicLlmChainExtractor,
  ...AI_AGENT_VERSIONS.map(createAiAgentExtractor),
  ...MESSAGE_A_MODEL_VERSIONS.map(createMessageAModelExtractor),
];

export async function extractN8nPromptCandidates(
  execution: N8nExecutionDetail,
  currentWorkflow?: N8nWorkflowDetail,
  extractors: readonly N8nPromptExtractor[] = defaultN8nPromptExtractors,
  detailAvailability: N8nDetailAvailability =
    execution.data === undefined || execution.data === null
      ? "not-retained"
      : "full",
): Promise<N8nPromptExtraction[]> {
  const fromExecution = executionWorkflowSnapshot(execution);
  const selectedWorkflow =
    fromExecution ??
    (currentWorkflow ? currentWorkflowSnapshot(currentWorkflow) : undefined);
  if (!selectedWorkflow) return [];
  // The top-level public API field was already checked against the user's
  // selected workflow. Treat it as authoritative over the observed nested
  // execution snapshot.
  const workflow = {
    ...selectedWorkflow,
    id: execution.workflowId,
  };

  const context: N8nExtractionContext = {
    workflow,
    execution,
    workflowSnapshotSource: fromExecution ? "execution" : "current-workflow",
    detailAvailability,
  };
  const results: N8nPromptExtraction[] = [];
  for (const node of workflow.nodes) {
    const recognized = extractors.filter((candidate) =>
      candidate.recognizes(node),
    );
    if (recognized.length === 0) continue;
    // Extractors are registered per node version, so recognition of the type
    // must not shadow a sibling extractor that supports this exact version.
    const extractor = recognized.find((candidate) => candidate.supports(node));
    if (!extractor) {
      results.push({
        status: "unsupported",
        invocation: invocationFor(node),
        code: "unsupported-node-version",
        message: `${node.type}@${node.typeVersion ?? "unknown"} is recognized, but this importer supports only a fixture-verified node version.`,
      });
      continue;
    }
    results.push(...(await extractor.extract(context, node)));
  }
  for (const node of workflow.unparsedNodes) {
    // Only surface unreadable nodes an extractor would have inspected;
    // reporting every unreadable node in the workflow would be noise.
    const probe: N8nNodeSnapshot = { ...node, parameters: {} };
    if (!extractors.some((candidate) => candidate.recognizes(probe))) continue;
    results.push({
      status: "unsupported",
      invocation: { id: node.id, name: node.name, type: node.type },
      code: "incompatible-node-snapshot",
      message: `${node.type} could not be read from the saved workflow snapshot, so its prompt cannot be reviewed.`,
    });
  }
  return results;
}
