// Posts every sample lead to the n8n webhook and prints the tier n8n returned.
// Usage: npm run send-samples            (default http://localhost:5678/webhook/lead)
//        WEBHOOK=https://... npm run send-samples
// Exits with code 1 if any lead does not get its expected tier.

import { readFileSync } from "node:fs";

const webhook = process.env.WEBHOOK || "http://localhost:5678/webhook/lead";
const samples = JSON.parse(readFileSync(new URL("../data/sample-leads.json", import.meta.url), "utf8"));

let failures = 0;
for (const sample of samples) {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sample.lead),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  const ok = body.tier === sample.expected_tier;
  if (!ok) failures += 1;
  const score = body.score === undefined ? "" : ` ${body.score}/100`;
  console.log(`${ok ? "OK  " : "FAIL"} ${sample.id.padEnd(24)} expected ${sample.expected_tier.padEnd(5)} got ${body.tier ?? `HTTP ${res.status}`}${score}`);
}
console.log(failures === 0 ? `\nAll ${samples.length} leads matched.` : `\n${failures} of ${samples.length} leads did not match.`);
process.exit(failures === 0 ? 0 : 1);
