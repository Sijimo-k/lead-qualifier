// Demo-mode stand-in for the Claude, HubSpot and Slack APIs.
// Lets anyone run the whole n8n workflow without API keys or accounts.
// It is NOT used in production: point the workflow at the real APIs with .env.
//
// - POST /v1/messages                         -> Claude Messages API (returns fixture signals)
// - POST /crm/v3/objects/contacts/batch/upsert -> HubSpot contact upsert
// - POST /crm/v3/objects/contacts/search      -> HubSpot contact search
// - PATCH /crm/v3/objects/contacts/:id        -> HubSpot contact update
// - POST /crm/v3/objects/notes                -> HubSpot note
// - POST /crm/v3/objects/tasks                -> HubSpot task
// - POST /slack                               -> Slack incoming webhook
// - GET  /_state, POST /_reset                -> inspect / clear what the workflow sent

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 4010);
const samples = JSON.parse(readFileSync(new URL("../data/sample-leads.json", import.meta.url), "utf8"));

let state;
function reset() {
  state = { contacts: [], notes: [], tasks: [], slack: [], claudeCalls: 0, nextId: 1001 };
}
reset();

const FALLBACK_SIGNALS = {
  is_spam: false,
  spam_reason: "",
  language: "en",
  budget_amount: null,
  budget_currency: "unknown",
  timeline: "unknown",
  need_fit: "partial",
  need_fit_reason: "Demo mode: no fixture for this enquiry.",
  decision_maker: "unknown",
  company_size: "unknown",
  service_requested: "Unknown (demo mode)",
  summary: "Demo mode could not analyse this enquiry; connect a real Claude API key for live results.",
  missing_info: ["Budget", "Timeline"],
  reply_draft: "Thanks for your message! Could you tell us a little more about your budget and timeline?",
};

// The mock recognises sample leads by the message text it receives.
function signalsFor(userText) {
  if (userText.includes("FORCE_ERROR")) return null;
  const sample = samples.find((s) => userText.includes(s.lead.message.slice(0, 60)));
  return sample ? sample.mock_signals : FALLBACK_SIGNALS;
}

// Follow-up drafts (the request schema asks for subject + body).
function followupDraft(userText) {
  const name = (userText.match(/Name: (.*)/) || [])[1] || "there";
  const requested = (userText.match(/Requested: (.*)/) || [])[1] || "your project";
  if (/[぀-ヿ一-鿿]/.test(name)) {
    return {
      subject: "先日のお問い合わせについて",
      body: `${name}様\n\n先日はお問い合わせありがとうございました。ご相談の件（${requested}）について、進め方の概要をお送りできます。ご希望があればご返信ください。\n\nNorthwind Automation team`,
    };
  }
  return {
    subject: "Following up on your enquiry",
    body: `Hi ${name},\n\nThanks again for reaching out about ${requested}. If it helps, we can send a short outline of how we would approach it. Just reply and we will get it over to you.\n\nBest regards,\nNorthwind Automation team`,
  };
}

function claudeResponse(body) {
  state.claudeCalls += 1;
  const userText = body?.messages?.[0]?.content ?? "";
  if (body?.output_config?.format?.schema?.properties?.subject) {
    return [
      200,
      {
        id: `msg_demo_${state.claudeCalls}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: JSON.stringify(followupDraft(userText)) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 300, output_tokens: 150 },
      },
    ];
  }
  const signals = signalsFor(typeof userText === "string" ? userText : JSON.stringify(userText));
  if (!signals) {
    return [529, { type: "error", error: { type: "overloaded_error", message: "Demo: simulated overload" } }];
  }
  return [
    200,
    {
      id: `msg_demo_${state.claudeCalls}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: JSON.stringify(signals) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 900, output_tokens: 350 },
    },
  ];
}

