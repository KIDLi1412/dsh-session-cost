// Contract smoke for the Host-side plugin CONFIG + its schema: imports the
// real lib/index.js and verifies the schemastery schema behaves exactly as DSH
// 0.2.0 relies on when it derives a settings form from it (`schema(section)`):
// an absent user layer resolves through the defaults, bad values are rejected
// (which is what makes the Host refuse a bad write), and unknown keys (e.g. the
// documented `pricing` override) survive resolution so the entry can carry both
// the panel's field and the pricing table without clobbering each other. It also
// pins the one string two processes must agree on — the profile ENTRY ID the
// client asks `ctx.configForms.get(...)` for — against the bundle patch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, SETTINGS_NAMESPACE, SessionCostSettingsSchema, resolvePricing, dshHomeDirectory, legacySettingFromDocument, apply, foldSessionCost } from "../lib/index.js";
import { periodsOf, LEGACY_PRICING } from "../lib/cost.js";

// Entry id: DSH 0.2.0 keys a plugin's config form by its profile entry id, so
// this constant is simultaneously the client's `configForms.get(...)` argument
// and the `id` of the row the bundle patch inserts. If they ever drift the
// panel silently stops persisting.
assert.equal(typeof SETTINGS_NAMESPACE, "string");
assert.equal(SETTINGS_NAMESPACE, "session-cost", "entry id must be session-cost");
const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
assert.match(patch, new RegExp(`id:\\s*${SETTINGS_NAMESPACE}\\s*$`, "m"), "the bundle patch must insert this exact entry id");
assert.equal(SessionCostSettingsSchema, Config, "the 0.1.x schema name must alias the current Config");

// Empty section → schema defaults (absent user layer resolves through these).
assert.deepEqual(Config({}), { lowBalanceThreshold: 10 });

// Explicit values pass through.
assert.deepEqual(Config({ lowBalanceThreshold: 15 }), {
	lowBalanceThreshold: 15
});

// Negative threshold is rejected.
assert.throws(() => Config({ lowBalanceThreshold: -1 }), /lowBalanceThreshold/, "negative threshold must throw");

// Non-number threshold is rejected (the form sends numbers only).
assert.throws(() => Config({ lowBalanceThreshold: "10" }), /lowBalanceThreshold/, "string threshold must throw");

// Unknown keys (the documented `pricing` override AND the legacy `displayMode`
// field from ≤0.1.4, whose standalone-bar mode no longer exists) are preserved,
// not stripped: the override table stays usable without being frozen into the
// schema, and a stale displayMode does not break a write.
const resolved = Config({ pricing: { "deepseek-v4-flash": { input: 1, output: 2 } }, displayMode: "stats" });
assert.deepEqual(resolved.pricing, { "deepseek-v4-flash": { input: 1, output: 2 } }, "unknown keys must be preserved");
assert.equal(resolved.displayMode, "stats", "legacy displayMode key must be preserved (ignored)");
assert.equal(periodsOf(resolvePricing(resolved)["deepseek-v4-flash"], LEGACY_PRICING["deepseek-v4-flash"]).offpeak.input, 1, "the preserved pricing table must still override");

// ---- legacy settings document rescue -------------------------------------
// DSH 0.2.0 imported the removed `settings.yaml` sections keyed by entry id,
// but skipped ours while the bundle was refused for incompatible peers. The
// scan is deliberately narrow: one top-level section, one scalar.
const legacyDocument = [
	"ui-theme:",
	"  preference: light",
	"session-cost:",
	"  displayMode: stats",
	"  lowBalanceThreshold: 5",
	"token-heatmap:",
	"  lowBalanceThreshold: 99"
].join("\n");
assert.equal(legacySettingFromDocument(legacyDocument, "session-cost", "lowBalanceThreshold"), 5, "the section value must be read");
assert.equal(legacySettingFromDocument(legacyDocument, "token-heatmap", "lowBalanceThreshold"), 99, "another section must not bleed in");
assert.equal(legacySettingFromDocument(legacyDocument, "session-cost", "missing"), null, "an absent field reads null");
assert.equal(legacySettingFromDocument("session-cost:\n  lowBalanceThreshold: -3", "session-cost", "lowBalanceThreshold"), null, "negative values are ignored");
assert.equal(legacySettingFromDocument("session-cost:\n  lowBalanceThreshold: \"7.5\" # keep", "session-cost", "lowBalanceThreshold"), 7.5, "quotes and inline comments are tolerated");
assert.equal(legacySettingFromDocument(null, "session-cost", "lowBalanceThreshold"), null, "a missing document reads null");
assert.equal(legacySettingFromDocument("  session-cost:\n    lowBalanceThreshold: 5", "session-cost", "lowBalanceThreshold"), null, "an indented section is not the top-level one");
// Nested sections and other keys must not be mistaken for ours: the scan stops
// at the next top-level key.
assert.equal(legacySettingFromDocument("session-cost:\n  displayMode: stats\nother:\n  lowBalanceThreshold: 3", "session-cost", "lowBalanceThreshold"), null, "the scan must stop at the next section");
assert.equal(dshHomeDirectory({ DSH_HOME: "  C:/custom-home  " }), "C:/custom-home", "DSH_HOME wins and is trimmed");
assert.equal(dshHomeDirectory({ DSH_HOME: "   " }), join(homedir(), ".dsh"), "a blank DSH_HOME falls back to the home directory");
assert.equal(dshHomeDirectory({}), join(homedir(), ".dsh"), "without DSH_HOME the home directory is used");

