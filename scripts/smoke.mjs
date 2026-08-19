// Quick sanity test for lib/cost.js: builds a synthetic session event log
// (request/header + usage chunks + assistant/message with usage, including a
// repeated sample that must REPLACE rather than double count) and checks the
// per-model fold, CNY cost computation, and the 峰谷 (peak/off-peak) billing
// periods. The synthetic log uses pre-cutover timestamps (epoch ms), so the
// legacy flat rates price it — the old numbers must keep holding.
import assert from "node:assert/strict";
import {
	applyUsageDelta,
	computeCost,
	createCostState,
	foldCost,
	priceOf,
	totalTokens,
	periodOf,
	periodsOf,
	PEAK_CUTOVER_MS,
	DEFAULT_PRICING,
	LEGACY_PRICING
} from "../lib/cost.js";

const seq = (function () { let n = 0; return () => n++; })();

const events = [
	{ seq: seq(), time: 1000, type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } },
	// Usage chunk for turn 0 step 0
	{ seq: seq(), time: 2000, type: "assistant/chunk", data: { turn: 0, step: 0, chunk: { type: "usage", usage: { inputTokens: 1000, outputTokens: 500 } } } },
	// assistant/message replaces the same (turn, step) with a final sample
	{ seq: seq(), time: 3000, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 1500, outputTokens: 700, cacheReadTokens: 300 } } },
	// A second request on a different model (reasoner) with cache-write
	{ seq: seq(), time: 4000, type: "request/header", data: { header: { config: { provider: "pi-ai", model: "deepseek-reasoner" } } } },
	{ seq: seq(), time: 5000, type: "assistant/message", data: { turn: 1, step: 0, message: { source: { provider: "pi-ai", model: "deepseek-reasoner" } }, usage: { inputTokens: 2000, outputTokens: 300, cacheWriteTokens: 100 } } }
];

// Incremental fold in two slices must equal a single full fold.
const state = createCostState();
applyUsageDelta(state, events.slice(0, 2));
applyUsageDelta(state, events.slice(2));
const fullState = createCostState();
applyUsageDelta(fullState, events);
assert.deepEqual(state.models, fullState.models, "incremental fold diverged from full fold");
const full = foldCost(events);
assert.deepEqual(full, computeCost(fullState), "foldCost diverged from computeCost over a full fold");

const cost = computeCost(state);
assert.equal(cost.tokens.inputTokens, 1500 + 2000, "input totals");
assert.equal(cost.tokens.cacheReadTokens, 300, "cacheRead totals");
assert.equal(cost.tokens.cacheWriteTokens, 100, "cacheWrite totals");
assert.equal(cost.tokens.outputTokens, 700 + 300, "output totals");
assert.equal(totalTokens(cost.tokens), 4900, "total tokens");

// flash: input 1500*1 + cacheRead 300*0.02 + output 700*2  (per 1M) = (1500 + 6 + 1400)/1e6
const flashCost = (1500 * 1 + 300 * 0.02 + 700 * 2) / 1e6;
// reasoner: input 2000*4 + cacheWrite 100*4 + output 300*16 = (8000 + 400 + 4800)/1e6
const reasonerCost = (2000 * 4 + 100 * 4 + 300 * 16) / 1e6;
const rows = new Map(cost.models.map((row) => [row.model, row]));
assert.ok(Math.abs(rows.get("deepseek-official/deepseek-v4-flash").cost - flashCost) < 1e-9, "flash cost");
assert.ok(Math.abs(rows.get("pi-ai/deepseek-reasoner").cost - reasonerCost) < 1e-9, "reasoner cost");
assert.ok(Math.abs(cost.cost - (flashCost + reasonerCost)) < 1e-9, "total cost");
assert.equal(cost.currency === void 0, true, "computeCost has no currency field");

// priceOf matching
assert.equal(priceOf("deepseek-official/deepseek-v4-flash").key, "deepseek-v4-flash");
assert.equal(priceOf("deepseek-v4-pro").key, "deepseek-v4-pro");
assert.equal(priceOf("unknown/unknown-model"), null);
assert.equal(priceOf("deepseek-official/deepseek-v4-flash-0731").key, "deepseek-v4-flash");

