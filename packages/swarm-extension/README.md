# Swarm Extension

Multi-agent orchestration for oh-my-pi. Define agent workflows in YAML — pipelines, parallel fan-outs, sequential chains, or any DAG — and run them unattended until completion.

Each agent is a full oh-my-pi subagent with access to every tool: bash, eval (Python/JS kernels), read, write, edit, grep, glob, fetch, web_search, browser. The orchestrator manages lifecycle and ordering; agents communicate through the shared workspace filesystem.

Use it for anything: research pipelines, code generation, data processing, content creation, analysis workflows, CI-like automation — any multi-step task that benefits from specialized agents working in coordination.

## Setup

```bash
cd packages/swarm-extension
bun install
```

## Running

### Standalone (recommended for long-running work)

```bash
# Foreground — runs until complete, no timeout:
omp-swarm path/to/swarm.yaml
omp-queue path/to/tasks.yaml

# Background — survives terminal close:
nohup omp-swarm path/to/swarm.yaml \
  > pipeline.log 2>&1 & disown
```

The standalone runners have no timeout. They run until the pipeline/queue finishes or you kill them.

### Inside oh-my-pi (TUI)

Register the extension in your config (`~/.omp/config.json` or `.omp/config.json`):

```json
{
	"extensions": ["packages/swarm-extension"]
}
```

Then:

```
/swarm run path/to/swarm.yaml
/swarm status <name>
/queue run path/to/tasks.yaml
/queue status <name>
```

## Monitoring

State persists to `<workspace>/.swarm_<name>/` while the pipeline runs:

```
.swarm_<name>/
  state/pipeline.json    # Live pipeline + per-agent status
  logs/orchestrator.log  # Wave transitions, iteration progress
  logs/<agent>.log       # Per-agent timestamps and errors
  context/               # Agent session artifacts
```

Check on a running pipeline:

```bash
# Quick status (state file is pretty-printed JSON)
cat workspace/.swarm_mypipeline/state/pipeline.json

# Watch the orchestrator log
tail -f workspace/.swarm_mypipeline/logs/orchestrator.log
```

---

## YAML Reference

Every swarm is a single YAML file with a top-level `swarm` key:

```yaml
swarm:
  name: my-pipeline # Identifier (state stored in .swarm_<name>/)
  workspace: ./workspace # Working directory (relative to YAML file location)
  mode: pipeline # pipeline | parallel | sequential
  target_count: 10 # Iterations (pipeline mode only, default: 1)
  model: claude-opus-4-6 # Default model for agents without an override (optional)

  agents:
    first_agent:
      role: short-role-name
      task: |
        Full instructions for this agent.
      extra_context: |
        Optional additional system prompt text.
      reports_to:
        - downstream_agent
      waits_for:
        - upstream_agent
      model: claude-sonnet-4-5 # Optional per-agent override
```

### Top-Level Fields

