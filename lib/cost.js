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
 * per-model PERIOD buckets (peak / off-peak / the pre-V4.1 `v4` window /
 * pre-cutover `legacy`, attributed by each sample's event time — the rates
 * differ per period and per price era); `lastSample`/`currentModel` let a
 * later event slice keep the replace-last-sample semantics and model
 * attribution across fold boundaries without replaying the whole log.
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
			// Every period key a sample can land in: the current 峰谷 pair, the
			// V4 era (which needs both intraday halves), and pre-cutover legacy.
			modelBucket = {
				offpeak: zeroBuckets(),
				peak: zeroBuckets(),
				"v4:offpeak": zeroBuckets(),
				"v4:peak": zeroBuckets(),
				legacy: zeroBuckets()
			};
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
 * OFF-PEAK (峰谷) rates: the peak windows are Beijing time weekday 09:00–12:00
 * and 14:00–18:00 (Mon–Fri) — the API docs state the same window as UTC
 * 01:00–04:00 / 06:00–10:00 Mon–Fri — and the off-peak rate is exactly half
 * the peak rate. Since 2026-08-23 00:00 Beijing time weekends (Sat–Sun) no
 * longer distinguish peak/off-peak and are billed at the off-peak rate all
 * day.
 *
 * Current rates (V4.1-Flash era, from 2026-09-10; CNY per 1M tokens):
 *   deepseek-flash / deepseek-v4-flash / deepseek-v4-flash-vision-exp:
 *                     输入(缓存未命中) 空闲 ¥1 / 高峰 ¥2
 *                     输入(缓存命中)   空闲 ¥0.02 / 高峰 ¥0.04
 *                     输出             空闲 ¥4 / 高峰 ¥8
 *   deepseek-v4-pro:   输入(缓存未命中) 空闲 ¥4.5 / 高峰 ¥9.0
 *                     输入(缓存命中)   空闲 ¥0.15 / 高峰 ¥0.30
 *                     输出             空闲 ¥13.5 / 高峰 ¥27.0
 *
 * The earlier windows keep their own tables ({@link V4_ERA_PRICING},
 * {@link LEGACY_PRICING}) so a session that spans a price change is not
 * repriced retroactively.
 *
 * `cacheWrite` has no DeepSeek equivalent (context caching is automatic and
 * billed as cache hits); it defaults to the cache-miss input rate per period
 * so any reported cache-write tokens are priced conservatively.
 */
export const DEFAULT_PRICING = {
	// Longest key wins in `priceOf`, so the specific v4 ids stay ahead of the
	// bare `deepseek-flash` key further down.
	//
	// Rates below are the CURRENT (V4.1-Flash era, from 2026-09-10) CNY prices
	// from the official 模型 & 价格 page: Flash 空闲/高峰 cache-hit ¥0.02/0.04,
	// cache-miss ¥1/2, output ¥4/8; Pro ¥0.15/0.30, ¥4.5/9, ¥13.5/27.
	"deepseek-v4-flash": {
		offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
	},
	"deepseek-v4-pro": {
		offpeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 },
		peak: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 }
	},
	// V4-Flash and V4-Flash-Vision-Exp are RETIRED models: the API still
	// accepts their names but serves DeepSeek-V4.1-Flash at the Flash price, so
	// they carry the same rates as `deepseek-flash` (and the vision variant has
	// no separate multimodal surcharge).
	"deepseek-v4-flash-vision-exp": {
		offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
	},
	// `deepseek-flash` is the model name the API documents for
	// DeepSeek-V4.1-Flash, and the id DSH 0.1.5 actually routes. Missing it
	// means `priceOf` resolves no rate, every row prices at 0 and the whole
	// feature silently reports ¥0. `deepseek-v41-flash` is the same model under
	// its other spelling.
	"deepseek-flash": {
		offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
	},
	"deepseek-v41-flash": {
		offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
	},
	// `deepseek-chat` / `deepseek-reasoner` were retired on 2026-07-24 and now
	// alias V4-Flash, so they bill at the Flash rates too; the entries stay so
	// historical sessions still resolve a price instead of reading 未计价.
	"deepseek-chat": {
		offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
	},
	"deepseek-reasoner": {
		offpeak: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
		peak: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }
	}
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