// ---- the plugin body against a fake host --------------------------------
// DSH 0.2.0 dropped `settings.register(ns, schema)` (the Config export is the
// form now) and dropped `settings.get(ns)` (entries ARE the namespaces), so the
// body must register its two routes and nothing else on the settings service.
const routes = [];
const settingsCalls = [];
const fakeCtx = {
	root: {},
	logger: { info: () => {}, warn: () => {} },
	effect: (fn) => { fn(); return () => {}; },
	get: (key) => (key === "settings" ? { describe: () => { settingsCalls.push("describe"); return []; }, update: () => { settingsCalls.push("update"); return Promise.resolve(); } } : void 0),
	webServer: { register: (route) => { routes.push(route); return () => {}; } }
};
apply(fakeCtx, {});
assert.deepEqual(routes.map((route) => [route.kind, route.path]), [
	["exact", "/api/session-cost/summary"],
	["exact", "/api/session-cost/balance"]
], "the body must register exactly the two exact routes");
assert.equal(typeof routes[0].handler, "function", "each route must own a handler");
assert.deepEqual(settingsCalls, [], "a host without a legacy document must not touch the settings service");

// ---- the resolver path over a fake sessions service ---------------------
// `foldSessionCost` is the only reader of the session log; 0.2.0 kept both
// `sessions.list()` and `session.seq` / `session.eventAt(seq)`. The event shape
// is the one session-shape-smoke pins in detail; here it only has to prove the
// service seam still resolves and prices.
const foldNow = Date.now();
const foldEvents = [
	{ seq: 1, time: foldNow, type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-flash" } } } },
	{ seq: 2, time: foldNow, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-flash" } }, usage: { inputTokens: 2000, outputTokens: 800, cacheReadTokens: 0 } } }
];
const fakeSession = { id: "s-1", seq: foldEvents.length, eventAt: (n) => foldEvents[n] };
const folded = foldSessionCost({ list: () => [fakeSession] }, "s-1", resolvePricing(undefined));
assert.ok(folded !== null && folded.models.length === 1, "the fold must resolve one model");
assert.equal(folded.tokens.inputTokens, 2000, "the usage sample must be read through eventAt");
assert.ok(folded.cost > 0, "a priced model must bill above zero");
assert.equal(foldSessionCost({ list: () => [] }, "missing", resolvePricing(undefined)), null, "an unknown session folds to null");

// ---- resolvePricing: flat and per-period override shapes -----------------
// Defaults are untouched by an absent config (current V4.1-Flash rates).
const defaults = resolvePricing(undefined);
assert.equal(defaults["deepseek-v4-flash"].offpeak.input, 1, "default off-peak flash input ¥1");
assert.equal(defaults["deepseek-v4-flash"].peak.output, 8, "default peak flash output ¥8");
assert.equal(defaults["deepseek-flash"].offpeak.cacheRead, 0.02, "the 0.1.5 short id is priced too");
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
assert.equal(perPeriod["deepseek-v4-flash"].peak.cacheRead, 0.04, "untouched peak cacheRead inherits the default");
assert.equal(perPeriod["deepseek-v4-flash"].offpeak.cacheWrite, 1, "untouched off-peak cacheWrite inherits the default");
// Invalid entries fall back, negatives rejected, unknown keys still merged.
const sanitized = resolvePricing({ pricing: { "deepseek-v4-flash": { input: -5 }, junk: { input: 1 } } });
assert.equal(periodsOf(sanitized["deepseek-v4-flash"], LEGACY_PRICING["deepseek-v4-flash"]).offpeak.input, 1, "negative override falls back to the default");
assert.equal(sanitized.junk.input, 1, "unknown model keys keep the legacy merge behavior");

console.log("settings schema contract smoke passed");
