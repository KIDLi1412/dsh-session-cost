// Quick sanity test for lib/cost.js: builds a synthetic session event log
// (request/header + usage chunks + assistant/message with usage, including a
// repeated sample that must REPLACE rather than double count) and checks the
// per-model fold and CNY cost computation.
import assert from "node:assert/strict";
import { applyUsageDelta, computeCost, createCostState, foldCost, priceOf, totalTokens } from "../lib/cost.js";

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

console.log("cost.js sanity test passed");
console.log(JSON.stringify(cost, null, 2));
