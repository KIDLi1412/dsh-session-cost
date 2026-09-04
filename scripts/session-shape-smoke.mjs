/**
 * Regression for DSH 0.1.2+ (rc.1): live sessions no longer expose an
 * `.events` array — the event count is `session.seq` and each event is read
 * via `session.eventAt(seq)` (0-based, the reads @deepseek-ai/dsh-token-meter
 * uses). foldSessionCost must fold both shapes to the same result instead of
 * throwing "Cannot read properties of undefined (reading 'length')".
 */
import assert from "node:assert/strict";
import { foldSessionCost } from "../lib/index.js";
import { DEFAULT_PRICING } from "../lib/cost.js";

const now = Date.now();
const events = [
	{ seq: 1, time: now, type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } },
	{ seq: 2, time: now, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 } } },
	{ seq: 3, time: now, type: "request/header", data: { header: { config: { provider: "pi-ai", model: "deepseek-reasoner" } } } },
	{ seq: 4, time: now, type: "assistant/message", data: { turn: 1, step: 0, message: { source: { provider: "pi-ai", model: "deepseek-reasoner" } }, usage: { inputTokens: 2000, outputTokens: 300, cacheWriteTokens: 100 } } }
];
const sessionsOf = (sessions) => ({ list: () => sessions });

// Legacy shape: .events array on the session object.
const legacySession = { id: "legacy-s1", events };
const legacyCost = foldSessionCost(sessionsOf([legacySession]), "legacy-s1", DEFAULT_PRICING);
assert.ok(legacyCost !== null, "legacy shape folds");

// rc.1 shape: seq + eventAt(seq), no .events array.
const rc1Session = { id: "rc1-s1", seq: events.length, eventAt: (n) => events[n] };
const rc1Cost = foldSessionCost(sessionsOf([rc1Session]), "rc1-s1", DEFAULT_PRICING);
assert.ok(rc1Cost !== null, "rc.1 shape folds without throwing");
assert.deepEqual(rc1Cost, legacyCost, "rc.1 shape folds to the same cost as the .events shape");

// Incremental: folding the same rc.1 session twice must not double count.
const rc1CostAgain = foldSessionCost(sessionsOf([rc1Session]), "rc1-s1", DEFAULT_PRICING);
assert.equal(rc1CostAgain.tokens.inputTokens, rc1Cost.tokens.inputTokens, "second fold adds nothing");

// A live session with only the first two events, then the full log appended
// (rc.1 sessions grow by seq), must fold incrementally to the same total.
const growing = { id: "rc1-grow", seq: 2, eventAt: (n) => events[n] };
const partial = foldSessionCost(sessionsOf([growing]), "rc1-grow", DEFAULT_PRICING);
growing.seq = events.length;
const grown = foldSessionCost(sessionsOf([growing]), "rc1-grow", DEFAULT_PRICING);
assert.equal(grown.tokens.inputTokens, 1000 + 2000, "growing session folds its new events incrementally");

console.log("rc.1 session shape smoke passed");
