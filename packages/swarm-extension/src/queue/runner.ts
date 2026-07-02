/**
 * Task-queue runner: N workers pull ready tasks from a priority-ordered,
 * dependency-gated queue and retry failures up an escalation ladder.
 *
 * Unlike the swarm pipeline's static waves, tasks unblock individually the
 * moment their dependencies complete — workers never idle behind an unrelated
 * slow task in the same "wave".
 *
 * Escalation: attempt N uses `escalation[min(N, len-1)]` unless the task pins
 * `model`. With the default ladder this encodes the model policy — cheap
 * cascade first, GLM, GPT 5.5, frontier last.
 */
import type { AgentProgress, ModelRegistry, Settings, SingleResult } from "@oh-my-pi/pi-coding-agent";
import { executeQueueTask } from "./executor";
import type { QueueTask, TaskQueueDefinition } from "./schema";
import type { QueueStateTracker } from "./state";

// ============================================================================
// Types
// ============================================================================

export interface QueueRunOptions {
	workspace: string;
	signal?: AbortSignal;
	onProgress?: (taskId: string, progress?: AgentProgress) => void;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
}

export interface QueueRunResult {
	status: "completed" | "failed" | "aborted";
	completed: number;
	failed: number;
	skipped: number;
	/** Final (successful or last-attempt) subagent result per executed task. */
	results: Map<string, SingleResult>;
	errors: string[];
}

type TerminalStatus = "completed" | "failed" | "skipped";

// ============================================================================
// Runner
// ============================================================================

export class QueueRunner {
	#def: TaskQueueDefinition;
	#stateTracker: QueueStateTracker;
	/** Declaration index per task id — the tie-break after priority. */
	#order: Map<string, number>;

	constructor(def: TaskQueueDefinition, stateTracker: QueueStateTracker) {
		this.#def = def;
		this.#stateTracker = stateTracker;
		this.#order = new Map(def.tasks.map((t, i) => [t.id, i]));
	}

