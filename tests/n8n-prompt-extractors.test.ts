import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { parseExternalPromptCandidate } from "../packages/core/src/external-prompt-import.ts";
import {
  canImportExternalPromptAsTemplate,
  projectExternalPromptTemplate,
} from "../packages/core/src/external-prompt-project.ts";
import {
  defaultN8nPromptExtractors,
  extractN8nPromptCandidates,
  parseN8nWorkflowSnapshot,
  scanN8nExpressionRegions,
  type N8nExecutionDetail,
  type N8nPromptExtractor,
  type N8nWorkflowDetail,
} from "../services/api/src/index.ts";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/n8n/captures/2.32.5",
);

async function executionFixture(
  directory: string,
  filename: string,
): Promise<N8nExecutionDetail> {
  return JSON.parse(
    await readFile(path.join(fixtureRoot, directory, filename), "utf8"),
  ) as N8nExecutionDetail;
}

async function workflowFixture(
  directory: string,
): Promise<N8nWorkflowDetail> {
  return JSON.parse(
    await readFile(path.join(fixtureRoot, directory, "workflow.json"), "utf8"),
  ) as N8nWorkflowDetail;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function dataRecord(execution: N8nExecutionDetail): Record<string, unknown> {
  assert.ok(execution.data && typeof execution.data === "object");
  return execution.data as Record<string, unknown>;
}

function runDataRecord(execution: N8nExecutionDetail): Record<string, unknown> {
  const resultData = dataRecord(execution).resultData as Record<string, unknown>;
  return resultData.runData as Record<string, unknown>;
}

test("the fixture-proven multi-item Basic LLM Chain fails closed with authored provenance", async () => {
  const execution = await executionFixture(
    "basic-llm-chain-success",
    "execution-success.json",
  );
  const results = await extractN8nPromptCandidates(execution);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "authored-only");
  assert.equal(compound.candidate.resolved, undefined);
  assert.equal(compound.candidate.bindings[0]?.status, "missing");
  assert.equal(
    compound.candidate.warnings[0]?.code,
    "multiple-input-items",
  );
  assert.doesNotThrow(() => parseExternalPromptCandidate(compound.candidate));
  const projection = projectExternalPromptTemplate(compound.candidate);
  assert.equal(projection.messages.length, 1);
  assert.equal(
    projection.messages[0]?.content,
    "IL_P0_LITERAL\n" +
      "simple={{topic}}\n" +
      "two={{first}}|{{second}}\n" +
      "compound={{expression_1}}\n" +
      "nested={{topic_2}}\n" +
      "repeated={{first}}|{{repeat}}",
  );
  assert.deepEqual(projection.values, {});
});

test("a single-item Basic LLM Chain produces a validated reconstructed user message", async () => {
  const captured = await executionFixture(
    "basic-llm-chain-success",
    "execution-success.json",
  );
  const execution = clone(captured);
  const runData = runDataRecord(execution);
  const parentRuns = runData["Compound prompt cases"] as Array<{
    data: { main: unknown[][] };
  }>;
  parentRuns[0]!.data.main[0] = parentRuns[0]!.data.main[0]!.slice(0, 1);
  const modelRuns = runData["Fixture OpenAI Chat Model"] as unknown[];
  runData["Fixture OpenAI Chat Model"] = modelRuns.slice(0, 1);

  const results = await extractN8nPromptCandidates(execution);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "execution-reconstructed");
  assert.deepEqual(compound.candidate.resolved, {
    messages: [
      {
        role: "user",
        content:
          "IL_P0_LITERAL\n" +
          "simple=IL_P0_TOPIC_ALPHA\n" +
          "two=IL_P0_REPEAT|IL_P0_SECOND_ALPHA\n" +
          "compound=IL_P0_TOPIC_ALPHA::IL_P0_SECOND_ALPHA\n" +
          'nested=value:{"inner":"IL_P0_TOPIC_ALPHA"}\n' +
          "repeated=IL_P0_REPEAT|IL_P0_REPEAT",
      },
    ],
    model: "template-echo-model",
    options: { temperature: 0 },
  });
  assert.deepEqual(
    compound.candidate.bindings.map(({ expression, status }) => ({
      expression,
      status,
    })),
    [
      { expression: "{{ $json.topic }}", status: "missing" },
      { expression: "{{ $json.first }}", status: "missing" },
      { expression: "{{ $json.second }}", status: "missing" },
      {
        expression:
          "{{\n" +
          "  [$json.topic, $json.second]\n" +
          "    .map((value) => `${value}`)\n" +
          '    .join("::")\n' +
          "}}",
        status: "missing",
      },
      {
        expression:
          "{{ `value:${JSON.stringify({ inner: $json.topic })}` }}",
        status: "missing",
      },
      { expression: "{{ $json.first }}", status: "missing" },
      { expression: "{{ $json.repeat }}", status: "missing" },
    ],
  );
  assert.equal(compound.candidate.invocation.runIndex, 0);
  assert.equal(compound.candidate.invocation.itemIndex, 0);
  assert.doesNotThrow(() => parseExternalPromptCandidate(compound.candidate));
});

