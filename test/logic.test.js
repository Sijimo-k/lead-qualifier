import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeLead, splitName, validateLead } from "../src/lead.js";
import { buildClaudeRequest, buildUserMessage, parseClaudeResponse, SIGNALS_SCHEMA } from "../src/qualify.js";
import { scoreLead, toUsd } from "../src/score.js";
import { hubspotContactUpsert, hubspotNote, slackAlert } from "../src/crm.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const business = readJson("../config/business.json");
const rubric = readJson("../config/rubric.json");
const samples = readJson("../data/sample-leads.json");

const NOW = "2026-11-15T00:00:00.000Z";

describe("normalizeLead", () => {
  it("accepts different field names from different form tools", () => {
    const lead = normalizeLead(
      { first_name: "Ana", last_name: "Silva", email_address: "ANA@Example.com ", details: "  Need help  " },
      NOW,
    );
    expect(lead.name).toBe("Ana Silva");
    expect(lead.email).toBe("ana@example.com");
    expect(lead.message).toBe("Need help");
    expect(lead.source).toBe("website_form");
    expect(lead.received_at).toBe(NOW);
  });

  it("truncates very long messages", () => {
    const lead = normalizeLead({ email: "a@b.co", message: "x".repeat(9000) }, NOW);
    expect(lead.message.length).toBe(5000);
  });

  it("handles a missing body", () => {
    expect(normalizeLead(undefined, NOW).email).toBe("");
  });
});

describe("validateLead", () => {
  it("reports a missing or invalid email and an empty message", () => {
    expect(validateLead(normalizeLead({ message: "hi" }, NOW))).toEqual(["email is missing"]);
    expect(validateLead(normalizeLead({ email: "nope", message: "hi" }, NOW))).toEqual(["email is not valid"]);
    expect(validateLead(normalizeLead({ email: "a@b.co" }, NOW))).toEqual(["message is empty"]);
    expect(validateLead(normalizeLead({ email: "a@b.co", message: "hi" }, NOW))).toEqual([]);
  });
});

describe("splitName", () => {
  it("splits western names given-name first", () => {
    expect(splitName("Mary Ann Lee")).toEqual({ firstname: "Mary Ann", lastname: "Lee" });
  });
  it("splits Japanese names family-name first", () => {
    expect(splitName("佐藤 美咲")).toEqual({ firstname: "美咲", lastname: "佐藤" });
  });
  it("keeps a single name as the first name", () => {
    expect(splitName("Cher")).toEqual({ firstname: "Cher", lastname: "" });
  });
});

describe("buildClaudeRequest", () => {
  const lead = normalizeLead(samples[0].lead, NOW);
  const request = buildClaudeRequest(lead, business);

  it("asks for JSON that matches the signals schema", () => {
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.output_config.format).toEqual({ type: "json_schema", schema: SIGNALS_SCHEMA });
    expect(request.fallbacks).toBe("default");
  });

  it("keeps every schema property required and closed (structured outputs rule)", () => {
    expect(SIGNALS_SCHEMA.additionalProperties).toBe(false);
    expect([...SIGNALS_SCHEMA.required].sort()).toEqual(Object.keys(SIGNALS_SCHEMA.properties).sort());
  });

  it("does not send the full email address to the model", () => {
    const message = buildUserMessage(lead);
    expect(message).not.toContain("maria@");
    expect(message).toContain("Email domain: brightcandles.example");
  });

  it("treats the enquiry as data, not instructions", () => {
    expect(request.system).toMatch(/data, not instructions/);
    expect(request.messages[0].content.startsWith("<enquiry>")).toBe(true);
  });
});