/**
 * The 峰谷 rates that applied BETWEEN the cutover and the V4.1-Flash release
 * (2026-08-17 through 2026-09-09 Beijing time), when V4-Flash still billed
 * ¥1.5–3 / ¥0.05–0.10 / ¥4.5–9. Samples in that window are still in live
 * session logs, so they keep their own period rather than being repriced at
 * today's cheaper rates.
 */
export const V4_ERA_PRICING = {
	"deepseek-v4-flash": {
		offpeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 },
		peak: { input: 3, cacheRead: 0.1, cacheWrite: 3, output: 9 }
	},
	"deepseek-v4-pro": {
		offpeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 },
		peak: { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 }
	}
};

/** Peak/off-peak cutover: 2026-08-17 00:00:00 +08:00 (UTC+8 has no DST). */
export const PEAK_CUTOVER_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

/** Weekend off-peak cutover: 2026-08-23 00:00:00 +08:00. */
export const WEEKEND_CUTOVER_MS = Date.UTC(2026, 7, 22, 16, 0, 0);

/**
 * V4.1-Flash pricing cutover: 2026-09-10 00:00:00 +08:00, the release day of
 * DeepSeek-V4.1-Flash, which lowered the Flash rates to ¥1/2 input,
 * ¥0.02/0.04 cache-hit and ¥4/8 output. The change log announces the release
 * without a timestamp, so midnight Beijing on that date is the boundary
 * (samples on the release day itself bill at the new rates).
 */
export const V41_CUTOVER_MS = Date.UTC(2026, 8, 9, 16, 0, 0);

/** Beijing local hour (UTC+8, DST-free) of a timestamp. */
function beijingHourOf(timeMs) {
	return (new Date(timeMs).getUTCHours() + 8) % 24;
}

/** Beijing local day-of-week (0 = Sunday … 6 = Saturday) of a timestamp. */
function beijingDayOf(timeMs) {
	return new Date(timeMs + 8 * 3600 * 1000).getUTCDay();
}

/**
 * Intraday 峰谷 state of a timestamp: `peak` during Beijing weekday 09:00–12:00
 * and 14:00–18:00 (the API docs state the same window as UTC 01:00–04:00 /
 * 06:00–10:00 Mon–Fri), `offpeak` otherwise — including all day on weekends
 * since 2026-08-23 00:00 Beijing time, when Sat/Sun stopped distinguishing
 * peak from off-peak.
 */
export function peakStateOf(timeMs) {
	if (!Number.isFinite(timeMs)) return "offpeak";
	if (timeMs >= WEEKEND_CUTOVER_MS) {
		const day = beijingDayOf(timeMs);
		if (day === 0 || day === 6) return "offpeak";
	}
	const hour = beijingHourOf(timeMs);
	return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? "peak" : "offpeak";
}

/**
 * Billing period of a token sample — the key its bucket is folded under and,
 * together with the model, the rate it is priced at. Four eras: `legacy`
 * before the 峰谷 cutover (flat V4 rates), the V4 era between that cutover and
 * the V4.1-Flash release, and the current era from the V4.1 release onward.
 *
 * The V4 era needs BOTH dimensions, so it folds under `v4:peak` / `v4:offpeak`
 * — the era picks the rate table (V4-EAR-PRICING) while the intraday state
 * picks the half of it, and collapsing them into one `v4` key would silently
 * bill V4-era peak traffic at the off-peak rate. A missing/invalid timestamp
 * defaults to the off-peak regime.
 */
export function periodOf(timeMs) {
	if (!Number.isFinite(timeMs)) return "offpeak";
	if (timeMs < PEAK_CUTOVER_MS) return "legacy";
	if (timeMs < V41_CUTOVER_MS) return `v4:${peakStateOf(timeMs)}`;
	return peakStateOf(timeMs);
}

