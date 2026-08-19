// Contract smoke for the Host-side settings namespace + schema: imports the
// real lib/index.js and verifies the schemastery schema behaves exactly as
// the settings service relies on (`schema(mergedSection)` — see
// dsh-settings' resolve): an empty user section resolves through the
// defaults, bad values are rejected (which is what makes the Host refuse a
// bad write), and unknown keys (e.g. the documented `pricing` override)
// survive resolution so the section can carry both the card's fields and the
// pricing table without clobbering each other.
import assert from "node:assert/strict";
import { SETTINGS_NAMESPACE, SessionCostSettingsSchema } from "../lib/index.js";

// Namespace branding: the exact string the client card keys on.
assert.equal(typeof SETTINGS_NAMESPACE, "string");
assert.equal(SETTINGS_NAMESPACE, "session-cost", "namespace must be session-cost");

// Empty section → schema defaults (absent user layer resolves through these).
assert.deepEqual(SessionCostSettingsSchema({}), { displayMode: "dock", lowBalanceThreshold: 10 });

// Explicit values pass through.
assert.deepEqual(SessionCostSettingsSchema({ displayMode: "stats", lowBalanceThreshold: 15 }), {
	displayMode: "stats",
	lowBalanceThreshold: 15
});

// Invalid enum is rejected → the Host refuses the write.
assert.throws(() => SessionCostSettingsSchema({ displayMode: "floating" }), /displayMode/, "invalid displayMode must throw");

// Negative threshold is rejected.
assert.throws(() => SessionCostSettingsSchema({ lowBalanceThreshold: -1 }), /lowBalanceThreshold/, "negative threshold must throw");

// Non-number threshold is rejected (scope.set sends numbers only).
assert.throws(() => SessionCostSettingsSchema({ lowBalanceThreshold: "10" }), /lowBalanceThreshold/, "string threshold must throw");

// Unknown keys (the documented `pricing` override) are preserved, not
// stripped, so the card fields and pricing coexist in one section.
const resolved = SessionCostSettingsSchema({ pricing: { "deepseek-v4-flash": { input: 1, output: 2 } } });
assert.deepEqual(resolved.pricing, { "deepseek-v4-flash": { input: 1, output: 2 } }, "unknown keys must be preserved");

console.log("settings schema contract smoke passed");