test("OpenAI Chat Model 1.3 reconstructs saved evidence for chains and agents", async () => {
  for (const fixture of [
    {
      directory: "basic-llm-chain-success",
      parentName: "Compound prompt cases",
      modelName: "Fixture OpenAI Chat Model",
    },
    {
      directory: "ai-agent-3-1",
      parentName: "AI Agent 3.1 contract",
      modelName: "AI Agent 3.1 OpenAI Chat Model",
    },
  ]) {
    const execution = clone(
      await executionFixture(fixture.directory, "execution-success.json"),
    );
    const runData = runDataRecord(execution);
    if (fixture.directory === "basic-llm-chain-success") {
      const parentRuns = runData[fixture.parentName] as Array<{
        data: { main: unknown[][] };
      }>;
      parentRuns[0]!.data.main[0] = parentRuns[0]!.data.main[0]!.slice(0, 1);
      runData[fixture.modelName] = (
        runData[fixture.modelName] as unknown[]
      ).slice(0, 1);
    }
    const workflowData = dataRecord(execution).workflowData as {
      nodes: Array<{ type: string; typeVersion: number }>;
    };
    workflowData.nodes.find(
      ({ type }) =>
        type === "@n8n/n8n-nodes-langchain.lmChatOpenAi",
    )!.typeVersion = 1.3;

    const results = await extractN8nPromptCandidates(execution);
    const result = results.find(
      (extraction) =>
        extraction.status === "candidate" &&
        extraction.candidate.invocation.name === fixture.parentName,
    );
    assert.ok(result?.status === "candidate");
    assert.equal(result.candidate.fidelity, "execution-reconstructed");
    assert.ok(result.candidate.resolved?.messages.length);
    assert.equal(
      result.candidate.warnings.some(
        ({ code }) => code === "unsupported-model-node",
      ),
      false,
    );
  }
});

