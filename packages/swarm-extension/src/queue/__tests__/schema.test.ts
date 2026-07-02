import { describe, expect, it } from "bun:test";
import { parseTaskQueueYaml } from "../schema";

function yaml(body: string): string {
	return `tasks:\n${body.replace(/^\n/, "")}`;
}

function minimalTask(id: string, extra = ""): string {
	return `    - id: ${id}\n      prompt: do ${id}\n${extra}`;
}

describe("parseTaskQueueYaml — defaults", () => {
	it("defaults escalation to empty (no escalation) when absent, and accepts an explicit empty list", () => {
		const absent = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a")}
`),
		);
		expect(absent.escalation).toEqual([]);

		const explicit = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  escalation: []
  items:
${minimalTask("a")}
`),
		);
		expect(explicit.escalation).toEqual([]);
	});

	it("preserves an explicit escalation ladder in order", () => {
		const def = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  escalation: ["cheap/model", "mid/model", "frontier/model"]
  items:
${minimalTask("a")}
`),
		);
		expect(def.escalation).toEqual(["cheap/model", "mid/model", "frontier/model"]);
	});

	it("defaults workers to 8 when workers is absent", () => {
		const def = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a")}
`),
		);
		expect(def.workers).toBe(8);
	});

	it("defaults verify_timeout_seconds to 600 when verify_timeout_seconds is absent", () => {
		const def = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a")}
`),
		);
		expect(def.verifyTimeoutSeconds).toBe(600);
	});

	it("defaults per-task role to 'task-executor' and priority to 0 when omitted", () => {
		const def = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a")}
`),
		);
		expect(def.tasks[0]?.role).toBe("task-executor");
		expect(def.tasks[0]?.priority).toBe(0);
	});

	it("defaults per-task max_retries to the queue-level 3 when neither task nor queue max_retries is set", () => {
		const def = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a")}
`),
		);
		expect(def.tasks[0]?.maxRetries).toBe(3);
	});

	it("uses an explicit queue-level max_retries as the per-task default", () => {
		const def = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  max_retries: 1
  items:
${minimalTask("a")}
${minimalTask("b")}
`),
		);
		expect(def.tasks[0]?.maxRetries).toBe(1);
		expect(def.tasks[1]?.maxRetries).toBe(1);
	});

	it("lets a per-task max_retries override the queue-level default", () => {
		const def = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  max_retries: 1
  items:
${minimalTask("a", "      max_retries: 5\n")}
${minimalTask("b")}
`),
		);
		expect(def.tasks[0]?.maxRetries).toBe(5);
		expect(def.tasks[1]?.maxRetries).toBe(1);
	});
});

describe("parseTaskQueueYaml — task identifiers and dependencies", () => {
	it("rejects a duplicate task id with a message naming the id", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a")}
${minimalTask("a")}
`),
			),
		).toThrow("Duplicate task id 'a'");
	});

	it("rejects depends_on that references an unknown task id with both ids named", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a", "      depends_on: [missing]\n")}
`),
			),
		).toThrow("Task 'a' depends_on unknown task 'missing'");
	});

	it("rejects a task that depends on itself with the task id named", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a", "      depends_on: [a]\n")}
`),
			),
		).toThrow("Task 'a' cannot depend on itself");
	});

	it("rejects a two-task dependency cycle a → b → a", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a", "      depends_on: [b]\n")}
${minimalTask("b", "      depends_on: [a]\n")}
`),
			),
		).toThrow(/Dependency cycle involving task/);
	});

	it("rejects a longer cycle a → b → c → a", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a", "      depends_on: [c]\n")}
${minimalTask("b", "      depends_on: [a]\n")}
${minimalTask("c", "      depends_on: [b]\n")}
`),
			),
		).toThrow(/Dependency cycle involving task/);
	});
});

describe("parseTaskQueueYaml — steering profiles", () => {
	it("trims profile values and drops profiles whose value is empty after trim", () => {
		const def = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  steering:
    "*": "  Always verify.  "
    dropme: "   "
    glm: "  GLM-RULES  "
  items:
${minimalTask("a")}
`),
		);
		expect(def.steering).toEqual({
			"*": "Always verify.",
			glm: "GLM-RULES",
		});
		expect(def.steering.dropme).toBeUndefined();
	});

	it("returns an empty steering map when steering is absent", () => {
		const def = parseTaskQueueYaml(
			yaml(`
  name: q
  workspace: /tmp
  items:
${minimalTask("a")}
`),
		);
		expect(def.steering).toEqual({});
	});
});

describe("parseTaskQueueYaml — top-level validation messages", () => {
	it("rejects non-positive workers with the documented message", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  workers: 0
  items:
${minimalTask("a")}
`),
			),
		).toThrow("tasks.workers must be a positive integer");
	});

	it("rejects non-integer workers with the documented message", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  workers: 1.5
  items:
${minimalTask("a")}
`),
			),
		).toThrow("tasks.workers must be a positive integer");
	});

	it("rejects empty-string escalation entries with the documented message", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  escalation: [""]
  items:
${minimalTask("a")}
`),
			),
		).toThrow("tasks.escalation must be a list of non-empty model selectors");
	});

	it("rejects escalation entries that are not strings", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  escalation: ["ok", ""]
  items:
${minimalTask("a")}
`),
			),
		).toThrow("tasks.escalation must be a list of non-empty model selectors");
	});

	it("rejects negative max_retries with the documented message", () => {
		expect(() =>
			parseTaskQueueYaml(
				yaml(`
  name: q
  workspace: /tmp
  max_retries: -1
  items:
${minimalTask("a")}
`),
			),
		).toThrow("tasks.max_retries must be a non-negative integer");
	});
});