	async run(options: QueueRunOptions): Promise<QueueRunResult> {
		const { signal } = options;
		const byId = new Map(this.#def.tasks.map(t => [t.id, t]));
		const pending = new Set(this.#def.tasks.map(t => t.id));
		const running = new Set<string>();
		const done = new Map<string, TerminalStatus>();
		const results = new Map<string, SingleResult>();
		const errors: string[] = [];
		let agentIndex = 0;

		// Completion notifier: workers with nothing ready park here until any
		// running task settles (or the run aborts).
		let wake = Promise.withResolvers<void>();
		const notify = () => {
			const current = wake;
			wake = Promise.withResolvers<void>();
			current.resolve();
		};
		signal?.addEventListener("abort", notify, { once: true });

		await this.#stateTracker.appendOrchestratorLog(
			`Queue '${this.#def.name}' starting: workers=${this.#def.workers} tasks=${this.#def.tasks.length} escalation=[${this.#def.escalation.join(" -> ")}]`,
		);

		const worker = async (workerId: number): Promise<void> => {
			while (!signal?.aborted) {
				// Cascade skips: a pending task with a failed/skipped dependency can
				// never run. Iterate to a fixed point — one sweep is not enough when
				// declaration order opposes dependency order (a dependent visited
				// before its blocker is skipped would be orphaned as pending).
				let cascaded = true;
				while (cascaded) {
					cascaded = false;
					for (const id of pending) {
						const task = byId.get(id)!;
						const blocker = task.dependsOn.find(d => done.get(d) === "failed" || done.get(d) === "skipped");
						if (blocker === undefined) continue;
						pending.delete(id);
						done.set(id, "skipped");
						cascaded = true;
						await this.#stateTracker.updateTask(id, {
							status: "skipped",
							completedAt: Date.now(),
							error: `dependency '${blocker}' did not complete`,
						});
						await this.#stateTracker.appendOrchestratorLog(
							`Skipping '${id}': dependency '${blocker}' did not complete`,
						);
						options.onProgress?.(id);
					}
				}

				const next = this.#pickReady(pending, byId, done);
				if (!next) {
					if (pending.size === 0 || running.size === 0) return;
					await wake.promise;
					continue;
				}

				pending.delete(next.id);
				running.add(next.id);
				await this.#stateTracker.appendOrchestratorLog(`Worker ${workerId} picked '${next.id}'`);
				try {
					const outcome = await this.#runTask(next, () => agentIndex++, options);
					done.set(next.id, outcome.status);
					if (outcome.result) results.set(next.id, outcome.result);
					if (outcome.error) errors.push(`${next.id}: ${outcome.error}`);
				} finally {
					running.delete(next.id);
					notify();
				}
			}
		};

		try {
			const workerCount = Math.min(this.#def.workers, this.#def.tasks.length);
			await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i + 1)));

			if (signal?.aborted) {
				await this.#stateTracker.updateQueue({ status: "aborted", completedAt: Date.now() });
				await this.#stateTracker.appendOrchestratorLog("Queue aborted");
				return { status: "aborted", ...tally(done), results, errors };
			}

			const counts = tally(done);
			const status = counts.failed > 0 || counts.skipped > 0 ? ("failed" as const) : ("completed" as const);
			await this.#stateTracker.updateQueue({ status, completedAt: Date.now() });
			await this.#stateTracker.appendOrchestratorLog(
				`Queue ${status}: ${counts.completed} completed, ${counts.failed} failed, ${counts.skipped} skipped`,
			);
			return { status, ...counts, results, errors };
		} catch (err) {
			if (signal?.aborted) {
				await this.#stateTracker.updateQueue({ status: "aborted", completedAt: Date.now() });
				return { status: "aborted", ...tally(done), results, errors };
			}
			const error = err instanceof Error ? err.message : String(err);
			errors.push(error);
			await this.#stateTracker.updateQueue({ status: "failed", completedAt: Date.now() });
			await this.#stateTracker.appendOrchestratorLog(`Queue fatal error: ${error}`);
			return { status: "failed", ...tally(done), results, errors };
		} finally {
			signal?.removeEventListener("abort", notify);
		}
	}

	/**
	 * Highest-priority ready task: all dependencies completed. Lower `priority`
	 * wins; declaration order breaks ties.
	 */
	#pickReady(pending: Set<string>, byId: Map<string, QueueTask>, done: Map<string, TerminalStatus>): QueueTask | null {
		let best: QueueTask | null = null;
		for (const id of pending) {
			const task = byId.get(id)!;
			if (!task.dependsOn.every(d => done.get(d) === "completed")) continue;
			if (
				!best ||
				task.priority < best.priority ||
				(task.priority === best.priority && this.#order.get(task.id)! < this.#order.get(best.id)!)
			) {
				best = task;
			}
		}
		return best;
	}

	/** Run one task through its attempt/escalation loop until pass or budget exhausted. */
	async #runTask(
		task: QueueTask,
		nextIndex: () => number,
		options: QueueRunOptions,
	): Promise<{ status: TerminalStatus; result?: SingleResult; error?: string }> {
		const { workspace, signal, onProgress, modelRegistry, settings } = options;
		const ladder = this.#def.escalation;
		// max_retries = retries after the first attempt.
		const totalAttempts = task.maxRetries + 1;

		await this.#stateTracker.updateTask(task.id, { status: "running", startedAt: Date.now() });
		onProgress?.(task.id);

		let lastError: string | undefined;
		let lastResult: SingleResult | undefined;

		for (let attempt = 0; attempt < totalAttempts; attempt++) {
			if (signal?.aborted) break;

			// Empty ladder or exhausted rungs resolve to undefined = session default.
			const model = task.model ?? (ladder.length > 0 ? ladder[Math.min(attempt, ladder.length - 1)] : undefined);
			if (attempt > 0) {
				await this.#stateTracker.updateTask(task.id, { status: "running" });
				await this.#stateTracker.appendOrchestratorLog(
					`Retrying '${task.id}' (attempt ${attempt + 1}/${totalAttempts}) on ${model ?? "session default"}`,
				);
			}

			const outcome = await executeQueueTask(this.#def, task, {
				workspace,
				model,
				index: nextIndex(),
				attempt,
				signal,
				onProgress: (taskId, progress) => onProgress?.(taskId, progress),
				modelRegistry,
				settings,
				stateTracker: this.#stateTracker,
			});
			lastResult = outcome.result;
			onProgress?.(task.id);

			if (outcome.ok) {
				await this.#stateTracker.updateTask(task.id, { status: "completed", completedAt: Date.now() });
				return { status: "completed", result: outcome.result };
			}
			lastError = outcome.error;
		}

		const error = signal?.aborted ? (lastError ?? "aborted") : (lastError ?? "unknown failure");
		await this.#stateTracker.updateTask(task.id, { status: "failed", completedAt: Date.now(), error });
		return { status: "failed", result: lastResult, error };
	}
}

function tally(done: Map<string, TerminalStatus>): { completed: number; failed: number; skipped: number } {
	let completed = 0;
	let failed = 0;
	let skipped = 0;
	for (const status of done.values()) {
		if (status === "completed") completed++;
		else if (status === "failed") failed++;
		else skipped++;
	}
	return { completed, failed, skipped };
}