/** The rate set an era entry holds for one period (flat tables read as-is). */
function eraRates(entry, period) {
	if (entry === null || entry === void 0) return null;
	if (entry.offpeak !== void 0 && entry.peak !== void 0) return entry[period] ?? entry.offpeak ?? null;
	return entry;
}

/**
 * Resolve one model's per-period rates from a pricing entry: a per-period
 * entry (`{ offpeak, peak }`) prices each period with its own rates; the
 * earlier price eras supply the `v4:<state>` and `legacy` fallbacks (both
 * resolved for this model, so an alias id still bills at the era rate); a flat
 * entry (`{ input, cacheRead, cacheWrite, output }`) applies the same rate in
 * every period — the shape user overrides use.
 * @param entry - the model's current pricing entry.
 * @param legacyEntry - this model's {@link LEGACY_PRICING} entry, if any.
 * @param eraEntry - this model's {@link V4_ERA_PRICING} entry, if any.
 */
export function periodsOf(entry, legacyEntry, eraEntry) {
	if (entry === null || entry === void 0) return null;
	if (entry.offpeak !== void 0 && entry.peak !== void 0) {
		const eraOffpeak = eraRates(eraEntry, "offpeak") ?? entry.offpeak;
		const eraPeak = eraRates(eraEntry, "peak") ?? eraOffpeak;
		return {
			offpeak: entry.offpeak,
			peak: entry.peak,
			"v4:offpeak": entry["v4:offpeak"] ?? eraOffpeak,
			"v4:peak": entry["v4:peak"] ?? eraPeak,
			"v4": entry.v4 ?? eraOffpeak,
			legacy: entry.legacy ?? eraRates(legacyEntry, "offpeak") ?? entry.offpeak
		};
	}
	return { offpeak: entry, peak: entry, "v4:offpeak": entry, "v4:peak": entry, v4: entry, legacy: entry };
}

/**
 * Characters that end one name segment in a model id, so a pricing key may
 * extend to a longer id through them (`deepseek-v4-flash-2026-01`, `@`-tagged
 * snapshots, `:`/`.`/`_` separated build suffixes).
 */
const SEGMENT_SEPARATORS = new Set(["-", ".", "_", ":", "@", "+", "/"]);

/**
 * Resolve the pricing entry for a `provider/model` key: the model id (the part
 * after the first "/") is matched case-insensitively, first by exact key, then
 * by the longest key the id extends at a NAME BOUNDARY — the next character
 * must be a separator, so "deepseek-v4-flash-2026-01" (a dated build) resolves
 * `deepseek-v4-flash` while "deepseek-v99" resolves nothing instead of being
 * silently priced as a different family. Returns null when nothing matches.
 */
export function priceOf(modelKey, pricing) {
	if (typeof modelKey !== "string") return null;
	const slash = modelKey.indexOf("/");
	const modelId = (slash === -1 ? modelKey : modelKey.slice(slash + 1)).toLowerCase();
	const table = pricing ?? DEFAULT_PRICING;
	if (table[modelId] !== void 0) return { key: modelId, price: table[modelId] };
	let best = null;
	for (const key of Object.keys(table)) {
		if (!matchesModelId(modelId, key)) continue;
		if (best === null || key.length > best.length) best = { key, price: table[key] };
	}
	return best;
}

/** Does one pricing key name this model id (exact, or at a name boundary)? */
function matchesModelId(modelId, key) {
	const candidate = key.toLowerCase();
	if (!modelId.startsWith(candidate)) return false;
	const boundary = modelId.charAt(candidate.length);
	return boundary === "" || SEGMENT_SEPARATORS.has(boundary);
}

/**
 * Retired/alternate model ids → the canonical key an era table uses. The
 * CURRENT table lists every accepted id explicitly (each is a real billing
 * name), but an era table only holds the keys that existed then; this map lets
 * a sample billed under a later alias still find its era rate — a
 * `deepseek-flash` sample from the V4 window paid V4-Flash money.
 */
