import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const NeoPiModelsScope = Schema.Literals(["global", "project"]);
export const NeoPiModelsTarget = Schema.Struct({ providerInstanceId: ProviderInstanceId, projectId: Schema.optional(ProjectId), threadId: Schema.optional(ThreadId) });
export type NeoPiModelsTarget = typeof NeoPiModelsTarget.Type;
export const NeoPiModelSelectorQuery = Schema.Struct({ target: NeoPiModelsTarget, query: Schema.String });
export const NeoPiModelSelectorFacts = Schema.Struct({
  intelligence: Schema.NullOr(Schema.Number), ttftMs: Schema.NullOr(Schema.Number),
  tokensPerSecond: Schema.NullOr(Schema.Number), contextWindow: Schema.NullOr(Schema.Number),
  effectiveContextWindow: Schema.NullOr(Schema.Number),
  inputCostPerMillion: Schema.NullOr(Schema.Number), outputCostPerMillion: Schema.NullOr(Schema.Number),
  performanceSource: Schema.NullOr(Schema.Literals(["measured", "catalog"])), serviceTier: Schema.NullOr(Schema.String),
});
export type NeoPiModelSelectorFacts = typeof NeoPiModelSelectorFacts.Type;
export const NeoPiModelSelectorItem = Schema.Struct({
  selector: Schema.String, provider: Schema.String, id: Schema.String, name: Schema.String,
  description: Schema.optional(Schema.String), resolvedSelector: Schema.NullOr(Schema.String),
  facts: NeoPiModelSelectorFacts,
});
export type NeoPiModelSelectorItem = typeof NeoPiModelSelectorItem.Type;
export const NeoPiModelSelectorResult = Schema.Struct({
  items: Schema.Array(NeoPiModelSelectorItem), roles: Schema.Array(NeoPiModelSelectorItem), error: Schema.NullOr(Schema.String),
});
export type NeoPiModelSelectorResult = typeof NeoPiModelSelectorResult.Type;
export const NeoPiEffortSelection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("inherit") }),
  Schema.Struct({ mode: Schema.Literal("fixed"), level: Schema.String }),
  Schema.Struct({ mode: Schema.Literal("auto"), allowed: Schema.optional(Schema.Array(Schema.String)), selector: Schema.optional(Schema.String) }),
]);
export type NeoPiEffortSelection = typeof NeoPiEffortSelection.Type;
export const NeoPiEffortRule = Schema.Struct({ selector: Schema.String, allowed: Schema.Array(Schema.String) });
export type NeoPiEffortRule = typeof NeoPiEffortRule.Type;
export const NeoPiRoleConfigurationValue = Schema.Struct({ selector: Schema.NullOr(Schema.String), effort: Schema.NullOr(NeoPiEffortSelection) });
export const NeoPiNativeModel = Schema.Struct({
  provider: Schema.String, id: Schema.String, name: Schema.String, kind: Schema.String, available: Schema.Boolean,
  contextWindow: Schema.Number, effectiveContextWindow: Schema.Number, maxTokens: Schema.Number, reasoning: Schema.Boolean,
  cost: Schema.Struct({ input: Schema.Number, output: Schema.Number, cacheRead: Schema.Number, cacheWrite: Schema.Number }),
  supportsFastMode: Schema.Boolean, supportedThinkingLevels: Schema.Array(Schema.String), permittedEfforts: Schema.Array(Schema.String),
});
export type NeoPiNativeModel = typeof NeoPiNativeModel.Type;
export const NeoPiModelsConfiguration = Schema.Struct({
  providers: Schema.Array(Schema.Struct({
    id: Schema.String, name: Schema.String,
    mark: Schema.Struct({ text: Schema.String, seed: Schema.String, icon: Schema.String }),
    authenticated: Schema.Boolean, authSource: Schema.NullOr(Schema.String), available: Schema.Boolean, disabled: Schema.Boolean,
    loginProviders: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, available: Schema.Boolean })), envVars: Schema.Array(Schema.String),
  })),
  models: Schema.Array(NeoPiNativeModel),
  roles: Schema.Array(Schema.Struct({
    id: Schema.String, name: Schema.String, alias: Schema.String, hidden: Schema.Boolean,
    configured: Schema.NullOr(Schema.String), provenance: Schema.String,
    description: Schema.optional(Schema.String),
    resolved: Schema.NullOr(Schema.Struct({ provider: Schema.String, modelId: Schema.String, thinkingLevel: Schema.optional(Schema.String) })),
    effort: Schema.NullOr(NeoPiEffortSelection), global: NeoPiRoleConfigurationValue, project: NeoPiRoleConfigurationValue,
  })),
  roleStorage: Schema.Literals(["global", "project"]), effortMode: Schema.Literals(["replacement", "legacy"]),
  effortRules: Schema.Array(NeoPiEffortRule), effortRulesProvenance: Schema.String,
  effortRuleScopes: Schema.Struct({ global: Schema.NullOr(Schema.Array(NeoPiEffortRule)), project: Schema.NullOr(Schema.Array(NeoPiEffortRule)) }),
  effortChoices: Schema.Array(Schema.String),
});
export type NeoPiModelsConfiguration = typeof NeoPiModelsConfiguration.Type;
export const NeoPiModelsUpdate = Schema.Struct({ target: NeoPiModelsTarget, change: Schema.Union([
  Schema.Struct({ operation: Schema.Literal("role"), role: Schema.String, scope: NeoPiModelsScope, selector: Schema.optional(Schema.String), effort: Schema.optional(NeoPiEffortSelection), expected: NeoPiRoleConfigurationValue }),
  Schema.Struct({ operation: Schema.Literal("storage"), value: NeoPiModelsScope, expected: NeoPiModelsScope }),
  Schema.Struct({ operation: Schema.Literal("rules"), scope: NeoPiModelsScope, rules: Schema.optional(Schema.Array(NeoPiEffortRule)), expected: Schema.NullOr(Schema.Array(NeoPiEffortRule)) }),
  Schema.Struct({ operation: Schema.Literal("key"), providerId: Schema.String, apiKey: Schema.String }),
  Schema.Struct({ operation: Schema.Literal("logout"), providerId: Schema.String, credentialId: Schema.Number }),
]) });
export type NeoPiModelsUpdate = typeof NeoPiModelsUpdate.Type;
export const NeoPiModelsAccountsInput = Schema.Struct({ target: NeoPiModelsTarget, providerId: Schema.String });
export const NeoPiModelsAccounts = Schema.Struct({ accounts: Schema.Array(Schema.Struct({ credentialId: Schema.Number, provider: Schema.String, label: Schema.String, detail: Schema.String, type: Schema.Literals(["api_key", "oauth"]), active: Schema.Boolean })) });
export type NeoPiModelsAccounts = typeof NeoPiModelsAccounts.Type;
export const NeoPiModelsAuthStart = Schema.Struct({ target: NeoPiModelsTarget, providerId: Schema.String });
export const NeoPiModelsAuthRef = Schema.Struct({ flowId: Schema.String });
export const NeoPiModelsAuthRespond = Schema.Struct({ flowId: Schema.String, requestId: Schema.String, value: Schema.String });
export const NeoPiModelsAuthState = Schema.Struct({
  flowId: Schema.String, status: Schema.Literals(["running", "complete", "cancelled", "failed"]), message: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String), instructions: Schema.NullOr(Schema.String),
  prompt: Schema.NullOr(Schema.Struct({ id: Schema.String, title: Schema.String, placeholder: Schema.NullOr(Schema.String), secret: Schema.Boolean })),
});
export type NeoPiModelsAuthState = typeof NeoPiModelsAuthState.Type;
export class NeoPiModelsError extends Schema.TaggedError<NeoPiModelsError>()("NeoPiModelsError", { message: Schema.String }) {}
