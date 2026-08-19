/**
 * dsh-session-cost — pure per-model token aggregation and CNY cost estimation
 * over session event logs. Kept free of cordis imports so it can be
 * unit-tested and validated against real logs outside the running harness.
 *
 * Aggregation semantics mirror `dsh-token-meter`'s `tokenUsage` projection
 * (and the reference plugin dsh-usage-stats, MIT © Ychris12138): a usage
 * sample rides an `assistant/chunk` (`data.chunk.type === "usage"`) or an
 * `assistant/message` (`data.usage`); a repeated sample for the same
 * (turn, step) REPLACES the earlier value instead of double counting it.
 *
 * Each sample is attributed to the model that produced it:
 * `assistant/message` carries `data.message.source.model`; usage chunks fall
 * back to the last `request/header` `data.header.config.model`; samples with
 * no model information land in the `unknown/unknown` bucket. Cost is then
 * computed per model against the pricing table (CNY per 1M tokens) so a
 * session that mixes models is priced exactly, not by the current model.
 *
 * @module dsh-session-cost/cost
 */

/** Empty token bucket. */
export function zeroBuckets() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	};
}

/** Provider usage → buckets (missing cache fields are absent in some reports). */
export function bucketsOf(usage) {
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0
	};
}

/** Total tokens across all buckets. */
export function totalTokens(buckets) {
	return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/** Extract the usage sample an event carries, if any. */
function sampleOf(event) {
	if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
		return {
			key: `${event.data.turn}:${event.data.step}`,
			usage: event.data.chunk.usage
		};
	}
	if (event.type === "assistant/message" && event.data?.usage !== void 0) {
		return {
			key: `${event.data.turn}:${event.data.step}`,
			usage: event.data.usage
		};
	}
	return void 0;
}

/**
 * The `provider/model` attribution key of a usage sample: the exact provider
 * route (dsh adapter id or pi-ai route) plus the model id, so the SAME model
 * served by different providers stays distinct. `assistant/message` names
 * its provider via `data.message.source`; usage chunks fall back to the last
 * `request/header` `data.header.config`; samples with no model information
 * land in the `unknown/unknown` bucket.
 */
function modelOf(event) {
	const source = event.data?.message?.source;
	if (source !== void 0 && typeof source.model === "string") {
		return `${typeof source.provider === "string" && source.provider.length > 0 ? source.provider : "unknown"}/${source.model}`;
	}
	const config = event.data?.header?.config;
	if (config !== void 0 && typeof config.model === "string") {
		return `${typeof config.provider === "string" && config.provider.length > 0 ? config.provider : "unknown"}/${config.model}`;
	}
	return void 0;
}

function addInto(target, source) {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	return target;
}

function subtractFrom(target, source) {
	target.inputTokens -= source.inputTokens;
	target.outputTokens -= source.outputTokens;
	target.cacheReadTokens -= source.cacheReadTokens;
	target.cacheWriteTokens -= source.cacheWriteTokens;
	return target;
}

/**
 * One session's incremental fold state. `models` holds the already-folded
 * per-model PERIOD buckets (peak / off-peak / pre-cutover legacy, attributed
 * by each sample's event time — the 峰谷 rates differ by period);
 * `lastSample`/`currentModel` let a later event slice keep the
 * replace-last-sample semantics and model attribution across fold boundaries
 * without replaying the whole log.
 */
export function createCostState() {
	return {
		models: new Map(),
		lastSample: null,
		currentModel: null,
		consumed: 0
	};
}

/**
 * Fold a slice of NEW events onto an existing session state (mutating).
 * Replacements for the same (turn, step) subtract the previous sample's
 * buckets from the model+period bucket they were attributed to, so a slice
 * starting mid-step (e.g. a usage chunk at the tail of the previous fold)
 * stays exact.
 * @param state - session fold state (mutated in place).
 * @param events - the new events, in seq order, starting after the last fold.
 */