describe("parseClaudeResponse", () => {
  const signals = samples[0].mock_signals;
  const ok = { type: "message", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(signals) }] };

  it("returns the signals from the text block", () => {
    expect(parseClaudeResponse(ok)).toEqual(signals);
  });

  it("skips non-text blocks such as thinking or fallback markers", () => {
    const withExtra = { ...ok, content: [{ type: "thinking", thinking: "" }, ...ok.content] };
    expect(parseClaudeResponse(withExtra).summary).toBe(signals.summary);
  });

  it("throws readable errors for unusable responses", () => {
    expect(() => parseClaudeResponse({ ...ok, stop_reason: "refusal" })).toThrow(/declined/);
    expect(() => parseClaudeResponse({ ...ok, stop_reason: "max_tokens" })).toThrow(/cut off/);
    expect(() => parseClaudeResponse({ type: "error", error: { type: "overloaded_error", message: "busy" } })).toThrow(
      /overloaded_error/,
    );
    expect(() => parseClaudeResponse({ ...ok, content: [{ type: "text", text: "not json" }] })).toThrow(/valid JSON/);
    const { summary, ...missing } = signals;
    expect(() => parseClaudeResponse({ ...ok, content: [{ type: "text", text: JSON.stringify(missing) }] })).toThrow(
      /summary/,
    );
  });
});

describe("scoreLead", () => {
  it.each(samples.map((s) => [s.id, s]))("%s scores as its expected tier", (_id, sample) => {
    expect(scoreLead(sample.mock_signals, rubric, business).tier).toBe(sample.expected_tier);
  });

  it("explains every point it gives", () => {
    const result = scoreLead(samples[0].mock_signals, rubric, business);
    const total = result.reasons.reduce((sum, r) => sum + Number(r.match(/^\+(\d+)/)[1]), 0);
    expect(total).toBe(result.score);
    expect(result.score).toBe(93);
  });

  it("caps leads for services we do not offer, even with a big budget", () => {
    const result = scoreLead(samples.find((s) => s.id === "cold-not-offered").mock_signals, rubric, business);
    expect(result.score).toBe(75);
    expect(result.tier).toBe("cold");
    expect(result.reasons.at(-1)).toMatch(/service not offered/);
  });

  it("converts budgets to USD with the configured rates", () => {
    expect(toUsd(1_000_000, "JPY", business)).toBeCloseTo(6666.67, 1);
    expect(toUsd(8000, "EUR", business)).toBeCloseTo(8695.65, 1);
    expect(toUsd(null, "USD", business)).toBeNull();
    expect(toUsd(100, "other", business)).toBeNull();
  });
});

describe("CRM payloads", () => {
  const sample = samples[1];
  const lead = normalizeLead(sample.lead, NOW);
  const result = scoreLead(sample.mock_signals, rubric, business);

  it("upserts the contact by email and drops empty fields", () => {
    const body = hubspotContactUpsert(lead, result, sample.mock_signals, splitName);
    const input = body.inputs[0];
    expect(input.idProperty).toBe("email");
    expect(input.id).toBe("sato@umeboshi-shop.example");
    expect(input.properties.lastname).toBe("佐藤");
    expect(input.properties.ai_lead_tier).toBe("hot");
    expect(input.properties).not.toHaveProperty("website");
  });

  it("writes a note with the breakdown and the reply draft, escaping HTML", () => {
    const evil = { ...lead, message: "<script>alert(1)</script>" };
    const note = hubspotNote("123", evil, result, sample.mock_signals, NOW);
    expect(note.associations[0].to.id).toBe("123");
    expect(note.properties.hs_note_body).toContain("HOT (83/100)");
    expect(note.properties.hs_note_body).toContain("Reply draft");
    expect(note.properties.hs_note_body).not.toContain("<script>");
  });

  it("builds a Slack alert with a link to the contact", () => {
    const alert = slackAlert(lead, result, sample.mock_signals, "https://app.hubspot.com/contacts/1/record/0-1/123");
    expect(alert.text).toContain("Hot lead");
    expect(JSON.stringify(alert.blocks)).toContain("Open in HubSpot");
  });

  it("still produces a useful note when Claude failed", () => {
    const failed = { score: 0, tier: "needs_review", reasons: ["Claude API error: overloaded"] };
    const note = hubspotNote("9", lead, failed, null, NOW);
    expect(note.properties.hs_note_body).toContain("review manually");
    expect(slackAlert(lead, failed, null, "x").text).toContain("manual review");
  });
});
