// ============================================================================
// Raw YAML shape (snake_case, optional fields)
// ============================================================================

interface RawTaskItem {
	id: string;
	prompt: string;
	role?: string;
	verify?: string;
	model?: string;
	priority?: number;
	depends_on?: string[];
	max_retries?: number;
}

interface RawTaskQueueConfig {
	name: string;
	workspace: string;
	workers?: number;
	escalation?: string[];
	steering?: Record<string, string>;
	verify_timeout_seconds?: number;
	max_retries?: number;
	items: RawTaskItem[];
}

// ============================================================================
// Normalized types (camelCase, defaults applied)
// ============================================================================

export interface QueueTask {
	id: string;
	prompt: string;
	/** Specialist role for the system prompt. Default: "task-executor". */
	role: string;
	/** Shell command run in the workspace after the agent finishes; exit 0 = pass (rejection sampling). */
	verify?: string;
	/** Pinned model selector. When set, retries do NOT escalate. */
	model?: string;
	/** Lower runs sooner among ready tasks. Default 0. */
	priority: number;
	dependsOn: string[];
	maxRetries: number;
}

export interface TaskQueueDefinition {
	name: string;
	workspace: string;
	/** Concurrent workers pulling tasks. */
	workers: number;
	/**
	 * Model escalation ladder: attempt N uses escalation[min(N, len-1)] unless
	 * the task pins `model`. Order cheap → frontier so retries climb in price.
	 * Empty = no escalation; every attempt uses the task `model` or the
	 * session default.
	 */
	escalation: string[];
	/** Per-model steering profiles, same semantics as swarm.steering. */
	steering: Record<string, string>;
	/** Timeout for each verify command, seconds. */
	verifyTimeoutSeconds: number;
	tasks: QueueTask[];
}

// ============================================================================
// Parsing
// ============================================================================

const VALID_QUEUE_NAME = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_VERIFY_TIMEOUT_SECONDS = 600;

export function parseTaskQueueYaml(content: string): TaskQueueDefinition {
	const raw = Bun.YAML.parse(content) as { tasks?: RawTaskQueueConfig } | null;
	if (!raw?.tasks) {
		throw new Error("YAML must have a top-level 'tasks' key");
	}
	const config = raw.tasks;

	if (!config.name || typeof config.name !== "string" || !VALID_QUEUE_NAME.test(config.name)) {
		throw new Error("tasks.name is required and may only contain letters, numbers, dot, underscore, and dash");
	}
	if (!config.workspace || typeof config.workspace !== "string") {
		throw new Error("tasks.workspace is required and must be a string");
	}
	if (!Array.isArray(config.items) || config.items.length === 0) {
		throw new Error("tasks.items must contain at least one task");
	}
	const workers = config.workers ?? 8;
	if (!Number.isInteger(workers) || workers < 1) {
		throw new Error("tasks.workers must be a positive integer");
	}
	const escalation = config.escalation ?? [];
	if (!Array.isArray(escalation) || escalation.some(m => typeof m !== "string" || !m)) {
		throw new Error("tasks.escalation must be a list of non-empty model selectors");
	}
	const defaultMaxRetries = config.max_retries ?? DEFAULT_MAX_RETRIES;
	if (!Number.isInteger(defaultMaxRetries) || defaultMaxRetries < 0) {
		throw new Error("tasks.max_retries must be a non-negative integer");
	}
	const verifyTimeoutSeconds = config.verify_timeout_seconds ?? DEFAULT_VERIFY_TIMEOUT_SECONDS;
	if (!Number.isFinite(verifyTimeoutSeconds) || verifyTimeoutSeconds <= 0) {
		throw new Error("tasks.verify_timeout_seconds must be a positive number");
	}

	const steering: Record<string, string> = {};
	for (const [selector, text] of Object.entries(config.steering ?? {})) {
		if (typeof text !== "string") {
			throw new Error(`tasks.steering['${selector}'] must be a string`);
		}
		const trimmed = text.trim();
		if (trimmed.length > 0) steering[selector] = trimmed;
	}

	const seen = new Set<string>();
	const tasks: QueueTask[] = config.items.map(item => {
		if (!item.id || typeof item.id !== "string") {
			throw new Error("Every task needs a non-empty string 'id'");
		}
		if (seen.has(item.id)) {
			throw new Error(`Duplicate task id '${item.id}'`);
		}
		seen.add(item.id);
		if (!item.prompt || typeof item.prompt !== "string") {
			throw new Error(`Task '${item.id}': 'prompt' is required`);
		}
		const maxRetries = item.max_retries ?? defaultMaxRetries;
		if (!Number.isInteger(maxRetries) || maxRetries < 0) {
			throw new Error(`Task '${item.id}': max_retries must be a non-negative integer`);
		}
		return {
			id: item.id,
			prompt: item.prompt.trim(),
			role: typeof item.role === "string" && item.role.trim() ? item.role.trim() : "task-executor",
			verify: typeof item.verify === "string" && item.verify.trim() ? item.verify.trim() : undefined,
			model: typeof item.model === "string" && item.model.trim() ? item.model.trim() : undefined,
			priority: typeof item.priority === "number" && Number.isFinite(item.priority) ? item.priority : 0,
			dependsOn: Array.isArray(item.depends_on) ? item.depends_on : [],
			maxRetries,
		};
	});

	// Dependency references + cycles (DFS over the dependency edges).
	const byId = new Map(tasks.map(t => [t.id, t] as const));
	for (const task of tasks) {
		for (const dep of task.dependsOn) {
			if (!byId.has(dep)) throw new Error(`Task '${task.id}' depends_on unknown task '${dep}'`);
			if (dep === task.id) throw new Error(`Task '${task.id}' cannot depend on itself`);
		}
	}
	const visiting = new Set<string>();
	const done = new Set<string>();
	const visit = (id: string): void => {
		if (done.has(id)) return;
		if (visiting.has(id)) throw new Error(`Dependency cycle involving task '${id}'`);
		visiting.add(id);
		for (const dep of byId.get(id)!.dependsOn) visit(dep);
		visiting.delete(id);
		done.add(id);
	};
	for (const task of tasks) visit(task.id);

	return {
		name: config.name,
		workspace: config.workspace,
		workers,
		escalation,
		steering,
		verifyTimeoutSeconds,
		tasks,
	};
}
