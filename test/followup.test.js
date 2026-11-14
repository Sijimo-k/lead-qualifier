import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildFollowupRequest,
  displayName,
  FOLLOWUP_SCHEMA,
  hubspotFollowupTask,
  parseFollowup,
  slackDigest,
  staleLeadSearch,
} from "../src/followup.js";
import { CLAUDE_MODEL } from "../src/qualify.js";

const business = JSON.parse(readFileSync(new URL("../config/business.json", import.meta.url), "utf8"));
const contact = {
  id: "1001",
  properties: {
    email: "sato@umeboshi-shop.example",
    firstname: "美咲",
    lastname: "佐藤",
    company: "梅の里ストア",
    ai_lead_tier: "hot",
    ai_service_requested: "Marketplace orders into Google Sheets",
    ai_lead_summary: "Owner of a food shop wants marketplace orders in a spreadsheet.",
  },
};

describe("displayName", () => {
  it("puts the family name first for Japanese names", () => {
    expect(displayName(contact.properties)).toBe("佐藤 美咲");
  });
  it("keeps western order and falls back to email", () => {
    expect(displayName({ firstname: "Maria", lastname: "Lopez" })).toBe("Maria Lopez");
    expect(displayName({ email: "a@b.co" })).toBe("a@b.co");
  });
});

describe("staleLeadSearch", () => {
  it("looks for hot/warm leads still NEW after N days and not drafted yet", () => {
    const now = Date.UTC(2026, 10, 15);
    const search = staleLeadSearch(now, 2);
    const filters = search.filterGroups[0].filters;
    expect(filters).toContainEqual({ propertyName: "ai_lead_tier", operator: "IN", values: ["hot", "warm"] });
    expect(filters).toContainEqual({ propertyName: "hs_lead_status", operator: "EQ", value: "NEW" });
    expect(filters.find((f) => f.propertyName === "createdate").value).toBe(String(now - 2 * 86400000));
    expect(filters.find((f) => f.propertyName === "ai_followup_drafted_at").operator).toBe("NOT_HAS_PROPERTY");
  });
});

describe("buildFollowupRequest", () => {
  it("asks for a subject and body only, using the lead summary", () => {
    const request = buildFollowupRequest(contact, business, CLAUDE_MODEL);
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.output_config.format.schema).toEqual(FOLLOWUP_SCHEMA);
    expect(request.messages[0].content).toContain("Name: 佐藤 美咲");
    expect(request.messages[0].content).toContain("Marketplace orders into Google Sheets");
    expect(request.system).toMatch(/data, not instructions/);
  });
});

describe("parseFollowup", () => {
  const ok = { stop_reason: "end_turn", content: [{ type: "text", text: '{"subject":"Hi","body":"Hello"}' }] };
  it("returns the draft", () => {
    expect(parseFollowup(ok)).toEqual({ subject: "Hi", body: "Hello" });
  });
  it("returns null instead of throwing for unusable responses", () => {
    expect(parseFollowup(undefined)).toBeNull();
    expect(parseFollowup({ ...ok, stop_reason: "refusal" })).toBeNull();
    expect(parseFollowup({ ...ok, content: [{ type: "text", text: "nope" }] })).toBeNull();
    expect(parseFollowup({ ...ok, content: [{ type: "text", text: '{"subject":"Hi"}' }] })).toBeNull();
    expect(parseFollowup({ error: { message: "529" } })).toBeNull();
  });
});

describe("hubspotFollowupTask", () => {
  it("creates a high-priority email task for hot leads, linked to the contact", () => {
    const task = hubspotFollowupTask(contact, { subject: "S", body: "B" }, "2026-11-15T00:00:00.000Z");
    expect(task.properties.hs_task_subject).toBe("Follow up with 佐藤 美咲 (hot lead, no reply yet)");
    expect(task.properties.hs_task_priority).toBe("HIGH");
    expect(task.properties.hs_task_body).toBe("Subject: S\n\nB");
    expect(task.associations[0]).toEqual({
      to: { id: "1001" },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }],
    });
  });
  it("still creates a task when no draft could be made", () => {
    const task = hubspotFollowupTask(contact, null, "2026-11-15T00:00:00.000Z");
    expect(task.properties.hs_task_body).toMatch(/manually/);
  });
});

describe("slackDigest", () => {
  it("lists every waiting lead and marks missing drafts", () => {
    const digest = slackDigest([
      { who: "佐藤 美咲", tier: "hot", requested: "Orders sync", drafted: true },
      { who: "James Carter", tier: "warm", requested: "Form to CRM", drafted: false },
    ]);
    expect(digest.text).toContain("2 lead(s)");
    expect(digest.blocks[1].text.text).toContain(":fire: 佐藤 美咲");
    expect(digest.blocks[1].text.text).toContain("_(no draft)_");
  });
});
