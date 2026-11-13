# MCP behavior grading

This directory retains the generic MCP behavior graders, case data, and offline regrading tool from upstream T3 Code. The Claude/Codex capture-based model runner and capture trimmer are retired: NeoCode executes through NeoPi, and those harness prompts are not a substitute for its native prompt and tool surface.

A future model-running eval needs an authoritative NeoPi prompt/tool capture seam. Until that exists, this directory does not claim to run a native NeoPi eval. The missing seam is a follow-up, not a prerequisite for the upstream sync.

## Regrade saved samples

From `evals/`:

```sh
pnpm mcp-tool-use:regrade runs/earlier/results.jsonl
pnpm mcp-tool-use:regrade runs/earlier/results.jsonl --cases mcp-tool-use/cases/secrets.ndjson
```

This performs no model calls and runs none of the recorded tool commands. It applies the current cases and graders to saved result rows, prints each changed result, and summarizes pass counts by case. Rows containing a runner error are excluded. A sample that stopped early but now passes is reported as cut short, not as a completed success.

Regrading cannot show that a changed prompt, world, tool description, or runtime behaves correctly. That requires fresh samples from an appropriate runner. Historical harness-specific samples remain historical evidence, not evidence of current NeoPi behavior.

## Retained modules

- `grading.ts` defines `McpToolUseCase`, tool-name/input normalization, `gradeSample`, `failedEarly`, and `pastedText`.
- `device-grading.ts` evaluates managed-device routing, ownership, capture/recording evidence, and bounded recovery attempts.
- `secret-grading.ts` evaluates secret requests, saved-file consumption, leakage, and behavior after a declined request.
- `devices.ts` provides the deterministic device-world helpers used by the device tests.

The graders read the current MCP tool schemas. Recorded Claude/Codex tool names can be normalized when regrading old results; this does not load or restore either execution adapter.

## Case data

Cases remain JSON lines in `cases/`, grouped by area. Each case identifies the experience it guards and its source. The schema in `grading.ts` documents the fields. Common checks include required/forbidden calls, partial argument matches, call ordering, per-tool counts, shell commands, final responses, links, device actions, and secret handling.

Argument matching supports `~text` for case-insensitive containment, `<=N` and `>=N` for numeric bounds, `null` for a missing or null value, and dotted paths for nested fields. Each `distinctCalls` or `newThreads` expectation must match a different call or request.

Device and secret cases retain their authored worlds and historical source references. A case marked for a retired harness must not be silently relabeled as native coverage. Preserve the general behavioral requirement when a real NeoPi runner can exercise it, and reassess harness-specific setup then.

Keep fixtures free of private user data. Use authored paths and identities such as `/home/user` and `acme/app`. Generic grader tests remain runnable without model credentials; repository-wide tests and paid model evals are separate operations.
