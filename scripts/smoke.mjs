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
	eraEntryOf,
	totalTokens,
	periodOf,
	peakStateOf,
	periodsOf,
	PEAK_CUTOVER_MS,
	WEEKEND_CUTOVER_MS,
	V41_CUTOVER_MS,
	DEFAULT_PRICING,
	V4_ERA_PRICING,
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
assert.equal(priceOf("deepseek-official/deepseek-v4-flash-vision-exp").key, "deepseek-v4-flash-vision-exp");

// ---- 峰谷 billing periods ---------------------------------------------
// Beijing = UTC+8, no DST. Peak windows: Beijing 09:00–12:00 and 14:00–18:00,
// which the API docs state as UTC 01:00–04:00 / 06:00–10:00 Mon–Fri.
// 2026-09-16 is a Wednesday inside the CURRENT (V4.1) pricing era, so the
// intraday peak/off-peak state is the whole answer here.
const at = (utcHour, utcMinute = 0) => Date.UTC(2026, 8, 16, utcHour, utcMinute, 0);
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
assert.equal(periodOf(PEAK_CUTOVER_MS), "v4:offpeak", "the cutover instant (Beijing 00:00) opens the V4 era, off-peak");
assert.equal(periodOf(Date.UTC(2026, 8, 8, 0, 0, 0)), "v4:offpeak", "2026-09-08 Beijing 08:00 is still V4-era off-peak");
assert.equal(periodOf(Date.UTC(2026, 8, 8, 3, 0, 0)), "v4:peak", "2026-09-08 Beijing 11:00 is still V4-era peak");
assert.equal(periodOf(V41_CUTOVER_MS), "offpeak", "the V4.1 cutover instant (Beijing 00:00) is off-peak");
assert.equal(periodOf(NaN), "offpeak", "missing timestamp defaults to off-peak");

// Weekend rule (2026-08-23 00:00 Beijing): Sat/Sun are off-peak all day.
// Checked through `peakStateOf` because inside the V4 era the intraday state
// is spelled by the era name (`v4`), while the rule itself still governs which
// half of the V4-EAR-PRICING table applies.
// 2026-08-22 = Sat, 2026-08-23 = Sun, 2026-08-24 = Mon, 2026-08-29 = Sat.
assert.equal(peakStateOf(Date.UTC(2026, 7, 22, 2, 0, 0)), "peak", "Sat 2026-08-22 Beijing 10:00 still peak before the weekend cutover");
assert.equal(peakStateOf(Date.UTC(2026, 7, 22, 12, 0, 0)), "offpeak", "Sat 2026-08-22 Beijing 20:00 off-peak");
assert.equal(peakStateOf(WEEKEND_CUTOVER_MS), "offpeak", "weekend cutover instant (Sun Beijing 00:00) is off-peak");
assert.equal(peakStateOf(Date.UTC(2026, 7, 23, 2, 0, 0)), "offpeak", "Sun 2026-08-23 Beijing 10:00 is off-peak on weekends");
assert.equal(peakStateOf(Date.UTC(2026, 7, 23, 10, 0, 0)), "offpeak", "Sun 2026-08-23 Beijing 18:00 is off-peak on weekends");
assert.equal(peakStateOf(Date.UTC(2026, 7, 24, 2, 0, 0)), "peak", "Mon 2026-08-24 Beijing 10:00 still peak on weekdays");
assert.equal(peakStateOf(Date.UTC(2026, 7, 29, 2, 0, 0)), "offpeak", "Sat 2026-08-29 Beijing 10:00 off-peak");
// 2026-09-19 = Sat, 2026-09-21 = Mon (current era).
assert.equal(peakStateOf(Date.UTC(2026, 8, 19, 2, 0, 0)), "offpeak", "Sat 2026-09-19 Beijing 10:00 off-peak");
assert.equal(peakStateOf(Date.UTC(2026, 8, 21, 2, 0, 0)), "peak", "Mon 2026-09-21 Beijing 10:00 is peak");
// Inside the V4 era both halves exist, so the weekend rule must survive there.
assert.equal(peakStateOf(Date.UTC(2026, 8, 8, 2, 0, 0)), "peak", "Tue 2026-09-08 Beijing 10:00 was peak");
assert.equal(peakStateOf(Date.UTC(2026, 8, 6, 2, 0, 0)), "offpeak", "Sun 2026-09-06 Beijing 10:00 was off-peak (weekend)");