test("fixture-verified AI Agent versions reconstruct attributable system and user messages", async () => {
  for (const fixture of [
    {
      directory: "ai-agent-2-2",
      version: "2.2",
      prefix: "IL_AGENT_2_2",
      caseValue: "ai-agent-2.2",
    },
    {
      directory: "ai-agent-3",
      version: "3",
      prefix: "IL_AGENT_3",
      caseValue: "ai-agent-3",
    },
    {
      directory: "ai-agent-3-1",
      version: "3.1",
      prefix: "IL_AGENT_3_1",
      caseValue: "ai-agent-3.1",
    },
  ]) {
    const execution = await executionFixture(
      fixture.directory,
      "execution-success.json",
    );
    const workflow = await workflowFixture(fixture.directory);
    const results = await extractN8nPromptCandidates(execution, workflow);

    assert.equal(results.length, 1);
    const result = results[0];
    assert.ok(result?.status === "candidate");
    const candidate = result.candidate;
    assert.equal(candidate.invocation.version, fixture.version);
    assert.equal(candidate.invocation.runIndex, 0);
    assert.equal(candidate.invocation.itemIndex, 0);
    assert.equal(candidate.fidelity, "execution-reconstructed");
    assert.deepEqual(
      candidate.authored.map(({ path, role }) => ({ path, role })),
      [
        { path: "parameters.options.systemMessage", role: "system" },
        { path: "parameters.text", role: "user" },
      ],
    );
    assert.deepEqual(candidate.resolved, {
      messages: [
        {
          role: "system",
          content: `${fixture.prefix}_SYSTEM\ntopic=${fixture.prefix}_TOPIC_ALPHA`,
        },
        {
          role: "user",
          content:
            `${fixture.prefix}_USER\n` +
            `case=${fixture.caseValue}\n` +
            `topic=${fixture.prefix}_TOPIC_ALPHA\n` +
            `compound=${fixture.prefix}_TOPIC_ALPHA::${fixture.prefix}_SECOND_ALPHA\n` +
            `repeated=${fixture.prefix}_REPEAT|${fixture.prefix}_REPEAT`,
        },
      ],
      model: "template-echo-model",
      options: { temperature: 0 },
    });
    assert.ok(candidate.bindings.length > 0);
    assert.ok(candidate.bindings.every(({ status }) => status === "missing"));
    assert.deepEqual(
      candidate.warnings.map(({ code }) => code),
      [
        "provider-request-unavailable",
        "expression-values-unavailable",
      ],
    );
    assert.doesNotThrow(() => parseExternalPromptCandidate(candidate));
  }
});

test("AI Agent reconstruction fails closed when serialized role boundaries are ambiguous", async () => {
  const execution = await executionFixture(
    "ai-agent-3-1",
    "execution-success.json",
  );
  const workflow = await workflowFixture("ai-agent-3-1");
  const runData = runDataRecord(execution);
  const modelRun = (
    runData["AI Agent 3.1 OpenAI Chat Model"] as Array<{
      inputOverride: {
        ai_languageModel: Array<Array<{ json: { messages: string[] } }>>;
      };
    }>
  )[0]!;
  modelRun.inputOverride.ai_languageModel[0]![0]!.json.messages[0] =
    "System: ambiguous\nHuman: embedded\nHuman: actual";

  const results = await extractN8nPromptCandidates(execution, workflow);
  assert.equal(results.length, 1);
  const result = results[0];
  assert.ok(result?.status === "candidate");
  assert.equal(result.candidate.fidelity, "authored-only");
  assert.equal(result.candidate.resolved, undefined);
  assert.deepEqual(
    result.candidate.warnings.map(({ code }) => code),
    ["model-evidence-incompatible"],
  );
});

test("Message a Model 1.2 and 1.3 retain ordered authored roles without trusting echoed output", async () => {
  for (const fixture of [
    { directory: "message-a-model-1-2", version: "1.2" },
    { directory: "message-a-model-1-3", version: "1.3" },
  ]) {
    const execution = await executionFixture(
      fixture.directory,
      "execution-success.json",
    );
    const workflow = await workflowFixture(fixture.directory);
    const runData = runDataRecord(execution);
    const targetName = `Message a Model ${fixture.version} contract`;
    const targetRun = (
      runData[targetName] as Array<{
        data: { main: Array<Array<{ json: Record<string, unknown> }>> };
      }>
    )[0]!;
    targetRun.data.main[0]![0]!.json = {
      message: {
        role: "assistant",
        content: "This output is not request evidence.",
      },
    };

    const results = await extractN8nPromptCandidates(execution, workflow);
    assert.equal(results.length, 1);
    const result = results[0];
    assert.ok(result?.status === "candidate");
    const candidate = result.candidate;
    assert.equal(candidate.invocation.version, fixture.version);
    assert.equal(candidate.invocation.runIndex, 0);
    assert.equal(candidate.fidelity, "authored-only");
    assert.equal(candidate.resolved, undefined);
    assert.deepEqual(
      candidate.authored.map(({ path, role }) => ({ path, role })),
      [
        {
          path: "parameters.messages.values[0].content",
          role: "system",
        },
        {
          path: "parameters.messages.values[1].content",
          role: "assistant",
        },
        {
          path: "parameters.messages.values[2].content",
          role: "user",
        },
      ],
    );
    assert.deepEqual(
      candidate.warnings.map(({ code }) => code),
      ["provider-request-unavailable"],
    );
    assert.ok(candidate.bindings.length > 0);
    assert.ok(candidate.bindings.every(({ status }) => status === "missing"));
    assert.doesNotThrow(() => parseExternalPromptCandidate(candidate));

    const projection = projectExternalPromptTemplate(candidate);
    assert.deepEqual(
      projection.messages.map(({ role }) => role),
      ["system", "assistant", "user"],
    );
  }
});

