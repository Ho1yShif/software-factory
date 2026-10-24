import { describe, expect, it } from "vitest";
import { implementer, prReviewer, specWriter, triage } from "../app/agents/index.js";

const agents = [triage, specWriter, implementer, prReviewer];

describe("agent authority", () => {
	it("gives every agent a unique id and prompt file", () => {
		const ids = agents.map((agent) => agent.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(agents.map((agent) => agent.promptPath)).size).toBe(ids.length);
	});

	it("gives only the implementer write tools and runs every agent in a sandbox", () => {
		const writers = agents.filter((agent) => agent.tools.some((tool) => tool === "edit" || tool === "write")).map((agent) => agent.id);
		expect(writers).toEqual(["implementer"]);
		expect(agents.every((agent) => agent.tools.length > 0)).toBe(true);
	});

	it("rejects unknown fields in every object an agent can submit, so a misspelled field is named in the error", () => {
		const looseObjects = (schema: unknown, path: string): string[] => {
			if (typeof schema !== "object" || schema === null) return [];
			const node = schema as Record<string, unknown>;
			const own = node.type === "object" && node.additionalProperties !== false ? [path || "(root)"] : [];
			return [...own, ...Object.entries(node).flatMap(([key, value]) => looseObjects(value, `${path}/${key}`))];
		};
		for (const agent of agents) expect(looseObjects(agent.outputJsonSchema, ""), agent.id).toEqual([]);
	});
});