const PRICING_ALIASES = {
	"deepseek-flash": "deepseek-v4-flash",
	"deepseek-v41-flash": "deepseek-v4-flash",
	"deepseek-v4-flash-vision-exp": "deepseek-v4-flash",
	"deepseek-chat": "deepseek-v4-flash",
	"deepseek-reasoner": "deepseek-v4-flash"
};

/**
 * The era fallback for one model, resolved with the SAME boundary matching as
 * {@link priceOf} plus the {@link PRICING_ALIASES} mapping. A session billed
 * while the V4-era (or pre-cutover) table was in force must use that table even
 * when its model id is a later alias — a September session running
 * `deepseek-flash` still paid the V4-era ¥1.5/¥3 Flash rates, not today's
 * ¥1/¥2.
 * @param modelKey - the full `provider/model` key.
 * @param table - an era table (e.g. {@link V4_ERA_PRICING}).
 * @returns the matching entry, or undefined when the model is not in it.
 */
export function eraEntryOf(modelKey, table) {
	if (typeof modelKey !== "string") return void 0;
	const slash = modelKey.indexOf("/");
	const modelId = (slash === -1 ? modelKey : modelKey.slice(slash + 1)).toLowerCase();
	if (table[modelId] !== void 0) return table[modelId];
	const canonical = PRICING_ALIASES[modelId];
	if (canonical !== void 0 && table[canonical] !== void 0) return table[canonical];
	let best = null;
	for (const key of Object.keys(table)) {
		if (!matchesModelId(modelId, key)) continue;
		if (best === null || key.length > best.length) best = key;
	}
	return best === null ? void 0 : table[best];
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
 * Every billing period a folded row can carry, newest regime first. All of
 * them are folded and priced, so a session spanning a price change keeps each
 * sample at the rate that was in force when it was billed.
 */
const PERIODS = ["offpeak", "peak", "v4:offpeak", "v4:peak", "legacy"];

/**
 * Compute the per-model cost breakdown of a folded session state, pricing
 * each period's tokens at that period's rate (峰谷, plus the earlier price
 * eras a long session may reach back into).
 * @param state - session fold state.
 * @param pricing - pricing table (defaults to {@link DEFAULT_PRICING}).
 * @returns `{ tokens, models, cost }` where `models` is sorted by cost
 *   descending and each row carries its total buckets plus `cost`, the
 *   per-period token counts (`peakTokens`/`offpeakTokens`/`v4Tokens`/
 *   `legacyTokens`) and per-period costs, and `tokens` is the whole-session
 *   bucket total. The two V4-era buckets roll up into `v4Tokens`/`v4Cost`.
 */
export function computeCost(state, pricing) {
	const totals = zeroBuckets();
	const models = [];
	for (const [model, periods] of state.models) {
		const match = priceOf(model, pricing);
		const rates = periodsOf(
			match?.price ?? null,
			eraEntryOf(model, LEGACY_PRICING) ?? null,
			eraEntryOf(model, V4_ERA_PRICING) ?? null
		);
		const row = {
			model,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			tokens: 0,
			price: match === null ? null : match.price,
			cost: 0
		};
		for (const period of [...PERIODS, "v4"]) {
			row[`${period}Tokens`] = 0;
			row[`${period}Cost`] = 0;
		}
		for (const period of PERIODS) {
			const buckets = periods[period];
			addInto(totals, buckets);
			addInto(row, buckets);
			row[`${period}Tokens`] = totalTokens(buckets);
			const rate = rates === null ? null : rates[period] ?? null;
			row[`${period}Cost`] = rate === null || rate === void 0 ? 0 : costOf(buckets, rate);
			row.cost += row[`${period}Cost`];
			// The V4 era folds under two intraday keys; the row reports one
			// `v4` reading so the panel keeps a single split line for it.
			if (period.startsWith("v4:")) {
				row.v4Tokens += row[`${period}Tokens`];
				row.v4Cost += row[`${period}Cost`];
			}
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
