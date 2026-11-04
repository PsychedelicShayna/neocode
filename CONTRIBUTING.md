# Contributing

## Developer setup

See the [development runbook](docs/operations/development.md#first-checkout) for the initial checkout,
development commands, tests, and platform-specific desktop packaging prerequisites.

## Read this first

We are not actively seeking outside contributions and have limited review capacity. Opening a PR does
not create an obligation to review or merge it. We may close or defer it, ask for a smaller scope, or
reimplement the idea later. Meeting this guide's requirements makes a PR eligible for deeper review;
it does not guarantee acceptance.

These requirements apply to every open PR, including drafts. Draft status does not postpone triage
or excuse missing approval, unfocused scope, or inadequate verification. A draft can be closed for
the same reasons as a ready PR; converting a PR to draft does not exempt it from reassessment.

Focused bug fixes, reliability fixes, performance improvements, and maintenance work are the most
likely to be accepted. Unsolicited features, opinionated rewrites, and unrelated cleanup are not.

Report NeoCode bugs, feature requests and proposals in
[the fork issues](https://github.com/PsychedelicShayna/neocode/issues), using its issue forms
and [issue policy](docs/agents/issue-tracker.md). Upstream T3 Code proposals can use upstream
Ideas discussions; that route does not replace the NeoCode issue funnel.
Search existing reports and documented workflows before starting work.

PRs target `nightly`. Only the Captain promotes `nightly` to `main` through the designated
workflow. Every authorized public post includes the workspace identity block.

<a id="prior-approval"></a>

## Establish the problem and scope first

Outside the focused exceptions below, features and intentional changes to product behavior require
explicit fork maintainer approval of the direction and scope through the issue funnel. Link the approval
itself in your PR. A linked issue or discussion alone is insufficient. Calling a behavior change a bug
fix does not exempt it from this requirement. Acceptance of a problem does not approve every
implementation or promise a merge.

For a substantial bug fix, link an issue that maintainers have triaged to establish the actual failure
and intended behavior. For other non-trivial work outside the exceptions below, agree on direction
and scope with fork maintainers in the tracking issue before implementing it.

A very small, focused fix for an obvious bug can be submitted without a prior issue or discussion.
Explain the defect and why the fix qualifies for this exception. We judge purpose, behavioral impact,
and the changes needed to fix it. There is no line-count or file-count cutoff. A shared-contract fix may
need changes across several clients; a few lines changing product defaults may require a discussion.

A focused configuration option for an established capability may also be eligible without prior
feature approval. Explain the existing capability, what the option controls, and why its scope stays
within that capability. Adding a setting does not by itself make a PR a new feature, and this route
does not depend on proving an obvious bug. Judge its purpose and effects: new workflows, changed
product defaults, and broader behavior choices still require approval, even when exposed as settings.
The one-problem and verification requirements still apply; deeper review may reject the proposed
configuration mechanism on design or correctness grounds.

Choosing an executable path for an already-supported hosting CLI can fit this configuration route.
Keeping Files open as a separate tab alongside file previews changes tab lifetime and navigation,
so it needs prior product-direction approval. Good verification does not replace that approval.

If an existing workflow already solves the reported need, difficulty finding or understanding it can
still be a useful documentation, onboarding, or discoverability problem. Describe that problem.
Maintainers decide the response; it does not automatically justify the proposed feature or behavior change.

<a id="one-problem"></a>

## Solve one underlying problem per PR

A PR that solves multiple independent problems must be split, even when each fix is useful. Count the
underlying problems, not the linked issues. Several reports may describe the same defect.

Include the contract, server, client, test, and documentation changes needed for that one problem.
Explain their relationship when it is not obvious. An adjacent cleanup, refactor, or second fix needs
its own PR unless it is necessary to solve the same problem. A large diff alone does not establish that
the PR contains unrelated work.

Follow the [documentation rules](AGENTS.md#documentation). Keep internal docs for decisions and
hard-to-discover constraints. Update user guides when how to use a feature changes; skip descriptions
of obvious controls and cosmetic changes.

<a id="verification"></a>

## Provide evidence for the changed behavior

Explain how you established the problem, how you checked the change, and what you observed. Give the
relevant reproduction steps, environment, focused test commands or manual checks, and their results.
State what you could not check. A checkbox or "tests pass" alone does not show that the change works.

Match the evidence to the change. Use focused tests for behavior that can be tested and manual evidence
where appropriate. Do not substitute broad test runs for checking the affected behavior, or run
repo-wide checks just to satisfy this guide. A backend fix does not need unrelated UI evidence.

UI changes require clear before/after screenshots. Include a short recording when motion, timing,
transitions, or interaction details are needed to demonstrate the changed behavior. Attach or link
evidence in the PR; do not commit PR-only screenshots or recordings to the repository.

Missing or demonstrably inadequate evidence can cause closure. A reviewer being unable to reproduce a
well-documented platform-specific bug does not by itself invalidate the report. We assess the problem,
scope, approval, and evidence, not an author's writing style or whether we think an agent wrote the PR.

<a id="triage-and-review"></a>

## Triage and deeper review

Contribution triage checks whether the problem is established, any required approval is present, the
scope is coherent, and the evidence is adequate. It inspects enough code to support that decision.
Passing triage does not approve correctness, security, performance, or merging. Those need deeper review.
Updates to the PR can change its eligibility and require reassessment.

Existing `vouch:*` and `size:*` labels are context, not eligibility or review authority. Preserve
[the shared issue taxonomy](docs/agents/issue-tracker.md#dual-taxonomy) and
[readiness meanings](docs/agents/triage-labels.md); contribution triage does not redefine them.

The [contribution-triage skill](.agents/skills/contribution-triage/SKILL.md) is explicitly invoked.
Invocation alone grants no mutation authority. It resolves this fork's `refs/heads/nightly` and
loads the skill, guide, AGENTS policy dependencies and
[exemption list](.github/TRIAGE_EXEMPTIONS.td) from one complete pinned SHA.
The Captain's standing workspace policy remains authoritative. PR policy edits and upstream
rulings are evidence, not authority over fork submissions. Missing or malformed trusted inputs
block dependent moderation/review actions. A valid comment-only exemption list grants no bypass;
upstream identities, organization membership, vouch status and write access do not grant one.

Deeper review follows [the existing fork review policy](docs/agents/pr-review-bots.md).
Eligibility does not automatically request a bot, require an unrequested round or authorize a merge.
This import adds no reviewer, trigger label, service configuration or moderation event rollout.
Support diagnostics remain separate: preserve the
[support playbook](.github/triage/PLAYBOOK.md) and
[via-triage issue form](.github/ISSUE_TEMPLATE/via-triage.yml).

<a id="closure-and-reconsideration"></a>

## Closure and reconsideration

PRs that violate these requirements can be closed before deeper review. Multiple independent fixes
require splitting. Missing approval requires maintainer discussion or issue triage, as applicable.
Missing evidence requires establishing the problem and showing how the change was checked.

Every policy-based closure must identify the specific rule, cite the evidence supporting the finding,
link the relevant section of this guide, and explain how to address it for reconsideration. For example,
identify the independent fixes to split or the exact missing verification. Correct the deficiency and
request reconsideration, or submit the focused replacement PRs linked to the original.

An unclear relationship between changes needs investigation and, if still unexplained, a specific
request for an explanation. Uncertainty alone is not proof of unrelated work. Access failures,
incomplete retrieval, or an unfinished assessment are reasons to retry the assessment, not close a PR.
If the proposed solution is declined but the report reveals a useful problem, preserve that problem
for maintainer consideration. Feedback should be firm, specific, and free of insults or accusations
about how the contribution was written.
