/**
 * Progress rendering for task-queue status (TUI widget + CLI dumps).
 */
import { formatDuration, truncate } from "@oh-my-pi/pi-utils";
import type { QueueState, TaskState } from "./state";

const STATUS_LABELS: Record<string, string> = {
	completed: "[done]",
	running: "[....]",
	verifying: "[vrfy]",
	failed: "[FAIL]",
	skipped: "[skip]",
	pending: "[    ]",
};

export function renderQueueProgress(state: QueueState): string[] {
	const lines: string[] = [];
	lines.push(`Queue: ${state.name} [${state.status.toUpperCase()}] | workers: ${state.workers}`);
	lines.push("");

	const tasks: TaskState[] = Object.values(state.tasks);
	if (tasks.length === 0) {
		lines.push("  (no tasks)");
		return lines;
	}

	for (const task of tasks) {
		const icon = STATUS_LABELS[task.status] ?? "[????]";
		const attempts = task.attempts.length > 1 ? ` x${task.attempts.length}` : "";
		const model = task.attempts.at(-1)?.model;
		const modelSuffix = model && task.status !== "pending" ? ` @ ${model}` : "";
		const duration = formatTaskDuration(task);
		const errorSuffix = task.error ? ` - ${truncate(task.error, 60)}` : "";
		lines.push(`  ${icon} ${task.id}: ${task.status}${attempts}${modelSuffix}${duration}${errorSuffix}`);
	}

	const completed = tasks.filter(t => t.status === "completed").length;
	const failed = tasks.filter(t => t.status === "failed").length;
	const skipped = tasks.filter(t => t.status === "skipped").length;
	const running = tasks.filter(t => t.status === "running" || t.status === "verifying").length;

	lines.push("");
	const parts = [`${completed}/${tasks.length} done`];
	if (running > 0) parts.push(`${running} running`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (skipped > 0) parts.push(`${skipped} skipped`);
	if (state.startedAt) {
		parts.push(`elapsed: ${formatDuration((state.completedAt ?? Date.now()) - state.startedAt)}`);
	}
	lines.push(`  ${parts.join(" | ")}`);

	return lines;
}

function formatTaskDuration(task: TaskState): string {
	if (task.startedAt && task.completedAt) {
		return ` (${formatDuration(task.completedAt - task.startedAt)})`;
	}
	if (task.startedAt && (task.status === "running" || task.status === "verifying")) {
		return ` (${formatDuration(Date.now() - task.startedAt)}...)`;
	}
	return "";
}
