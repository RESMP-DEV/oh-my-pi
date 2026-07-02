import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import * as executor from "../executor";
import { PipelineController } from "../pipeline";
import type { SwarmDefinition } from "../schema";
import { StateTracker } from "../state";

const okResult: SingleResult = {
	index: 0,
	id: "x",
	agent: "x",
	agentSource: "project",
	task: "t",
	exitCode: 0,
	output: "",
	stderr: "",
	truncated: false,
	durationMs: 0,
	tokens: 0,
	requests: 0,
};

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-pipeline-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

function makeDef(maxParallel: number, agentNames: string[]): SwarmDefinition {
	const agents = new Map(agentNames.map(n => [n, { name: n, role: "r", task: "t", reportsTo: [], waitsFor: [] }]));
	return {
		name: "ts",
		workspace,
		mode: "parallel",
		targetCount: 1,
		steering: {},
		maxParallel,
		agents,
		agentOrder: agentNames,
	};
}

/**
 * Each mocked agent increments a shared active-counter on entry, yields via
 * microtasks so concurrent invocations remain concurrent, and decrements on
 * exit. The highest observed value of `active` is the true concurrency peak
 * the controller permitted within a single wave.
 */
function instrumentedSpy() {
	let active = 0;
	let peak = 0;
	const spy = vi.spyOn(executor, "executeSwarmAgent").mockImplementation(async () => {
		active += 1;
		if (active > peak) peak = active;
		for (let i = 0; i < 100; i++) await Promise.resolve();
		active -= 1;
		return { ...okResult, agent: "x" };
	});
	return { spy, peak: () => peak };
}

describe("PipelineController concurrency bound (mapWithLimit)", () => {
	it("runs agents strictly sequentially within a wave when maxParallel=1", async () => {
		const { spy, peak } = instrumentedSpy();

		const def = makeDef(1, ["a", "b", "c"]);
		const stateTracker = new StateTracker(workspace, "ts");
		await stateTracker.init(["a", "b", "c"], 1, "parallel");

		const controller = new PipelineController(def, [["a", "b", "c"]], stateTracker);
		const result = await controller.run({ workspace });

		expect(spy).toHaveBeenCalledTimes(3);
		expect(peak()).toBe(1);
		expect(result.status).toBe("completed");
	});

	it("runs agents concurrently within a wave when maxParallel=0 (unbounded)", async () => {
		const { spy, peak } = instrumentedSpy();

		const def = makeDef(0, ["a", "b", "c"]);
		const stateTracker = new StateTracker(workspace, "ts");
		await stateTracker.init(["a", "b", "c"], 1, "parallel");

		const controller = new PipelineController(def, [["a", "b", "c"]], stateTracker);
		const result = await controller.run({ workspace });

		expect(spy).toHaveBeenCalledTimes(3);
		expect(peak()).toBe(3);
		expect(result.status).toBe("completed");
	});
});
