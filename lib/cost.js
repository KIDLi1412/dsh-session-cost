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
 * per-model buckets; `lastSample`/`currentModel` let a later event slice keep
 * the replace-last-sample semantics and model attribution across fold
 * boundaries without replaying the whole log.
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
 * buckets from the model bucket they were attributed to, so a slice starting
 * mid-step (e.g. a usage chunk at the tail of the previous fold) stays exact.
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
		if (last !== null && last.key === sample.key) {
			// Same turn/step re-reported: replace instead of double counting.
			const previous = state.models.get(last.model);
			if (previous !== void 0) subtractFrom(previous, last.buckets);
		}
		let modelBucket = state.models.get(model);
		if (modelBucket === void 0) {
			modelBucket = zeroBuckets();
			state.models.set(model, modelBucket);
		}
		addInto(modelBucket, buckets);
		last = { key: sample.key, model, buckets };
	}
	state.lastSample = last;
	state.currentModel = currentModel;
}

/**
 * Default pricing table, CNY per 1M tokens, from the official DeepSeek
 * pricing page (https://api-docs.deepseek.com/quick_start/pricing/, 中文版).
 *
 * Current flat prices as of 2026-08 (peak/off-peak billing takes effect
 * 2026-08-17 00:00 Beijing time; see README):
 *   deepseek-v4-flash: 输入(缓存未命中) ¥1 · 输入(缓存命中) ¥0.02 · 输出 ¥2
 *   deepseek-v4-pro:   输入(缓存未命中) ¥3 · 输入(缓存命中) ¥0.025 · 输出 ¥6
 *
 * Legacy V3 models (deepseek-chat / deepseek-reasoner) are no longer listed
 * on the pricing page; their entries keep the last known V3 prices as a
 * best-effort default and can be overridden through plugin config.
 *
 * `cacheWrite` has no DeepSeek equivalent (context caching is automatic and
 * billed as cache hits); it defaults to the cache-miss input rate so any
 * reported cache-write tokens are priced conservatively.
 */
export const DEFAULT_PRICING = {
	"deepseek-v4-flash": { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 2 },
	"deepseek-v4-pro": { input: 3, cacheRead: 0.025, cacheWrite: 3, output: 6 },
	"deepseek-chat": { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 3 },
	"deepseek-reasoner": { input: 4, cacheRead: 1, cacheWrite: 4, output: 16 }
};

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
 * Compute the per-model cost breakdown of a folded session state.
 * @param state - session fold state.
 * @param pricing - pricing table (defaults to {@link DEFAULT_PRICING}).
 * @returns `{ tokens, models, cost }` where `models` is sorted by cost
 *   descending and each row carries its buckets plus `cost`, and `tokens` is
 *   the whole-session bucket total.
 */
export function computeCost(state, pricing) {
	const totals = zeroBuckets();
	const models = [];
	for (const [model, buckets] of state.models) {
		addInto(totals, buckets);
		const match = priceOf(model, pricing);
		const cost = match === null ? 0 : costOf(buckets, match.price);
		models.push({
			model,
			...buckets,
			tokens: totalTokens(buckets),
			price: match === null ? null : match.price,
			cost
		});
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