export function applyUsageDelta(state, events) {
	let last = state.lastSample;
	let currentModel = state.currentModel;
	for (const event of events) {
		if (event.type === "request/header") {
			const model = modelOf(event);
			if (model !== void 0) currentModel = model;
		}
		const sample = sampleOf(event);
		if (sample === void 0) continue;
		const buckets = bucketsOf(sample.usage);
		const model = modelOf(event) ?? currentModel ?? "unknown/unknown";
		const period = periodOf(event.time);
		if (last !== null && last.key === sample.key) {
			// Same turn/step re-reported: replace instead of double counting.
			const previous = state.models.get(last.model);
			if (previous !== void 0) subtractFrom(previous[last.period], last.buckets);
		}
		let modelBucket = state.models.get(model);
		if (modelBucket === void 0) {
			modelBucket = { offpeak: zeroBuckets(), peak: zeroBuckets(), legacy: zeroBuckets() };
			state.models.set(model, modelBucket);
		}
		addInto(modelBucket[period], buckets);
		last = { key: sample.key, model, buckets, period };
	}
	state.lastSample = last;
	state.currentModel = currentModel;
}

/**
 * Pricing tables, CNY per 1M tokens, from the official DeepSeek pricing page
 * (https://api-docs.deepseek.com/quick_start/pricing/, 中文版).
 *
 * Since 2026-08-17 00:00 Beijing time the V4 models are billed with PEAK /
 * OFF-PEAK (峰谷) rates: the peak windows are Beijing time 09:00–12:00 and
 * 14:00–18:00, and the off-peak rate is exactly half the peak rate.
 *   deepseek-v4-flash: 输入(缓存未命中) 空闲 ¥1.5 / 高峰 ¥3.0
 *                     输入(缓存命中)   空闲 ¥0.05 / 高峰 ¥0.10
 *                     输出             空闲 ¥4.5 / 高峰 ¥9.0
 *   deepseek-v4-pro:   输入(缓存未命中) 空闲 ¥4.5 / 高峰 ¥9.0
 *                     输入(缓存命中)   空闲 ¥0.15 / 高峰 ¥0.30
 *                     输出             空闲 ¥13.5 / 高峰 ¥27.0
 *
 * `cacheWrite` has no DeepSeek equivalent (context caching is automatic and
 * billed as cache hits); it defaults to the cache-miss input rate per period
 * so any reported cache-write tokens are priced conservatively.
 */
export const DEFAULT_PRICING = {
	"deepseek-v4-flash": {
		offpeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 },
		peak: { input: 3, cacheRead: 0.1, cacheWrite: 3, output: 9 }
	},
	"deepseek-v4-pro": {
		offpeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 },
		peak: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 }
	},
	// Legacy V3 models are no longer listed on the pricing page; their
	// entries keep the last known V3 prices as a best-effort flat default
	// (the same rate in every period) and can be overridden through config.
	"deepseek-chat": { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 3 },
	"deepseek-reasoner": { input: 4, cacheRead: 1, cacheWrite: 4, output: 16 }
};

/**
 * Flat rates in force BEFORE the peak/off-peak cutover (2026-08-17 00:00
 * Beijing time), used to price token samples that predate it.
 */
export const LEGACY_PRICING = {
	"deepseek-v4-flash": { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 2 },
	"deepseek-v4-pro": { input: 3, cacheRead: 0.025, cacheWrite: 3, output: 6 },
	"deepseek-chat": { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 3 },
	"deepseek-reasoner": { input: 4, cacheRead: 1, cacheWrite: 4, output: 16 }
};

/** Peak/off-peak cutover: 2026-08-17 00:00:00 +08:00 (UTC+8 has no DST). */
export const PEAK_CUTOVER_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

/** Beijing local hour (UTC+8, DST-free) of a timestamp. */
function beijingHourOf(timeMs) {
	return (new Date(timeMs).getUTCHours() + 8) % 24;
}

/**
 * Billing period of a token sample: `legacy` before the 峰谷 cutover, then
 * `peak` during Beijing 09:00–12:00 / 14:00–18:00 and `offpeak` otherwise.
 * A missing/invalid timestamp defaults to `offpeak` (the majority regime).
 */
export function periodOf(timeMs) {
	if (!Number.isFinite(timeMs)) return "offpeak";
	if (timeMs < PEAK_CUTOVER_MS) return "legacy";
	const hour = beijingHourOf(timeMs);
	return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? "peak" : "offpeak";
}