test("scans fixture-backed n8n expression regions without evaluating JavaScript", async () => {
  const fixture = JSON.parse(
    await readFile(
      path.resolve(
        import.meta.dirname,
        "fixtures/n8n/parser-cases/expression-regions.json",
      ),
      "utf8",
    ),
  ) as {
    cases: Array<{
      authored: string;
      expressions: string[];
      error?: { offset: number; reason: string };
    }>;
  };
  for (const parserCase of fixture.cases) {
    const scan = scanN8nExpressionRegions(parserCase.authored);
    if (parserCase.error) {
      assert.deepEqual(scan, {
        ok: false,
        errorOffset: parserCase.error.offset,
        reason: parserCase.error.reason,
      });
    } else {
      assert.equal(scan.ok, true);
      if (!scan.ok) continue;
      assert.deepEqual(
        scan.regions.map(({ expression }) => expression),
        parserCase.expressions,
      );
    }
  }
});

test("missing model evidence degrades to authored-only instead of inferring from parent output", async () => {
  const execution = await executionFixture(
    "basic-llm-chain-invalid-syntax",
    "execution-error.json",
  );
  const results = await extractN8nPromptCandidates(execution);
  assert.equal(results.length, 2);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "authored-only");
  assert.equal(
    compound.candidate.warnings[0]?.code,
    "execution-detail-unavailable",
  );
});

test("an unsafe n8n expression warning identifies the field and parse failure", async () => {
  const execution = clone(
    await executionFixture("basic-llm-chain-success", "execution-success.json"),
  );
  const workflowData = dataRecord(execution).workflowData as {
    nodes: Array<{ name: string; parameters: { text?: string } }>;
  };
  workflowData.nodes.find(
    ({ name }) => name === "Compound prompt cases",
  )!.parameters.text = "=Before {{ $json.topic";

  const results = await extractN8nPromptCandidates(execution);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  const issue = compound.candidate.warnings.find(
    ({ code }) => code === "invalid-expression-regions",
  );
  assert.equal(
    issue?.message,
    'Expression issue in parameters.text at character 8: Expression is missing its closing }} delimiter. Reusable template import is unavailable.',
  );
});

test("missing retained execution data falls back to current authored text with an explicit compatibility warning", async () => {
  const workflow = await workflowFixture("basic-llm-chain-success");
  const execution: N8nExecutionDetail = {
    id: "execution_without_data",
    workflowId: "workflow_fixture",
    status: "success",
    startedAt: "2026-07-28T12:00:00.000Z",
    data: null,
  };
  const results = await extractN8nPromptCandidates(execution, workflow);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "authored-only");
  assert.deepEqual(
    compound.candidate.warnings.map(({ code }) => code),
    ["execution-detail-unavailable", "current-workflow-snapshot"],
  );
  assert.equal(compound.candidate.source.resource.id, "workflow_fixture");
  assert.equal(
    compound.candidate.source.execution?.id,
    "execution_without_data",
  );
});

