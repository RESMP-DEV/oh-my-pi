/**
 * Task-queue attempt execution: one subagent run plus optional verification.
 *
 * A task attempt succeeds only when the subagent exits 0 AND the task's
 * `verify` command (when present) exits 0 in the workspace — rejection
 * sampling against an objective check, not the model's self-report.
 */
import * as path from "node:path";
import type {
	AgentDefinition,
	AgentProgress,
	AgentSource,
	ModelRegistry,
	Settings,
	SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent";
import { ptree } from "@oh-my-pi/pi-utils";
import { matchSteeringProfiles } from "../steering";
import type { QueueTask, TaskQueueDefinition } from "./schema";
import type { QueueStateTracker } from "./state";

/** Bounded tail kept from failure output so state files stay small. */
const ERROR_TAIL_CHARS = 2_000;

export interface QueueAttemptOptions {
	workspace: string;
	/** Resolved model selector for this attempt (escalation rung or pinned); undefined = session default. */
	model?: string;
	/** Monotonic subagent index across the whole queue run. */
	index: number;
	/** 0-based attempt number for this task. */
	attempt: number;
	signal?: AbortSignal;
	onProgress?: (taskId: string, progress: AgentProgress) => void;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	stateTracker: QueueStateTracker;
}

export interface QueueAttemptResult {
	ok: boolean;
	result: SingleResult;
	/** Set when ok=false: which stage rejected the attempt. */
	failureStage?: "agent" | "verify";
	/** Bounded failure detail for logs/state. */
	error?: string;
}

/**
 * Run one attempt of a queue task: spawn the subagent, then run `verify`.
 *
 * Never throws for agent/verify failures — those come back as `ok: false` so
 * the runner owns retry/escalation. Only abort propagates as a rejection.
 */
export async function executeQueueTask(
	def: TaskQueueDefinition,
	task: QueueTask,
	options: QueueAttemptOptions,
): Promise<QueueAttemptResult> {
	const { workspace, model, index, attempt, signal, onProgress, modelRegistry, settings, stateTracker } = options;

	const agentId = `queue-${def.name}-${task.id}-${attempt}`;
	const agentDef: AgentDefinition = {
		name: task.id,
		description: `Queue task: ${task.role}`,
		systemPrompt: buildSystemPrompt(task, model, def.steering),
		source: "project" as AgentSource,
	};

	const attemptRecord = await stateTracker.beginAttempt(task.id, model);
	await stateTracker.appendLog(task.id, `Attempt ${attempt + 1} starting on ${model ?? "session default"}`);

	let result: SingleResult;
	try {
		result = await runSubprocess({
			cwd: workspace,
			agent: agentDef,
			task: task.prompt,
			index,
			id: agentId,
			modelOverride: model,
			signal,
			onProgress: progress => onProgress?.(task.id, progress),
			modelRegistry,
			settings,
			enableLsp: false,
			artifactsDir: path.join(stateTracker.queueDir, "context"),
		});
	} catch (err) {
		if (signal?.aborted) {
			await stateTracker.finishAttempt(attemptRecord, { exitCode: -1, failureStage: "agent", error: "aborted" });
			throw err;
		}
		const error = truncateTail(err instanceof Error ? err.message : String(err));
		await stateTracker.finishAttempt(attemptRecord, { exitCode: -1, failureStage: "agent", error });
		await stateTracker.appendLog(task.id, `Attempt ${attempt + 1} threw: ${error}`);
		return {
			ok: false,
			failureStage: "agent",
			error,
			result: syntheticFailure(task, agentId, index, error),
		};
	}

	if (result.exitCode !== 0) {
		const error = truncateTail(result.error || result.stderr || `exit code ${result.exitCode}`);
		await stateTracker.finishAttempt(attemptRecord, {
			exitCode: result.exitCode,
			failureStage: "agent",
			error,
		});
		await stateTracker.appendLog(task.id, `Attempt ${attempt + 1} agent failed: ${error}`);
		return { ok: false, failureStage: "agent", error, result };
	}

	// Rejection sampling: agent claims success; the verify command decides.
	if (task.verify) {
		await stateTracker.updateTask(task.id, { status: "verifying" });
		await stateTracker.appendLog(task.id, `Attempt ${attempt + 1} verifying: ${task.verify}`);
		const verdict = await runVerify(task.verify, workspace, def.verifyTimeoutSeconds, signal);
		if (!verdict.ok) {
			await stateTracker.finishAttempt(attemptRecord, {
				exitCode: result.exitCode,
				failureStage: "verify",
				error: verdict.error,
			});
			await stateTracker.appendLog(task.id, `Attempt ${attempt + 1} verify failed: ${verdict.error}`);
			return { ok: false, failureStage: "verify", error: verdict.error, result };
		}
	}

	await stateTracker.finishAttempt(attemptRecord, { exitCode: 0 });
	await stateTracker.appendLog(task.id, `Attempt ${attempt + 1} succeeded on ${model ?? "session default"}`);
	return { ok: true, result };
}

function buildSystemPrompt(task: QueueTask, model: string | undefined, profiles: Record<string, string>): string {
	const parts = [`You are a ${task.role}.`];
	parts.push(...matchSteeringProfiles(model, profiles));
	return parts.join("\n\n");
}

async function runVerify(
	command: string,
	workspace: string,
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const result = await ptree.exec(["bash", "-c", command], {
			cwd: workspace,
			signal: ptree.combineSignals(signal, timeoutSeconds * 1000),
			allowNonZero: true,
			allowAbort: false,
		});
		if (result.ok) return { ok: true };
		const detail = (result.stderr || result.stdout).trim();
		return {
			ok: false,
			error: truncateTail(`verify exited ${result.exitCode}${detail ? `: ${detail}` : ""}`),
		};
	} catch (err) {
		if (signal?.aborted) throw err;
		return { ok: false, error: truncateTail(err instanceof Error ? err.message : String(err)) };
	}
}

function truncateTail(text: string): string {
	return text.length > ERROR_TAIL_CHARS ? text.slice(-ERROR_TAIL_CHARS) : text;
}

function syntheticFailure(task: QueueTask, id: string, index: number, error: string): SingleResult {
	return {
		index,
		id,
		agent: task.id,
		agentSource: "project" as AgentSource,
		task: task.prompt,
		exitCode: 1,
		output: "",
		stderr: error,
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		error,
	};
}
