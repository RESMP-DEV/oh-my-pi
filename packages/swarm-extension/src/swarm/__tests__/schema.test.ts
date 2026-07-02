import { describe, expect, it } from "bun:test";
import { parseSwarmYaml } from "../schema";

describe("parseSwarmYaml — steering profiles", () => {
	it("trims profile values and drops profiles whose value is empty after trim", () => {
		const def = parseSwarmYaml(`
swarm:
  name: t
  workspace: /tmp
  steering:
    "*": "  Always verify.  "
    minimax: "  Use small diffs.  "
    dropme: "   "
  agents:
    a: { role: r, task: t }
`);
		expect(def.steering).toEqual({
			"*": "Always verify.",
			minimax: "Use small diffs.",
		});
		expect(def.steering.dropme).toBeUndefined();
	});

	it("returns an empty steering map when steering is absent", () => {
		const def = parseSwarmYaml(`
swarm:
  name: t
  workspace: /tmp
  agents:
    a: { role: r, task: t }
`);
		expect(def.steering).toEqual({});
	});

	it("throws with selector name when a steering value is not a string", () => {
		expect(() =>
			parseSwarmYaml(`
swarm:
  name: t
  workspace: /tmp
  steering:
    badkey: 42
  agents:
    a: { role: r, task: t }
`),
		).toThrow("swarm.steering['badkey'] must be a string");
	});
});

describe("parseSwarmYaml — max_parallel", () => {
	it("defaults to 0 when max_parallel is absent", () => {
		const def = parseSwarmYaml(`
swarm:
  name: t
  workspace: /tmp
  agents:
    a: { role: r, task: t }
`);
		expect(def.maxParallel).toBe(0);
	});

	it("preserves an explicit non-negative integer", () => {
		const def = parseSwarmYaml(`
swarm:
  name: t
  workspace: /tmp
  max_parallel: 8
  agents:
    a: { role: r, task: t }
`);
		expect(def.maxParallel).toBe(8);
	});

	it("rejects negative values with the documented message", () => {
		expect(() =>
			parseSwarmYaml(`
swarm:
  name: t
  workspace: /tmp
  max_parallel: -1
  agents:
    a: { role: r, task: t }
`),
		).toThrow("swarm.max_parallel must be a non-negative integer");
	});

	it("rejects non-integer values with the documented message", () => {
		expect(() =>
			parseSwarmYaml(`
swarm:
  name: t
  workspace: /tmp
  max_parallel: 1.5
  agents:
    a: { role: r, task: t }
`),
		).toThrow("swarm.max_parallel must be a non-negative integer");
	});
});

describe("parseSwarmYaml — per-agent steering", () => {
	it("trims per-agent steering and sets undefined when absent", () => {
		const def = parseSwarmYaml(`
swarm:
  name: t
  workspace: /tmp
  agents:
    with_steering:
      role: r
      task: t
      steering: "  be concise  "
    without_steering:
      role: r
      task: t
`);
		expect(def.agents.get("with_steering")?.steering).toBe("be concise");
		expect(def.agents.get("without_steering")?.steering).toBeUndefined();
	});
});
