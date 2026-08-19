/**
 * dsh-session-cost — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step): registers into the
 * conversation `composer.dock` list slot (the status strip at the BOTTOM of
 * the conversation, right below the built-in stats line) and renders a slim
 * status bar with:
 *   - the ESTIMATED cost of the current session (本会话费用 ¥X.XXXX), computed
 *     server-side per model from the live session event log and priced in CNY
 *     against the table in ./cost.js;
 *   - the LIVE DeepSeek account balance (余额 ¥Y.YY), queried through the
 *     provider's balance API by the server half.
 *
 * Data comes from the server half's loopback-only endpoints via same-origin
 * fetch. The cost summary refreshes whenever the client-side `tokenUsage`
 * projection changes (debounced) and every 30 s while the bar is mounted;
 * the balance refreshes every 5 minutes and on demand via the ⟳ button.
 * Hovering the bar shows the per-model breakdown (model · in/out tokens ·
 * cost) plus the balance split (充值/赠送) and the last-updated time.
 */
window.__ModuleLoader__.load({
	id: "@kidli1412/dsh-session-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region css
		const css = [
			".sco_row{box-sizing:border-box;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;align-items:center;gap:2px 14px;padding:2px 0 6px;font-size:11px;line-height:16px;display:flex;font-variant-numeric:tabular-nums}",
			".sco_item{align-items:center;gap:4px;display:inline-flex;min-width:0}",
			".sco_item[data-warn=true]{color:var(--dsw-alias-state-error-primary)}",
			".sco_item[data-warn=true] .sco_balance,.sco_item[data-warn=true] .sco_unknown{color:inherit}",
			".sco_cost{color:var(--dsw-alias-label-primary);font-weight:600}",
			".sco_balance{color:var(--dsw-alias-label-primary);font-weight:600}",
			".sco_unknown{color:var(--dsw-alias-label-tertiary)}",
			".sco_updated{color:var(--dsw-alias-state-success-primary);font-size:10px;line-height:14px;margin-right:2px}",
			".sco_btn{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:6px;width:18px;height:18px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex;font-size:12px;line-height:1}",
			".sco_btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".sco_btn:disabled{opacity:.45;cursor:default}",
			".sco_btn[data-spin=true] svg{animation:sco_spin 0.8s linear infinite}",
			"@keyframes sco_spin{to{transform:rotate(360deg)}}",
			".sco_error{color:var(--dsw-alias-state-error-primary)}",
			// Stats-line merge mode (appended into the built-in stats row).
			".sco_anchor{display:none}",
			".sco_merge{display:inline-flex;align-items:center;vertical-align:baseline;gap:2px;margin-left:4px;white-space:nowrap}",
			".sco_mergeSep{color:var(--dsw-alias-separator-primary);margin:0 10px;display:inline-block}",
			".sco_mergeVal{color:var(--dsw-alias-label-primary);font-weight:600}",
			".sco_mergeVal[data-warn=true]{color:var(--dsw-alias-state-error-primary)}",
			".sco_mergeBtn{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:4px;width:14px;height:14px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex;vertical-align:middle;font-size:10px;line-height:1}",
			".sco_mergeBtn:hover{color:var(--dsw-alias-label-primary)}",
			".sco_mergeBtn:disabled{opacity:.45;cursor:default}",
			".sco_mergeBtn[data-spin=true] svg{animation:sco_spin 0.8s linear infinite}",
			// Settings card (设置 → 插件 → 插件配置), disclosure chrome like the
			// official plugin cards.
			".sco_settings{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
			".sco_settings:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".sco_settingsOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".sco_settingsHeader{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".sco_settingsHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
			".sco_settingsHeadText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			".sco_settingsName{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
			".sco_settingsDesc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}",
			".sco_settingsChevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
			".sco_settingsChevronOpen{transform:rotate(180deg)}",
			".sco_settingsBody{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:12px}",
			".sco_settingsField{display:flex;flex-direction:column;gap:6px}",
			".sco_settingsLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}",
			".sco_settingsOptions{display:flex;flex-wrap:wrap;gap:8px}",
			".sco_settingsOption{appearance:none;font:inherit;cursor:pointer;text-align:left;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:10px;padding:8px 12px;display:flex;flex-direction:column}",
			".sco_settingsOption:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
			".sco_settingsOption[data-active=true]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary) inset}",
			".sco_settingsOptionName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}",
			".sco_settingsOptionHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0;max-width:280px}",
			".sco_settingsThresholdRow{align-items:center;gap:8px;display:flex}",
			".sco_settingsInput{box-sizing:border-box;width:96px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 8px;font:inherit;font-size:13px;line-height:1.5;font-variant-numeric:tabular-nums}",
			".sco_settingsUnit{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}"
		].join("");
		const tagId = "@kidli1412/dsh-session-cost/SessionCost.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@kidli1412/dsh-session-cost";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const S = {
			row: "sco_row",
			item: "sco_item",
			cost: "sco_cost",
			balance: "sco_balance",
			unknown: "sco_unknown",
			updated: "sco_updated",
			btn: "sco_btn",
			error: "sco_error",
			anchor: "sco_anchor",
			merge: "sco_merge",
			mergeSep: "sco_mergeSep",
			mergeVal: "sco_mergeVal",
			mergeBtn: "sco_mergeBtn",
			settings: "sco_settings",
			settingsOpen: "sco_settingsOpen",
			settingsHeader: "sco_settingsHeader",
			settingsHeadText: "sco_settingsHeadText",
			settingsName: "sco_settingsName",
			settingsDesc: "sco_settingsDesc",
			settingsChevron: "sco_settingsChevron",
			settingsChevronOpen: "sco_settingsChevronOpen",
			settingsBody: "sco_settingsBody",
			settingsField: "sco_settingsField",
			settingsLabel: "sco_settingsLabel",
			settingsOptions: "sco_settingsOptions",
			settingsOption: "sco_settingsOption",
			settingsOptionName: "sco_settingsOptionName",
			settingsOptionHint: "sco_settingsOptionHint",
			settingsThresholdRow: "sco_settingsThresholdRow",
			settingsInput: "sco_settingsInput",
			settingsUnit: "sco_settingsUnit"
		};
		//#endregion

		//#region locale
		/** Locale namespace and dictionaries. */
		const NS = "sessionCost";
		const zh = {
			cost: "本会话费用",
			balance: "余额",
			refresh: "刷新",
			refreshing: "刷新中…",
			updated: "已更新 {time}",
			loading: "加载中…",
			unavailable: "暂不可用",
			noCredential: "未配置 {ref}",
			retry: "重试",
			tooltipCost: "本会话费用估算",
			tooltipBalance: "账户余额",
			tooltipModel: "模型",
			tooltipInput: "输入",
			tooltipOutput: "输出",
			tooltipTokens: "tokens",
			tooltipCostTotal: "费用合计",
			tooltipToppedUp: "充值余额",
			tooltipGranted: "赠送余额",
			tooltipTotal: "总余额",
			tooltipUpdated: "更新于 {time}",
			tooltipPeak: "高峰",
			tooltipOffpeak: "空闲",
			tooltipLegacy: "旧价",
			tooltipPricingNote: "费用为估算值：token 用量来自会话日志，单价见官方定价页（2026-08-17 起峰谷计价：高峰为北京时间 9:00–12:00、14:00–18:00，价格为空闲时段的 2 倍；deepseek-v4-flash 输入 ¥1.5–3.0/百万、缓存命中 ¥0.05–0.10/百万、输出 ¥4.5–9.0/百万）。",
			tooltipNoModels: "暂无 token 用量",
			currencySymbol: "¥",
			settingsTitle: "会话费用显示",
			settingsDescription: "费用估算与账户余额的显示位置，可切换两种方式。",
			settingsMode: "显示方式",
			settingsDock: "独立状态栏",
			settingsDockHint: "在统计栏下方单独显示一行「本会话费用 · 余额」（当前默认）。",
			settingsStats: "并入统计栏",
			settingsStatsHint: "追加到统计栏同一行，与轮次/时长/token 统计并列；会话尚无统计内容时暂不显示。",
			settingsApplied: "设置即时生效。",
			settingsThreshold: "低余额阈值",
			settingsThresholdHint: "余额低于该值时显示为红色，否则为黑色。",
			settingsThresholdUnit: "元",
			settingsExpand: "展开设置",
			settingsCollapse: "收起设置"
		};
		const en = {
			cost: "This session",
			balance: "Balance",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			updated: "Updated {time}",
			loading: "Loading…",
			unavailable: "Unavailable",
			noCredential: "{ref} not configured",
			retry: "Retry",
			tooltipCost: "Estimated cost of this session",
			tooltipBalance: "Account balance",
			tooltipModel: "Model",
			tooltipInput: "Input",
			tooltipOutput: "Output",
			tooltipTokens: "tokens",
			tooltipCostTotal: "Total cost",
			tooltipToppedUp: "Topped up",
			tooltipGranted: "Granted",
			tooltipTotal: "Total",
			tooltipUpdated: "Updated at {time}",
			tooltipPeak: "Peak",
			tooltipOffpeak: "Off-peak",
			tooltipLegacy: "Legacy",
			tooltipPricingNote: "Cost is an estimate: token usage comes from the session log; unit prices follow the official pricing page (peak/off-peak billing since 2026-08-17: peak = Beijing 09:00–12:00 / 14:00–18:00 at 2× the off-peak rate; deepseek-v4-flash input ¥1.5–3.0/M, cache hit ¥0.05–0.10/M, output ¥4.5–9.0/M).",
			tooltipNoModels: "No token usage yet",
			currencySymbol: "¥",
			settingsTitle: "Session cost display",
			settingsDescription: "Where the cost estimate and account balance appear; two display modes.",
			settingsMode: "Display mode",
			settingsDock: "Standalone bar",
			settingsDockHint: "A separate row below the stats line: cost · balance (current default).",
			settingsStats: "In the stats line",
			settingsStatsHint: "Appended to the stats line, next to turns/duration/token stats; hidden until the session has stats.",
			settingsApplied: "Changes apply immediately.",
			settingsThreshold: "Low balance threshold",
			settingsThresholdHint: "Balance below this amount renders red; otherwise black.",
			settingsThresholdUnit: "CNY",
			settingsExpand: "Show settings",
			settingsCollapse: "Hide settings"
		};
		//#endregion

		//#region helpers
		/** Locale-safe template interpolation: `t("key", {a})` replaces `{a}`. */
		function interpolate(template, params) {
			if (params === void 0) return template;
			return template.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(params, key) ? String(params[key]) : match));
		}

		/** Group thousands. */
		function fmt(n) {
			return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		/** CNY amount: up to 4 decimals for tiny costs, 2 for balances. */
		function fmtCny(value, maxDecimals) {
			if (value === null || value === void 0 || !Number.isFinite(Number(value))) return "—";
			const n = Number(value);
			const decimals = maxDecimals === 4 && n < 1 ? 4 : 2;
			return n.toFixed(decimals).replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
		}

		/** Coerce an amount (number or numeric string) to a number, or null. */
		function numOrNull(value) {
			if (value === null || value === void 0) return null;
			const n = Number(value);
			return Number.isFinite(n) ? n : null;
		}

		/** Per-request staleness guard: only the most recent start may `isCurrent()`. */
		function createLoader() {
			let current = 0;
			return {
				start: () => ++current,
				isCurrent: (id) => id === current
			};
		}

		/**
		 * One hover-title model line: `model · 输入 X tokens · 输出 Y tokens ·
		 * ¥Z`, with a peak/off-peak/legacy cost split appended when a session
		 * spans more than one billing period (峰谷).
		 */
		function modelTooltipLine(dict, row) {
			const label = row.model.includes("/") ? row.model.slice(row.model.indexOf("/") + 1) : row.model;
			let line = `  ${label} · ${dict("tooltipInput")} ${fmt(row.inputTokens)} ${dict("tooltipTokens")} · ${dict("tooltipOutput")} ${fmt(row.outputTokens)} ${dict("tooltipTokens")} · ${dict("currencySymbol")}${fmtCny(row.cost, 4)}`;
			const parts = [];
			if (row.peakCost > 0) parts.push(`${dict("tooltipPeak")} ${dict("currencySymbol")}${fmtCny(row.peakCost, 4)}`);
			if (row.offpeakCost > 0) parts.push(`${dict("tooltipOffpeak")} ${dict("currencySymbol")}${fmtCny(row.offpeakCost, 4)}`);
			if (row.legacyCost > 0) parts.push(`${dict("tooltipLegacy")} ${dict("currencySymbol")}${fmtCny(row.legacyCost, 4)}`);
			if (parts.length > 1) line += ` · ${parts.join(" · ")}`;
			return line;
		}

		async function fetchJson(path) {
			const response = await fetch(path, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			if (payload === null || typeof payload !== "object") throw new Error("unexpected response");
			return payload;
		}
		//#endregion

		//#region config store (settings-scope backed)
		/**
		 * Display-mode + low-balance-threshold preference, persisted through
		 * the Host `session-cost` settings namespace (settings.yaml) via the
		 * bound settings scope — NOT localStorage. The bar and the settings
		 * card read the store through useSyncExternalStore; while the scope
		 * is loading or unavailable the store falls back to the defaults
		 * (dock / 10 CNY), so the UI never blocks on the settings transport.
		 * `dock` = the standalone status bar below the stats line (the
		 * original layout, kept as the default); `stats` = cost/balance
		 * segments appended INTO the built-in stats line. `lowBalanceThreshold`
		 * (CNY, default 10) colors the balance red when it drops below.
		 */
		const LEGACY_CONFIG_KEY = "dsh-session-cost:config";
		const DEFAULT_LOW_BALANCE_CNY = 10;
		const CONFIG_DEFAULTS = { displayMode: "dock", lowBalanceThreshold: DEFAULT_LOW_BALANCE_CNY };
		/** Coerce a config threshold to a sane number (>= 0, finite), else the default. */
		function sanitizeThreshold(value) {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOW_BALANCE_CNY;
		}
		/**
		 * Reactive adapter over one bound settings scope: a
		 * useSyncExternalStore-compatible store whose snapshot is
		 * `{ status, displayMode, lowBalanceThreshold }` derived from the
		 * scope. `set(patch)` writes the touched fields through scope.set
		 * (async; the scope fences revisions and reloads on failure), and the
		 * snapshot only changes after the Host confirms. `dispose()` removes
		 * the subscription.
		 */
		function createConfigStore(scope) {
			const listeners = [];
			let snapshot = { status: "loading", ...CONFIG_DEFAULTS };
			const compute = () => {
				const s = scope.getSnapshot();
				if (s === void 0 || s === null || s.status !== "ready" || s.value === void 0 || s.value === null) {
					return { status: s === void 0 || s === null ? "unavailable" : s.status, ...CONFIG_DEFAULTS };
				}
				const v = s.value;
				return {
					status: s.status,
					displayMode: v.displayMode === "stats" ? "stats" : "dock",
					lowBalanceThreshold: sanitizeThreshold(v.lowBalanceThreshold)
				};
			};
			const notify = () => {
				snapshot = compute();
				for (const listener of listeners.slice()) {
					try { listener(); } catch { /* contained: never break the fan-out */ }
				}
			};
			const unsubscribe = scope.subscribe(notify);
			snapshot = compute();
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.push(listener);
					return () => {
						const index = listeners.indexOf(listener);
						if (index !== -1) listeners.splice(index, 1);
					};
				},
				set: async (patch) => {
					if (Object.hasOwn(patch, "displayMode")) {
						await scope.set("displayMode", patch.displayMode === "stats" ? "stats" : "dock");
					}
					if (Object.hasOwn(patch, "lowBalanceThreshold")) {
						await scope.set("lowBalanceThreshold", sanitizeThreshold(patch.lowBalanceThreshold));
					}
				},
				dispose: () => unsubscribe()
			};
		}
		/**
		 * One-time migration from the legacy localStorage key: once the scope
		 * is ready, any non-default value is written through the scope, then
		 * the key is removed — the settings.yaml section becomes the single
		 * source of truth for existing users too.
		 */
		function migrateLegacyConfig(scope) {
			let finished = false;
			const run = () => {
				if (finished) return;
				const s = scope.getSnapshot();
				if (s === void 0 || s === null || s.status !== "ready") return;
				finished = true;
				let legacy = null;
				try {
					if (typeof localStorage === "undefined") return;
					const raw = localStorage.getItem(LEGACY_CONFIG_KEY);
					if (raw === null) return;
					const parsed = JSON.parse(raw);
					if (parsed !== null && typeof parsed === "object") legacy = parsed;
				} catch { return; }
				if (legacy === null) return;
				const writes = [];
				if (legacy.displayMode === "stats") writes.push(scope.set("displayMode", "stats"));
				const threshold = Number(legacy.lowBalanceThreshold);
				if (Number.isFinite(threshold) && threshold >= 0 && threshold !== DEFAULT_LOW_BALANCE_CNY) {
					writes.push(scope.set("lowBalanceThreshold", threshold));
				}
				const cleanup = () => {
					try { localStorage.removeItem(LEGACY_CONFIG_KEY); } catch { /* storage unavailable: ignore */ }
				};
				if (writes.length === 0) { cleanup(); return; }
				Promise.all(writes).then(cleanup, cleanup);
			};
			run();
			if (!finished) {
				const unsubscribe = scope.subscribe(() => {
					run();
					if (finished) unsubscribe();
				});
			}
		}
		/** Module-level store, created in apply() once the settings scope is bound. */
		let configStore = null;
		//#endregion

		//#region stats-line merge helpers
		/** Regex matching the built-in stats line's leading counts text ("3 轮 · 5 步" / "3 turns · 5 steps"). */
		const STATS_ROW_TEXT = /^\s*\d+\s*(轮|turns?)\s*·\s*\d+\s*(步|steps?)/;

		/**
		 * Locate the built-in stats row among the dock container's children.
		 * The container is the element that holds both StatsLine's root and our
		 * hidden anchor (they are sibling dock entries). The stats row is
		 * identified by its leading "N 轮 · M 步" counts text; hashed CSS class
		 * names are deliberately not relied upon.
		 */
		function findStatsRow(container) {
			if (container === null || container === void 0 || container.nodeType !== 1) return null;
			for (const child of container.children) {
				if (child.nodeType !== 1) continue;
				if (child.hasAttribute("data-session-cost-anchor")) continue;
				const text = child.textContent ?? "";
				if (STATS_ROW_TEXT.test(text)) return child;
			}
			return null;
		}

		/** Create a small inline SVG refresh icon (used by both display modes). */
		function refreshIconSvg() {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("width", "10");
			svg.setAttribute("height", "10");
			svg.setAttribute("aria-hidden", "true");
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("fill", "currentColor");
			path.setAttribute("d", "M13.65 2.35a.75.75 0 0 0-1.06 0L11.28 3.66A6.5 6.5 0 1 0 14.5 8h-1.5a5 5 0 1 1-1.47-3.54l-1.22 1.22a.75.75 0 0 0 .53 1.28h3a.75.75 0 0 0 .75-.75v-3a.75.75 0 0 0-1.94-.86Z");
			svg.appendChild(path);
			return svg;
		}

		/**
		 * Build the DOM node appended into the stats line in "stats" mode:
		 * `| 本会话费用 ¥0.4549 · 余额 ¥7.09 · ⟳` with a hover title carrying
		 * the per-model breakdown. `dict` provides localized labels, `data`
		 * carries the current cost/balance state, `onRefresh` wires the button.
		 * @returns the container element, or null when there is nothing to show.
		 */
		function buildMergeNode(dict, data) {
			const cost = data.cost;
			const hasBalance = data.hasBalance;
			const totalValue = data.totalValue;
			const costError = data.costError;
			const balanceError = data.balanceError;
			const balanceRef = data.balanceRef;
			const refreshing = data.refreshing;
			const justRefreshed = data.justRefreshed;
			const onRefresh = data.onRefresh;
			if (costError === null && balanceError === null && cost === null && !hasBalance) return null;
			const container = document.createElement("span");
			container.className = S.merge;
			container.setAttribute("data-session-cost-merge", "");
			const addSep = () => {
				const sep = document.createElement("span");
				sep.className = S.mergeSep;
				sep.textContent = "|";
				container.appendChild(sep);
			};
			if (costError === null) {
				addSep();
				const label = document.createElement("span");
				label.textContent = dict("cost") + " ";
				container.appendChild(label);
				const value = document.createElement("span");
				value.className = S.mergeVal;
				value.textContent = `${dict("currencySymbol")}${fmtCny(cost, 4)}`;
				container.appendChild(value);
			} else {
				addSep();
				const value = document.createElement("span");
				value.className = S.mergeVal;
				value.setAttribute("data-warn", "true");
				value.textContent = dict("unavailable");
				container.appendChild(value);
			}
			if (balanceError !== null) {
				addSep();
				const value = document.createElement("span");
				value.className = S.mergeVal;
				value.setAttribute("data-warn", "true");
				value.textContent = balanceError === "no-credential" ? dict("noCredential", { ref: balanceRef?.message ?? "" }) : dict("unavailable");
				container.appendChild(value);
			} else if (hasBalance) {
				addSep();
				const label = document.createElement("span");
				label.textContent = dict("balance") + " ";
				container.appendChild(label);
				const value = document.createElement("span");
				value.className = S.mergeVal;
				if (totalValue < (data.lowBalanceThreshold ?? DEFAULT_LOW_BALANCE_CNY)) value.setAttribute("data-warn", "true");
				value.textContent = `${dict("currencySymbol")}${fmtCny(totalValue, 2)}`;
				container.appendChild(value);
			}
			// Hover title: full per-model breakdown + balance split.
			const titleParts = [];
			titleParts.push(`${dict("tooltipCost")}: ${dict("currencySymbol")}${fmtCny(cost, 4)}`);
			const models = data.models;
			if (models.length === 0) {
				titleParts.push(dict("tooltipNoModels"));
			} else {
				for (const row of models) {
					titleParts.push(modelTooltipLine(dict, row));
				}
			}
			titleParts.push(`${dict("tooltipBalance")}: ${hasBalance ? `${dict("currencySymbol")}${fmtCny(totalValue, 2)}` : "—"}`);
			if (hasBalance && data.balance != null) {
				const b = data.balance;
				if (numOrNull(b.toppedUp) !== null) titleParts.push(`  ${dict("tooltipToppedUp")}: ${dict("currencySymbol")}${fmtCny(b.toppedUp, 2)}`);
				if (numOrNull(b.granted) !== null) titleParts.push(`  ${dict("tooltipGranted")}: ${dict("currencySymbol")}${fmtCny(b.granted, 2)}`);
			}
			const updatedAt = Math.max(
				data.summary !== null && typeof data.summary.updatedAt === "number" ? data.summary.updatedAt : 0,
				data.balance !== null && typeof data.balance.fetchedAt === "number" ? data.balance.fetchedAt : 0
			);
			if (updatedAt > 0) {
				titleParts.push(dict("tooltipUpdated", {
					time: new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				}));
			}
			titleParts.push(dict("tooltipPricingNote"));
			container.setAttribute("title", titleParts.join("\n"));
			if (justRefreshed !== null) {
				const updated = document.createElement("span");
				updated.className = S.updated;
				updated.textContent = dict("updated", {
					time: new Date(justRefreshed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				});
				container.appendChild(updated);
			}
			const button = document.createElement("button");
			button.type = "button";
			button.className = S.mergeBtn;
			button.disabled = refreshing;
			button.setAttribute("data-spin", refreshing ? "true" : "false");
			button.setAttribute("aria-label", dict(refreshing ? "refreshing" : "refresh"));
			button.appendChild(refreshIconSvg());
			if (typeof onRefresh === "function") button.addEventListener("click", onRefresh);
			container.appendChild(button);
			return container;
		}

		/**
		 * Merge-row CSS while "stats" mode is active. The built-in StatsLine
		 * root caps itself at `--dsh-chat-content-width` (748 px) with
		 * `overflow:hidden` + `text-overflow:ellipsis` (DSH rc.7+), which clips
		 * the cost/balance segment appended at the row's tail — the merge then
		 * silently disappears. Widening the row (`max-width:none`, full width)
		 * and making overflow visible shows the merge without relying on the
		 * zh_pro "统计全显示" tweak doing the same thing. Only INLINE styles are
		 * touched and the previous inline values are restored on teardown, so
		 * DSH's own stylesheet (and zh_pro's !important overrides) still win.
		 * @internal
		 */
		const MERGE_ROW_STYLE_PROPS = ["max-width", "overflow", "text-overflow"];
		const MERGE_ROW_STYLE_VALUES = { "max-width": "none", overflow: "visible", "text-overflow": "clip" };
		/** Per-row record of the inline values replaced while the merge is active. */
		const mergeRowPrior = typeof WeakMap !== "undefined" ? new WeakMap() : null;
		/**
		 * Apply the merge-row styles to the stats row, remembering what was
		 * there before. Idempotent per row (a WeakMap entry gates re-apply).
		 * @param row - the stats row element.
		 */
		function applyMergeRowStyles(row) {
			if (row === null || typeof row.style === "undefined") return;
			if (mergeRowPrior !== null && mergeRowPrior.has(row)) return;
			const prior = {};
			for (const prop of MERGE_ROW_STYLE_PROPS) {
				prior[prop] = {
					value: row.style.getPropertyValue(prop),
					priority: row.style.getPropertyPriority(prop)
				};
			}
			if (mergeRowPrior !== null) mergeRowPrior.set(row, prior);
			for (const prop of MERGE_ROW_STYLE_PROPS) {
				row.style.setProperty(prop, MERGE_ROW_STYLE_VALUES[prop]);
			}
		}
		/**
		 * Restore the inline values replaced by applyMergeRowStyles (exact
		 * round-trip; values that were absent are removed again). No-op for
		 * rows that were never styled or already restored.
		 * @param row - the stats row element.
		 */
		function restoreMergeRowStyles(row) {
			if (row === null || typeof row.style === "undefined") return;
			if (mergeRowPrior === null || !mergeRowPrior.has(row)) return;
			const prior = mergeRowPrior.get(row);
			mergeRowPrior.delete(row);
			for (const prop of MERGE_ROW_STYLE_PROPS) {
				const before = prior[prop];
				if (before.value === "") row.style.removeProperty(prop);
				else row.style.setProperty(prop, before.value, before.priority);
			}
		}
		//#endregion

		//#region SessionCostBar
		/**
		 * The conversation-bottom status bar.
		 * @param props - `useSession`/`useProjection` from the slot runtime, `t`
		 *   bound by the slot runtime locale seat, and `session`/`input` from
		 *   the composer-dock zone share.
		 */
		function SessionCostBar({ useSession, useProjection, t, session, input }) {
			const dict = t !== void 0 ? t : (key) => zh[key] ?? key;
			const translate = (key, params) => interpolate(dict(key), params);
			const sessionId = useSession((snapshot) => snapshot.sessionId);
			const tokenUsage = useProjection("tokenUsage");

			const [summary, setSummary] = react.useState(null);
			const [balance, setBalance] = react.useState(null);
			const [summaryError, setSummaryError] = react.useState(null);
			const [balanceError, setBalanceError] = react.useState(null);
			const [refreshing, setRefreshing] = react.useState(false);
			const [justRefreshed, setJustRefreshed] = react.useState(null);
			const summaryLoaderRef = react.useRef(null);
			const balanceLoaderRef = react.useRef(null);
			const debounceRef = react.useRef(null);
			if (summaryLoaderRef.current === null) summaryLoaderRef.current = createLoader();
			if (balanceLoaderRef.current === null) balanceLoaderRef.current = createLoader();

			const loadSummary = react.useCallback(async () => {
				if (sessionId === void 0 || sessionId === null || sessionId === "") return false;
				const seq = summaryLoaderRef.current.start();
				try {
					const payload = await fetchJson(`/api/session-cost/summary?session=${encodeURIComponent(sessionId)}`);
					if (summaryLoaderRef.current.isCurrent(seq)) {
						setSummary(payload);
						setSummaryError(null);
					}
					return true;
				} catch (err) {
					if (summaryLoaderRef.current.isCurrent(seq)) setSummaryError(err instanceof Error ? err.message : String(err));
					return false;
				}
			}, [sessionId]);

			const loadBalance = react.useCallback(async (force = false) => {
				const seq = balanceLoaderRef.current.start();
				try {
					const payload = await fetchJson(`/api/session-cost/balance${force ? "?refresh=1" : ""}`);
					if (balanceLoaderRef.current.isCurrent(seq)) {
						setBalance(payload);
						setBalanceError(null);
					}
					return true;
				} catch (err) {
					if (balanceLoaderRef.current.isCurrent(seq)) setBalanceError(err instanceof Error ? err.message : String(err));
					return false;
				}
			}, []);

			const refreshAll = react.useCallback(async () => {
				setRefreshing(true);
				try {
					// The balance endpoint serves a 2-minute cache; the manual
					// refresh must force an upstream query, otherwise the numbers
					// (and the tooltip timestamp) never change and the button
					// looks dead. Only announce "updated" when both fetches
					// actually succeeded — failures already render their own
					// error states.
					const [summaryOk, balanceOk] = await Promise.all([loadSummary(), loadBalance(true)]);
					if (summaryOk && balanceOk) setJustRefreshed(Date.now());
				} finally {
					setRefreshing(false);
				}
			}, [loadSummary, loadBalance]);

			// Initial load + interval + visibility refetch while mounted.
			react.useEffect(() => {
				loadSummary();
				loadBalance();
				const summaryTimer = window.setInterval(loadSummary, 30 * 1000);
				const balanceTimer = window.setInterval(loadBalance, 5 * 60 * 1000);
				const onVisible = () => {
					if (document.visibilityState === "visible") {
						loadSummary();
						loadBalance();
					}
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					window.clearInterval(summaryTimer);
					window.clearInterval(balanceTimer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [loadSummary, loadBalance]);

			// Refetch the cost summary shortly after the client-side token
			// projection moves (a turn finished), debounced.
			react.useEffect(() => {
				if (tokenUsage === void 0 || tokenUsage === null) return;
				if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
				debounceRef.current = window.setTimeout(() => {
					debounceRef.current = null;
					loadSummary();
				}, 500);
				return () => {
					if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
				};
			}, [tokenUsage, loadSummary]);

			// Fade the "updated" confirmation out shortly after a manual refresh.
			react.useEffect(() => {
				if (justRefreshed === null) return;
				const timer = window.setTimeout(() => setJustRefreshed(null), 2500);
				return () => window.clearTimeout(timer);
			}, [justRefreshed]);

			// Display mode + low-balance threshold from the plugin settings
			// (设置 → 插件 → 插件配置).
			const config = react.useSyncExternalStore(configStore.subscribe, configStore.getSnapshot);
			const displayMode = config.displayMode === "stats" ? "stats" : "dock";
			const lowBalanceThreshold = config.lowBalanceThreshold;
			const anchorRef = react.useRef(null);
			const dictRef = react.useRef(dict);
			dictRef.current = dict;
			const refreshRef = react.useRef(refreshAll);
			refreshRef.current = refreshAll;

			const cost = summary !== null && summary.ok === true ? numOrNull(summary.cost) : null;
			const models = summary !== null && Array.isArray(summary.models) ? summary.models : [];
			const bal = balance !== null && balance.ok === true ? balance.balance : null;
			const totalValue = bal === null ? null : numOrNull(bal.total);
			const hasBalance = totalValue !== null;
			const lowBalance = hasBalance && totalValue < lowBalanceThreshold;

			// "stats" mode: keep a hidden anchor in the dock and append the
			// cost/balance segments INTO the built-in stats line's DOM. StatsLine
			// is React-owned, so its re-renders can wipe our appended nodes; a
			// MutationObserver (disconnected while we write, like the zh_pro DOM
			// layer) re-appends after every external mutation. Both the dock
			// container (row mount/replacement) and the row itself (content
			// re-renders) are watched. The row must have content first (empty
			// sessions show nothing until stats exist). Since DSH rc.7 the row
			// caps at 748 px with overflow:hidden + ellipsis, which clips the
			// appended segment — the row is widened + unclipped inline
			// (applyMergeRowStyles) so the merge is visible even without the
			// zh_pro "统计全显示" tweak; the styles are restored on teardown.
			react.useEffect(() => {
				if (displayMode !== "stats") return;
				const anchor = anchorRef.current;
				if (anchor === null) return;
				let row = null;
				let observer = null;
				const sync = () => {
					const found = findStatsRow(anchor.parentElement);
					if (found === null) {
						if (row !== null && row.isConnected) restoreMergeRowStyles(row);
						row = null;
						return;
					}
					if (row !== found) {
						if (row !== null && row.isConnected) restoreMergeRowStyles(row);
						row = found;
					}
					applyMergeRowStyles(row);
					const previous = row.querySelector("[data-session-cost-merge]");
					const node = buildMergeNode(dictRef.current, {
						cost,
						models,
						balance: bal,
						totalValue,
						hasBalance,
						costError: summaryError,
						balanceError,
						balanceRef: balance,
						refreshing,
						justRefreshed,
						lowBalanceThreshold,
						onRefresh: refreshRef.current,
						summary
					});
					if (node === null) {
						if (previous !== null) previous.remove();
						return;
					}
					// Identical content: keep the existing node (its click
					// listener stays wired); only rebuild when data changed.
					if (previous !== null && previous.outerHTML === node.outerHTML) return;
					if (previous !== null) previous.remove();
					row.appendChild(node);
				};
				const teardown = () => {
					if (row !== null && row.isConnected) {
						restoreMergeRowStyles(row);
						const previous = row.querySelector("[data-session-cost-merge]");
						if (previous !== null) previous.remove();
					}
					if (observer !== null) observer.disconnect();
					observer = null;
					row = null;
				};
				sync();
				const parent = anchor.parentElement;
				observer = new MutationObserver(() => {
					// Guard against our own append loops: write with the observer
					// disconnected, reconnect afterwards.
					observer.disconnect();
					try {
						if (row !== null && !row.isConnected) row = null;
						sync();
					} finally {
						if (parent !== null && parent.isConnected) observer.observe(parent, { childList: true });
						if (row !== null && row.isConnected) observer.observe(row, { childList: true, characterData: true, subtree: true });
					}
				});
				if (parent !== null) observer.observe(parent, { childList: true });
				if (row !== null && row.isConnected) observer.observe(row, { childList: true, characterData: true, subtree: true });
				return teardown;
			}, [displayMode, lowBalanceThreshold, summary, balance, summaryError, balanceError, refreshing, justRefreshed, cost, models, totalValue, hasBalance, bal]);

			// Hero / blank sessions have nothing to meter; the dock is also not
			// rendered there, but guard anyway.
			if (session === void 0 || session === null || sessionId === void 0) return null;
			if (session.composerPhase === "blank") return null;

			if (displayMode === "stats") {
				// The merge effect writes into the stats row; this anchor is the
				// React-visible presence marker (display:none).
				return react_jsx_runtime.jsx("div", {
					ref: anchorRef,
					className: S.anchor,
					"data-session-cost-anchor": ""
				});
			}

			// Nothing to show yet (still loading, no error): render a subtle
			// placeholder so the bar appears without a flash, then settles.
			if (summaryError === null && balanceError === null && cost === null && !hasBalance) {
				return react_jsx_runtime.jsx("div", {
					className: S.row,
					"data-session-cost": true,
					children: react_jsx_runtime.jsx("span", { className: S.unknown, children: dict("loading") })
				});
			}

			const tooltipLines = [];
			tooltipLines.push(`${dict("tooltipCost")}: ${dict("currencySymbol")}${fmtCny(cost, 4)}`);
			if (models.length === 0) {
				tooltipLines.push(dict("tooltipNoModels"));
			} else {
				for (const row of models) {
					tooltipLines.push(modelTooltipLine(dict, row));
				}
			}
			tooltipLines.push(`${dict("tooltipBalance")}: ${hasBalance ? `${dict("currencySymbol")}${fmtCny(totalValue, 2)}` : "—"}`);
			if (hasBalance) {
				if (numOrNull(bal.toppedUp) !== null) tooltipLines.push(`  ${dict("tooltipToppedUp")}: ${dict("currencySymbol")}${fmtCny(bal.toppedUp, 2)}`);
				if (numOrNull(bal.granted) !== null) tooltipLines.push(`  ${dict("tooltipGranted")}: ${dict("currencySymbol")}${fmtCny(bal.granted, 2)}`);
			}
			const updatedAt = Math.max(
				summary !== null && typeof summary.updatedAt === "number" ? summary.updatedAt : 0,
				balance !== null && typeof balance.fetchedAt === "number" ? balance.fetchedAt : 0
			);
			if (updatedAt > 0) {
				tooltipLines.push(dict("tooltipUpdated", {
					time: new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				}));
			}
			tooltipLines.push(dict("tooltipPricingNote"));

			const items = [];
			if (summaryError !== null) {
				items.push(react_jsx_runtime.jsx("span", {
					className: S.error,
					children: dict("unavailable")
				}, "cost-error"));
			} else {
				items.push(react_jsx_runtime.jsxs("span", {
					className: S.item,
					children: [
						react_jsx_runtime.jsx("span", { children: dict("cost") }),
						react_jsx_runtime.jsx("span", {
							className: S.cost,
							children: `${dict("currencySymbol")}${fmtCny(cost, 4)}`
						})
					]
				}, "cost"));
			}
			if (balanceError !== null) {
				items.push(react_jsx_runtime.jsxs("span", {
					className: S.item,
					"data-warn": true,
					children: [
						react_jsx_runtime.jsx("span", { children: dict("balance") }),
						react_jsx_runtime.jsx("span", { className: S.unknown, children: balanceError === "no-credential" ? dict("noCredential", { ref: balance?.message ?? "" }) : dict("unavailable") })
					]
				}, "balance"));
			} else if (hasBalance) {
				items.push(react_jsx_runtime.jsxs("span", {
					className: S.item,
					"data-warn": lowBalance,
					children: [
						react_jsx_runtime.jsx("span", { children: dict("balance") }),
						react_jsx_runtime.jsx("span", {
							className: S.balance,
							children: `${dict("currencySymbol")}${fmtCny(totalValue, 2)}`
						})
					]
				}, "balance"));
			}

			return react_jsx_runtime.jsx(primitives.Tooltip, {
				label: tooltipLines.join("\n"),
				side: "top",
				delayMs: 400,
				maxWidth: 420,
				children: react_jsx_runtime.jsxs("div", {
					className: S.row,
					"data-session-cost": true,
					children: [
						...items,
						justRefreshed !== null && react_jsx_runtime.jsx("span", {
							className: S.updated,
							children: dict("updated", {
								time: new Date(justRefreshed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
							})
						}),
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: S.btn,
							disabled: refreshing,
							"data-spin": refreshing,
							"aria-label": dict(refreshing ? "refreshing" : "refresh"),
							onClick: refreshAll,
							children: react_jsx_runtime.jsx("svg", {
								viewBox: "0 0 16 16",
								width: "12",
								height: "12",
								"aria-hidden": true,
								children: react_jsx_runtime.jsx("path", {
									fill: "currentColor",
									d: "M13.65 2.35a.75.75 0 0 0-1.06 0L11.28 3.66A6.5 6.5 0 1 0 14.5 8h-1.5a5 5 0 1 1-1.47-3.54l-1.22 1.22a.75.75 0 0 0 .53 1.28h3a.75.75 0 0 0 .75-.75v-3a.75.75 0 0 0-1.94-.86Z"
								})
							})
						})
					]
				})
			});
		}
		//#endregion

		//#region SessionCostSettingsCard
		/**
		 * The plugin settings card, rendered inside the official
		 * 设置 → 插件 → 插件配置 tab (the `settings.plugin.item` seat). Offers
		 * the display-mode switch (独立状态栏 ↔ 并入统计栏), persisted through
		 * the `session-cost` settings namespace and applied immediately.
		 * @param props - `t` bound by the slot runtime locale seat.
		 */
		function SessionCostSettingsCard({ t }) {
			const dict = t !== void 0 ? t : (key) => zh[key] ?? key;
			const config = react.useSyncExternalStore(configStore.subscribe, configStore.getSnapshot);
			const displayMode = config.displayMode === "stats" ? "stats" : "dock";
			const choose = (mode) => configStore.set({ displayMode: mode });
			// Local draft for the threshold input so typing never commits
			// intermediate values; commit on blur/Enter, sync back on change.
			const [open, setOpen] = react.useState(false);
			const [thresholdDraft, setThresholdDraft] = react.useState(String(config.lowBalanceThreshold));
			react.useEffect(() => {
				setThresholdDraft(String(config.lowBalanceThreshold));
			}, [config.lowBalanceThreshold]);
			const commitThreshold = (raw) => {
				const text = String(raw ?? "").trim();
				if (text === "") {
					setThresholdDraft(String(config.lowBalanceThreshold));
					return;
				}
				const n = Number(text);
				if (Number.isFinite(n) && n >= 0) {
					configStore.set({ lowBalanceThreshold: n });
				} else {
					setThresholdDraft(String(config.lowBalanceThreshold));
				}
			};
			const title = dict("settingsTitle");
			return react_jsx_runtime.jsxs("li", {
				className: open ? `${S.settings} ${S.settingsOpen}` : S.settings,
				children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						className: S.settingsHeader,
						"aria-expanded": open,
						"aria-label": `${dict(open ? "settingsCollapse" : "settingsExpand")}: ${title}`,
						onClick: () => setOpen(!open),
						children: [
							react_jsx_runtime.jsxs("span", {
								className: S.settingsHeadText,
								children: [
									react_jsx_runtime.jsx("span", { className: S.settingsName, children: title }),
									react_jsx_runtime.jsx("span", { className: S.settingsDesc, children: dict("settingsDescription") })
								]
							}),
							react_jsx_runtime.jsx(primitives.IconChevronDownOutline14, {
								className: open ? `${S.settingsChevron} ${S.settingsChevronOpen}` : S.settingsChevron
							})
						]
					}),
					open ? react_jsx_runtime.jsxs("div", {
						className: S.settingsBody,
						children: [
							react_jsx_runtime.jsxs("div", {
								className: S.settingsField,
								children: [
									react_jsx_runtime.jsx("span", { className: S.settingsLabel, children: dict("settingsMode") }),
									react_jsx_runtime.jsxs("div", {
										className: S.settingsOptions,
										children: [
											react_jsx_runtime.jsxs("button", {
												type: "button",
												className: S.settingsOption,
												"data-active": displayMode === "dock",
												"aria-pressed": displayMode === "dock",
												onClick: () => choose("dock"),
												children: [
													react_jsx_runtime.jsx("span", { className: S.settingsOptionName, children: dict("settingsDock") }),
													react_jsx_runtime.jsx("p", { className: S.settingsOptionHint, children: dict("settingsDockHint") })
												]
											}),
											react_jsx_runtime.jsxs("button", {
												type: "button",
												className: S.settingsOption,
												"data-active": displayMode === "stats",
												"aria-pressed": displayMode === "stats",
												onClick: () => choose("stats"),
												children: [
													react_jsx_runtime.jsx("span", { className: S.settingsOptionName, children: dict("settingsStats") }),
													react_jsx_runtime.jsx("p", { className: S.settingsOptionHint, children: dict("settingsStatsHint") })
												]
											})
										]
									})
								]
							}),
							react_jsx_runtime.jsxs("div", {
								className: S.settingsField,
								children: [
									react_jsx_runtime.jsx("span", { className: S.settingsLabel, children: dict("settingsThreshold") }),
									react_jsx_runtime.jsxs("div", {
										className: S.settingsThresholdRow,
										children: [
											react_jsx_runtime.jsx("input", {
												type: "number",
												min: 0,
												step: 1,
												className: S.settingsInput,
												value: thresholdDraft,
												"aria-label": dict("settingsThreshold"),
												onChange: (event) => setThresholdDraft(event.target.value),
												onBlur: () => commitThreshold(thresholdDraft),
												onKeyDown: (event) => {
													if (event.key === "Enter") commitThreshold(thresholdDraft);
												}
											}),
											react_jsx_runtime.jsx("span", { className: S.settingsUnit, children: dict("settingsThresholdUnit") })
										]
									}),
									react_jsx_runtime.jsx("p", { className: S.settingsOptionHint, children: dict("settingsThresholdHint") })
								]
							}),
							react_jsx_runtime.jsx("p", { className: S.settingsDesc, children: dict("settingsApplied") })
						]
					}) : null
				]
			});
		}
		//#endregion

		//#region plugin body
		/**
		 * Settings namespace this plugin's card edits — must match the
		 * namespace the Host registers (lib/index.js). Spelled here rather
		 * than imported: a client package must not depend on a Host package.
		 */
		const SETTINGS_NS = "session-cost";
		/** Services required by the client plugin body. */
		const inject = ["slots", "locale", "connection", "remote", "settingsScope"];

		/**
		 * Client plugin body: register the dictionaries, the composer-dock entry
		 * (status bar at the bottom of the conversation) and the plugin settings
		 * card (设置 → 插件 → 插件配置), all backed by the `session-cost`
		 * settings namespace through a bound settings scope.
		 *
		 * Slot-kind contract: `conversation.composer.dock` is a LIST slot, so its
		 * registration is keyed by `id`; `settings.plugin.item` is a KEYED slot,
		 * so its registration must carry `key` (the settings namespace the card
		 * edits) — registering with `id` instead throws
		 * `keyed slot "settings.plugin.item" requires options.key` and fails
		 * the whole plugin load. The card is only dispatched by the official
		 * 插件配置 tab when the Host actually SERVES that namespace, which is
		 * why this plugin registers it on the Host side too.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			// Bind the namespace scope on THIS plugin's fiber (settingsScope.bind
			// registers the disposer itself); the scope auto-loads and refreshes
			// on settings/document-updated and connection/reset. Requires the
			// injected connection (transport) and remote (invalidation) services.
			const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
			configStore = createConfigStore(scope);
			migrateLegacyConfig(scope);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-cost: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "session-cost",
				order: 100,
				locale: NS
			}, SessionCostBar));
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: SETTINGS_NS,
				order: 20,
				locale: NS
			}, SessionCostSettingsCard));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.SessionCostBar = SessionCostBar;
		exports.SessionCostSettingsCard = SessionCostSettingsCard;
		exports.findStatsRow = findStatsRow;
		exports.buildMergeNode = buildMergeNode;
		exports.applyMergeRowStyles = applyMergeRowStyles;
		exports.restoreMergeRowStyles = restoreMergeRowStyles;
		exports.createConfigStore = createConfigStore;
		exports.fmtCny = fmtCny;
		exports.LOW_BALANCE_CNY = DEFAULT_LOW_BALANCE_CNY;
		return module.exports;
	}
});
