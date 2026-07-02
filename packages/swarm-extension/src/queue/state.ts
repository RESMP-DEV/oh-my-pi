/**
 * Filesystem state tracker for task-queue execution.
 *
 * Persists queue and per-task state to `.queue_<name>/` in the workspace:
 *
 *   .queue_<name>/
 *     state/queue.json       # Live queue + per-task status and attempts
 *     logs/orchestrator.log  # Scheduling decisions, worker activity
 *     logs/<task>.log        # Per-task attempt history
 *     context/               # Subagent session artifacts
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ============================================================================
// State types
// ============================================================================

export type QueueStatus = "idle" | "running" | "completed" | "failed" | "aborted";
export type TaskStatus = "pending" | "running" | "verifying" | "completed" | "failed" | "skipped";

/** One model attempt at a task: which rung ran and how it ended. */
export interface TaskAttempt {
	/** Resolved model selector for this attempt; undefined = session default. */
	model?: string;
	startedAt: number;
	completedAt?: number;
	/** Subagent exit code, or -1 when the attempt threw before completion. */
	exitCode?: number;
	/** "agent" = subagent failed; "verify" = agent passed but verify command failed. */
	failureStage?: "agent" | "verify";
	/** Bounded failure detail (stderr tail / verify output tail). */
	error?: string;
}

export interface TaskState {
	id: string;
	status: TaskStatus;
	attempts: TaskAttempt[];
	startedAt?: number;
	completedAt?: number;
	/** Terminal failure summary, or the dep id that caused a skip. */
	error?: string;
}

export interface QueueState {
	name: string;
	status: QueueStatus;
	workers: number;
	tasks: Record<string, TaskState>;
	startedAt: number;
	completedAt?: number;
}

// ============================================================================
// State tracker
// ============================================================================

export class QueueStateTracker {
	#queueDir: string;
	#state: QueueState;

	constructor(workspaceDir: string, name: string) {
		this.#queueDir = path.join(workspaceDir, `.queue_${name}`);
		this.#state = {
			name,
			status: "idle",
			workers: 0,
			tasks: {},
			startedAt: Date.now(),
		};
	}

	get queueDir(): string {
		return this.#queueDir;
	}

	get state(): Readonly<QueueState> {
		return this.#state;
	}

	async init(taskIds: string[], workers: number): Promise<void> {
		await fs.mkdir(path.join(this.#queueDir, "state"), { recursive: true });
		await fs.mkdir(path.join(this.#queueDir, "logs"), { recursive: true });
		await fs.mkdir(path.join(this.#queueDir, "context"), { recursive: true });

		this.#state.workers = workers;
		this.#state.status = "running";
		this.#state.startedAt = Date.now();

		for (const id of taskIds) {
			this.#state.tasks[id] = { id, status: "pending", attempts: [] };
		}

		await this.#persist();
	}

	async updateTask(id: string, update: Partial<TaskState>): Promise<void> {
		const task = this.#state.tasks[id];
		if (!task) return;
		Object.assign(task, update);
		await this.#persist();
	}

	/** Append an attempt record and return it for in-place completion updates. */
	async beginAttempt(id: string, model: string | undefined): Promise<TaskAttempt> {
		const attempt: TaskAttempt = { model, startedAt: Date.now() };
		this.#state.tasks[id]?.attempts.push(attempt);
		await this.#persist();
		return attempt;
	}

	async finishAttempt(attempt: TaskAttempt, update: Partial<TaskAttempt>): Promise<void> {
		Object.assign(attempt, update, { completedAt: Date.now() });
		await this.#persist();
	}

	async updateQueue(update: Partial<QueueState>): Promise<void> {
		Object.assign(this.#state, update);
		await this.#persist();
	}

	async appendLog(taskId: string, message: string): Promise<void> {
		const logPath = path.join(this.#queueDir, "logs", `${taskId}.log`);
		const timestamp = new Date().toISOString();
		await fs.appendFile(logPath, `[${timestamp}] ${message}\n`);
	}

	async appendOrchestratorLog(message: string): Promise<void> {
		const logPath = path.join(this.#queueDir, "logs", "orchestrator.log");
		const timestamp = new Date().toISOString();
		await fs.appendFile(logPath, `[${timestamp}] ${message}\n`);
	}

	async load(): Promise<QueueState | null> {
		const statePath = path.join(this.#queueDir, "state", "queue.json");
		try {
			const content = await Bun.file(statePath).text();
			this.#state = JSON.parse(content) as QueueState;
			return this.#state;
		} catch {
			return null;
		}
	}

	async #persist(): Promise<void> {
		await Bun.write(path.join(this.#queueDir, "state", "queue.json"), JSON.stringify(this.#state, null, 2));
	}
}
