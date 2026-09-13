/**
 * dsh-session-cost — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step): registers into the
 * conversation `composer.dock` list slot (the status strip at the BOTTOM of
 * the conversation) and appends the cost/balance segments INTO the built-in
 * stats bar (the only display mode since 0.1.5; the standalone bar was
 * removed):
 *   - the ESTIMATED cost of the current session (本会话费用 ¥X.XXXX), computed
 *     server-side per model from the live session event log and priced in CNY
 *     against the table in ./cost.js;
 *   - the LIVE DeepSeek account balance (余额 ¥Y.YY), queried through the
 *     provider's balance API by the server half.
 *
 * Since DSH 0.1.5 that bar is `StatsPills` — a centered flex row of icon pills
 * tagged `data-composer-stats`, which replaced the single ellipsised
 * `StatsLine` text row — and it renders nothing at all until the session has a
 * step or token activity. The merge therefore attaches to a bar that appears
 * LATE and must match its pill styling (see `startStatsRowObserver`).
 *
 * Data comes from the server half's loopback-only endpoints via same-origin
 * fetch. The cost summary refreshes whenever the client-side `tokenUsage`
 * projection changes (debounced) and every 30 s while mounted; the balance
 * refreshes every 5 minutes and on demand via the ⟳ button. Hovering the
 * merged segment shows the per-model breakdown (model · in/out tokens ·
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
		// NOTE: `@deepseek-ai/dsh-client-ui-primitives` is deliberately NOT
		// required here. DSH 0.1.5 stopped shipping it as a standalone host
		// module, and a top-level `require()` of a module the loader cannot
		// resolve throws inside this factory — which aborts the WHOLE client
		// half (no dock entry, no merge, no settings card) rather than
		// degrading one icon. Every glyph this bundle draws is hand-written
		// inline SVG below, so the bundle stays free of optional host modules.

		//#region css
		const css = [
			// Stats-bar merge (appended into the built-in stats bar).
			//
			// DSH 0.1.5 replaced the single ellipsised text row (StatsLine) with
			// the centered pill bar (StatsPills): `[data-composer-stats]` is a
			// `display:flex; justify-content:center; gap:12px` container whose
			// children are the time/usage pill anchors. The merge node is
			// appended as one more flex item, so it must NOT carry a left
			// margin (the container's gap owns the spacing) and must opt out of
			// the pill label's ellipsis clamp.
			//
			// The trigger copies the shipped `.pill` recipe (13/20 secondary
			// tier, `1px 8px` padding, 24px radius, hover + `aria-expanded`
			// background), and the panel copies `stat-dialog.module.css` (fixed
			// placement, 12px radius, `--dsw-specific-menu`, 12/18 text, the
			// `minmax(76px,auto)` dt/dd grid) — the bar's own two pills open
			// exactly that panel, so the three read as one family.
			".sco_updated{color:var(--dsw-alias-state-success-primary);font-size:10px;line-height:14px;margin-right:2px}",
			"@keyframes sco_spin{to{transform:rotate(360deg)}}",
			".sco_anchor{display:none}",
			// Standalone fallback host. While DSH renders no bar at all (a
			// brand-new session, or the second a COLD session takes to load)
			// `StatsPills` is null, and the merge node is hosted by the dock
			// anchor itself instead of vanishing with the bar. The metrics are
			// copied from the shipped `.bOPqQW_root` so the pill does not move
			// or resize when the real bar appears and takes it over.
			".sco_anchor[data-solo=true]{box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width);margin:0 auto;padding:4px calc(var(--dsh-composer-side-clearance,0px) + 16px) 0;justify-content:center;gap:12px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:flex}",
			".sco_merge{display:inline-flex;align-items:center;max-width:none;flex:none;vertical-align:baseline;white-space:nowrap}",
			".sco_mergeBtn{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;display:inline-flex;font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap}",
			".sco_mergeBtn svg{width:14px;height:14px;flex:none}",
			".sco_mergeBtn:hover,.sco_mergeBtn[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".sco_mergeLabel{min-width:0;display:inline-flex;align-items:center;gap:5px}",
			".sco_mergeSep{color:var(--dsw-alias-separator-primary);margin:0 6px;display:inline-block}",
			".sco_mergeBalance{display:inline-flex;align-items:center}",
			// Same 13/20 secondary tier as the shipped readings: the values are
			// NOT bolded (the built-in pills are regular weight) and only the
			// digits are tabular, so the numbers stay column-aligned without
			// stretching the CJK labels around them.
			".sco_mergeVal{color:var(--dsw-alias-label-secondary)}",
			".sco_mergeAmount{font-variant-numeric:tabular-nums}",
			".sco_mergeVal[data-warn=true]{color:var(--dsw-alias-state-error-primary)}",
			// Click-open details panel (mirrors the built-in stat dialog).
			".sco_mergePanel{position:fixed;z-index:1100;box-sizing:border-box;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;text-align:left;white-space:normal;font-weight:400}",
			".sco_mergePanelTitle{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
			".sco_mergePanelTitleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}",
			".sco_mergePanelTitleLabel svg{flex:none;width:14px;height:14px}",
			".sco_mergePanelTitleValue{font-variant-numeric:tabular-nums}",
			".sco_mergePanelRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}",
			".sco_mergePanelDetails{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}",
			".sco_mergePanelDetails dt,.sco_mergePanelDetails dd{min-width:0;margin:0;font-weight:400}",
			".sco_mergePanelDetails dt{overflow-wrap:anywhere}",
			".sco_mergePanelDetails dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}",
			".sco_mergePanelDetails dd[data-warn=true]{color:var(--dsw-alias-state-error-primary)}",
			".sco_mergePanelFoot{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:10px;padding-top:8px;align-items:center;gap:8px;display:flex}",
			".sco_mergeRefresh{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:24px;flex:none;justify-content:center;align-items:center;width:20px;height:20px;padding:0;margin-left:auto;display:inline-flex}",
			".sco_mergeRefresh:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".sco_mergeRefresh:disabled{opacity:.45;cursor:default}",
			".sco_mergeRefresh[data-spin=true] svg{animation:sco_spin 0.8s linear infinite}",
			".sco_mergePanelNote{color:var(--dsw-alias-label-caption);margin:8px 0 0;font-size:11px;line-height:16px}",
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
			".sco_settingsChevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;width:14px;height:14px}",
			".sco_settingsChevronOpen{transform:rotate(180deg)}",
			".sco_settingsBody{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:12px}",
			".sco_settingsField{display:flex;flex-direction:column;gap:6px}",
			".sco_settingsLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}",
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
			updated: "sco_updated",
			anchor: "sco_anchor",
			merge: "sco_merge",
			mergeSep: "sco_mergeSep",
			mergeBalance: "sco_mergeBalance",
			mergeVal: "sco_mergeVal",
			mergeAmount: "sco_mergeAmount",
			mergeBtn: "sco_mergeBtn",
			mergeLabel: "sco_mergeLabel",
			mergePanel: "sco_mergePanel",
			mergePanelTitle: "sco_mergePanelTitle",
			mergePanelTitleLabel: "sco_mergePanelTitleLabel",
			mergePanelTitleValue: "sco_mergePanelTitleValue",
			mergePanelRule: "sco_mergePanelRule",
			mergePanelDetails: "sco_mergePanelDetails",
			mergePanelFoot: "sco_mergePanelFoot",
			mergePanelNote: "sco_mergePanelNote",
			mergeRefresh: "sco_mergeRefresh",
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
			settingsThresholdRow: "sco_settingsThresholdRow",
			settingsInput: "sco_settingsInput",
			settingsUnit: "sco_settingsUnit"
		};
		//#endregion

		//#region locale
		/** Locale namespace and dictionaries. */
		const NS = "sessionCost";
		const zh = {
			cost: "费用",
			balance: "余额",
			refresh: "刷新",
			refreshing: "刷新中…",
			updated: "已更新 {time}",
			unavailable: "暂不可用",
			noCredential: "未配置 {ref}",
			tooltipCost: "本会话费用估算",
			tooltipBalance: "账户余额",
			tooltipInput: "输入",
			tooltipOutput: "输出",
			tooltipTokens: "tokens",
			tooltipToppedUp: "充值余额",
			tooltipGranted: "赠送余额",
			tooltipUpdated: "更新于 {time}",
			tooltipPeak: "高峰",
			tooltipOffpeak: "空闲",
			tooltipV4: "V4 价",
			tooltipLegacy: "旧价",
			tooltipPricingNote: "费用为估算值：token 用量来自会话日志，单价见官方定价页（2026-08-17 起峰谷计价：高峰为北京时间工作日 9:00–12:00、14:00–18:00，价格为空闲时段的 2 倍；2026-08-23 起周末全天按空闲价计费；deepseek-v4-flash 输入 ¥1.5–3.0/百万、缓存命中 ¥0.05–0.10/百万、输出 ¥4.5–9.0/百万）。",
			tooltipNoModels: "暂无 token 用量",
			unpriced: "未计价",
			currencySymbol: "¥",
			settingsTitle: "会话费用显示",
			settingsDescription: "费用估算与账户余额显示在统计栏同一行，与轮次/时长/token 统计并列。",
			settingsApplied: "设置即时生效。",
			settingsThreshold: "低余额阈值",
			settingsThresholdHint: "余额低于该值时显示为红色，否则为黑色。",
			settingsThresholdUnit: "元",
			settingsExpand: "展开设置",
			settingsCollapse: "收起设置"
		};
		const en = {
			cost: "Cost",
			balance: "Balance",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			updated: "Updated {time}",
			unavailable: "Unavailable",
			noCredential: "{ref} not configured",
			tooltipCost: "Estimated cost of this session",
			tooltipBalance: "Account balance",
			tooltipInput: "Input",
			tooltipOutput: "Output",
			tooltipTokens: "tokens",
			tooltipToppedUp: "Topped up",
			tooltipGranted: "Granted",
			tooltipUpdated: "Updated at {time}",
			tooltipPeak: "Peak",
			tooltipOffpeak: "Off-peak",
			tooltipV4: "V4-era",
			tooltipLegacy: "Legacy",
			tooltipPricingNote: "Cost is an estimate: token usage comes from the session log; unit prices follow the official pricing page (peak/off-peak billing since 2026-08-17: peak = Beijing weekdays 09:00–12:00 / 14:00–18:00 at 2× the off-peak rate; weekends bill at off-peak rates all day since 2026-08-23; deepseek-v4-flash input ¥1.5–3.0/M, cache hit ¥0.05–0.10/M, output ¥4.5–9.0/M).",
			tooltipNoModels: "No token usage yet",
			unpriced: "unpriced",
			currencySymbol: "¥",
			settingsTitle: "Session cost display",
			settingsDescription: "The cost estimate and account balance appear in the built-in stats bar, next to the turns/duration/token readings.",
			settingsApplied: "Changes apply immediately.",
			settingsThreshold: "Low balance threshold",
			settingsThresholdHint: "Balance below this amount renders red; otherwise black.",
			settingsThresholdUnit: "CNY",
			settingsExpand: "Show settings",
			settingsCollapse: "Hide settings"
		};
		//#endregion

		//#region helpers
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
		 * The per-period cost split for one model, as a trailing
		 * `· 高峰 ¥x · 空闲 ¥y` suffix. Only rendered when a session actually
		 * spans more than one rate regime — the current 峰谷 pair, or an earlier
		 * price era (V4 价 / 旧价) that a long session reaches back into — so it
		 * stays out of the way in the common case.
		 * @param dict - localized dictionary.
		 * @param row - one per-model summary row.
		 * @returns the suffix, or an empty string when the row billed one period.
		 */
		function billingSplitSuffix(dict, row) {
			const parts = [];
			if (row.peakCost > 0) parts.push(`${dict("tooltipPeak")} ${dict("currencySymbol")}${fmtCny(row.peakCost, 4)}`);
			if (row.offpeakCost > 0) parts.push(`${dict("tooltipOffpeak")} ${dict("currencySymbol")}${fmtCny(row.offpeakCost, 4)}`);
			if (row.v4Cost > 0) parts.push(`${dict("tooltipV4")} ${dict("currencySymbol")}${fmtCny(row.v4Cost, 4)}`);
			if (row.legacyCost > 0) parts.push(`${dict("tooltipLegacy")} ${dict("currencySymbol")}${fmtCny(row.legacyCost, 4)}`);
			return parts.length > 1 ? ` · ${parts.join(" · ")}` : "";
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
		 * Low-balance-threshold preference, persisted through the Host
		 * `session-cost` settings namespace (settings.yaml) via the bound
		 * settings scope — NOT localStorage. The merge component and the
		 * settings card read the store through useSyncExternalStore; while the
		 * scope is loading or unavailable the store falls back to the default
		 * (10 CNY), so the UI never blocks on the settings transport.
		 * `lowBalanceThreshold` (CNY, default 10) colors the balance red when
		 * it drops below.
		 */
		const LEGACY_CONFIG_KEY = "dsh-session-cost:config";
		const DEFAULT_LOW_BALANCE_CNY = 10;
		const CONFIG_DEFAULTS = { lowBalanceThreshold: DEFAULT_LOW_BALANCE_CNY };
		/** Coerce a config threshold to a sane number (>= 0, finite), else the default. */
		function sanitizeThreshold(value) {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LOW_BALANCE_CNY;
		}
		/**
		 * Reactive adapter over one bound settings scope: a
		 * useSyncExternalStore-compatible store whose snapshot is
		 * `{ status, lowBalanceThreshold }` derived from the scope.
		 * `set(patch)` writes the touched fields through scope.set
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
		 * source of truth for existing users too. The legacy `displayMode`
		 * field is ignored (the standalone bar no longer exists); only the
		 * threshold is carried over.
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

		//#region stats-bar merge helpers
		/**
		 * Attribute the built-in stats bar has carried since DSH 0.1.5
		 * (`StatsPills`, which replaced the `StatsLine` block). It is the
		 * primary handle: the row is a flex container of icon pills, the text
		 * marker below is only a fallback for assemblies without the attribute.
		 */
		const STATS_ROW_ATTR = "data-composer-stats";
		/**
		 * Fallback text marker for the built-in stats row: the counts segment
		 * is `N 轮 · M 步` (StatsLine, ≤ 0.1.4) or `N 轮 61 步` / `N turns 61
		 * steps` (StatsPills, ≥ 0.1.5, separator dropped), with `轮`/`步`
		 * localized. Matched anywhere in the row's text, never anchored, so a
		 * leading icon or a changed separator cannot break detection.
		 */
		const STATS_ROW_TEXT = /\d+\s*(?:轮|turns?)\s*·?\s*\d+\s*(?:步|steps?)/;

		/**
		 * Locate the built-in stats bar among the dock container's children.
		 * The container is the element that holds both the stats bar's root
		 * and our hidden anchor (they are sibling dock entries). The bar is
		 * identified by its `data-composer-stats` attribute first (DSH 0.1.5+,
		 * where the row is a pill container rather than a text line) and by
		 * its counts text second (older assemblies); hashed CSS class names
		 * are deliberately not relied upon.
		 */
		function findStatsRow(container) {
			if (container === null || container === void 0 || container.nodeType !== 1) return null;
			for (const child of container.children) {
				if (child.nodeType !== 1) continue;
				if (child.hasAttribute("data-session-cost-anchor")) continue;
				if (child.hasAttribute(STATS_ROW_ATTR) || child.querySelector("[" + STATS_ROW_ATTR + "]") !== null) return child;
				if (STATS_ROW_TEXT.test(child.textContent ?? "")) return child;
			}
			return null;
		}

		/**
		 * The settings-card disclosure chevron, as a plain function component
		 * returning inline SVG. Drawn here rather than imported from
		 * `@deepseek-ai/dsh-client-ui-primitives` (which 0.1.5 no longer serves
		 * to plugins) so the bundle depends on no optional host module.
		 * @param props - `className` supplied by the card.
		 */
		function chevronDownIcon(props) {
			return react_jsx_runtime.jsx("svg", {
				className: props?.className,
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				"aria-hidden": "true",
				children: react_jsx_runtime.jsx("path", {
					fill: "currentColor",
					d: "M8 10.4 3.2 5.6a.9.9 0 0 1 1.27-1.27L8 7.86l3.53-3.53A.9.9 0 0 1 12.8 5.6L8 10.4Z"
				})
			});
		}

		//#region svg glyphs
		const SVG_NS = "http://www.w3.org/2000/svg";

		/**
		 * Build one inline SVG element. Every glyph this bundle draws is
		 * hand-written here (see `chevronDownIcon`): the shipped icon module is
		 * not part of the client module graph at 0.1.5, and requiring it would
		 * throw inside the factory and take the whole client half down.
		 * @param props - svg attributes; `children` lists `[tag, attributes]` pairs.
		 */
		function svgEl(props) {
			const svg = document.createElementNS(SVG_NS, "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("aria-hidden", "true");
			for (const [name, value] of Object.entries(props ?? {})) {
				if (name === "children" || value === void 0 || value === null) continue;
				svg.setAttribute(name, String(value));
			}
			for (const [tag, attrs] of props?.children ?? []) {
				const child = document.createElementNS(SVG_NS, tag);
				for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, String(value));
				svg.appendChild(child);
			}
			return svg;
		}

		/** Two stacked chevrons at 14/10 px — the `<detail>` disclosure zoom spec. */
		const ZOOM_ICON_PATH = {
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "1.2",
			"stroke-linecap": "round",
			d: "M2.2 6.1h11.6M4 10.1h8M5.8 14h4.4"
		};

		/**
		 * The session-cost pill glyph: a wallet. Deliberately NOT a ¥ badge —
		 * the label already reads 费用 ¥x, so a currency-symbol icon both
		 * duplicates the unit and says nothing about what is being counted.
		 * A wallet reads as "what this costs / what is left", carries no
		 * currency symbol of its own, and holds its weight at the pill's 14 px
		 * next to the built-in gauge/database glyphs.
		 */
		function costIconSvg() {
			return svgEl({
				width: "14",
				height: "14",
				children: [
					["rect", {
						x: "2", y: "3.5", width: "12", height: "9.5", rx: "2.2",
						fill: "none", stroke: "currentColor", "stroke-width": "1.2"
					}],
					["path", { fill: "none", stroke: "currentColor", "stroke-width": "1.2", d: "M2 7h12" }],
					["circle", { cx: "11.6", cy: "9.9", r: "0.95", fill: "currentColor" }]
				]
			});
		}

		/** Create a small inline SVG refresh icon. */
		function refreshIconSvg() {
			return svgEl({
				width: "10",
				height: "10",
				children: [["path", {
					fill: "currentColor",
					d: "M13.65 2.35a.75.75 0 0 0-1.06 0L11.28 3.66A6.5 6.5 0 1 0 14.5 8h-1.5a5 5 0 1 1-1.47-3.54l-1.22 1.22a.75.75 0 0 0 .53 1.28h3a.75.75 0 0 0 .75-.75v-3a.75.75 0 0 0-1.94-.86Z"
				}]]
			});
		}

		/** The panel's title glyph: the same wallet at title scale. */
		function panelTitleIconSvg() {
			return costIconSvg();
		}
		//#endregion

		/** Observer options: childList + text + the whole subtree (see below). */
		const STATS_OBSERVE = { childList: true, characterData: true, subtree: true };
		/** How often the watchdog checks that the merge is still where it belongs. */
		const MERGE_WATCHDOG_MS = 1000;

		/**
		 * Keep the cost/balance merge attached to the built-in stats bar for as
		 * long as the dock anchor is mounted.
		 *
		 * The bar is React-owned, so any of its re-renders can wipe the nodes we
		 * appended; a MutationObserver re-appends after every external mutation.
		 * Three timing facts make the wiring delicate:
		 *
		 * 1. The bar APPEARS LATE. Since DSH 0.1.5 `StatsPills` returns `null`
		 *    until the session has a step or token activity, so the anchor's
		 *    parent already exists while the bar does not. Observing only that
		 *    parent's own `childList` never fires when the bar finally mounts
		 *    (the parent itself is untouched), which silently loses the merge —
		 *    the observer therefore watches the whole subtree.
		 * 2. The DATA also arrives late: on a freshly started host the first
		 *    summary/balance responses are still in flight while the component
		 *    mounts. The observer must therefore be installed UNCONDITIONALLY —
		 *    bailing out when there is nothing to draw yet (an earlier version
		 *    did exactly that) leaves nobody watching for the bar, and the merge
		 *    only ever appeared after a page reload had already warmed the data.
		 *    `sync()` simply renders nothing until the first payload lands.
		 * 3. The whole COMPOSER is torn down on a session switch. Opening a
		 *    session with no warm client cache takes about a second, and for
		 *    that second the anchor sits inside a DETACHED subtree — so a
		 *    mutation callback legitimately runs while `container()` is not
		 *    connected. Re-observing only a connected host is what made the
		 *    reading disappear for good on such a switch (the observer stayed
		 *    disconnected for the rest of the component's life, and only a page
		 *    reload — a fresh mount with a fresh observer — brought the pill
		 *    back). Re-observation is therefore UNCONDITIONAL, and a watchdog
		 *    repairs a merge that should be on screen but is not.
		 *
		 * The merge also survives a session in which DSH renders NO bar at all
		 * (brand new, or still loading): the node is then hosted by the anchor
		 * itself (`data-solo`, styled with the bar's own metrics) and moves into
		 * the bar as soon as it appears. Without that fallback the reading
		 * vanished together with the bar it used to live in.
		 *
		 * `writeMerge` returns the node to append (or null while there is
		 * nothing to show); it is re-invoked on every sync so the latest
		 * cost/balance state and the current dictionary are always what lands
		 * in the DOM.
		 *
		 * @param anchor - the hidden dock anchor whose sibling is the stats bar.
		 * @param writeMerge - builds the merge node for the current state.
		 * @returns `{ sync, dispose }` — `sync` re-applies the current state
		 *   (the owner calls it whenever its data changes), `dispose` removes
		 *   the observer, the watchdog and the merge node.
		 * @internal
		 */
		function startStatsRowObserver(anchor, writeMerge) {
			if (anchor === null || anchor === void 0 || anchor.nodeType !== 1) {
				return { sync: () => {}, dispose: () => {} };
			}
			/** The built-in stats bar the merge is currently attached to. */
			let row = null;
			let observer = null;
			/** The element the observer is currently attached to. */
			let observed = null;
			let timer = null;
			/** Whether the last sync actually put a merge node in the DOM. */
			let rendered = false;
			const container = () => anchor.parentElement;
			const hostOf = () => (row !== null ? row : anchor);

			/** Drop the merge node a host carries, with its panel and listeners. */
			const drop = (host) => {
				if (host === null || host === void 0 || host.nodeType !== 1) return;
				const node = host.querySelector("[data-session-cost-merge]");
				if (node === null) return;
				disposeMergeNode(node);
				node.remove();
			};

			/**
			 * Build (or reconcile) the merge node inside `host`. An identical
			 * shape is patched in place so the mounted listeners — and an open
			 * panel — survive a data update; the candidate node is then
			 * discarded, its portaled panel included.
			 */
			const place = (host) => {
				const previous = host.querySelector("[data-session-cost-merge]");
				const node = writeMerge();
				rendered = node !== null;
				if (node === null) {
					if (previous !== null) {
						disposeMergeNode(previous);
						previous.remove();
					}
					return;
				}
				if (previous !== null && sameMergeShape(previous, node)) {
					updateMergeNode(previous, node);
					disposeMergeNode(node);
					placeOpenPanel(previous);
					return;
				}
				if (previous !== null) {
					disposeMergeNode(previous);
					previous.remove();
				}
				host.appendChild(node);
				placeOpenPanel(node);
			};

			/** Bring the merge in line with the current DOM and data. */
			const runSync = () => {
				row = findStatsRow(container());
				if (row === null) {
					// No bar (yet): host the node in the anchor itself so the
					// reading does not disappear with the bar.
					anchor.setAttribute("data-solo", "true");
				} else {
					// The bar is used EXACTLY as DSH styles it: no width,
					// overflow or text-overflow is ever rewritten. The old
					// widening existed for the ≤ 0.1.4 text row (748 px cap +
					// `overflow:hidden` + ellipsis, which clipped the appended
					// tail); 0.1.5's `.bOPqQW_root` is a centered flex row that
					// clips nothing, so its own layout is enough.
					anchor.removeAttribute("data-solo");
					drop(anchor);
				}
				place(hostOf());
			};

			/**
			 * Contained wrapper around {@link runSync}: this runs from a React
			 * effect (an uncaught error there unmounts the whole app) and from a
			 * MutationObserver callback, so a defect in the merge must never take
			 * the harness down with it. The failure is reported to the console and
			 * the watchdog retries a second later.
			 */
			const sync = () => {
				try {
					runSync();
				} catch (error) {
					rendered = false;
					if (typeof console !== "undefined" && typeof console.warn === "function") {
						console.warn("session-cost: merge update failed", error);
					}
				}
			};

			/** (Re-)attach the observer to the anchor's current container. */
			const watch = () => {
				if (observer === null) return;
				const host = container();
				if (host === null) return;
				if (host !== observed) {
					observer.disconnect();
					observed = host;
				}
				// Unconditional: a momentarily detached host still delivers
				// subtree mutations, and skipping it here is exactly the bug.
				observer.observe(host, STATS_OBSERVE);
			};

			/** Detach the observer and forget its target. */
			const unwatch = () => {
				if (observer !== null) observer.disconnect();
				observed = null;
			};

			/**
			 * Safety net for everything the mutation stream cannot report: a
			 * node React wiped while the observer was detached, a bar re-mounted
			 * with no mutation we could observe, an anchor that moved to another
			 * container. Checking is cheap and rebuilding only happens when
			 * something is actually missing, so this is a repair pass rather
			 * than a poll.
			 */
			const watchdog = () => {
				watch();
				if (!rendered) return;
				if (row !== null && !row.isConnected) {
					sync();
					return;
				}
				const host = hostOf();
				const node = host.querySelector("[data-session-cost-merge]");
				if (node === null || node.parentElement !== host) sync();
			};

			sync();
			if (typeof MutationObserver !== "undefined") {
				observer = new MutationObserver(() => {
					// Guard against our own append loops: write with the observer
					// disconnected, reconnect afterwards.
					unwatch();
					try {
						if (row !== null && !row.isConnected) row = null;
						sync();
					} finally {
						watch();
					}
				});
				watch();
			}
			if (typeof window !== "undefined" && typeof window.setInterval === "function") {
				timer = window.setInterval(watchdog, MERGE_WATCHDOG_MS);
			}
			const dispose = () => {
				if (timer !== null && typeof window !== "undefined" && typeof window.clearInterval === "function") {
					window.clearInterval(timer);
				}
				timer = null;
				unwatch();
				drop(row);
				drop(anchor);
				anchor.removeAttribute("data-solo");
				row = null;
				rendered = false;
			};
			return { sync, dispose };
		}
		//#endregion

		/**
		 * Reconcile a freshly built merge node with the one already in the DOM.
		 *
		 * Replacing the node wholesale would be simpler, but it would also
		 * discard the click listener's captured state and any open panel. The
		 * node's shape only depends on which segments are present, so an
		 * update patches the value-bearing slots (trigger label, panel rows,
		 * warn flags, open state) and keeps the same elements — and therefore
		 * the same listeners — alive.
		 *
		 * The panel is PORTALED to `document.body`, so nothing inside it is
		 * reachable by querying the merge node: both panels are resolved
		 * through the node→panel registry. Reaching for them with
		 * `previous.querySelector("[data-slot=panel]")` (which is what this
		 * did) always returned null, which silently froze every panel reading
		 * and — once the merge node stopped being rebuilt on each data change —
		 * left the panel unable to open at all.
		 * @param previous - the node currently mounted.
		 * @param node - the freshly built node for the current state.
		 */
		function updateMergeNode(previous, node) {
			// Slots inside the node itself (the trigger and its label).
			patchIcon(previous.querySelector("[data-slot=trigger-icon]"), node.querySelector("[data-slot=trigger-icon]"));
			patchText(previous.querySelector("[data-slot=trigger-label]"), node.querySelector("[data-slot=trigger-label]"));
			const prevCost = previous.querySelector("[data-slot=cost]");
			const nextCost = node.querySelector("[data-slot=cost]");
			patchText(prevCost, nextCost);
			patchWarn(prevCost, nextCost);
			patchText(previous.querySelector("[data-slot=balance]"), node.querySelector("[data-slot=balance]"));
			patchWarn(previous.querySelector("[data-slot=balance]"), node.querySelector("[data-slot=balance]"));
			// Slots inside the portaled panel.
			const previousPanel = panelOf(previous);
			const nextPanel = panelOf(node);
			const previousTrigger = previous.querySelector("[data-slot=trigger]");
			if (previousPanel !== null && nextPanel !== null) {
				const slot = (panel, name) => panel.querySelector("[data-slot=" + name + "]");
				patchText(slot(previousPanel, "title-value"), slot(nextPanel, "title-value"));
				patchText(slot(previousPanel, "panel-balance"), slot(nextPanel, "panel-balance"));
				patchWarn(slot(previousPanel, "panel-balance"), slot(nextPanel, "panel-balance"));
				patchText(slot(previousPanel, "panel-updated"), slot(nextPanel, "panel-updated"));
				patchIcon(slot(previousPanel, "refresh-icon"), slot(nextPanel, "refresh-icon"));
				patchText(slot(previousPanel, "panel-note"), slot(nextPanel, "panel-note"));
				patchIcon(slot(previousPanel, "panel-head-icon"), slot(nextPanel, "panel-head-icon"));
				const previousRefresh = slot(previousPanel, "refresh");
				const nextRefresh = slot(nextPanel, "refresh");
				if (previousRefresh !== null && nextRefresh !== null) {
					previousRefresh.disabled = nextRefresh.disabled;
					previousRefresh.setAttribute("data-spin", nextRefresh.getAttribute("data-spin") ?? "false");
					previousRefresh.setAttribute("aria-label", nextRefresh.getAttribute("aria-label") ?? "");
				}
				const previousList = slot(previousPanel, "panel-list");
				const nextList = slot(nextPanel, "panel-list");
				if (previousList !== null && nextList !== null) {
					const wanted = nextList.children.length;
					while (previousList.children.length > wanted) previousList.lastElementChild.remove();
					for (let index = 0; index < wanted; index += 1) {
						const current = previousList.children[index];
						const next = nextList.children[index];
						patchText(current.querySelector("[data-slot=row-label]"), next.querySelector("[data-slot=row-label]"));
						patchText(current.querySelector("[data-slot=row-value]"), next.querySelector("[data-slot=row-value]"));
					}
				}
				// The open state travels on the panel (React owns it), so an
				// in-place update opens and closes it without rebuilding.
				if (previousTrigger !== null) {
					const wantOpen = nextPanel.hidden !== true;
					previousPanel.hidden = nextPanel.hidden;
					previousTrigger.setAttribute("aria-expanded", wantOpen ? "true" : "false");
					// Placement is measured on the live trigger and re-done by
					// `placeOpenPanel` below, never copied from the freshly built
					// node (which was never laid out).
					if (!wantOpen) previousPanel.style.visibility = "hidden";
				}
			}
			// Placement is measured against the LIVE trigger, which is the only
			// reason this runs here rather than on the freshly built node.
			// `startStatsRowObserver.sync()` calls this only once the node has
			// been appended, so the pill has a real box by now.
			placeOpenPanel(previous);
		}
		//#endregion

		/**
		 * Set a text slot's content only when it actually changed. A slot that
		 * CONTAINS other slots (the pill label wraps the cost and balance
		 * readings) must never be written as text — that would wipe its
		 * children out of the DOM — so only leaf slots are patched.
		 */
		function patchText(previous, next) {
			if (previous === null || next === null) return;
			if (previous.querySelector("[data-slot]") !== null) return;
			if (previous.textContent !== next.textContent) previous.textContent = next.textContent;
		}

		/** Mirror the warn flag a value slot carries. */
		function patchWarn(previous, next) {
			if (previous === null || next === null) return;
			const warn = next.getAttribute("data-warn") === "true";
			if (warn) previous.setAttribute("data-warn", "true");
			else previous.removeAttribute("data-warn");
		}

		/** Replace an svg slot when its path data changed (warn/refresh glyphs). */
		function patchIcon(previous, next) {
			if (previous === null || next === null) return;
			if (previous.outerHTML === next.outerHTML) return;
			previous.replaceWith(next);
		}

		/** Both node shapes carry the same classes: safe to patch slot by slot. */
		function sameMergeShape(previous, node) {
			if (previous.tagName !== node.tagName) return false;
			if (previous.className !== node.className) return false;
			const previousSlots = previous.querySelectorAll("[data-slot]").length;
			const nextSlots = node.querySelectorAll("[data-slot]").length;
			return previousSlots === nextSlots;
		}

		/**
		 * The panel's "model · in/out tokens · ¥cost" reading, as a `dt`/`dd`
		 * pair for the shared stat-dialog grid. A model whose `price` came back
		 * null bills at 0 and would read as "this session is free", so its row
		 * says 未计价 instead (that means DSH started routing the model under an
		 * id the pricing table has not learned yet).
		 * @param dict - localized dictionary.
		 * @param row - one per-model summary row.
		 */
		function modelRowElement(dict, row) {
			const name = row.model.includes("/") ? row.model.slice(row.model.indexOf("/") + 1) : row.model;
			const dt = document.createElement("dt");
			dt.setAttribute("data-slot", "row-label");
			dt.textContent = name;
			const dd = document.createElement("dd");
			dd.setAttribute("data-slot", "row-value");
			const tokens = `${dict("tooltipInput")} ${fmt(row.inputTokens)} · ${dict("tooltipOutput")} ${fmt(row.outputTokens)}`;
			if (row.price === null || row.price === void 0) {
				dd.setAttribute("data-warn", "true");
				dd.textContent = `${tokens} · ${dict("unpriced")}`;
				return [dt, dd];
			}
			dd.textContent = `${tokens} · ${dict("currencySymbol")}${fmtCny(row.cost, 4)}${billingSplitSuffix(dict, row)}`;
			return [dt, dd];
		}

		/** One `dt`/`dd` pair with an explicit label (balance split, totals). */
		function rowElement(label, value) {
			const dt = document.createElement("dt");
			dt.setAttribute("data-slot", "row-label");
			dt.textContent = label;
			const dd = document.createElement("dd");
			dd.setAttribute("data-slot", "row-value");
			dd.textContent = value;
			return [dt, dd];
		}

		/** Distance between the trigger's top edge and the panel's bottom (native dialog spec). */
		const PANEL_GAP = 8;
		/** Viewport margin the placement clamp keeps (native dialog spec). */
		const PANEL_MARGIN = 12;

		/**
		 * Position the panel above its trigger, clamped to the viewport — the
		 * same measure-then-place flow the built-in stat dialogs use (the
		 * shipped `useAnchoredPosition` hook needs the icon module the client
		 * module graph no longer serves, so the arithmetic lives here).
		 * @param trigger - the pill button the panel is anchored to.
		 * @param panel - the `position:fixed` panel to place.
		 */
		function placePanel(trigger, panel) {
			const anchor = trigger.getBoundingClientRect();
			const width = panel.offsetWidth;
			const height = panel.offsetHeight;
			const viewportWidth = window.innerWidth;
			const viewportHeight = window.innerHeight;
			const left = Math.min(
				Math.max(12, anchor.left + anchor.width / 2 - width / 2),
				Math.max(12, viewportWidth - width - 12)
			);
			let top = anchor.top - height - PANEL_GAP;
			if (top < PANEL_MARGIN) top = Math.min(anchor.bottom + PANEL_GAP, viewportHeight - height - PANEL_MARGIN);
			panel.style.left = `${Math.round(left)}px`;
			panel.style.top = `${Math.round(Math.max(PANEL_MARGIN, top))}px`;
			panel.style.visibility = "visible";
		}

		/**
		 * Each merge node's portaled panel. It lives in `document.body`, not in
		 * the node, so the node cannot find it by querying itself — this map is
		 * how the owner reaches it (placement, and the DOM-smoke assertions).
		 */
		const mergePanels = typeof WeakMap !== "undefined" ? new WeakMap() : null;

		/**
		 * Resolve a merge node's portaled panel. The panel is NOT a descendant
		 * of the node (it hangs off `document.body` so the stats bar's
		 * `overflow` cannot clip it), so every panel slot — readings, warn
		 * flags, open state — must be reached through this lookup rather than
		 * through `node.querySelector`.
		 * @param node - a node produced by `buildMergeNode`.
		 * @returns the panel element, or null when there is none.
		 */
		function panelOf(node) {
			if (node === null || node === void 0 || mergePanels === null) return null;
			return mergePanels.get(node) ?? null;
		}

		/**
		 * Drop a merge node's document-level listeners and its portaled panel.
		 * Every node built by `buildMergeNode` owns a panel, including the ones
		 * that never reach the DOM (the observer builds a candidate on every
		 * sync and keeps only some of them), so the discards must run this too
		 * or each sync would leak one panel into `document.body`.
		 * @param node - a node produced by `buildMergeNode`.
		 */
		function disposeMergeNode(node) {
			if (node === null || node === void 0) return;
			const panel = panelOf(node);
			if (mergePanels !== null) mergePanels.delete(node);
			node.dispatchEvent(new Event("session-cost:dispose"));
			if (panel !== null && panel.isConnected) panel.remove();
		}

		/**
		 * Place a merge node's panel when it should be open. Called after the
		 * node is in the DOM: the trigger's box is only meaningful then, so a
		 * re-opened panel (after a node rebuild) lands where the pill actually
		 * is instead of at the viewport origin.
		 * @param node - a node produced by `buildMergeNode`.
		 */
		function placeOpenPanel(node) {
			if (node === null || node === void 0) return;
			const panel = panelOf(node);
			const trigger = node.querySelector("[data-slot=trigger]");
			if (panel === null || trigger === null || panel.hidden === true) return;
			if (typeof window === "undefined" || typeof trigger.getBoundingClientRect !== "function") return;
			placePanel(trigger, panel);
		}

		/**
		 * Build the DOM node appended into the built-in stats bar: a pill
		 * button in the bar's own tier — `[¥] 本会话费用 ¥0.4549 ｜ 余额 ¥7.09`
		 * — that opens a portaled details panel above the bar (per-model
		 * breakdown, balance split, refresh, update time). This mirrors how the
		 * built-in stats pills carry their figures in a click-open dialog; the
		 * panel is placed with `position:fixed` and appended to `document.body`
		 * so the bar's `overflow` cannot clip it, and only one merge node is
		 * ever open (the open panel is closed on outside pointerdown/Escape).
		 *
		 * `dict` provides localized labels, `data` carries the current
		 * cost/balance state (plus `open`, the cross-rebuild panel state, and
		 * `onToggle`/`onRefresh`), and the node it returns is reconciled in
		 * place by `updateMergeNode`, so an open panel survives data updates.
		 * @returns the trigger + panel wrapper, or null when nothing to show.
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
			if (costError === null && balanceError === null && cost === null && !hasBalance) return null;

			const container = document.createElement("span");
			container.className = S.merge;
			container.setAttribute("data-session-cost-merge", "");

			// ---- trigger: the pill itself ------------------------------------
			const button = document.createElement("button");
			button.type = "button";
			button.className = S.mergeBtn;
			button.setAttribute("data-slot", "trigger");
			button.setAttribute("aria-haspopup", "dialog");
			button.setAttribute("aria-expanded", data.open === true ? "true" : "false");
			button.setAttribute("aria-label", dict("tooltipCost"));
			const icon = costIconSvg();
			icon.setAttribute("data-slot", "trigger-icon");
			button.appendChild(icon);
			const label = document.createElement("span");
			label.className = S.mergeLabel;
			label.setAttribute("data-slot", "trigger-label");
			label.appendChild(costSegment(dict, cost, costError));
			const balanceSegment = buildBalanceSegment(dict, data);
			if (balanceSegment !== null) label.appendChild(balanceSegment);
			button.appendChild(label);
			container.appendChild(button);

			// ---- panel: the old hover tooltip, now click-open -----------------
			const panel = document.createElement("div");
			panel.className = S.mergePanel;
			panel.setAttribute("data-slot", "panel");
			panel.setAttribute("role", "dialog");
			panel.setAttribute("aria-label", dict("tooltipCost"));
			panel.hidden = data.open !== true;

			const head = document.createElement("div");
			head.className = S.mergePanelTitle;
			const headLabel = document.createElement("span");
			headLabel.className = S.mergePanelTitleLabel;
			const headIcon = panelTitleIconSvg();
			headIcon.setAttribute("data-slot", "panel-head-icon");
			headLabel.appendChild(headIcon);
			const headText = document.createElement("span");
			headText.textContent = dict("cost");
			headLabel.appendChild(headText);
			head.appendChild(headLabel);
			const titleValue = document.createElement("span");
			titleValue.className = S.mergePanelTitleValue;
			titleValue.setAttribute("data-slot", "title-value");
			titleValue.textContent = costError !== null
				? dict("unavailable")
				: cost === null ? "—" : `${dict("currencySymbol")}${fmtCny(cost, 4)}`;
			head.appendChild(titleValue);
			panel.appendChild(head);

			const rule = document.createElement("div");
			rule.className = S.mergePanelRule;
			rule.setAttribute("aria-hidden", "true");
			panel.appendChild(rule);

			const details = document.createElement("dl");
			details.className = S.mergePanelDetails;
			details.setAttribute("data-slot", "panel-list");
			const models = data.models;
			// `rowElement` returns a dt/dd PAIR: append the cells, never the
			// array itself (a real `appendChild(array)` throws, which is how the
			// "no token usage yet" path used to take the whole merge down).
			if (models.length === 0) {
				for (const cell of rowElement(dict("tooltipNoModels"), "")) details.appendChild(cell);
			} else {
				for (const row of models) {
					for (const cell of modelRowElement(dict, row)) details.appendChild(cell);
				}
			}
			const [balanceLabel, balanceValue] = rowElement(dict("tooltipBalance"), "—");
			details.appendChild(balanceLabel);
			details.appendChild(balanceValue);
			balanceValue.setAttribute("data-slot", "panel-balance");
			balanceValue.textContent = hasBalance ? `${dict("currencySymbol")}${fmtCny(totalValue, 2)}` : "—";
			if (balanceError !== null) {
				balanceValue.setAttribute("data-warn", "true");
				balanceValue.textContent = balanceError === "no-credential"
					? dict("noCredential", { ref: balanceRef?.message ?? "" })
					: dict("unavailable");
			} else if (hasBalance && totalValue < (data.lowBalanceThreshold ?? DEFAULT_LOW_BALANCE_CNY)) {
				balanceValue.setAttribute("data-warn", "true");
			}
			panel.appendChild(details);
			if (hasBalance && data.balance != null) {
				const b = data.balance;
				if (numOrNull(b.toppedUp) !== null) {
					for (const cell of rowElement(dict("tooltipToppedUp"), `${dict("currencySymbol")}${fmtCny(b.toppedUp, 2)}`)) details.appendChild(cell);
				}
				if (numOrNull(b.granted) !== null) {
					for (const cell of rowElement(dict("tooltipGranted"), `${dict("currencySymbol")}${fmtCny(b.granted, 2)}`)) details.appendChild(cell);
				}
			}

			const foot = document.createElement("div");
			foot.className = S.mergePanelFoot;
			const updatedAt = Math.max(
				data.summary !== null && typeof data.summary.updatedAt === "number" ? data.summary.updatedAt : 0,
				data.balance !== null && typeof data.balance.fetchedAt === "number" ? data.balance.fetchedAt : 0
			);
			if (updatedAt > 0) {
				const updated = document.createElement("span");
				updated.className = S.mergeUpdated;
				updated.setAttribute("data-slot", "panel-updated");
				updated.textContent = dict("tooltipUpdated", {
					time: new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				});
				foot.appendChild(updated);
			}
			const refresh = document.createElement("button");
			refresh.type = "button";
			refresh.className = S.mergeRefresh;
			refresh.setAttribute("data-slot", "refresh");
			refresh.disabled = refreshing;
			refresh.setAttribute("data-spin", refreshing ? "true" : "false");
			refresh.setAttribute("aria-label", dict(refreshing ? "refreshing" : "refresh"));
			const refreshIcon = refreshIconSvg();
			refreshIcon.setAttribute("data-slot", "refresh-icon");
			refresh.appendChild(refreshIcon);
			// Read the handler at CLICK time, not at build time: this node can now
			// outlive many renders (the merge is patched in place), and the owner
			// hands in a stable state object whose fields are refreshed per render
			// — so the refresh always acts on the session that is on screen.
			refresh.addEventListener("click", () => {
				if (typeof data.onRefresh === "function") data.onRefresh();
			});
			foot.appendChild(refresh);
			panel.appendChild(foot);

			const note = document.createElement("p");
			note.className = S.mergePanelNote;
			note.setAttribute("data-slot", "panel-note");
			note.textContent = dict("tooltipPricingNote");
			panel.appendChild(note);

			// The panel is created closed and placed by its owner once the node
			// is actually in the DOM (`placeOpenPanel`): the trigger's box is
			// meaningless before that, and the panel must never be visible at
			// the origin for a frame.
			panel.hidden = data.open !== true;
			if (typeof document !== "undefined" && document.body !== void 0 && document.body !== null) {
				document.body.appendChild(panel);
			}
			if (mergePanels !== null) mergePanels.set(container, panel);

			// The trigger owns the panel's lifecycle: toggling it, closing it on
			// outside pointerdown/Escape, and removing it with the node.
			if (typeof data.onToggle === "function") {
				button.addEventListener("click", () => data.onToggle(panel.hidden !== true));
			}
			const onOutside = (event) => {
				if (panel.hidden === true) return;
				if (panel.contains(event.target) || button.contains(event.target)) return;
				if (typeof data.onToggle === "function") {
					data.onToggle(true);
					return;
				}
				panel.hidden = true;
				button.setAttribute("aria-expanded", "false");
			};
			const onKeydown = (event) => {
				if (event.key !== "Escape" || panel.hidden === true) return;
				if (typeof data.onToggle === "function") {
					data.onToggle(true);
					return;
				}
				panel.hidden = true;
				button.setAttribute("aria-expanded", "false");
			};
			if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
				document.addEventListener("pointerdown", onOutside, true);
				document.addEventListener("keydown", onKeydown);
			}
			container.addEventListener("session-cost:dispose", () => {
				if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
					document.removeEventListener("pointerdown", onOutside, true);
					document.removeEventListener("keydown", onKeydown);
				}
				panel.remove();
			});
			if (justRefreshed !== null) {
				const updated = document.createElement("span");
				updated.className = S.updated;
				updated.textContent = dict("updated", {
					time: new Date(justRefreshed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				});
				container.appendChild(updated);
			}
			return container;
		}

		/** The `费用 ¥x.xxxx` segment of the pill label. */
		function costSegment(dict, cost, costError) {
			const value = document.createElement("span");
			value.className = S.mergeVal;
			value.setAttribute("data-slot", "cost");
			if (costError !== null) {
				value.setAttribute("data-warn", "true");
				value.textContent = `${dict("cost")} ${dict("unavailable")}`;
				return value;
			}
			// The summary is still in flight (or the session has no priced
			// usage sample yet): an em dash WITHOUT the currency symbol, never a
			// `¥—` that reads like a broken number.
			if (cost === null) {
				value.textContent = `${dict("cost")} —`;
				return value;
			}
			value.appendChild(document.createTextNode(`${dict("cost")} `));
			value.appendChild(amountSpan(`${dict("currencySymbol")}${fmtCny(cost, 4)}`));
			return value;
		}

		/** A currency amount in the tabular-figure span the pill readings use. */
		function amountSpan(text) {
			const amount = document.createElement("span");
			amount.className = S.mergeAmount;
			amount.textContent = text;
			return amount;
		}

		/** The `| 余额 ¥y.yy` tail of the pill label, or null when unknown. */
		function buildBalanceSegment(dict, data) {
			const balanceError = data.balanceError;
			const hasBalance = data.hasBalance;
			if (balanceError === null && !hasBalance) return null;
			const segment = document.createElement("span");
			segment.className = S.mergeBalance;
			const separator = document.createElement("span");
			separator.className = S.mergeSep;
			separator.setAttribute("aria-hidden", "true");
			// The built-in pills separate their own readings with this middot
			// (`11 轮 · 565 步 · 297 tok/s`), so the cost and balance readings
			// join the same way instead of inventing a second separator style.
			separator.textContent = "·";
			segment.appendChild(separator);
			const value = document.createElement("span");
			value.className = S.mergeVal;
			value.setAttribute("data-slot", "balance");
			if (balanceError !== null) {
				value.setAttribute("data-warn", "true");
				value.textContent = balanceError === "no-credential"
					? dict("noCredential", { ref: data.balanceRef?.message ?? "" })
					: dict("unavailable");
			} else {
				if (data.totalValue < (data.lowBalanceThreshold ?? DEFAULT_LOW_BALANCE_CNY)) value.setAttribute("data-warn", "true");
				value.appendChild(document.createTextNode(`${dict("balance")} `));
				value.appendChild(amountSpan(`${dict("currencySymbol")}${fmtCny(data.totalValue, 2)}`));
			}
			segment.appendChild(value);
			return segment;
		}

		// The stats bar's own layout is never rewritten (see `runSync`): 0.1.5's
		// `.bOPqQW_root` is a centered flex row that caps and clips nothing, and
		// the ≤ 0.1.4 row that did need an inline widening patch is far outside
		// the supported range.
		//#endregion

		//#region SessionCostMerge
		/**
		 * The conversation-bottom stats-bar merge (the only display mode since
		 * 0.1.5; the standalone bar was removed). Renders a hidden anchor in
		 * the composer dock and appends the cost/balance segments INTO the
		 * built-in stats bar, which may mount after this component does.
		 * @param props - `useSession`/`useProjection` from the slot runtime and
		 *   `t` bound by the slot runtime locale seat.
		 */
		function SessionCostMerge({ useSession, useProjection, t }) {
			const dict = t !== void 0 ? t : (key) => zh[key] ?? key;
			const sessionId = useSession((snapshot) => snapshot.sessionId);
			const tokenUsage = useProjection("tokenUsage");

			const [summary, setSummary] = react.useState(null);
			const [balance, setBalance] = react.useState(null);
			const [summaryError, setSummaryError] = react.useState(null);
			const [balanceError, setBalanceError] = react.useState(null);
			const [refreshing, setRefreshing] = react.useState(false);
			const [justRefreshed, setJustRefreshed] = react.useState(null);
			// Panel open state, owned by React so it survives a merge-node
			// rebuild: the node is patched in place while its shape is stable,
			// but a shape change (a balance appearing, a segment erroring)
			// replaces it, and the replacement must re-open the same panel.
			const [panelOpen, setPanelOpen] = react.useState(false);
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

			// Low-balance threshold from the plugin settings
			// (设置 → 插件 → 插件配置).
			const config = react.useSyncExternalStore(configStore.subscribe, configStore.getSnapshot);
			const lowBalanceThreshold = config.lowBalanceThreshold;
			const anchorRef = react.useRef(null);
			const dictRef = react.useRef(dict);
			dictRef.current = dict;
			// React owns "is the panel open"; the DOM adapts on the next render.
			// The setter's identity is stable, so the data-push effect below can
			// depend on `panelOpen` alone.
			const togglePanel = react.useCallback((open) => setPanelOpen(open !== true), []);

			const cost = summary !== null && summary.ok === true ? numOrNull(summary.cost) : null;
			const models = summary !== null && Array.isArray(summary.models) ? summary.models : [];
			const bal = balance !== null && balance.ok === true ? balance.balance : null;
			const totalValue = bal === null ? null : numOrNull(bal.total);
			const hasBalance = totalValue !== null;

			// Keep a hidden anchor in the dock and append the cost/balance
			// segments INTO the built-in stats bar's DOM (see
			// `startStatsRowObserver` for how the late-appearing bar is tracked,
			// why the observer must span a subtree and re-arm itself, and how the
			// reading survives a session where DSH renders no bar at all).
			//
			// The bar's own styles are left alone: 0.1.5's `.bOPqQW_root` is a
			// centered flex row (`width:100%`, `max-width:748px`, `gap:12px`,
			// no overflow clipping), so an appended segment is simply a third
			// item in that group and the row is wide enough to hold it.
			//
			// Installed ONCE per mount, with the data pushed in by the effect
			// below: reinstalling on every poll used to tear the merge node down
			// and rebuild it (closing an open panel on each 30 s refresh) and it
			// masked the fact that a disarmed observer never came back.
			// One STABLE state object, refreshed in place on every render. The
			// merge node now outlives many renders (it is patched in place), and
			// its handlers read `onToggle`/`onRefresh` from this object at CLICK
			// time — replacing the object would freeze them on whichever render
			// happened to build the node (a refresh button bound to a stale
			// session, a toggle driving an unmounted component).
			const mergeRef = react.useRef(null);
			const mergeInputRef = react.useRef(null);
			if (mergeInputRef.current === null) mergeInputRef.current = {};
			const input = mergeInputRef.current;
			input.cost = cost;
			input.models = models;
			input.balance = bal;
			input.totalValue = totalValue;
			input.hasBalance = hasBalance;
			input.costError = summaryError;
			input.balanceError = balanceError;
			input.balanceRef = balance;
			input.refreshing = refreshing;
			input.justRefreshed = justRefreshed;
			input.lowBalanceThreshold = lowBalanceThreshold;
			input.open = panelOpen;
			input.onToggle = togglePanel;
			input.onRefresh = refreshAll;
			input.summary = summary;
			react.useEffect(() => {
				const handle = startStatsRowObserver(anchorRef.current, () => buildMergeNode(dictRef.current, mergeInputRef.current));
				mergeRef.current = handle;
				return () => {
					mergeRef.current = null;
					handle.dispose();
				};
			}, []);
			react.useEffect(() => {
				const handle = mergeRef.current;
				if (handle !== null) handle.sync();
			}, [dict, lowBalanceThreshold, summary, balance, summaryError, balanceError, refreshing, justRefreshed, panelOpen]);

			// The merge effect writes into the stats row; this anchor is the
			// React-visible presence marker (display:none).
			return react_jsx_runtime.jsx("div", {
				ref: anchorRef,
				className: S.anchor,
				"data-session-cost-anchor": ""
			});
		}
		//#endregion

		//#region SessionCostSettingsCard
		/**
		 * The plugin settings card, rendered inside the official
		 * 设置 → 插件 → 插件配置 tab (the `settings.plugin.item` seat). Edits
		 * the `lowBalanceThreshold` field of the `session-cost` settings
		 * namespace, applied immediately.
		 * @param props - `t` bound by the slot runtime locale seat.
		 */
		function SessionCostSettingsCard({ t }) {
			const dict = t !== void 0 ? t : (key) => zh[key] ?? key;
			const config = react.useSyncExternalStore(configStore.subscribe, configStore.getSnapshot);
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
							react_jsx_runtime.jsx(chevronDownIcon, {
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
		 * (the hidden anchor whose observer appends the cost/balance segments
		 * into the built-in stats bar) and the plugin settings card
		 * (设置 → 插件 → 插件配置), all backed by the `session-cost`
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
			}, SessionCostMerge));
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
		exports.SessionCostMerge = SessionCostMerge;
		exports.SessionCostSettingsCard = SessionCostSettingsCard;
		exports.findStatsRow = findStatsRow;
		exports.startStatsRowObserver = startStatsRowObserver;
		exports.chevronDownIcon = chevronDownIcon;
		exports.buildMergeNode = buildMergeNode;
		exports.createConfigStore = createConfigStore;
		exports.fmtCny = fmtCny;
		exports.LOW_BALANCE_CNY = DEFAULT_LOW_BALANCE_CNY;
		return module.exports;
	}
});
