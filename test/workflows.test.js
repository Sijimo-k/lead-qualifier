import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const load = (file) => JSON.parse(readFileSync(new URL(`../workflows/${file}`, import.meta.url), "utf8"));

describe("generated n8n workflows", () => {
  it("are up to date with src/ (npm run build)", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/build-workflows.mjs", "--check"], {
        cwd: new URL("..", import.meta.url),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  for (const file of ["lead-qualifier.json", "followup-drafts.json"]) {
    describe(file, () => {
      const wf = load(file);
      const names = new Set(wf.nodes.map((n) => n.name));

      it("only connects nodes that exist", () => {
        for (const [from, { main }] of Object.entries(wf.connections)) {
          expect(names.has(from)).toBe(true);
          for (const output of main) for (const edge of output) expect(names.has(edge.node)).toBe(true);
        }
      });

      it("has valid JavaScript in every Code node", () => {
        for (const node of wf.nodes.filter((n) => n.type === "n8n-nodes-base.code")) {
          // n8n wraps Code node bodies in a function, so a top-level return is allowed.
          expect(() => new Function("$json", "$input", "$", "$env", node.parameters.jsCode), node.name).not.toThrow();
        }
      });

      it("never contains a secret", () => {
        const text = JSON.stringify(wf);
        expect(text).not.toMatch(/sk-ant-|pat-na1-|hooks\.slack\.com\/services\/T/);
      });
    });
  }

  it("sends every Claude call with the API version and fallback headers", () => {
    for (const file of ["lead-qualifier.json", "followup-drafts.json"]) {
      const claudeNodes = load(file).nodes.filter((n) => n.name.startsWith("Claude:"));
      expect(claudeNodes.length).toBeGreaterThan(0);
      for (const node of claudeNodes) {
        const headers = node.parameters.headerParameters.parameters.map((h) => h.name);
        expect(headers).toEqual(["anthropic-version", "anthropic-beta"]);
        expect(node.credentials.httpHeaderAuth.name).toBe("Anthropic API key");
      }
    }
  });
});
