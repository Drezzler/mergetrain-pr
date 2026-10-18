# Efficient mergetrain operation

The fastest safe train is not the one with the most shortcuts. It is the one
whose expensive work is measured, scoped, and run at the right time.
mergetrain's default remains conservative: isolated worktrees, full pre-push
gates, explicit deploy approval, and no cache or validation reuse.

Use this order when reducing latency:

1. remove avoidable waiting around the runner;
2. make each gate fast and deterministic;
3. scope independent gates to the paths that can affect them;
4. batch compatible work so shared gates run once;
5. consider a persistent build cache only after measuring a cold-build problem;
6. consider validated-gate reuse only with an explicit safety policy.

Cache and validated-gate reuse solve different problems. A cache accelerates a
gate that still runs. Reuse skips eligible pre-push gates after restoring and
verifying an exact validation identity.

## Measure the critical path first

Start with read-only commands:

```sh
mergetrain status --diagnose --json
mergetrain stats --json
```

`stats` separates the timings that operators can act on:

| Field | What it measures | Typical response when high |
| --- | --- | --- |
| `latency.queue_wait` | first train request to validation/direct-deploy runner start | start the runner sooner; check daemon ownership and scheduling |
| `latency.approval_wait` | completed validation to the deploy runner start | validate only a final train and request approval immediately |
| `latency.runs.validate` | observed validation runner duration | inspect validation phases and slow gates |
| `latency.runs.deploy` | observed deploy runner duration | inspect gates, push, and post-push verify separately |
| `latency.phases[]` | fetch, assembly, gates, push, and verify by run mode | optimize the phase that actually dominates |
| `gates[]` | completion state and duration by gate | parallelize or narrow the slow gate |
| `validation.runs.failure_rate` | validation runs with any failed member, over conclusive retained runs | inspect failure reasons before changing train size or gates |
| `validation.trains.deployment_rate` | validated trains that eventually deployed, including pending trains in the denominator | reduce supersession and approval delay; use `resolved_deployment_rate` for closed outcomes |
| `outcomes.not_landed_reason_counts` | mutually exclusive reasons that observed trains have not deployed | address the largest repeatable failure class first |
| `outcomes.conflicts` | merge and semantic conflicts over terminal trains | separate high-conflict branches or improve task boundaries |
| `trains.terminal_land_rate` | deployed trains over deployed + blocked + failed + canceled trains | compare with legacy `land_rate` to expose cancellation/supersession cost |
| `batching.jobs_per_run` | claimed jobs per retained runner invocation | compare actual batches with the intended two-to-five-job starting heuristic |
| `batching.estimated_savings` | conservative gate executions and seconds avoided by successful multi-job runs | weigh observed savings against validation failure and conflict rates |
| `recovery.operation_counts` | operator `reconcile` invocations plus retained historical `recover` evidence since the selected baseline | investigate repeated recovery before treating it as normal operating cost |

Recommendations require at least three timed samples and include their evidence.
Treat them as leads, not commands. Runner events retain the newest 5,000 rows,
and the `latency.coverage` object says how much usable history was observed.
Incomplete runs are counted in coverage but never converted into zero-second
samples.

The batch-savings figure is a counterfactual, not observed elapsed-time savings:
it assumes the same timed successful gate would otherwise have run once per
job. Failed, partial, reused, skipped, and untimed gates contribute nothing.
This makes the estimate conservative and auditable, but it still cannot account
for per-job cache effects or parallelism. Check it alongside validation failure
and conflict rates, never by itself.

`stats.evidence_gaps` is also operational evidence. Recovery-operation tracking
starts at the durable `recovery.tracking_started_at` baseline. A database born
on schema 11 has a complete all-history window. An upgraded database reports
that earlier invocations are unknown; use `--since` at or after the baseline
for a complete window. Mergetrain never backfills frequency from mutable job
notes.

`average_queue_seconds` remains available for compatibility, but it aggregates
durable job history and can include long human pauses. Prefer the attributed
`latency` fields when deciding what to optimize.

