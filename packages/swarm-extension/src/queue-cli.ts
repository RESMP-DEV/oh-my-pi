#!/usr/bin/env bun
/**
 * Standalone task-queue runner — executes a task queue outside of the TUI.
 *
 * Usage: bun queue-cli.ts <path-to-yaml>
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderQueueProgress } from "./queue/render";
import { QueueRunner } from "./queue/runner";
import { parseTaskQueueYaml } from "./queue/schema";
import { QueueStateTracker } from "./queue/state";

const yamlPath = process.argv[2];
if (!yamlPath) {
	console.error("Usage: omp-queue <path-to-yaml>");
	process.exit(1);
}

const resolvedPath = path.resolve(yamlPath);
console.log(`Reading: ${resolvedPath}`);

const content = await Bun.file(resolvedPath).text();
const def = parseTaskQueueYaml(content);

console.log(`Queue: ${def.name}`);
console.log(`Workers: ${def.workers}`);
console.log(`Tasks: ${def.tasks.map(t => t.id).join(", ")}`);
console.log(`Escalation: ${def.escalation.join(" -> ")}`);

// Resolve workspace relative to the YAML file location
const workspace = path.isAbsolute(def.workspace)
	? def.workspace
	: path.resolve(path.dirname(resolvedPath), def.workspace);

await fs.mkdir(workspace, { recursive: true });
console.log(`Workspace: ${workspace}`);

// Initialize
const stateTracker = new QueueStateTracker(workspace, def.name);
await stateTracker.init(
	def.tasks.map(t => t.id),
	def.workers,
);

// Auth + settings
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const settings = Settings.isolated();

// Progress display
let lastProgressDump = 0;
const PROGRESS_INTERVAL_MS = 5000;

console.log("\n--- Queue starting ---\n");

const runner = new QueueRunner(def, stateTracker);
const result = await runner.run({
	workspace,
	onProgress: () => {
		const now = Date.now();
		if (now - lastProgressDump > PROGRESS_INTERVAL_MS) {
			lastProgressDump = now;
			console.log(renderQueueProgress(stateTracker.state).join("\n"));
			console.log();
		}
	},
	modelRegistry,
	settings,
});

console.log("\n--- Queue finished ---\n");
console.log(`Status: ${result.status}`);
console.log(`Completed: ${result.completed} | Failed: ${result.failed} | Skipped: ${result.skipped}`);
if (result.errors.length > 0) {
	console.log(`Errors (${result.errors.length}):`);
	for (const err of result.errors) {
		console.log(`  - ${err}`);
	}
}
console.log(`\nState saved to: ${stateTracker.queueDir}`);
console.log(renderQueueProgress(stateTracker.state).join("\n"));

process.exit(result.status === "completed" ? 0 : 1);
