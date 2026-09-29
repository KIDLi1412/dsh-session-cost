/**
 * dsh-session-cost — server half.
 *
 * Registers two loopback-only endpoints on the web server:
 *   GET /api/session-cost/summary?session=<id> — estimated cost of one LIVE
 *       session: per-model token buckets (folded from the session event log
 *       with the same replace-last-sample semantics as dsh-token-meter's
 *       `tokenUsage` projection) priced against the CNY table in ./cost.js.
 *   GET /api/session-cost/balance — the DeepSeek account balance queried
 *       through the provider's own balance API (`GET {baseURL}/user/balance`)
 *       with a short in-memory cache (2 minutes) and single-flight guard.
 *
 * The endpoints live under the `/api` prefix as exact routes; each handler
 * applies its own peer-socket loopback fence, and DSH 0.2.0 additionally
 * requires its own browser-session cookie for every request, so an
 * unauthenticated caller never reaches them at all.
 *
 * The per-session cost fold is INCREMENTAL: each session's fold state is
 * cached in memory keyed by session id, and only the events added since the
 * last fold are processed on every request, so steady-state cost stays
 * O(new events) no matter how large the session log grows.
 *
 * Provider configuration is read straight from the harness settings
 * (`llm-deepseek` namespace), and the API key is resolved through the
 * credentials seam at request time — nothing is stored by this plugin.
 *
 * DSH 0.2.0 replaced the plugin-owned settings namespace with schema-derived
 * plugin CONFIG: a plugin exports its `Config`, the Loader keys the resulting
 * form by the profile entry id (our bundle row is `session-cost`), and the
 * browser edits it through `ctx.configForms.get("session-cost")`. The old
 * `settings.yaml` sections were imported per entry id by DSH itself — except
 * ours, which was not mounted at that moment (incompatible peers), so this
 * half also carries a one-time rescue of that value.
 *
 * @module dsh-session-cost
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyUsageDelta, computeCost, createCostState, DEFAULT_PRICING } from "./cost.js";
import { balanceStatusOf, queryDeepSeekBalance } from "./balance.js";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "session-cost";

/** Services required before this plugin activates. */
const inject = ["webServer", "sessions", "credentials", "settings"];

//#region plugin config
/**
 * Profile entry id this plugin's form is keyed by: the `id` of the row our
 * bundle patch inserts, which is also what `ctx.configForms.get(...)` asks for
 * on the client. DSH 0.2.0 derives the settings form from this schema, so the
 * field is editable (and durable) without any registration call.
 */
const SETTINGS_NAMESPACE = "session-cost";

/**
 * Configurable fields of this plugin. `lowBalanceThreshold` (CNY) colors the
 * balance readings red below it; `pricing` stays undeclared on purpose —
 * schemastery preserves unknown keys, and the override table is read leniently
 * from the raw config by `resolvePricing`, so a user table of any shape keeps
 * working without being frozen into this schema.
 */
const Config = z.object({
	lowBalanceThreshold: z.number().min(0).default(10)
});
/** @deprecated 0.1.x name; the schema IS the config now. Kept for old importers. */
const SessionCostSettingsSchema = Config;
//#endregion

//#region legacy settings document
/** DSH home resolution, mirroring `@deepseek-ai/dsh-home-paths` (no extra peer). */
function dshHomeDirectory(env = process.env) {
	const configured = env.DSH_HOME;
	if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
	return join(homedir(), ".dsh");
}

/**
 * Best-effort read of one scalar out of the pre-0.2.0 `settings.yaml` section
 * for this entry. DSH's own importer moves those sections into the profile
 * once, keyed by entry id — and skipped ours while the bundle was refused for
 * incompatible peers, leaving the value only in the renamed document. This is
 * a deliberately narrow scan (one top-level section, one scalar) rather than a
 * YAML dependency: anything it cannot read is simply left for the user.
 * @param text - contents of `settings.yaml` or `settings.yaml.imported`.
 * @param section - top-level section name (`session-cost`).
 * @param field - scalar key inside it (`lowBalanceThreshold`).
 * @returns the finite non-negative number, or null.
 */
