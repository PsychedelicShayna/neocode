import { ProviderInstanceId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import {
  type AgentThread,
  agentToolProperties,
  catalogModelLabel,
  handoffSettings,
  providerDimensions,
} from "./ProviderDimensions.ts";

const provider = (
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; isCustom: boolean }>,
) =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    models,
  }) as unknown as ServerProvider;

const providers = [
  provider("work-codex", "codex", [{ slug: "gpt-5.5", isCustom: false }]),
  provider("claudeAgent", "claudeAgent", [
    { slug: "claude-opus-5-5", isCustom: false },
    { slug: "my-private-finetune", isCustom: true },
  ]),
  provider("opencode", "opencode", [{ slug: "ollama/acme-internal", isCustom: false }]),
];

const thread = (
  instanceId: string,
  model: string,
  overrides: Partial<AgentThread> = {},
): AgentThread => ({
  modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("t") },
  ...overrides,
});

it("omits custom, user-configured, and unknown models and instance names", () => {
  expect(
    agentToolProperties({
      tool: "t3_thread_send",
      providers,
      caller: thread("claudeAgent", "my-private-finetune"),
      targets: [thread("opencode", "ollama/acme-internal"), thread("removed-instance", "gpt-5.5")],
      outcome: { outcome: "ok" },
    }).map(({ callerProvider, callerModel, targetProvider, targetModel }) => ({
      callerProvider,
      callerModel,
      targetProvider,
      targetModel,
    })),
  ).toEqual([
    {
      callerProvider: "claudeAgent",
      callerModel: undefined,
      targetProvider: "opencode",
      targetModel: undefined,
    },
    {
      callerProvider: "claudeAgent",
      callerModel: undefined,
      targetProvider: "unknown",
      targetModel: undefined,
    },
  ]);
});

it("does not treat native discovery as proof that a model name is public", () => {
  const models = [
    { slug: "openai-codex/gpt-6.1-sol", isCustom: false },
    { slug: "company/internal-deployment", isCustom: false },
    { slug: "@private-review-role", isCustom: false },
    { slug: "anthropic/claude-fable-5-2", isCustom: true },
  ];
  const native = [provider("private-profile-name", "neopi", models)];
  expect(
    models.map(({ slug }) =>
      providerDimensions(native, {
        instanceId: ProviderInstanceId.make("private-profile-name"),
        model: slug,
      }),
    ),
  ).toEqual([
    { provider: "neopi", model: "gpt-6.1-sol" },
    { provider: "neopi" },
    { provider: "neopi" },
    { provider: "neopi" },
  ]);
  expect(catalogModelLabel("company/internal-deployment")).toBeUndefined();
  expect(catalogModelLabel("@private-review-role")).toBeUndefined();
  expect(catalogModelLabel("anthropic/claude-opus-5-5-20261101")).toBe("claude-opus-5-5");
  expect(catalogModelLabel("anthropic/opus-5.5")).toBe("claude-opus-5-5");
});

it("drops input strings outside the schema's literals, since rejected calls are recorded too", () => {
  expect(handoffSettings("delegate_task", { mode: "/home/me/secret" }, undefined)).toEqual({
    targetChosen: false,
    mode: "async",
  });
  expect(
    handoffSettings("t3_thread_launch", { workspaceStrategy: { type: "/home/me/secret" } }, {}),
  ).toEqual({ targetChosen: false, workspace: "root" });
});
