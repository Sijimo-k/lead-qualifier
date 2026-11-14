// Deterministic lead scoring from the signals Claude extracted.
// Every point comes from config/rubric.json and is listed in `reasons`,
// so a salesperson can see exactly why a lead is hot, warm or cold.
// Pure functions: inlined into an n8n Code node by the build script.

export function toUsd(amount, currency, business) {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
  const value = Number(amount);
  switch (currency) {
    case "USD":
      return value;
    case "JPY":
      return value / business.jpy_per_usd;
    case "EUR":
      return value / business.eur_per_usd;
    case "GBP":
      return value / business.gbp_per_usd;
    default:
      return null;
  }
}

function budgetPoints(budgetUsd, rubric) {
  if (budgetUsd === null) return { points: rubric.budget_unknown_points, label: "budget not stated" };
  const band = rubric.budget_usd.find((b) => budgetUsd >= b.min);
  const rounded = Math.round(budgetUsd).toLocaleString("en-US");
  return { points: band ? band.points : 0, label: `budget about $${rounded}` };
}

const TIER_ORDER = ["cold", "warm", "hot"];

function tierFromScore(score, rubric) {
  if (score >= rubric.tiers.hot) return "hot";
  if (score >= rubric.tiers.warm) return "warm";
  return "cold";
}

/**
 * Returns { score, tier, reasons, budget_usd }.
 * tier is one of: hot, warm, cold, spam.
 */
export function scoreLead(signals, rubric, business) {
  if (signals.is_spam) {
    return { score: 0, tier: "spam", reasons: [`spam: ${signals.spam_reason || "not a real enquiry"}`], budget_usd: null };
  }

  const budgetUsd = toUsd(signals.budget_amount, signals.budget_currency, business);
  const parts = [
    budgetPoints(budgetUsd, rubric),
    { points: rubric.timeline[signals.timeline] ?? 0, label: `timeline: ${signals.timeline}` },
    { points: rubric.need_fit[signals.need_fit] ?? 0, label: `fit: ${signals.need_fit}` },
    { points: rubric.decision_maker[signals.decision_maker] ?? 0, label: `decision maker: ${signals.decision_maker}` },
    { points: rubric.company_size[signals.company_size] ?? 0, label: `company size: ${signals.company_size}` },
  ];

  const score = parts.reduce((sum, p) => sum + p.points, 0);
  let tier = tierFromScore(score, rubric);
  const reasons = parts.map((p) => `+${p.points} ${p.label}`);

  // A lead asking for something we don't do should never be hot, whatever the budget.
  if (signals.need_fit === "none") {
    const cap = rubric.no_fit_max_tier;
    if (TIER_ORDER.indexOf(tier) > TIER_ORDER.indexOf(cap)) {
      tier = cap;
      reasons.push(`capped at ${cap}: service not offered`);
    }
  }

  return { score, tier, reasons, budget_usd: budgetUsd === null ? null : Math.round(budgetUsd) };
}