function legacySettingFromDocument(text, section, field) {
	if (typeof text !== "string") return null;
	const lines = text.split(/\r?\n/);
	const inSection = /^[^\s#][^:]*:/;
	let inside = false;
	for (const line of lines) {
		if (inSection.test(line)) {
			inside = line.trim() === `${section}:` && !line.startsWith(" ");
			continue;
		}
		if (!inside) continue;
		const match = /^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
		if (match === null || match[1] !== field) continue;
		const raw = match[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
		const value = Number(raw);
		return Number.isFinite(value) && value >= 0 ? value : null;
	}
	return null;
}

/** Files the legacy value may still live in, newest name first. */
const LEGACY_THRESHOLD_FILES = ["settings.yaml.imported", "settings.yaml"];

/**
 * One-time rescue of the threshold from the removed settings document.
 *
 * Only runs when the entry has no user-set value yet (`describe()` reports the
 * raw user layer), and only for a non-default number — a plugin that never
 * touched the setting keeps inheriting the schema default. Failures are
 * logged and ignored: this is a convenience, never a boot dependency.
 * @param ctx - plugin context carrying the settings service.
 */
async function rescueLegacyThreshold(ctx) {
	try {
		const descriptors = ctx.settings.describe();
		const entry = descriptors.find((row) => row.ns === SETTINGS_NAMESPACE);
		if (entry === void 0) return;
		const user = entry.user;
		if (user !== null && typeof user === "object" && Object.hasOwn(user, "lowBalanceThreshold")) return;
		const home = dshHomeDirectory();
		let legacy = null;
		for (const file of LEGACY_THRESHOLD_FILES) {
			try {
				legacy = legacySettingFromDocument(readFileSync(join(home, file), "utf8"), SETTINGS_NAMESPACE, "lowBalanceThreshold");
			} catch {
				continue;
			}
			if (legacy !== null) break;
		}
		if (legacy === null || legacy === Config({}).lowBalanceThreshold) return;
		await ctx.settings.update(SETTINGS_NAMESPACE, { lowBalanceThreshold: legacy });
		ctx.logger.info(`session-cost: carried lowBalanceThreshold=${legacy} over from the removed settings.yaml`);
	} catch (error) {
		ctx.logger.warn(`session-cost: legacy threshold rescue skipped: ${String(error)}`);
	}
}
//#endregion

const SUMMARY_PATH = "/api/session-cost/summary";
const BALANCE_PATH = "/api/session-cost/balance";
const BALANCE_TTL_MS = 2 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 15000;

/** Default DeepSeek connection facts when the settings namespace is absent. */
const DEEPSEEK_DEFAULTS = {
	apiKeyEnv: "DEEPSEEK_API_KEY",
	baseURL: "https://api.deepseek.com"
};

/** Write a JSON response. */
function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(body);
}

/**
 * Loopback fence, primary on the PEER SOCKET address (not the
 * client-controllable Host header): the request must come from a loopback
 * interface. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized. The Host
 * header is kept as an additional check, never as the deciding one.
 */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const a = address.toLowerCase();
	if (a === "::1") return true;
	const ipv4 = a.startsWith("::ffff:") ? a.slice(7) : a;
	const octets = ipv4.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
	if (typeof value !== "string") return null;
	const host = value.trim().toLowerCase();
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close <= 1) return null;
		const suffix = host.slice(close + 1);
		if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
		return host.slice(1, close);
	}
	const firstColon = host.indexOf(":");
	const lastColon = host.lastIndexOf(":");
	if (firstColon !== lastColon) return host;
	if (lastColon === -1) return host.replace(/\.$/, "");
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
	return host.slice(0, lastColon).replace(/\.$/, "");
}

