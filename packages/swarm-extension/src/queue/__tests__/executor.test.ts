import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as codingAgent from "@oh-my-pi/pi-coding-agent";
import { executeQueueTask } from "../executor";
import type { QueueTask, TaskQueueDefinition } from "../schema";
import { QueueStateTracker } from "../state";

function makeResult(taskId: string, exitCode: number, opts: { stderr?: string; error?: string } = {}): SingleResult {
	return {
		index: 0,
		id: `mock-${taskId}`,
		agent: taskId,
		agentSource: "project",
		task: taskId,
		exitCode,
		output: "",
		stderr: opts.stderr ?? "",
		truncated: false,
		durationMs: 0,
		tokens: 0,
		requests: 0,
		...(opts.error !== undefined ? { error: opts.error } : {}),
	};
}

function makeDef(
	overrides: Partial<Pick<TaskQueueDefinition, "steering" | "verifyTimeoutSeconds">> = {},
): TaskQueueDefinition {
	return {
		name: "ts",
		workspace: "/tmp",
		workers: 1,
		escalation: ["m1"],
		steering: overrides.steering ?? {},
		verifyTimeoutSeconds: overrides.verifyTimeoutSeconds ?? 60,
		tasks: [],
	};
}

function makeTask(overrides: Partial<QueueTask> = {}): QueueTask {
	return {
		id: "t",
		prompt: "do t",
		role: "task-executor",
		priority: 0,
		dependsOn: [],
		maxRetries: 0,
		...overrides,
	};
}

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "queue-executor-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("executeQueueTask — agent + verify outcomes", () => {
	it("returns ok:true when the agent exits 0 and a verify 'exit 0' command also exits 0", async () => {
		vi.spyOn(codingAgent, "runSubprocess").mockResolvedValue(makeResult("t", 0));

		const stateTracker = new QueueStateTracker(workspace, "ts");
		await stateTracker.init(["t"], 1);

		const outcome = await executeQueueTask(makeDef(), makeTask({ verify: "exit 0" }), {
			workspace,
			model: "m1",
			index: 0,
			attempt: 0,
			stateTracker,
		});

		expect(outcome.ok).toBe(true);
		expect(outcome.failureStage).toBeUndefined();
		expect(outcome.result.exitCode).toBe(0);
	});

	it("returns ok:false with failureStage 'verify' when verify 'exit 1' fails, and the error mentions the exit code", async () => {
		vi.spyOn(codingAgent, "runSubprocess").mockResolvedValue(makeResult("t", 0));

		const stateTracker = new QueueStateTracker(workspace, "ts");
		await stateTracker.init(["t"], 1);

		const outcome = await executeQueueTask(makeDef(), makeTask({ verify: "exit 1" }), {
			workspace,
			model: "m1",
			index: 0,
			attempt: 0,
			stateTracker,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.failureStage).toBe("verify");
		expect(outcome.error).toMatch(/verify exited 1/);
	});

	it("returns ok:false with failureStage 'agent' when the subagent exits non-zero, and never runs verify", async () => {
		const sentinelPath = path.join(workspace, "should-not-exist.txt");
		vi.spyOn(codingAgent, "runSubprocess").mockResolvedValue(makeResult("t", 7, { stderr: "boom" }));

		const stateTracker = new QueueStateTracker(workspace, "ts");
		await stateTracker.init(["t"], 1);

		const verifyCommand = `touch "${sentinelPath}"`;
		const outcome = await executeQueueTask(makeDef(), makeTask({ verify: verifyCommand }), {
			workspace,
			model: "m1",
			index: 0,
			attempt: 0,
			stateTracker,
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.failureStage).toBe("agent");
		expect(outcome.error).toMatch(/boom/);

		// The verify command MUST NOT have run: prove it by asserting the sentinel
		// file was never created.
		await expect(fs.stat(sentinelPath)).rejects.toThrow();
	});
});

describe("executeQueueTask — steering profile composition", () => {
	async function capturedSystemPrompt(model: string): Promise<string> {
		const spy = vi.spyOn(codingAgent, "runSubprocess").mockResolvedValue(makeResult("t", 0));
		const def = makeDef({ steering: { "*": "GLOBAL", glm: "GLM-RULES" } });
		const stateTracker = new QueueStateTracker(workspace, "ts");
		await stateTracker.init(["t"], 1);
		await executeQueueTask(def, makeTask(), {
			workspace,
			model,
			index: 0,
			attempt: 0,
			stateTracker,
		});
		const call = spy.mock.calls[0]?.[0] as { agent: { systemPrompt: string } } | undefined;
		if (!call) throw new Error("runSubprocess was not called");
		return call.agent.systemPrompt;
	}

	it("includes both '*' and 'glm' profile text when the model selector contains 'glm'", async () => {
		const prompt = await capturedSystemPrompt("zai/glm-4.6");
		expect(prompt).toContain("GLOBAL");
		expect(prompt).toContain("GLM-RULES");
	});

	it("includes only the '*' profile when the model selector does not match 'glm'", async () => {
		const prompt = await capturedSystemPrompt("anthropic/claude-opus-4-6");
		expect(prompt).toContain("GLOBAL");
		expect(prompt).not.toContain("GLM-RULES");
	});
});

describe("executeQueueTask — verify runs in the workspace cwd", () => {
	it("writes a verify-side file relative to the workspace directory", async () => {
		vi.spyOn(codingAgent, "runSubprocess").mockResolvedValue(makeResult("t", 0));

		const stateTracker = new QueueStateTracker(workspace, "ts");
		await stateTracker.init(["t"], 1);

		const fileName = `verify-cwd-${Date.now()}.txt`;
		const verifyCommand = `printf done > "${fileName}"`;

		const outcome = await executeQueueTask(makeDef(), makeTask({ verify: verifyCommand }), {
			workspace,
			model: "m1",
			index: 0,
			attempt: 0,
			stateTracker,
		});

		expect(outcome.ok).toBe(true);
		// The file must exist at <workspace>/<fileName>, proving the verify
		// command ran with cwd === workspace.
		const written = await fs.readFile(path.join(workspace, fileName), "utf8");
		expect(written).toBe("done");
	});
});