// ---- 峰谷 billing periods ---------------------------------------------
// Beijing = UTC+8, no DST. Peak windows: Beijing 09:00–12:00 and 14:00–18:00.
const at = (utcHour, utcMinute = 0) => Date.UTC(2026, 7, 19, utcHour, utcMinute, 0);
assert.equal(periodOf(at(0, 59)), "offpeak", "Beijing 08:59 is off-peak");
assert.equal(periodOf(at(1, 0)), "peak", "Beijing 09:00 is peak");
assert.equal(periodOf(at(3, 59)), "peak", "Beijing 11:59 is peak");
assert.equal(periodOf(at(4, 0)), "offpeak", "Beijing 12:00 is off-peak (lunch gap)");
assert.equal(periodOf(at(5, 59)), "offpeak", "Beijing 13:59 is off-peak");
assert.equal(periodOf(at(6, 0)), "peak", "Beijing 14:00 is peak");
assert.equal(periodOf(at(9, 59)), "peak", "Beijing 17:59 is peak");
assert.equal(periodOf(at(10, 0)), "offpeak", "Beijing 18:00 is off-peak");
assert.equal(periodOf(at(12, 0)), "offpeak", "Beijing 20:00 is off-peak");
assert.equal(periodOf(Date.UTC(2026, 7, 16, 10, 0, 0)), "legacy", "pre-cutover is legacy");
assert.equal(periodOf(PEAK_CUTOVER_MS), "offpeak", "cutover instant (Beijing 00:00) is off-peak");
assert.equal(periodOf(NaN), "offpeak", "missing timestamp defaults to off-peak");

// Official table: off-peak is exactly half of peak, per field.
for (const [model, entry] of Object.entries({ "deepseek-v4-flash": DEFAULT_PRICING["deepseek-v4-flash"], "deepseek-v4-pro": DEFAULT_PRICING["deepseek-v4-pro"] })) {
	for (const field of ["input", "cacheRead", "cacheWrite", "output"]) {
		assert.ok(Math.abs(entry.peak[field] - 2 * entry.offpeak[field]) < 1e-9, `${model} ${field}: peak must be 2× off-peak`);
	}
}

// Same tokens at peak vs off-peak: peak costs exactly twice.
const flashSample = (turn, utcHour) => ({
	seq: 100 + turn,
	time: at(utcHour),
	type: "assistant/message",
	data: { turn, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 1000, outputTokens: 1000 } }
});
const peakOnly = foldCost([flashSample(10, 2)]); // Beijing 10:00
const offpeakOnly = foldCost([flashSample(11, 12)]); // Beijing 20:00
const peakRow = peakOnly.models[0];
const offpeakRow = offpeakOnly.models[0];
assert.equal(peakRow.peakTokens, 2000, "peak sample lands in peak bucket");
assert.equal(offpeakRow.offpeakTokens, 2000, "off-peak sample lands in off-peak bucket");
assert.ok(Math.abs(peakRow.cost - (1000 * 3 + 1000 * 9) / 1e6) < 1e-9, "peak flash cost");
assert.ok(Math.abs(offpeakRow.cost - (1000 * 1.5 + 1000 * 4.5) / 1e6) < 1e-9, "off-peak flash cost");
assert.ok(Math.abs(peakRow.cost - 2 * offpeakRow.cost) < 1e-9, "peak must be 2× off-peak");

// Mixed-period session: period costs sum, tokens stay total.
const mixed = foldCost([flashSample(10, 2), flashSample(11, 12)]);
const mixedRow = mixed.models[0];
assert.ok(Math.abs(mixedRow.cost - (peakRow.cost + offpeakRow.cost)) < 1e-9, "mixed cost = peak + off-peak");
assert.equal(mixedRow.peakTokens, 2000);
assert.equal(mixedRow.offpeakTokens, 2000);
assert.equal(mixedRow.inputTokens, 2000, "total buckets span both periods");
assert.equal(mixedRow.legacyTokens, 0);

// Legacy period: pre-cutover samples use the old flat rates.
const legacyEvt = {
	seq: 120,
	time: Date.UTC(2026, 7, 16, 10, 0, 0), // 2026-08-16, pre-cutover
	type: "assistant/message",
	data: { turn: 12, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 1000, outputTokens: 1000 } }
};
const legacyRow = foldCost([legacyEvt]).models[0];
assert.equal(legacyRow.legacyTokens, 2000, "pre-cutover sample lands in legacy bucket");
assert.ok(Math.abs(legacyRow.cost - (1000 * 1 + 1000 * 2) / 1e6) < 1e-9, "legacy flash cost uses the old flat rates");
assert.ok(Math.abs(LEGACY_PRICING["deepseek-v4-flash"].input - 1) < 1e-9, "legacy flash input rate is ¥1");

// periodsOf: flat entries apply to every period; per-period entries keep the
// legacy fallback separate.
const flat = periodsOf({ input: 1, cacheRead: 0.02, cacheWrite: 1, output: 2 }, LEGACY_PRICING["deepseek-v4-flash"]);
assert.equal(flat.legacy, flat.offpeak, "flat entry prices legacy at the same rate");
const perPeriod = periodsOf(DEFAULT_PRICING["deepseek-v4-flash"], LEGACY_PRICING["deepseek-v4-flash"]);
assert.equal(perPeriod.legacy, LEGACY_PRICING["deepseek-v4-flash"], "per-period entry falls back to the legacy table");
assert.ok(Math.abs(perPeriod.peak.output - 9) < 1e-9, "peak output ¥9");

console.log("cost.js sanity test passed (incl. 峰谷 periods)");
console.log(JSON.stringify(cost, null, 2));