test("an unsupported connected model preserves an importable authored trace", async () => {
  const execution = clone(
    await executionFixture("ai-agent-3-1", "execution-success.json"),
  );
  const workflowData = dataRecord(execution).workflowData as {
    nodes: Array<{ type: string; typeVersion: number }>;
  };
  workflowData.nodes.find(
    ({ type }) => type === "@n8n/n8n-nodes-langchain.lmChatOpenAi",
  )!.typeVersion = 1.4;

  const results = await extractN8nPromptCandidates(execution);
  assert.equal(results.length, 1);
  const result = results[0];
  assert.ok(result?.status === "candidate");
  assert.equal(result.candidate.fidelity, "authored-only");
  assert.equal(result.candidate.resolved, undefined);
  assert.deepEqual(
    result.candidate.warnings.map(({ code }) => code),
    ["unsupported-model-node"],
  );
  assert.equal(canImportExternalPromptAsTemplate(result.candidate), true);
  const projection = projectExternalPromptTemplate(result.candidate);
  assert.deepEqual(
    projection.messages.map(({ role }) => role),
    ["system", "user"],
  );
});

test("recognized future Basic LLM Chain versions are explicit unsupported results", async () => {
  const execution = await executionFixture(
    "basic-llm-chain-success",
    "execution-success.json",
  );
  const workflowData = dataRecord(execution).workflowData as {
    nodes: Array<{ name: string; typeVersion: number }>;
  };
  workflowData.nodes.find(
    (node) => node.name === "Compound prompt cases",
  )!.typeVersion = 2;

  const results = await extractN8nPromptCandidates(execution);
  const unsupported = results.find(
    (result) =>
      result.status === "unsupported" &&
      result.invocation.name === "Compound prompt cases",
  );
  assert.deepEqual(unsupported, {
    status: "unsupported",
    invocation: {
      id: "node_fixture_003",
      name: "Compound prompt cases",
      type: "@n8n/n8n-nodes-langchain.chainLlm",
      version: "2",
    },
    code: "unsupported-node-version",
    message:
      "@n8n/n8n-nodes-langchain.chainLlm@2 is recognized, but this importer supports only a fixture-verified node version.",
  });
});

test("recognized future AI Agent and Message a Model versions remain unsupported", async () => {
  for (const fixture of [
    {
      directory: "ai-agent-3-1",
      type: "@n8n/n8n-nodes-langchain.agent",
      nextVersion: 3.2,
    },
    {
      directory: "message-a-model-1-3",
      type: "@n8n/n8n-nodes-langchain.openAi",
      nextVersion: 1.4,
    },
  ]) {
    const execution = await executionFixture(
      fixture.directory,
      "execution-success.json",
    );
    const workflowData = dataRecord(execution).workflowData as {
      nodes: Array<{ type: string; typeVersion: number }>;
    };
    workflowData.nodes.find(({ type }) => type === fixture.type)!.typeVersion =
      fixture.nextVersion;

    const results = await extractN8nPromptCandidates(execution);
    assert.equal(results.length, 1);
    const result = results[0];
    assert.ok(result?.status === "unsupported");
    assert.equal(result.code, "unsupported-node-version");
    assert.equal(result.invocation.version, String(fixture.nextVersion));
  }
});

test("a sibling extractor supporting a newer node version is not shadowed", async () => {
  const execution = clone(
    await executionFixture(
      "basic-llm-chain-success",
      "execution-success.json",
    ),
  );
  const workflowData = dataRecord(execution).workflowData as Record<
    string,
    unknown
  >;
  for (const node of workflowData.nodes as Array<Record<string, unknown>>) {
    if (node.type === "@n8n/n8n-nodes-langchain.chainLlm") {
      node.typeVersion = 1.11;
    }
  }

  // Extractors are registered one per supported node version. Registering a
  // newer one alongside the fixture-verified extractor must reach it.
  const nextVersionExtractor: N8nPromptExtractor = {
    id: "basic-llm-chain-1-11",
    recognizes: (node) => node.type === "@n8n/n8n-nodes-langchain.chainLlm",
    supports: (node) => node.typeVersion === 1.11,
    extract: async (_context, node) => [
      {
        status: "unsupported",
        invocation: { id: node.id, name: node.name, type: node.type },
        code: "unsupported-node-configuration",
        message: "handled by the 1.11 extractor",
      },
    ],
  };

  const results = await extractN8nPromptCandidates(execution, undefined, [
    ...defaultN8nPromptExtractors,
    nextVersionExtractor,
  ]);
  assert.ok(
    results.length > 0 &&
      results.every(
        (result) =>
          result.status === "unsupported" &&
          result.message === "handled by the 1.11 extractor",
      ),
    "every recognized node should reach the extractor supporting its version",
  );

  // Without a sibling that supports the version, the unsupported result stands.
  const withoutSibling = await extractN8nPromptCandidates(execution, undefined, [
    ...defaultN8nPromptExtractors,
  ]);
  assert.ok(
    withoutSibling.every(
      (result) =>
        result.status === "unsupported" &&
        result.code === "unsupported-node-version",
    ),
  );
});

