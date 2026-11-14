// Creates the custom contact properties the workflows write to.
// Run once per HubSpot account. Use a service key (Development > Keys > Service keys);
// legacy private app tokens also work. HubSpot stopped new private apps on 2026-10-26.
// Run:
//   HUBSPOT_TOKEN=pat-... npm run hubspot:setup
// The key needs the scopes crm.objects.contacts.read/write and
// crm.schemas.contacts.write. Safe to run again: existing properties are skipped.

const token = process.env.HUBSPOT_TOKEN;
const base = process.env.HUBSPOT_BASE_URL || "https://api.hubapi.com";
if (!token) {
  console.error("Set HUBSPOT_TOKEN to your HubSpot service key first.");
  process.exit(1);
}

const GROUP = { name: "ai_lead_qualification", label: "AI lead qualification", displayOrder: -1 };

const PROPERTIES = [
  { name: "ai_lead_score", label: "AI lead score", type: "number", fieldType: "number" },
  {
    name: "ai_lead_tier",
    label: "AI lead tier",
    type: "enumeration",
    fieldType: "select",
    options: ["hot", "warm", "cold", "needs_review"].map((value, i) => ({ label: value, value, displayOrder: i })),
  },
  { name: "ai_lead_summary", label: "AI lead summary", type: "string", fieldType: "textarea" },
  { name: "ai_score_reasons", label: "AI score reasons", type: "string", fieldType: "textarea" },
  { name: "ai_service_requested", label: "AI service requested", type: "string", fieldType: "text" },
  { name: "ai_followup_drafted_at", label: "AI follow-up drafted at", type: "datetime", fieldType: "date" },
];

async function hubspot(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const group = await hubspot("POST", "/crm/v3/properties/contacts/groups", GROUP);
if (group.status === 201) console.log(`created group ${GROUP.name}`);
else if (group.status === 409) console.log(`group ${GROUP.name} already exists`);
else throw new Error(`group: HTTP ${group.status} ${JSON.stringify(group.body)}`);

for (const property of PROPERTIES) {
  const res = await hubspot("POST", "/crm/v3/properties/contacts", { ...property, groupName: GROUP.name });
  if (res.status === 201) console.log(`created ${property.name}`);
  else if (res.status === 409) console.log(`${property.name} already exists`);
  else throw new Error(`${property.name}: HTTP ${res.status} ${JSON.stringify(res.body)}`);
}
console.log("HubSpot is ready.");
