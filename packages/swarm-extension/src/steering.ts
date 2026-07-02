/**
 * Per-model steering profiles, shared by swarm pipelines and task queues.
 *
 * A profile map keys selector → system-prompt text. A selector matches when it
 * is a case-insensitive substring of the resolved model selector; `"*"` matches
 * every model (including "no model resolved"). Matches concatenate in
 * profile-declaration order, letting cheap models (MiniMax, GLM, DeepSeek
 * Flash) carry extra process discipline while strong models run clean.
 */
export function matchSteeringProfiles(
	model: string | undefined,
	profiles: Record<string, string> | undefined,
): string[] {
	const parts: string[] = [];
	const normalized = (model ?? "").toLowerCase();
	for (const [selector, text] of Object.entries(profiles ?? {})) {
		if (selector === "*" || (normalized.length > 0 && normalized.includes(selector.toLowerCase()))) {
			parts.push(text);
		}
	}
	return parts;
}