// Official table: off-peak is exactly half of peak, per field, for every
// per-period entry (the current V4.1 table, and the V4-era one behind it).
for (const [model, entry] of Object.entries(DEFAULT_PRICING)) {
	if (entry.offpeak === void 0 || entry.peak === void 0) continue; // flat entries
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
// V4.1-Flash rates: cache-miss ¥1/¥2, output ¥4/¥8.
assert.ok(Math.abs(peakRow.cost - (1000 * 2 + 1000 * 8) / 1e6) < 1e-9, "peak flash cost");
assert.ok(Math.abs(offpeakRow.cost - (1000 * 1 + 1000 * 4) / 1e6) < 1e-9, "off-peak flash cost");
assert.ok(Math.abs(peakRow.cost - 2 * offpeakRow.cost) < 1e-9, "peak must be 2× off-peak");

// Mixed-period session: period costs sum, tokens stay total.
const mixed = foldCost([flashSample(10, 2), flashSample(11, 12)]);
const mixedRow = mixed.models[0];
assert.ok(Math.abs(mixedRow.cost - (peakRow.cost + offpeakRow.cost)) < 1e-9, "mixed cost = peak + off-peak");
assert.equal(mixedRow.peakTokens, 2000);
assert.equal(mixedRow.offpeakTokens, 2000);
assert.equal(mixedRow.inputTokens, 2000, "total buckets span both periods");
assert.equal(mixedRow.legacyTokens, 0);

// Legacy era: pre-cutover samples use the old flat rates.
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

// V4 era: the window between the 峰谷 cutover and the V4.1-Flash release bills
// at the higher V4-era rates (cache-miss ¥1.5/¥3, output ¥4.5/¥9), and it does
// so for the LATER alias ids too — a `deepseek-flash` sample from that window
// paid V4-Flash money, not today's cheaper rate.
const v4Evt = (model, time) => ({
	seq: 130,
	time,
	type: "assistant/message",
	data: { turn: 13, step: 0, message: { source: { provider: "deepseek-official", model } }, usage: { inputTokens: 1000, outputTokens: 1000 } }
});
const v4Window = Date.UTC(2026, 8, 8, 19, 0, 0); // Beijing 2026-09-09 03:00 (V4 era, off-peak)
assert.equal(periodOf(v4Window), "v4:offpeak");
for (const model of ["deepseek-v4-flash", "deepseek-flash", "deepseek-v4-flash-vision-exp"]) {
	const row = foldCost([v4Evt(model, v4Window)]).models[0];
	assert.equal(row.v4Tokens, 2000, `${model}: v4-window sample lands in the v4 bucket`);
	assert.ok(Math.abs(row.cost - (1000 * 1.5 + 1000 * 4.5) / 1e6) < 1e-9, `${model}: V4-era off-peak flash rates (${row.cost})`);
}
// A session that spans both eras keeps each sample at its own rate. Rows are
// per MODEL (sorted by cost), and the fold treats a repeated (turn, step) as a
// re-report, so each sample gets its own turn here.
const spanningFold = foldCost([v4Evt("deepseek-flash", v4Window), flashSample(14, 12)]);
const spanningV4 = spanningFold.models.find((row) => row.model.endsWith("deepseek-flash"));
const spanningNow = spanningFold.models.find((row) => row.model.endsWith("deepseek-v4-flash"));
assert.equal(spanningV4.v4Tokens, 2000, "the older sample stays in the v4 bucket");
assert.equal(spanningNow.offpeakTokens, 2000, "the newer sample bills off-peak");
assert.ok(
	Math.abs(spanningFold.cost - ((1000 * 1.5 + 1000 * 4.5) + (1000 * 1 + 1000 * 4)) / 1e6) < 1e-9,
	`mixed-era cost sums both eras (${spanningFold.cost})`
);
// Inside the V4 era BOTH halves of its table are reachable — the era name
// hides the intraday state, so the two samples below differ only by hour.
const v4Peak = foldCost([v4Evt("deepseek-flash", Date.UTC(2026, 8, 8, 3, 0, 0))]).models[0]; // Beijing 11:00
assert.equal(v4Peak.v4Tokens, 2000, "a V4-era peak sample shares the v4 bucket");
assert.ok(Math.abs(v4Peak.cost - (1000 * 3 + 1000 * 9) / 1e6) < 1e-9, "V4-era peak bills at the V4 peak rates");

// Model-id aliases: DSH 0.1.5 routes V4-Flash as `deepseek-flash` (the id the
// session log actually carries), so the pricing table must resolve it — an
// unresolved id prices every row at 0 and the whole feature silently reads ¥0.
const aliasSample = {
	seq: 200,
	time: Date.UTC(2026, 8, 13, 12, 0, 0), // Sunday → off-peak all day
	type: "assistant/message",
	data: {
		turn: 20,
		step: 1,
		message: { source: { provider: "deepseek-official", model: "deepseek-flash" } },
		usage: { inputTokens: 11983, outputTokens: 114, cacheReadTokens: 3712 }
	}
};
const aliasFold = foldCost([aliasSample]);
const aliasRow = aliasFold.models[0];
assert.equal(aliasRow.model, "deepseek-official/deepseek-flash");
assert.notEqual(aliasRow.price, null, "the 0.1.5 short model id must resolve a pricing entry");
assert.ok(aliasFold.cost > 0, `an aliased model must cost something, got ${aliasFold.cost}`);
// V4.1-Flash off-peak: cache-miss ¥1, cache-hit ¥0.02, output ¥4.
const expectedAlias = (11983 * 1 + 3712 * 0.02 + 114 * 4) / 1e6;
assert.ok(Math.abs(aliasFold.cost - expectedAlias) < 1e-9, `aliased flash must bill at the V4.1-Flash rates (${aliasFold.cost} vs ${expectedAlias})`);
// The retired ids stay priced: V4-Flash / Vision-Exp now alias V4.1-Flash, and
// the V3 names alias it too, so historical sessions never read 未计价.
assert.equal(priceOf("deepseek-official/deepseek-v4-flash").key, "deepseek-v4-flash");
assert.equal(priceOf("deepseek-official/deepseek-v41-flash").key, "deepseek-v41-flash");
assert.equal(priceOf("deepseek-official/deepseek-flash").key, "deepseek-flash");
assert.notEqual(priceOf("deepseek-official/deepseek-chat"), null, "retired V3 names stay priced");
assert.equal(priceOf("deepseek-official/deepseek-v99"), null, "an unknown model still resolves nothing");
// Era lookups follow the alias map, so every accepted id finds the era rate.
for (const id of ["deepseek-v4-flash", "deepseek-flash", "deepseek-v41-flash", "deepseek-v4-flash-vision-exp", "deepseek-chat"]) {
	assert.notEqual(eraEntryOf(`deepseek-official/${id}`, V4_ERA_PRICING), void 0, `${id}: V4-era rate must resolve`);
	assert.notEqual(eraEntryOf(`deepseek-official/${id}`, LEGACY_PRICING), void 0, `${id}: legacy rate must resolve`);
}

// periodsOf: flat entries apply to every period; per-period entries keep the
// era fallbacks separate.
const flat = periodsOf({ input: 1, cacheRead: 0.02, cacheWrite: 1, output: 2 }, LEGACY_PRICING["deepseek-v4-flash"]);
assert.equal(flat.legacy, flat.offpeak, "flat entry prices legacy at the same rate");
const perPeriod = periodsOf(
	DEFAULT_PRICING["deepseek-v4-flash"],
	LEGACY_PRICING["deepseek-v4-flash"],
	V4_ERA_PRICING["deepseek-v4-flash"]
);
assert.equal(perPeriod.legacy, LEGACY_PRICING["deepseek-v4-flash"], "per-period entry falls back to the legacy table");
assert.equal(perPeriod.v4, V4_ERA_PRICING["deepseek-v4-flash"].offpeak, "the v4 fallback carries the V4-era off-peak rates");
assert.ok(Math.abs(perPeriod.peak.output - 8) < 1e-9, "current peak output ¥8");
assert.ok(Math.abs(perPeriod.offpeak.input - 1) < 1e-9, "current off-peak input ¥1");

console.log("cost.js sanity test passed (incl. 峰谷 periods)");
console.log(JSON.stringify(cost, null, 2));