test("an unreadable node is skipped instead of failing the whole workflow", async () => {
  const execution = clone(
    await executionFixture(
      "basic-llm-chain-success",
      "execution-success.json",
    ),
  );
  const runData = runDataRecord(execution);
  const parentRuns = runData["Compound prompt cases"] as Array<{
    data: { main: unknown[][] };
  }>;
  parentRuns[0]!.data.main[0] = parentRuns[0]!.data.main[0]!.slice(0, 1);
  runData["Fixture OpenAI Chat Model"] = (
    runData["Fixture OpenAI Chat Model"] as unknown[]
  ).slice(0, 1);

  const workflowData = dataRecord(execution).workflowData as Record<
    string,
    unknown
  >;
  const nodes = workflowData.nodes as Array<Record<string, unknown>>;
  // An unrelated node this importer cannot read must not block the import, and
  // must not be reported: no extractor would have inspected it.
  nodes.push({ id: "node_opaque", name: "Opaque node", type: "unknown.node" });
  // A recognized node that cannot be read is reported instead of vanishing.
  nodes.push({
    id: "node_broken",
    name: "Broken chain",
    type: "@n8n/n8n-nodes-langchain.chainLlm",
  });

  const results = await extractN8nPromptCandidates(execution);
  const compound = results.find(
    (result) =>
      result.status === "candidate" &&
      result.candidate.invocation.name === "Compound prompt cases",
  );
  assert.ok(compound?.status === "candidate");
  assert.equal(compound.candidate.fidelity, "execution-reconstructed");

  assert.deepEqual(
    results.find(
      (result) =>
        result.status === "unsupported" && result.invocation.id === "node_broken",
    ),
    {
      status: "unsupported",
      invocation: {
        id: "node_broken",
        name: "Broken chain",
        type: "@n8n/n8n-nodes-langchain.chainLlm",
      },
      code: "incompatible-node-snapshot",
      message:
        "@n8n/n8n-nodes-langchain.chainLlm could not be read from the saved workflow snapshot, so its prompt cannot be reviewed.",
    },
  );
  assert.equal(
    results.some(
      (result) =>
        result.status === "unsupported" && result.invocation.id === "node_opaque",
    ),
    false,
  );
});

test("an unreadable workflow envelope is still rejected", () => {
  for (const envelope of [
    undefined,
    null,
    "workflow",
    [],
    { name: "no id", nodes: [], connections: {} },
    { id: "w", nodes: [], connections: {} },
    { id: "w", name: "no nodes", connections: {} },
    { id: "w", name: "bad nodes", nodes: "changed shape", connections: {} },
    { id: "w", name: "no connections", nodes: [] },
  ]) {
    assert.equal(
      parseN8nWorkflowSnapshot(envelope),
      undefined,
      `expected ${JSON.stringify(envelope)} to be unreadable`,
    );
  }

  assert.deepEqual(
    parseN8nWorkflowSnapshot({
      id: "w",
      name: "Readable",
      nodes: [{}],
      connections: {},
    }),
    { id: "w", name: "Readable", nodes: [], unparsedNodes: [], connections: {} },
  );
});
