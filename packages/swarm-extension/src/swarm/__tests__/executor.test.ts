import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry, SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as taskExecutor from "@oh-my-pi/pi-coding-agent";
import { executeSwarmAgent, resolveSteering } from "../executor";
import type { SwarmAgent } from "../schema";
import { StateTracker } from "../state";

const mockResult = {
	index: 0,
	id: "test-agent-0",
	agent: "test",
	agentSource: "project",
	task: "test task",
	exitCode: 0,
	output: "ok",
	stderr: "",
	truncated: false,
	durationMs: 100,
	tokens: 0,
} as SingleResult;

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("executeSwarmAgent", () => {
	it("does not pass authStorage to runSubprocess when modelRegistry is provided", async () => {
		const runSubprocessSpy = vi.spyOn(taskExecutor, "runSubprocess").mockResolvedValue(mockResult);

		const mockModelRegistry = {
			authStorage: { discover: vi.fn() },
		} as unknown as ModelRegistry;

		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "parallel");

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
		};

		await executeSwarmAgent(agent, 0, {
			workspace,
			swarmName: "test-swarm",
			iteration: 0,
			modelRegistry: mockModelRegistry,
			stateTracker,
		});

		expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
		const passedOptions = runSubprocessSpy.mock.calls[0][0];
		const { authStorage, modelRegistry } = passedOptions;
		expect(authStorage).toBeUndefined();
		expect(modelRegistry).toBe(mockModelRegistry);
	});
});

describe("resolveSteering", () => {
	const baseAgent: SwarmAgent = {
		name: "a",
		role: "r",
		task: "t",
		reportsTo: [],
		waitsFor: [],
	};

	it("matches the '*' selector regardless of modelOverride (undefined, non-empty, empty)", () => {
		const profiles = { "*": "GLOBAL" };
		expect(resolveSteering(baseAgent, undefined, profiles)).toEqual(["GLOBAL"]);
		expect(resolveSteering(baseAgent, "openrouter/whatever", profiles)).toEqual(["GLOBAL"]);
		expect(resolveSteering(baseAgent, "", profiles)).toEqual(["GLOBAL"]);
	});

	it("matches selectors as case-insensitive substrings of the resolved model", () => {
		const agent: SwarmAgent = { ...baseAgent, steering: undefined };
		expect(resolveSteering(agent, "openrouter/minimax,minimax-m2.7", { MiniMax: "B" })).toEqual(["B"]);
		expect(resolveSteering(agent, "OPENROUTER/MINIMAX", { minimax: "B" })).toEqual(["B"]);
	});

	it("excludes non-matching selectors when modelOverride is undefined, empty, or unrelated", () => {
		const agent: SwarmAgent = { ...baseAgent, steering: undefined };
		expect(resolveSteering(agent, undefined, { minimax: "B" })).toEqual([]);
		expect(resolveSteering(agent, "", { minimax: "B" })).toEqual([]);
		expect(resolveSteering(agent, "openai/gpt-4o", { minimax: "B" })).toEqual([]);
	});

	it("appends agent.steering after every matching profile", () => {
		const agent: SwarmAgent = { ...baseAgent, steering: "AGENT" };
		expect(resolveSteering(agent, "openrouter/minimax-m2.7", { "*": "GLOBAL", minimax: "MODEL" })).toEqual([
			"GLOBAL",
			"MODEL",
			"AGENT",
		]);
	});

	it("preserves declaration order across multiple matching profiles", () => {
		const agent: SwarmAgent = { ...baseAgent, steering: undefined };
		const profiles = { minimax: "FIRST", m2: "SECOND", "*": "THIRD" };
		expect(resolveSteering(agent, "openrouter/minimax-m2.7", profiles)).toEqual(["FIRST", "SECOND", "THIRD"]);
	});
});
