// Lead normalization and validation.
// Pure functions: the build script inlines this file into an n8n Code node,
// so it must not import anything.

const MAX_MESSAGE_CHARS = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanText(value, maxChars) {
  if (value === undefined || value === null) return "";
  const text = String(value).replace(/\r\n/g, "\n").trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Accepts the raw webhook payload (website form, Typeform, Meta lead ad
 * relayed by a webhook...) and returns a lead in one fixed shape.
 * Field names are matched loosely because every form tool names them differently.
 */
export function normalizeLead(raw, receivedAt) {
  const body = raw && typeof raw === "object" ? raw : {};
  const pick = (...keys) => {
    for (const key of keys) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== "") return body[key];
    }
    return "";
  };

  const firstName = cleanText(pick("first_name", "firstname", "firstName"), 100);
  const lastName = cleanText(pick("last_name", "lastname", "lastName"), 100);
  const fullName = cleanText(pick("name", "full_name", "fullName"), 200);

  return {
    name: fullName || [firstName, lastName].filter(Boolean).join(" "),
    email: cleanText(pick("email", "email_address", "emailAddress"), 254).toLowerCase(),
    company: cleanText(pick("company", "company_name", "companyName", "organization"), 200),
    website: cleanText(pick("website", "url", "company_website"), 300),
    budget_hint: cleanText(pick("budget", "budget_range"), 100),
    message: cleanText(pick("message", "details", "description", "comments", "project"), MAX_MESSAGE_CHARS),
    source: cleanText(pick("source", "utm_source", "form_name"), 100) || "website_form",
    received_at: receivedAt,
  };
}

/** Returns a list of problems; an empty list means the lead can be processed. */
export function validateLead(lead) {
  const problems = [];
  if (!lead.email) problems.push("email is missing");
  else if (!EMAIL_RE.test(lead.email)) problems.push("email is not valid");
  if (!lead.message) problems.push("message is empty");
  return problems;
}

/** Splits a full name for CRMs that store first and last name separately. */
export function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstname: "", lastname: "" };
  if (parts.length === 1) return { firstname: parts[0], lastname: "" };
  // Japanese / Chinese names are written family name first.
  if (/[぀-ヿ一-鿿]/.test(name)) {
    return { firstname: parts.slice(1).join(" "), lastname: parts[0] };
  }
  return { firstname: parts.slice(0, -1).join(" "), lastname: parts[parts.length - 1] };
}