/**
 * Resolve one model's three billing-period rates from a pricing entry:
 * a per-period entry (`{ offpeak, peak, legacy? }`) prices each period with
 * its own rates (legacy falls back to {@link LEGACY_PRICING}); a flat entry
 * (`{ input, cacheRead, cacheWrite, output }`) applies the same rate in every
 * period — the shape user overrides use.
 */
export function periodsOf(entry, legacyEntry) {
	if (entry === null || entry === void 0) return null;
	if (entry.offpeak !== void 0 && entry.peak !== void 0) {
		return {
			offpeak: entry.offpeak,
			peak: entry.peak,
			legacy: entry.legacy ?? legacyEntry ?? entry.offpeak
		};
	}
	return { offpeak: entry, peak: entry, legacy: entry };
}

/**
 * Resolve the pricing entry for a `provider/model` key: the model id (the
 * part after the first "/") is matched case-insensitively by exact key, then
 * by longest matching key prefix (so "deepseek/deepseek-v4-flash" and
 * "deepseek-v4-flash" both resolve). Returns null when no entry matches.
 */
export function priceOf(modelKey, pricing) {
	if (typeof modelKey !== "string") return null;
	const slash = modelKey.indexOf("/");
	const modelId = (slash === -1 ? modelKey : modelKey.slice(slash + 1)).toLowerCase();
	const table = pricing ?? DEFAULT_PRICING;
	if (table[modelId] !== void 0) return { key: modelId, price: table[modelId] };
	let best = null;
	for (const key of Object.keys(table)) {
		if (modelId.startsWith(key.toLowerCase())) {
			if (best === null || key.length > best.length) best = { key, price: table[key] };
		}
	}
	return best;
}

/** CNY cost of one bucket set under one pricing entry (per 1M token rates). */
export function costOf(buckets, price) {
	return (
		(buckets.inputTokens * price.input
			+ buckets.cacheReadTokens * price.cacheRead
			+ buckets.cacheWriteTokens * price.cacheWrite
			+ buckets.outputTokens * price.output) / 1e6
	);
}

/**
 * Compute the per-model cost breakdown of a folded session state, pricing
 * each period's tokens at that period's rate (峰谷).
 * @param state - session fold state.
 * @param pricing - pricing table (defaults to {@link DEFAULT_PRICING}).
 * @returns `{ tokens, models, cost }` where `models` is sorted by cost
 *   descending and each row carries its total buckets plus `cost`, the
 *   per-period token counts (`peakTokens`/`offpeakTokens`/`legacyTokens`)
 *   and per-period costs, and `tokens` is the whole-session bucket total.
 */
export function computeCost(state, pricing) {
	const totals = zeroBuckets();
	const models = [];
	for (const [model, periods] of state.models) {
		const match = priceOf(model, pricing);
		const rates = periodsOf(match?.price ?? null, match === null ? null : LEGACY_PRICING[match.key] ?? null);
		const row = {
			model,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			tokens: 0,
			price: match === null ? null : match.price,
			cost: 0,
			peakTokens: 0,
			offpeakTokens: 0,
			legacyTokens: 0,
			peakCost: 0,
			offpeakCost: 0,
			legacyCost: 0
		};
		for (const period of ["offpeak", "peak", "legacy"]) {
			const buckets = periods[period];
			addInto(totals, buckets);
			addInto(row, buckets);
			row[`${period}Tokens`] = totalTokens(buckets);
			const rate = rates === null ? null : rates[period];
			row[`${period}Cost`] = rate === null ? 0 : costOf(buckets, rate);
			row.cost += row[`${period}Cost`];
		}
		row.tokens = totalTokens(row);
		models.push(row);
	}
	models.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
	return {
		tokens: { ...totals, tokens: totalTokens(totals) },
		models,
		cost: models.reduce((sum, row) => sum + row.cost, 0)
	};
}

/** Fold a whole event log from scratch (convenience wrapper). */
export function foldCost(events, pricing) {
	const state = createCostState();
	applyUsageDelta(state, events);
	return computeCost(state, pricing);
}
