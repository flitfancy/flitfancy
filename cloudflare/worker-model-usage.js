/* Usage metadata only: never persist prompts, replies, or credentials. */
import {runDdlOnce} from "./worker-storage.js";

const TABLE = `CREATE TABLE IF NOT EXISTS model_gateway_usage (
  id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL, purpose TEXT NOT NULL, provider TEXT NOT NULL,
  model TEXT NOT NULL, effort TEXT NOT NULL, outcome TEXT NOT NULL,
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, cache_write_tokens INTEGER,
  reasoning_tokens INTEGER, estimated_usd REAL, price_version TEXT NOT NULL
)`;
const INDEX = "CREATE INDEX IF NOT EXISTS model_gateway_usage_at ON model_gateway_usage(at_ms)";

function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const input = count(raw.input_tokens ?? raw.prompt_tokens), output = count(raw.output_tokens ?? raw.completion_tokens);
  if (input === null || output === null) return null;
  const inputDetails = raw.input_tokens_details || raw.prompt_tokens_details || {};
  const outputDetails = raw.output_tokens_details || raw.completion_tokens_details || {};
  return {input_tokens: input, output_tokens: output,
    cached_tokens: count(inputDetails.cached_tokens ?? raw.prompt_cache_hit_tokens),
    cache_write_tokens: count(inputDetails.cache_write_tokens),
    reasoning_tokens: count(outputDetails.reasoning_tokens)};
}

export function estimateCost(provider, model, usage, tier) {
  if (provider !== "openai" || model !== "gpt-6.1-sol" || !usage ||
      !["default", "standard"].includes(tier) || usage.cached_tokens === null || usage.cache_write_tokens === null) return null;
  const normal = usage.input_tokens - usage.cached_tokens - usage.cache_write_tokens;
  if (normal < 0 || usage.input_tokens > 272000) return null;
  return (normal * 2 + usage.cached_tokens * 0.1 + usage.cache_write_tokens * 2.5 + usage.output_tokens * 10) / 1000000;
}

export async function recordUsage(env, record) {
  if (!env.DB) return false;
  try {
    await runDdlOnce(env, TABLE);
    await runDdlOnce(env, INDEX);
    const u = record.usage || {};
    const estimate = estimateCost(record.provider, record.model, record.usage, record.tier);
    await env.DB.prepare(`INSERT INTO model_gateway_usage
      (id,at_ms,purpose,provider,model,effort,outcome,input_tokens,output_tokens,cached_tokens,cache_write_tokens,reasoning_tokens,estimated_usd,price_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), Date.now(), record.purpose,
      record.provider, record.model, record.effort || "auto", record.outcome,
      u.input_tokens ?? null, u.output_tokens ?? null, u.cached_tokens ?? null, u.cache_write_tokens ?? null,
      u.reasoning_tokens ?? null, estimate, estimate === null ? "" : "openai-2026-11-08").run();
    return true;
  } catch { return false; }
}

export async function usageSummary(env) {
  if (!env.DB) throw new Error("usage unavailable");
  await runDdlOnce(env, TABLE);
  await runDdlOnce(env, INDEX);
  const now = Date.now(), local = new Date(now + 8 * 3600000);
  const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 8 * 3600000;
  const month = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 8 * 3600000;
  async function period(start) {
    return await env.DB.prepare(`SELECT COUNT(*) AS requests,
      COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
      COALESCE(SUM(cached_tokens),0) AS cached_tokens, COALESCE(SUM(reasoning_tokens),0) AS reasoning_tokens,
      SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_usage,
      SUM(CASE WHEN estimated_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost,
      COALESCE(SUM(estimated_usd),0) AS estimated_usd FROM model_gateway_usage WHERE at_ms >= ?`).bind(start).first();
  }
  const rows = await env.DB.prepare(`SELECT at_ms,purpose,provider,model,effort,outcome,input_tokens,output_tokens,
    cached_tokens,cache_write_tokens,reasoning_tokens,estimated_usd,price_version FROM model_gateway_usage ORDER BY at_ms DESC LIMIT 50`).all();
  const grouped = await env.DB.prepare(`SELECT purpose,provider,model,COUNT(*) AS requests,
    COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
    SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_usage
    FROM model_gateway_usage WHERE at_ms >= ? GROUP BY purpose,provider,model ORDER BY requests DESC LIMIT 50`).bind(month).all();
  return {today: await period(day), month: await period(month), recent: rows.results || [], breakdown: grouped.results || [], timezone: "Asia/Shanghai",
    from_ms: (await env.DB.prepare("SELECT MIN(at_ms) AS first_at FROM model_gateway_usage").first())?.first_at ?? null};
}
