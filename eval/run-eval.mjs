// Runs the sample leads through the real Claude API with the exact request the
// workflow sends, scores them with the same rubric, and compares the tier with
// the expected one. Use it after changing the prompt, schema or rubric.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run eval
//
// Costs a few cents (one request per sample lead). Results are saved to eval/results/.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { normalizeLead } from "../src/lead.js";
import { ANTHROPIC_BETA, buildClaudeRequest, parseClaudeResponse } from "../src/qualify.js";
import { scoreLead } from "../src/score.js";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const business = readJson("../config/business.json");
const rubric = readJson("../config/rubric.json");
const samples = readJson("../data/sample-leads.json");

// Opus 5.5 list prices per million tokens, for the cost estimate only.
const PRICE_IN = 4;
const PRICE_OUT = 20;

const client = new Anthropic();

async function qualify(sample) {
  const lead = normalizeLead(sample.lead, new Date().toISOString());
  const request = buildClaudeRequest(lead, business);
  const started = Date.now();
  const response = await client.beta.messages.create({ ...request, betas: [ANTHROPIC_BETA] });
  const signals = parseClaudeResponse(response);
  const result = scoreLead(signals, rubric, business);
  return {
    id: sample.id,
    expected: sample.expected_tier,
    tier: result.tier,
    score: result.score,
    pass: result.tier === sample.expected_tier,
    reasons: result.reasons,
    signals,
    model: response.model,
    ms: Date.now() - started,
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

const rows = [];
for (const sample of samples) {
  try {
    rows.push(await qualify(sample));
  } catch (error) {
    let message = error.message;
    if (error instanceof Anthropic.AuthenticationError) message = "authentication failed - check ANTHROPIC_API_KEY";
    else if (error instanceof Anthropic.RateLimitError) message = "rate limited - try again in a minute";
    else if (error instanceof Anthropic.APIError) message = `API error ${error.status}: ${error.message}`;
    rows.push({ id: sample.id, expected: sample.expected_tier, tier: "error", pass: false, error: message });
  }
  const row = rows.at(-1);
  const detail = row.error ? row.error : `${row.tier} ${row.score}/100 (${row.ms} ms)`;
  console.log(`${row.pass ? "OK  " : "FAIL"} ${row.id.padEnd(24)} expected ${row.expected.padEnd(5)} got ${detail}`);
  if (!row.pass && row.signals) console.log(`     ${row.reasons.join(" | ")}`);
}

const passed = rows.filter((r) => r.pass).length;
const input = rows.reduce((sum, r) => sum + (r.usage?.input || 0), 0);
const output = rows.reduce((sum, r) => sum + (r.usage?.output || 0), 0);
const cost = (input * PRICE_IN + output * PRICE_OUT) / 1_000_000;
console.log(`\n${passed}/${rows.length} matched the expected tier. Tokens: ${input} in / ${output} out (about $${cost.toFixed(3)}).`);

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = new URL(`./results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ passed, total: rows.length, input, output, rows }, null, 2));
console.log(`Saved ${file.pathname}`);
process.exit(passed === rows.length ? 0 : 1);
