// Builds the HubSpot and Slack payloads from a qualified lead.
// Pure functions: inlined into n8n Code nodes by the build script.

const HUBSPOT_NOTE_TO_CONTACT = 202; // HubSpot-defined association type id

export function hubspotContactUpsert(lead, result, signals, splitNameFn) {
  const { firstname, lastname } = splitNameFn(lead.name);
  const properties = {
    email: lead.email,
    firstname,
    lastname,
    company: lead.company,
    website: lead.website,
    hs_lead_status: "NEW",
    ai_lead_score: String(result.score),
    ai_lead_tier: result.tier,
    ai_lead_summary: signals ? signals.summary : "",
    ai_score_reasons: result.reasons.join("\n"),
    ai_service_requested: signals ? signals.service_requested : "",
    ai_lead_language: signals ? signals.language : "",
  };
  // Never overwrite existing CRM data with empty strings.
  for (const key of Object.keys(properties)) {
    if (properties[key] === "") delete properties[key];
  }
  return { inputs: [{ idProperty: "email", id: lead.email, properties }] };
}

export function hubspotNote(contactId, lead, result, signals, timestamp) {
  const lines = [
    `<b>AI lead qualification: ${result.tier.toUpperCase()} (${result.score}/100)</b>`,
    signals ? escapeHtml(signals.summary) : "Automatic qualification failed. Please review manually.",
    "",
    "<b>Score breakdown</b>",
    ...result.reasons.map((r) => escapeHtml(r)),
  ];
  if (signals && signals.missing_info.length > 0) {
    lines.push("", "<b>Still need to ask</b>", ...signals.missing_info.map((m) => `- ${escapeHtml(m)}`));
  }
  if (signals && signals.reply_draft) {
    lines.push("", "<b>Reply draft (review before sending)</b>", escapeHtml(signals.reply_draft));
  }
  lines.push("", "<b>Original message</b>", escapeHtml(lead.message));

  return {
    properties: { hs_timestamp: timestamp, hs_note_body: lines.join("<br>") },
    associations: [
      {
        to: { id: String(contactId) },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: HUBSPOT_NOTE_TO_CONTACT }],
      },
    ],
  };
}

export function slackAlert(lead, result, signals, contactUrl) {
  const icon = result.tier === "hot" ? ":fire:" : ":warning:";
  const title =
    result.tier === "needs_review"
      ? `${icon} New lead needs manual review`
      : `${icon} Hot lead: ${lead.name || lead.email} (${result.score}/100)`;
  const detail = signals
    ? `*${signals.service_requested}*\n${signals.summary}`
    : `Automatic qualification failed: ${result.reasons.join("; ")}`;
  const contact = [lead.name, lead.company, lead.email].filter(Boolean).join(" · ");
  return {
    text: title,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${title}*\n${contact}` } },
      { type: "section", text: { type: "mrkdwn", text: detail } },
      { type: "context", elements: [{ type: "mrkdwn", text: result.reasons.join(" | ") }] },
      { type: "section", text: { type: "mrkdwn", text: `<${contactUrl}|Open in HubSpot>` } },
    ],
  };
}

/** Short, readable reason from an HTTP error such as `400 - "{...INVALID_EMAIL...}"`. */
export function crmErrorReason(rawError) {
  const raw = String(rawError || "unknown error");
  const status = (raw.match(/^(\d{3})/) || [])[1];
  const code = (raw.match(/\\?"code\\?"\s*:\s*\\?"([A-Z_]+)/) || [])[1] || (raw.match(/\b(INVALID_[A-Z_]+|[A-Z]+_ERROR)\b/) || [])[1];
  if (status) return `HubSpot rejected the contact (HTTP ${status}${code ? `, ${code}` : ""})`;
  return `HubSpot request failed: ${raw.slice(0, 200)}`;
}

/** Slack message used when the CRM write fails, so the lead is never silently lost. */
export function crmErrorAlert(lead, result, reason) {
  const contact = [lead.name, lead.company, lead.email].filter(Boolean).join(" · ");
  return {
    text: `:rotating_light: Lead could not be saved to HubSpot: ${lead.name || lead.email}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*:rotating_light: Lead could not be saved to HubSpot*\n${contact}` },
      },
      { type: "section", text: { type: "mrkdwn", text: `*Reason:* ${reason}\n*AI result:* ${result.tier} (${result.score}/100)` } },
      { type: "section", text: { type: "mrkdwn", text: `*Message*\n${lead.message.slice(0, 2500)}` } },
    ],
  };
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}
