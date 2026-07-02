# Changelog

## [Unreleased]

### Added

- Added per-model steering profiles: a top-level `swarm.steering` map (selector substring → system-prompt text, `"*"` matches every agent) and a per-agent `steering` field, letting cheap models (MiniMax, GLM, DeepSeek Flash) carry extra process discipline while strong models run clean.
- Added `swarm.max_parallel` (default 0 = unbounded) bounding concurrent agents within a wave, enabling 50+ agent swarms without overwhelming workers or providers.
- Added task-queue orchestration (`/queue run`, `/queue status`, `omp-queue` bin): a dependency-gated, priority-ordered work queue where N workers pull tasks the moment their dependencies complete (no wave barriers), each task's optional `verify` shell command gates success (rejection sampling), and failed attempts retry up an optional model escalation ladder (`tasks.escalation`, ordered cheap → frontier; omitted = no escalation) unless the task pins `model`. Queue-level `steering` profiles reuse the swarm selector semantics.

## [15.9.0] - 2026-06-04

### Fixed

- Fixed swarm `/swarm run` failing with authStorage/modelRegistry identity error ([#1472](https://github.com/can1357/oh-my-pi/issues/1472))