## Build coherent trains

Batching saves time when several low-conflict branches share the same expensive
gates. As a starting heuristic, try two to five cohesive jobs per train, then
adjust from your own failure and timing history. There is no universal ideal
size.

Good batch candidates:

- small changes in separate modules;
- documentation and code changes covered by the same quick checks;
- branches whose combined behavior is the behavior you intend to ship.

Keep a branch separate when it changes a schema, lockfile, generated project
file, release pipeline, or another high-conflict surface. A large train with a
likely semantic conflict makes failure isolation and revalidation more
expensive than the saved gate run.

Do not leave a validated train waiting while continuing to edit its branches.
Freeze the intended membership, validate it, inspect the exact `train_id`, and
request deploy approval promptly. A changed task head is correctly refused.

### Choose batch or ordered

**Keep `batch` for ordinary parallel development.** Use `ordered` when the
workflow needs one submission per landing and must keep the same order after
a failed submission is repaired. This is a repository setting; task agents
use the same handoff commands in both modes. See
[configuration and release availability](config.md#queue) before enabling it.

| Question | `batch` (default) | `ordered` (optional) |
| --- | --- | --- |
| What does the runner take? | The eligible queued submissions available when it starts | The earliest unfinished submission only |
| Can later work pass a failed submission? | Yes, after failure isolation and checks on the remaining combination | No; resolve the earlier submission first |
| Where does a retry go? | The back of the queue | The original submission's position |
| What is the tradeoff? | Share checks across compatible work | Run checks per submission and accept waiting behind an unresolved head |

#### Example: agents develop independent web features

Suppose three agents finish unrelated changes and submit A, B, then C:

- A fixes login in the authentication module.
- B adds a search filter in the search module.
- C updates the admin screen.

With `batch`, if all three are queued when the runner starts, it merges them
in submission order and checks the combined result. If B is proven to fail
on its own, the runner checks A+C as a fresh combination. A+C can land only
after those checks pass. B's agent repairs and commits its branch, then an
authorized operator or repair controller uses `retry`. The replacement joins
the back of the queue and may be processed with other waiting work.

```text
A+B+C checks → isolate failing B → A+C checks and landing
B repair → retry → back of queue
```

`ordered` would land A, then hold C while B is repaired. Choose `batch` here
when B's original position has no value to the workflow. It also processes a
single available submission; there is no wait for a complete group of agents.

#### Example: agents make compiler optimizations

Suppose three agents submit A (constant folding), B (loop optimization), and
C (register allocation). Each change must be measured against the preceding
landed result. Configure the project gates to run the required performance
checks, and select `ordered`:

```text
A checks, measurement, landing
  → B fails
  → B repair and retry at the same position
  → B checks, measurement, landing
  → C checks, measurement, landing
```

After A lands, B's candidate includes A. After B lands, C's candidate includes
A+B. This lets the project compare each candidate with the previous landed
baseline. B's repair retains its position before C, including after a runner
restart. A batch of all three would measure their combined effect instead.

The reviewed [Darklang compiler integration](https://github.com/pbiggar/darklang-compiler/blob/096c7d42d1ece1dd63e51077d53e0f701822e676/scripts/run-mergetrain-integrator.sh)
uses a separate first-in, first-out ledger and promotes a landed performance
baseline before advancing to the next submission. That source is a concrete
example of this ordering need. Our [compatibility evidence](evidence/darklang-compatibility-2026-10-15.json)
covers the pinned integration code and disposable Git workflows; it does not
claim an upstream migration or execution of the external compiler.

In both examples, agents can continue developing and submitting new work
while the runner integrates earlier submissions. `ordered` pauses later
landings, not agent development. Agents or a repair controller still make
fixes and request retries; the processing mode does not perform coding work.
Both modes retain deploy approval, configured verification, and the default
pre-push recheck. With the same checks and several compatible submissions,
`ordered` runs those checks per submission instead of sharing a batch run.

#### Changes that must land in order

Submission order starts when finished work is enqueued, not when development
starts. Neither mode reserves a slot before work begins. Queue order also
does not express a code dependency. Express that in Git:

- **A change that needs another:** build its branch on top of the other and
  enqueue only the top branch. That one job carries both changes, so the later
  one can never land without the earlier one. If the job fails, fix the stack
  and retry the job.
- **One change per landing,** for example to compare performance against the
  preceding deployed change: use ordered processing instead of maintaining
  another admission ledger. Keep benchmark policy in project gates.

Neither mode makes an absent prerequisite safe.

## Design gates for fast failure

Put cheap, high-signal checks before expensive checks. Keep commands
deterministic and non-interactive, and pin their toolchain through the project
lockfile or environment. A gate must fail when a required tool is absent; a
silent skip produces quick but meaningless validation.

Current top-level gates run in order. Parallelize within a gate using the
project's own scheduler:

```yaml
gates:
  - name: lint
    run: ruff check .
  - name: tests
    run: python -m pytest -q -n auto
```

### Keep the assembled tree clean

A gate may read the assembled checkout and use caches outside it, but it must
not leave tracked or untracked output in the integration worktree. Mergetrain
fails the train if a successful command changes that tree; otherwise a pushed
commit could differ from the state the gate actually tested.

Disable repository-local caches and generated bytecode where practical. For a
Python gate, for example:

```yaml
gates:
  - name: tests
    run: python -B -m pytest -q -p no:cacheprovider
```

For other toolchains, redirect caches outside the checkout or make generated
paths ignored and remove them before the command exits. Do not weaken the clean
tree check to accommodate a mutating test command.

Avoid repeating the same expensive suite in multiple top-level gates. Separate
gates are useful when they have different path scopes, failure ownership, or
operating requirements—not merely to give one command several names.

### Scope gates by changed path

Use fail-closed `paths` for checks that truly cannot be affected outside a
known boundary:

```yaml
gates:
  - name: api-tests
    run: ./scripts/test-api
    paths:
      - api/**
      - shared/**
      - lockfiles/api.lock
```

Include shared code, build scripts, manifests, lockfiles, generated inputs, and
test infrastructure that can change the result. When mergetrain cannot compute
the changed-path set, it runs every scoped gate. Leave cross-cutting security,
policy, and repository-integrity checks unscoped.

Path scoping is often the best first optimization because it preserves cold,
isolated execution for every gate that does run.

### Keep pre-push and post-push work distinct

Pre-push gates answer “is this combined commit safe to land?” Post-push verify
hooks answer “did the landed commit become healthy in its destination?” Do not
move a safety requirement to `deploy.verify` just to make the push faster:
verify runs after the remote ref has already changed.

Network-dependent checks tend to be slower and less deterministic. Keep the
reproducible safety subset local and use a verify hook for remote CI or live
health only when a post-push warning is the correct failure model.

## Cache only a measured cold-build bottleneck

The recommended default is:

```yaml
state:
  validation_workspace:
    mode: ephemeral
```

Stay ephemeral when tests are already fast, cache correctness is unclear, the
tool writes outside the declared project directory, or most deploy latency is
approval/remote verification rather than local compilation.

Persistent validation is reasonable when all of these are true:

- `stats` shows a repeatable cold-build gate bottleneck;
- the tool has a project-local, Git-ignored cache directory;
- the cache is safe across hard resets and branch combinations;
- a stable cache identity can include every relevant toolchain and policy
  input;
- warm validation saves enough time to justify maintenance and disk cost.

Example:

```yaml
state:
  validation_workspace:
    mode: persistent
    cache_key: unity-library-v2
    cache_paths:
      - game/Library
```

mergetrain preserves only the declared ignored directories, invalidates them
when the key, gate policy, or environment fingerprints change, and continues
to use isolated deploy and bisect worktrees. Change `cache_key` when the cache
schema or an un-fingerprinted toolchain changes.

Roll out one cache at a time. Compare at least three cold and three warm
validation samples, monitor disk growth and flake rate, and revert to
`ephemeral` if the saving is not material. Never add a cache path merely
because a build tool has one.

## Reuse validation only under an explicit policy

Validated-gate reuse is more aggressive than a warm cache. Keep
`deploy.reuse.enabled: false` unless the repository owner has accepted and
committed the policy. v3 deliberately has no one-off reuse switch. Use
`mergetrain deploy --json` to inspect the exact non-pushing decision.

Safe reuse needs a short age limit, environment fingerprints for compilers,
SDKs, container images, and other non-Git inputs, plus
`always_rerun_on_deploy: true` for time-sensitive policy checks. Prefer
`on_mismatch: rerun` while introducing the policy. Post-push verification still
runs.

Do not use reuse to hide a slow, flaky, or over-broad test suite. Fix or scope
that suite first.

## Keep one operator checkout authoritative

The runner reads configuration from the control checkout, the one that holds
the shared queue, even when mergetrain starts in a linked task worktree. An old
or locally edited `.mergetrain.yaml` there can silently select different gates
from the integration branch.

`status --diagnose --json`, run from the control checkout or any of its task
worktrees, compares that configuration's bytes with the configuration at the
locally known integration ref and reports:

- `config_drift.state=in_sync` when the blobs match;
- `drifted` plus an `operator_config_drift` recommendation when they differ;
- an explicit unavailable/missing state when comparison is impossible.

This check is read-only and does not fetch, so update the operator checkout's
remote refs through the repository's normal safe workflow. Review the diff;
do not discard uncommitted operator changes automatically.

Let exactly one runner or daemon own merge, gates, push, and verify. Multiple
agents may enqueue, but they should not run competing integration loops or push
deploy refs themselves.

## Recovery is part of the fast path

Fast recovery avoids repeating failed manual work:

1. Read `status --json` and follow `next_action`.
2. Fix a blocked or failed job in its owning worktree and commit the result.
3. Run `mergetrain retry <job-id>` to dismiss the old outcome and capture fresh
   SHAs.
4. After a crash or ambiguous push, run `reconcile --apply` before another
   deploy.

Do not bypass a failed row with a duplicate enqueue. That loses failure
ownership and makes queue history harder to interpret. When the owning branch
must stay as it was handed off, replace the job from a separate branch instead,
as [failure modes](failure-modes.md#repairing-on-a-separate-branch) describes.

## Project profiles

These are starting points, not universal presets:

| Project | First optimization | Cache guidance |
| --- | --- | --- |
| Python | use pytest-xdist where isolation permits; scope lint/type/test gates to source, tests, config, and lockfiles | usually stay ephemeral; Python bytecode and package caches rarely justify a stable worktree |
| Node | use the lockfile's reproducible install and the test runner's worker controls; separate frontend/backend scopes | prefer package-manager caches managed outside the worktree; preserve `node_modules` only with strong lockfile/platform invalidation |
| Gradle/Android | use Gradle's own parallelism and build cache; scope by modules plus shared build logic and version catalogs | measure first; project-local caches may help, while machine-global caches are outside validation-workspace preservation |
| Unity | keep trains small around scenes, prefabs, and project settings; run batch-mode validation | `Library` is a strong candidate only when ignored, path-stable, fingerprinted by editor/toolchain, and demonstrably faster |

For every profile, include shared build inputs in path scopes and fingerprints.
A false skip is more expensive than a cold run.

## Adoption checklist

- [ ] `status --diagnose --json` is healthy and config drift is understood.
- [ ] One runner owns all integration and deploy work.
- [ ] Gates are ordered from cheap/high-signal to expensive.
- [ ] The test runner uses safe internal parallelism.
- [ ] Path scopes include shared inputs and fail closed.
- [ ] Three or more samples identify the actual slow phase.
- [ ] Persistent cache remains off unless warm results justify it.
- [ ] Validated reuse remains off unless explicitly authorized and fingerprinted.
- [ ] Validation happens only after train membership is final.
- [ ] Failed jobs are fixed and retried; crash outcomes are reconciled.
