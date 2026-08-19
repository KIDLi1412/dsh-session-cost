// Contract smoke for the Host-side settings namespace + schema: imports the
// real lib/index.js and verifies the schemastery schema behaves exactly as
// the settings service relies on (`schema(mergedSection)` — see
// dsh-settings' resolve): an empty user section resolves through the
// defaults, bad values are rejected (which is what makes the Host refuse a
// bad write), and unknown keys (e.g. the documented `pricing` override)
// survive resolution so the section can carry both the card's fields and the
// pricing table without clobbering each other.
import assert from "node:assert/strict";
import { SETTINGS_NAMESPACE, SessionCostSettingsSchema, resolvePricing } from "../lib/index.js";
import { periodsOf, LEGACY_PRICING } from "../lib/cost.js";

// Namespace branding: the exact string the client card keys on.
assert.equal(typeof SETTINGS_NAMESPACE, "string");
assert.equal(SETTINGS_NAMESPACE, "session-cost", "namespace must be session-cost");

// Empty section → schema defaults (absent user layer resolves through these).
assert.deepEqual(SessionCostSettingsSchema({}), { lowBalanceThreshold: 10 });

// Explicit values pass through.
assert.deepEqual(SessionCostSettingsSchema({ lowBalanceThreshold: 15 }), {
	lowBalanceThreshold: 15
});

// Negative threshold is rejected.
assert.throws(() => SessionCostSettingsSchema({ lowBalanceThreshold: -1 }), /lowBalanceThreshold/, "negative threshold must throw");

// Non-number threshold is rejected (scope.set sends numbers only).
assert.throws(() => SessionCostSettingsSchema({ lowBalanceThreshold: "10" }), /lowBalanceThreshold/, "string threshold must throw");

// Unknown keys (the documented `pricing` override AND the legacy
// `displayMode` field from ≤0.1.4, whose standalone-bar mode no longer
// exists) are preserved, not stripped, so the card fields and pricing
// coexist in one section and stale displayMode does not break the write.
const resolved = SessionCostSettingsSchema({ pricing: { "deepseek-v4-flash": { input: 1, output: 2 } }, displayMode: "stats" });
assert.deepEqual(resolved.pricing, { "deepseek-v4-flash": { input: 1, output: 2 } }, "unknown keys must be preserved");
assert.equal(resolved.displayMode, "stats", "legacy displayMode key must be preserved (ignored)");

// ---- resolvePricing: flat and per-period override shapes -----------------
// Defaults are untouched by an absent config.
const defaults = resolvePricing(undefined);
assert.equal(defaults["deepseek-v4-flash"].offpeak.input, 1.5, "default off-peak flash input ¥1.5");
assert.equal(defaults["deepseek-v4-flash"].peak.output, 9, "default peak flash output ¥9");
// Flat override applies one rate to every period (resolved via periodsOf).
const flat = resolvePricing({ pricing: { "deepseek-v4-flash": { input: 2, cacheRead: 0.1, cacheWrite: 2, output: 4 } } });
const flatRates = periodsOf(flat["deepseek-v4-flash"], LEGACY_PRICING["deepseek-v4-flash"]);
assert.equal(flatRates.offpeak.input, 2, "flat override sets off-peak input");
assert.equal(flatRates.peak.input, 2, "flat override sets peak input too");
assert.equal(flatRates.peak.cacheRead, 0.1, "flat override sets peak cacheRead");
assert.equal(flatRates.offpeak.output, 4, "flat override sets off-peak output");
assert.equal(flatRates.legacy.input, 2, "flat override prices the legacy period too");
// Per-period override sets distinct 空闲/高峰 rates; untouched fields inherit.
const perPeriod = resolvePricing({
	pricing: {
		"deepseek-v4-flash": {
			offpeak: { input: 1.5, output: 4.5 },
			peak: { input: 3, output: 9 }
		}
	}
});
assert.equal(perPeriod["deepseek-v4-flash"].offpeak.input, 1.5, "per-period off-peak input");
assert.equal(perPeriod["deepseek-v4-flash"].peak.input, 3, "per-period peak input");
assert.equal(perPeriod["deepseek-v4-flash"].peak.cacheRead, 0.1, "untouched peak cacheRead inherits the default");
assert.equal(perPeriod["deepseek-v4-flash"].offpeak.cacheWrite, 1.5, "untouched off-peak cacheWrite inherits the default");
// Invalid entries fall back, negatives rejected, unknown keys still merged.
const sanitized = resolvePricing({ pricing: { "deepseek-v4-flash": { input: -5 }, junk: { input: 1 } } });
assert.equal(periodsOf(sanitized["deepseek-v4-flash"], LEGACY_PRICING["deepseek-v4-flash"]).offpeak.input, 1.5, "negative override falls back to the default");
assert.equal(sanitized.junk.input, 1, "unknown model keys keep the legacy merge behavior");

console.log("settings schema contract smoke passed");
