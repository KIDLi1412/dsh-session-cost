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
 * The endpoints live under the `/api` prefix as exact routes, so they win
 * over the connection plugin's `/api` prefix handler; each handler applies
 * its own peer-socket loopback fence (the exact routes bypass the RPC trust
 * fence); Host is checked only as an additional defense.
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
 * The plugin also registers its own `session-cost` settings namespace
 * (lowBalanceThreshold). Registering it makes the Host serve
 * that section, which is what the official 设置 → 插件 → 插件配置 tab
 * dispatches on: the client card keyed `session-cost` only renders while the
 * namespace is served.
 *
 * @module dsh-session-cost
 */

import { applyUsageDelta, computeCost, createCostState, DEFAULT_PRICING } from "./cost.js";
import { balanceStatusOf, queryDeepSeekBalance } from "./balance.js";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "session-cost";

/** Services required before this plugin activates. */
const inject = ["webServer", "sessions", "credentials", "settings"];

//#region settings namespace
/**
 * Settings namespace owned by this plugin. Registering it makes the Host
 * serve a `session-cost` section (resolved from schema defaults, then any
 * composition `base`, then the user settings.yaml layer), which is exactly
 * what the official 设置 → 插件 → 插件配置 tab dispatches on: it renders the
 * card registered into `settings.plugin.item` whose `key` matches a served
 * namespace. The same section may keep unknown keys (e.g. the documented
 * `pricing` override) — schemastery preserves them, and the server still
 * reads pricing from the cordis plugin config, so the two coexist.
 */
const SETTINGS_NAMESPACE = settingsNamespace("session-cost");

/** Durable display preferences; also the wire envelope the browser scope validates against. */
const SessionCostSettingsSchema = z.object({
	lowBalanceThreshold: z.number().min(0).default(10)
});
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
	const count = session.events.length;
	if ((state.consumed ?? 0) < count) {
		applyUsageDelta(state, session.events.slice(state.consumed ?? 0));
		state.consumed = count;
	}
	costStates.set(sessionId, state);
	return computeCost(state, pricing);
}
//#endregion

//#region balance
/** Coerce a numeric value (number or numeric string, e.g. DeepSeek's "7.09") to a number, or undefined. */
function numOf(value) {
	if (value === null || value === void 0) return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : void 0;
}

/** Resolve the DeepSeek connection facts from harness settings + credentials. */
async function deepseekFacts(ctx) {
	const settings = ctx.get("settings");
	const deepseek = settings?.get?.("llm-deepseek");
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
 * Plugin body: register the summary and balance routes plus the settings
 * namespace that backs the plugin configuration card (设置 → 插件 → 插件配置).
 * @param ctx - plugin context carrying webServer, sessions, credentials, and settings.
 * @param rawConfig - optional plugin config; `pricing` overrides the default table.
 */
function apply(ctx, rawConfig = {}) {
	const pricing = resolvePricing(rawConfig);
	// The registration is fiber-bound: disposing this plugin removes the
	// namespace and its observers. `settings` is a hard dependency (inject),
	// so ctx.settings is available here unconditionally.
	ctx.settings.register(SETTINGS_NAMESPACE, SessionCostSettingsSchema);
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
}

export { apply, inject, name, SUMMARY_PATH, BALANCE_PATH, foldSessionCost, resolvePricing, SETTINGS_NAMESPACE, SessionCostSettingsSchema };