| Field          | Required | Default         | Description                                                                    |
| -------------- | -------- | --------------- | ------------------------------------------------------------------------------ |
| `name`         | yes      | —               | Pipeline identifier. State directory is `.swarm_<name>/`                       |
| `workspace`    | yes      | —               | Shared working directory. Relative paths resolve from YAML file location       |
| `mode`         | no       | `sequential`    | Execution mode (see below)                                                     |
| `target_count` | no       | `1`             | How many times to repeat the full pipeline. Only meaningful in `pipeline` mode |
| `model`        | no       | session default | Default model for agents that do not set `agents.<name>.model`                |
| `max_parallel` | no       | `0` (unbounded) | Max agents running concurrently within a wave                                  |
| `steering`     | no       | —               | Per-model steering profiles (see [Steering Profiles](#steering-profiles))      |

### Agent Fields

| Field           | Required | Description                                                             |
| --------------- | -------- | ----------------------------------------------------------------------- |
| `role`          | yes      | Short role identifier — becomes the agent's system prompt               |
| `task`          | yes      | Complete instructions sent as user prompt. Use YAML `\|` for multi-line |
| `extra_context` | no       | Additional text appended to system prompt                               |
| `model`         | no       | Model override for this agent only                                      |
| `steering`      | no       | Extra system-prompt discipline for this agent, appended verbatim        |
| `reports_to`    | no       | List of agent names that depend on this agent                           |
| `waits_for`     | no       | List of agent names this agent depends on                               |

### Execution Modes

**`pipeline`** — Repeat the full agent graph `target_count` times. Each iteration runs all waves in order. Use for accumulative work: "find 50 things, one per iteration."

**`sequential`** — Run agents once, chained by declaration order (unless explicit dependencies override). The default mode.

**`parallel`** — Run all agents simultaneously (unless explicit dependencies impose ordering).

### Dependency Resolution

The orchestrator builds a DAG from `waits_for` and `reports_to`, then groups agents into **waves** using topological sort. Agents in the same wave run in parallel; waves execute in sequence.

- `waits_for: [a, b]` — this agent won't start until both `a` and `b` finish
- `reports_to: [x]` — equivalent to `x` having `waits_for: [this_agent]`
- No explicit deps + `pipeline`/`sequential` mode — agents chain by YAML declaration order
- No explicit deps + `parallel` mode — all agents run in one wave
- Cycles are detected and rejected before execution

---

## Patterns

### Pipeline: Iterative Accumulation

Run the same agent chain N times. Each iteration builds on the previous one's output. Good for: research collection, data gathering, batch processing, iterative refinement.

```yaml
swarm:
  name: research-collector
  workspace: ./workspace
  mode: pipeline
  target_count: 25
  model: claude-opus-4-6

  agents:
    finder:
      role: researcher
      task: |
        Find ONE new source on the topic defined in workspace/topic.md.

        1. Read processed.txt to see what's already been found
        2. Use web_search to find a new, high-quality source
        3. Append the URL to processed.txt
        4. Write the URL to signals/finder_out.txt: FOUND:<url>

    analyzer:
      role: analyst
      task: |
        Read signals/finder_out.txt for the URL.
        Fetch the page and extract key findings.
        Read tracking/count.txt, increment it, write back.
        Write analysis to analyzed/item_<N>.md
        Write to signals/analyzer_out.txt: DONE:<N>

    compiler:
      role: technical-writer
      task: |
        Read signals/analyzer_out.txt for the item number.
        Read analyzed/item_<N>.md.
        Append a summary to output/report.md under a new section.
```

After 25 iterations: 25 sources found, analyzed, and compiled into a single report.

### Fan-In: Parallel Specialists

Multiple agents work independently, one synthesizer combines results. Good for: multi-perspective analysis, parallel code review, comprehensive audits.

```yaml
swarm:
  name: codebase-audit
  workspace: ./workspace

  agents:
    security:
      role: security-auditor
      task: |
        Audit all code in src/ for security vulnerabilities.
        Write findings to reports/security.md with severity ratings.
      reports_to:
        - lead

    performance:
      role: performance-analyst
      task: |
        Profile and analyze src/ for performance bottlenecks.
        Write findings to reports/performance.md with benchmarks.
      reports_to:
        - lead

    architecture:
      role: architecture-reviewer
      task: |
        Review src/ for architectural issues, coupling, and tech debt.
        Write findings to reports/architecture.md with refactoring suggestions.
      reports_to:
        - lead

    lead:
      role: engineering-lead
      task: |
        Read all reports in reports/.
        Create a prioritized action plan in output/action_plan.md.
        Rank issues by impact and effort.
      waits_for:
        - security
        - performance
        - architecture
```

Execution: security + performance + architecture run in parallel (wave 1), lead starts after all three complete (wave 2).

### Sequential Chain: Staged Handoff

Linear progression through distinct phases. Good for: content pipelines, multi-stage processing, review chains.

```yaml
swarm:
  name: blog-post
  workspace: ./workspace
  mode: sequential

  agents:
    researcher:
      role: researcher
      task: |
        Research the topic in topic.md using web_search.
        Write raw findings and source links to research/notes.md

    writer:
      role: technical-writer
      task: |
        Read research/notes.md.
        Write a complete blog post draft to drafts/post.md.
        Include code examples where relevant.

    editor:
      role: editor
      task: |
        Read drafts/post.md.
        Fix grammar, improve flow, tighten prose.
        Rewrite to drafts/post.md.

    reviewer:
      role: senior-reviewer
      task: |
        Read drafts/post.md.
        Check technical accuracy against research/notes.md.
        Add an editorial note at top if issues found, otherwise
        copy to output/final.md.
```

Execution: researcher -> writer -> editor -> reviewer, one after another.

### Diamond: Fan-Out Then Fan-In

One planner, parallel workers, one integrator. Good for: divide-and-conquer, modular code generation, multi-file refactors.

```yaml
swarm:
  name: feature-implementation
  workspace: ./workspace

  agents:
    planner:
      role: architect
      task: |
        Read the feature spec in spec.md.
        Break it into independent implementation tasks.
        Write the plan to plan.md with file assignments.
      reports_to:
        - api
        - ui
        - tests

    api:
      role: backend-developer
      task: |
        Read plan.md for your assigned files.
        Implement the API layer. Write to src/api/.
      reports_to:
        - integrator

    ui:
      role: frontend-developer
      task: |
        Read plan.md for your assigned files.
        Implement the UI components. Write to src/ui/.
      reports_to:
        - integrator

    tests:
      role: test-engineer
      task: |
        Read plan.md for the full feature scope.
        Write integration tests to tests/.
      reports_to:
        - integrator

    integrator:
      role: tech-lead
      task: |
        Read plan.md and review all code in src/ and tests/.
        Wire everything together. Fix any integration issues.
        Run the tests and fix failures.
        Write status to output/done.md.
```

Execution: planner (wave 1) -> api + ui + tests in parallel (wave 2) -> integrator (wave 3).

### Hybrid: Mixed Dependencies

Any DAG is valid. Combine patterns freely.

```yaml
swarm:
  name: data-pipeline
  workspace: ./workspace
  mode: pipeline
  target_count: 10

  agents:
    scraper_a:
      role: web-scraper
      task: |
        Scrape data source A. Write to raw/source_a.json
      reports_to:
        - transformer

    scraper_b:
      role: web-scraper
      task: |
        Scrape data source B. Write to raw/source_b.json
      reports_to:
        - transformer

    transformer:
      role: data-engineer
      task: |
        Read raw/source_a.json and raw/source_b.json.
        Clean, normalize, merge. Write to processed/merged.json
      reports_to:
        - loader
        - validator

    validator:
      role: qa-analyst
      task: |
        Read processed/merged.json.
        Validate schema, check for anomalies.
        Write report to qa/validation.md

    loader:
      role: data-engineer
      task: |
        Read processed/merged.json.
        Append to output/dataset.jsonl
```

Execution per iteration: scraper_a + scraper_b (wave 1) -> transformer (wave 2) -> loader + validator (wave 3).

---

## Writing Agent Tasks

### What Agents Can Do

Each agent is a full oh-my-pi session. It can:

- **bash/eval**: Run commands and Python/JS code, install packages, process data
- **read/write/edit**: Create and modify files in the workspace
- **grep/glob**: Search the workspace (or anywhere on disk)
- **web_search**: Search the internet (via configured provider)
- **fetch**: Download web pages, APIs, documents
- **browser**: Navigate websites, scrape dynamic content, take screenshots

### Inter-Agent Communication

The orchestrator starts and stops agents in the right order. It does **not** pass data between them. Agents communicate through files in the shared workspace.

Design your own protocol. Common patterns:

**Signal files** — lightweight status flags an agent writes when done:

```
signals/finder_out.txt    -> "FOUND:https://example.com"
signals/analyzer_out.txt  -> "DONE:42"
signals/reviewer_out.txt  -> "APPROVED" or "REJECTED:reason"
```

**Structured output** — detailed results other agents read:

```
analyzed/item_1.md        -> Full analysis document
results/report.json       -> Machine-readable data
output/final.docx         -> Accumulated deliverable
```

**Tracking files** — prevent duplicate work across pipeline iterations:

```
processed.txt             -> Items already handled (one per line)
tracking/count.txt        -> Current item counter
tracking/status.json      -> Cumulative state
```

### Tips for Reliable Agents

- **Be explicit about paths.** Agents start fresh each iteration — they don't remember previous runs. Tell them exactly where to read input and write output.
- **Check existing state.** In pipeline mode, tell agents to read tracking files before doing work: "Read processed.txt to avoid duplicates."
- **Use numbered outputs.** `item_1.md`, `item_2.md` etc. so iterations don't clobber each other.
- **Handle failure.** Tell agents what to do when things go wrong: "If the source lacks depth, write SKIP to signals/out.txt and explain why."
- **Keep signal files simple.** One line, parseable format. Complex data goes in structured output files.
- **Scope the task tightly.** An agent that tries to do five things will do zero well. One clear objective per agent.

---

## Models

Any model configured in omp works. Set a swarm default and optionally override per agent:

```yaml
swarm:
  model: claude-opus-4-6
  agents:
    writer:
      role: technical-writer
      task: |
        Write the draft.
    reviewer:
      role: reviewer
      model: claude-sonnet-4-5
      task: |
        Review the draft.
```

Precedence: `agents.<name>.model` → `swarm.model` → session default. Check `packages/catalog/src/models.json` for available model IDs.

### Steering Profiles

Cheap models need discipline, not distrust. `swarm.steering` maps a **selector** to system-prompt text appended to every agent whose resolved model selector contains that substring (case-insensitive). `"*"` matches every agent. Multiple matches concatenate in declaration order; an agent's own `steering` field lands last.

```yaml
swarm:
  model: claude-haiku-4-5
  steering:
    "*": |
      After every file change, run the check command and paste its output.
    haiku: |
      One file at a time. If a step fails twice, write BLOCKED:<reason>
      to signals/ and stop — do not improvise.
    glm: |
      Keep diffs minimal. Never refactor beyond the task.
  agents:
    fixer:
      role: bug-fixer
      model: glm-4.6                  # gets "*" + glm
      task: |
        Fix the failing test in tests/test_router.py.
    reviewer:
      role: reviewer
      model: claude-opus-4-6          # gets "*" only
      steering: "Approve only when the invariant table is complete."
      task: |
        Review the fix.
```

---

## Task Queues

Swarm pipelines run a **static DAG in waves** — every agent in wave N must finish before wave N+1 starts. Task queues are the complement for bulk work: **N workers pull from a dependency-gated, priority-ordered queue**, each task unblocks the moment its dependencies complete, and failures retry up a **model escalation ladder** with an objective `verify` gate.

Use a swarm when the shape of the work is the point (fan-out/fan-in, staged handoffs). Use a queue when you have a pile of tasks and want maximum throughput at minimum cost.

```yaml
tasks:
  name: refactor-sweep
  workspace: ./ws
  workers: 8                      # concurrent workers
  escalation:                     # attempt N uses rung min(N, last)
    - claude-haiku-4-5            # cheap first
    - claude-sonnet-4-5
    - claude-opus-4-6             # frontier last
  steering:
    "*": "Run the verify command yourself before finishing."
  max_retries: 3                  # retries after the first attempt
  verify_timeout_seconds: 600
  items:
    - id: contract
      prompt: Define the shared API contract in src/contract.ts
      priority: 0                 # lower runs sooner among ready tasks
      verify: bun check           # exit 0 = accepted (rejection sampling)
    - id: impl_a
      prompt: Implement module A against the contract
      depends_on: [contract]
      verify: bun test src/a.test.ts
    - id: impl_b
      prompt: Implement module B against the contract
      depends_on: [contract]
      model: glm-4.6                     # pinned — never escalates
      verify: bun test src/b.test.ts
    - id: integrate
      prompt: Wire A and B together
      depends_on: [impl_a, impl_b]
      verify: bun test
```

Semantics:

- **Scheduling** — a task is *ready* when every `depends_on` entry completed. Among ready tasks, lowest `priority` wins (declaration order breaks ties). Workers never idle behind an unrelated slow task.
- **Verification** — after the agent exits 0, `verify` runs in the workspace via `bash -c`. Non-zero exit rejects the attempt regardless of what the model claimed.
- **Escalation** — attempt N uses `escalation[min(N, len-1)]`. A failed cheap attempt escalates one rung; the frontier model is the last resort, not the default. Tasks that pin `model` retry on the same model instead. Omit `escalation` entirely and every attempt uses the task `model` or the session default.
- **Skip cascade** — when a task exhausts its retries (or is skipped), every transitive dependent is marked `skipped`, never run.
- **State** — persists to `<workspace>/.queue_<name>/` (`state/queue.json`, `logs/orchestrator.log`, `logs/<task>.log`, `context/`), same layout as swarms.

Queue `steering` uses the same selector semantics as swarms, matched against the model actually chosen for each attempt — so discipline text follows the task down the ladder and drops away on strong models.

---

## Architecture

```
src/extension.ts      TUI entry point (registers /swarm and /queue commands)
src/cli.ts            Standalone swarm runner (no TUI, no timeout)
src/queue-cli.ts      Standalone queue runner (no TUI, no timeout)
src/steering.ts       Per-model steering profile matching (shared)
src/swarm/
  schema.ts           YAML parsing + validation
  dag.ts              Dependency graph, cycle detection, topological sort
  executor.ts         Spawns agents via oh-my-pi's runSubprocess
  pipeline.ts         Iteration loop + wave controller
  state.ts            Filesystem state persistence
  render.ts           Progress display formatting
src/queue/
  schema.ts           Task-queue YAML parsing + dependency validation
  runner.ts           Worker pool, ready-task scheduling, escalation ladder
  executor.ts         One attempt: subagent run + verify command
  state.ts            Filesystem state persistence (.queue_<name>/)
  render.ts           Progress display formatting
```