function isLoopbackHostHeader(req) {
	const hostName = hostNameOf(req.headers.host);
	return hostName === "localhost" || isLoopbackAddress(hostName);
}

/** Refuse non-loopback callers and non-GET methods before any work. */
function rejectForeignCaller(req, res) {
	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	const peer = req.socket?.remoteAddress;
	if (isLoopbackAddress(peer) && isLoopbackHostHeader(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

//#region per-session cost fold
/** In-memory per-session fold states keyed by session id. */
const costStates = new Map();

/**
 * Enumerate a live session's events from an offset, across session shapes.
 *
 * Pre-0.1.2 sessions kept the whole log on the object as `.events`; DSH
 * 0.1.2+ (rc.1) live sessions expose no `.events` array — the count is
 * `session.seq` and each event is read via `session.eventAt(seq)` (0-based,
 * the same reads @deepseek-ai/dsh-token-meter uses).
 * @returns `{ count, events }` — `count` the session's total event count,
 *   `events` the events from `from` onward.
 */
function liveSessionEvents(session, from) {
	if (Array.isArray(session.events)) {
		return { count: session.events.length, events: session.events.slice(from) };
	}
	if (typeof session.seq !== "number" || typeof session.eventAt !== "function") {
		return { count: 0, events: [] };
	}
	const events = [];
	for (let seq = from; seq < session.seq; seq += 1) {
		const event = session.eventAt(seq);
		if (event !== void 0) events.push(event);
	}
	return { count: session.seq, events };
}

/**
 * Fold the events added since the last fold for one live session and return
 * the per-model cost breakdown. Sessions not in the live registry (closed,
 * or never seen by this process) produce null.
 * @param sessions - the harness "sessions" service.
 * @param sessionId - session id to compute.
 * @param pricing - pricing table.
 */
function foldSessionCost(sessions, sessionId, pricing) {
	if (sessions === void 0 || sessions === null) return null;
	let session = null;
	for (const candidate of sessions.list()) {
		if (candidate.id === sessionId) {
			session = candidate;
			break;
		}
	}
	if (session === null) return null;
	const state = costStates.get(sessionId) ?? createCostState();
	const { count, events } = liveSessionEvents(session, state.consumed ?? 0);
	if ((state.consumed ?? 0) < count) {
		applyUsageDelta(state, events);
		state.consumed = count;
	}
	costStates.set(sessionId, state);
	const cost = computeCost(state, pricing);
	// Diagnostics for the "cost is stuck at ¥0" class of report: a zero total
	// is either "no usage sample was recognized in this session's events" or
	// "samples were recognized but no pricing entry matched their model", and
	// the two look identical in the UI. `priced` is the number of models that
	// resolved a rate; `eventTypes` (only populated while nothing is priced)
	// then says whether the expected event types are even present.
	cost.diagnostics = {
		events: count,
		samples: state.models.size,
		priced: cost.models.filter((row) => row.price !== null && row.price !== void 0).length,
		models: cost.models.map((row) => row.model)
	};
	if (cost.diagnostics.priced === 0 && count > 0) {
		const types = new Map();
		for (const event of liveSessionEvents(session, 0).events) {
			const type = typeof event?.type === "string" ? event.type : "(no type)";
			types.set(type, (types.get(type) ?? 0) + 1);
		}
		cost.diagnostics.eventTypes = [...types.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 12)
			.map(([type, n]) => `${type}=${n}`);
	}
	return cost;
}
//#endregion

//#region balance
/** Coerce a numeric value (number or numeric string, e.g. DeepSeek's "7.09") to a number, or undefined. */
function numOf(value) {
	if (value === null || value === void 0) return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : void 0;
}

/**
 * One profile entry's resolved config section, read through the settings
 * service. DSH 0.2.0 dropped the old `settings.get(ns)` accessor — a plugin's
 * settings ARE its profile entry config now — so this reads the same
 * `describe()` view the settings UI renders. Secrets come back redacted only
 * when the caller asks for redaction, which we never do; the values we read
 * here are an env-var reference and a base URL, never a key.
 * @param ctx - plugin context.
 * @param entryId - profile entry id (e.g. `llm-deepseek`).
 * @returns the resolved section, or undefined when the entry is absent.
 */
function entryConfig(ctx, entryId) {
	const settings = ctx.get("settings");
	if (settings === null || settings === void 0 || typeof settings.describe !== "function") return void 0;
	try {
		const descriptor = settings.describe().find((row) => row.ns === entryId);
		const value = descriptor?.value;
		return value !== null && typeof value === "object" ? value : void 0;
	} catch {
		return void 0;
	}
}

/** Resolve the DeepSeek connection facts from harness settings + credentials. */
async function deepseekFacts(ctx) {
	const deepseek = entryConfig(ctx, "llm-deepseek");
	const apiKeyEnv = typeof deepseek?.apiKeyEnv === "string" && deepseek.apiKeyEnv.length > 0
		? deepseek.apiKeyEnv
		: DEEPSEEK_DEFAULTS.apiKeyEnv;
	const baseURL = typeof deepseek?.baseURL === "string" && deepseek.baseURL.length > 0
		? deepseek.baseURL
		: DEEPSEEK_DEFAULTS.baseURL;
	const credentials = ctx.get("credentials");
	let apiKey = "";
	if (credentials !== void 0 && credentials !== null && typeof credentials.resolve === "function") {
		try {
			const hit = await credentials.resolve(apiKeyEnv);
			apiKey = typeof hit?.value === "string" && hit.value.length > 0 ? hit.value : "";
		} catch {
			apiKey = "";
		}
	}
	return { baseURL, apiKey, apiKeyEnv };
}

let balanceCache = null;
let balanceInflight = null;

/**
 * Query the DeepSeek balance with a short TTL cache and single-flight guard.
 * `force=true` skips the TTL cache so a manual refresh always hits upstream
 * (single-flight still coalesces concurrent requests).
 */
function fetchBalance(ctx, force = false) {
	if (!force && balanceCache !== null && Date.now() - balanceCache.fetchedAt < BALANCE_TTL_MS) return Promise.resolve(balanceCache);
	if (balanceInflight !== null) return balanceInflight;
	balanceInflight = (async () => {
		const facts = await deepseekFacts(ctx);
		if (facts.apiKey === "") {
			return {
				ok: false,
				error: "no-credential",
				message: facts.apiKeyEnv,
				fetchedAt: Date.now()
			};
		}
		try {
			const raw = await queryDeepSeekBalance({
				baseURL: facts.baseURL,
				apiKey: facts.apiKey,
				timeoutMs: UPSTREAM_TIMEOUT_MS
			});
			balanceCache = {
				ok: true,
				balance: {
					isAvailable: raw.isAvailable === true,
					currency: raw.currency,
					total: numOf(raw.total),
					granted: numOf(raw.granted),
					toppedUp: numOf(raw.toppedUp)
				},
				fetchedAt: Date.now()
			};
			return balanceCache;
		} catch (error) {
			ctx.logger.warn(`session-cost: balance fetch failed: ${String(error)}`);
			return {
				ok: false,
				error: balanceStatusOf(error),
				message: error instanceof Error ? error.message : String(error),
				fetchedAt: Date.now()
			};
		}
	})().finally(() => {
		balanceInflight = null;
	});
	return balanceInflight;
}
//#endregion

async function handleSummary(ctx, req, res, pricing) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const sessionId = url.searchParams.get("session");
		if (sessionId === null || sessionId === "") {
			json(res, 400, { ok: false, error: "missing-session", message: "?session=<id> is required" });
			return;
		}
		const result = foldSessionCost(ctx.get("sessions"), sessionId, pricing);
		if (result === null) {
			json(res, 404, { ok: false, error: "unknown-session", message: `session "${sessionId}" is not live` });
			return;
		}
		json(res, 200, {
			ok: true,
			sessionId,
			currency: "CNY",
			estimated: true,
			updatedAt: Date.now(),
			...result
		});
	} catch (error) {
		ctx.logger.warn(`session-cost: summary failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

async function handleBalance(ctx, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const force = url.searchParams.get("refresh") === "1";
		const result = await fetchBalance(ctx, force);
		if (result.ok === true) {
			json(res, 200, result);
		} else if (result.error === "no-credential") {
			json(res, 200, { ok: false, error: "no-credential", message: result.message, fetchedAt: result.fetchedAt });
		} else {
			json(res, 502, { ok: false, error: result.error, message: result.message, fetchedAt: result.fetchedAt });
		}
	} catch (error) {
		ctx.logger.warn(`session-cost: balance handler failed: ${String(error)}`);
		json(res, 502, { ok: false, error: "failed", message: error instanceof Error ? error.message : String(error) });
	}
}

/** Lenient merge of optional plugin-config pricing over the defaults. */
function resolvePricing(rawConfig) {
	const overrides = rawConfig?.pricing;
	if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) return { ...DEFAULT_PRICING };
	const merged = { ...DEFAULT_PRICING };
	const numeric = (value, fallback) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
	const sanitize = (entry, base) => {
		const b = base ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
		return {
			input: numeric(entry.input, b.input),
			cacheRead: numeric(entry.cacheRead, b.cacheRead),
			cacheWrite: numeric(entry.cacheWrite, b.cacheWrite),
			output: numeric(entry.output, b.output)
		};
	};
	for (const [key, entry] of Object.entries(overrides)) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const base = merged[key];
		const baseOffpeak = base?.offpeak ?? base ?? null;
		if (entry.offpeak !== null && typeof entry.offpeak === "object" && !Array.isArray(entry.offpeak)
			&& entry.peak !== null && typeof entry.peak === "object" && !Array.isArray(entry.peak)) {
			// Per-period override: distinct 空闲/高峰 rates.
			merged[key] = {
				offpeak: sanitize(entry.offpeak, baseOffpeak),
				peak: sanitize(entry.peak, base?.peak ?? baseOffpeak)
			};
		} else {
			// Flat override: one rate applied to every period (legacy too).
			merged[key] = sanitize(entry, baseOffpeak);
		}
	}
	return merged;
}

/**
 * Plugin body: register the summary and balance routes, then rescue a
 * threshold the removed settings document still holds. DSH 0.2.0 needs no
 * namespace registration — the exported `Config` is the form — so nothing here
 * touches the settings document beyond that one-time rescue.
 * @param ctx - plugin context carrying webServer, sessions, credentials, and settings.
 * @param rawConfig - resolved plugin config; `pricing` overrides the default table.
 */
function apply(ctx, rawConfig = {}) {
	const pricing = resolvePricing(rawConfig);
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: SUMMARY_PATH,
		handler: (req, res) => handleSummary(ctx, req, res, pricing)
	}), "session-cost: summary route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: BALANCE_PATH,
		handler: (req, res) => handleBalance(ctx, req, res)
	}), "session-cost: balance route");
	// Fire-and-forget: the rescue only writes when the entry has no user value
	// and the removed document still holds a non-default one, and it never
	// blocks activation. DSH's own importer waited for the Loader to settle, so
	// this waits too when the Loader exposes that promise.
	const loader = ctx.root?.loader;
	const settled = typeof loader?.await === "function" ? Promise.resolve(loader.await()).catch(() => void 0) : Promise.resolve();
	settled.then(() => rescueLegacyThreshold(ctx)).catch(() => void 0);
}

export {
	apply,
	inject,
	name,
	Config,
	SUMMARY_PATH,
	BALANCE_PATH,
	foldSessionCost,
	resolvePricing,
	SETTINGS_NAMESPACE,
	SessionCostSettingsSchema,
	dshHomeDirectory,
	legacySettingFromDocument,
	rescueLegacyThreshold
};