function upsertContacts(body) {
  // Like the real HubSpot API: reserved .example addresses are rejected.
  const bad = (body.inputs || []).find((input) => /\.example$/i.test(input.id || ""));
  if (bad) {
    const message = `Email address ${bad.id} is invalid`;
    return [400, { status: "error", message, errors: [{ message, code: "INVALID_EMAIL" }], category: "VALIDATION_ERROR" }];
  }
  const results = (body.inputs || []).map((input) => {
    let contact = state.contacts.find((c) => c.properties.email === input.id);
    const now = new Date().toISOString();
    if (contact) {
      Object.assign(contact.properties, input.properties);
      contact.updatedAt = now;
    } else {
      contact = { id: String(state.nextId++), properties: { ...input.properties, createdate: now }, createdAt: now, updatedAt: now };
      state.contacts.push(contact);
    }
    return contact;
  });
  return [200, { status: "COMPLETE", results }];
}

// Supports the filters the follow-up workflow uses: EQ, IN, LT, NOT_HAS_PROPERTY.
function matches(contact, filter) {
  const value = contact.properties[filter.propertyName];
  switch (filter.operator) {
    case "EQ":
      return String(value) === String(filter.value);
    case "IN":
      return filter.values.map(String).includes(String(value));
    case "LT":
      return value !== undefined && new Date(value).getTime() < Number(filter.value);
    case "NOT_HAS_PROPERTY":
      return value === undefined || value === "";
    default:
      return false;
  }
}

function searchContacts(body) {
  const groups = body.filterGroups || [];
  const results = state.contacts.filter((c) =>
    groups.length === 0 ? true : groups.some((g) => g.filters.every((f) => matches(c, f))),
  );
  return [200, { total: results.length, results: results.slice(0, body.limit || 100) }];
}

function route(method, path, body) {
  if (method === "POST" && path === "/v1/messages") return claudeResponse(body);
  if (method === "POST" && path === "/crm/v3/objects/contacts/batch/upsert") return upsertContacts(body);
  if (method === "POST" && path === "/crm/v3/objects/contacts/search") return searchContacts(body);
  const patch = path.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/);
  if (method === "PATCH" && patch) {
    const contact = state.contacts.find((c) => c.id === patch[1]);
    if (!contact) return [404, { message: "contact not found" }];
    Object.assign(contact.properties, body.properties || {});
    return [200, contact];
  }
  if (method === "POST" && (path === "/crm/v3/objects/notes" || path === "/crm/v3/objects/tasks")) {
    const list = path.endsWith("notes") ? state.notes : state.tasks;
    const record = { id: String(state.nextId++), ...body };
    list.push(record);
    return [201, record];
  }
  if (method === "POST" && (path === "/crm/v3/properties/contacts" || path === "/crm/v3/properties/contacts/groups")) {
    state.properties ??= [];
    const key = `${path}:${body.name}`;
    if (state.properties.includes(key)) return [409, { message: "already exists" }];
    state.properties.push(key);
    return [201, body];
  }
  if (method === "POST" && path === "/slack") {
    state.slack.push(body);
    return [200, "ok"];
  }
  if (method === "GET" && path === "/_state") return [200, state];
  if (method === "POST" && path === "/_reset") {
    reset();
    return [200, { ok: true }];
  }
  // Test helper: make every contact look older so the follow-up workflow picks it up.
  if (method === "POST" && path === "/_age-contacts") {
    const days = Number(body.days || 3);
    const past = new Date(Date.now() - days * 86400000).toISOString();
    for (const c of state.contacts) c.properties.createdate = past;
    return [200, { ok: true, count: state.contacts.length }];
  }
  return [404, { message: `mock: no route for ${method} ${path}` }];
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    const path = new URL(req.url, "http://localhost").pathname;
    const [status, payload] = route(req.method, path, body);
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    res.writeHead(status, { "content-type": typeof payload === "string" ? "text/plain" : "application/json" });
    res.end(text);
    if (path !== "/_state") console.log(`${req.method} ${path} -> ${status}`);
  });
}).listen(PORT, () => console.log(`Demo mock listening on :${PORT}`));
