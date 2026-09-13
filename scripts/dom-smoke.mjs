// DOM-stub smoke test for the client bundle's pure-ish pieces:
// loads lib/client.js through its __ModuleLoader__ factory with a minimal DOM
// shim, then exercises findStatsRow, buildMergeNode and configStore.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

// ---- minimal DOM shim ------------------------------------------------
class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.nodeType = 1;
		this.children = [];
		this.parentElement = null;
		this.attrs = new Map();
		this.dataset = {};
		this._text = "";
		this.handlers = {};
		this.disabled = false;
		this.style = {
			_map: new Map(),
			getPropertyValue(name) { return this._map.get(name)?.value ?? ""; },
			getPropertyPriority(name) { return this._map.get(name)?.priority ?? ""; },
			setProperty(name, value, priority = "") { this._map.set(name, { value: String(value), priority: priority || "" }); },
			removeProperty(name) { this._map.delete(name); }
		};
	}
	get textContent() {
		if (this._text !== "") return this._text;
		return this.children.map((c) => c.textContent).join("");
	}
	set textContent(value) {
		this._text = String(value);
	}
	get className() {
		return this.attrs.get("class") ?? "";
	}
	set className(value) {
		this.setAttribute("class", String(value));
	}
	appendChild(child) {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}
	remove() {
		if (this.parentElement === null) return;
		const index = this.parentElement.children.indexOf(this);
		if (index !== -1) this.parentElement.children.splice(index, 1);
		this.parentElement = null;
	}
	setAttribute(name, value) { this.attrs.set(name, String(value)); }
	getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
	hasAttribute(name) { return this.attrs.has(name); }
	addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
	querySelector(selector) {
		const hits = this.querySelectorAll(selector);
		return hits.length === 0 ? null : hits[0];
	}
	querySelectorAll(selector) {
		const parts = selector.split(",").map((part) => part.trim());
		const matches = (el) => {
			for (const part of parts) {
				if (part.startsWith("[")) {
					const m = /^\[([\w-]+)(?:=(["']?)(.*?)\2)?\]$/.exec(part);
					if (m !== null) {
						if (m[3] === void 0) {
							if (el.hasAttribute(m[1])) return true;
						} else if (el.getAttribute(m[1]) === m[3]) return true;
					}
					continue;
				}
				if (part.startsWith(".")) {
					if (el.attrs.get("class")?.split(/\s+/).includes(part.slice(1)) ?? false) return true;
					continue;
				}
				if (el.tagName === part.toUpperCase()) return true;
			}
			return false;
		};
		const found = [];
		const walk = (el) => {
			if (matches(el)) found.push(el);
			for (const child of el.children) walk(child);
		};
		walk(this);
		return found;
	}
	get isConnected() {
		let node = this;
		while (node.parentElement !== null) node = node.parentElement;
		return node.tagName === "#ROOT";
	}
	get outerHTML() {
		const attrs = [...this.attrs.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
		const body = this._text !== "" ? this._text : this.children.map((c) => c.outerHTML).join("");
		return `<${this.tagName.toLowerCase()}${attrs}>${body}</${this.tagName.toLowerCase()}>`;
	}
}

// MutationObserver double: records observed targets and lets a test fire the
// callback by hand (the real browser dispatches it; the smoke test just needs
// the wiring: what is observed, and that a fire re-runs the sync).
class MutationObserverStub {
	constructor(callback) {
		this.callback = callback;
		this.targets = [];
		this.options = [];
		this.disconnected = 0;
		MutationObserverStub.instances.push(this);
	}
	observe(target, options) { this.targets.push(target); this.options.push(options); }
	disconnect() { this.disconnected += 1; this.targets = []; }
	fire() { this.callback([], this); }
}
MutationObserverStub.instances = [];

const root = new El("#root");
const document = {
	createElement: (tag) => new El(tag),
	createElementNS: (_ns, tag) => new El(tag),
	querySelector: () => null,
	head: new El("head"),
	documentElement: root
};

// ---- load the client bundle ------------------------------------------
let descriptor = null;
globalThis.window = {
	__ModuleLoader__: { load: (m) => { descriptor = m; } },
	addEventListener: () => {}
};
globalThis.document = document;
globalThis.MutationObserver = MutationObserverStub;
vm.runInThisContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"));
assert.ok(descriptor !== null, "client bundle did not self-register");
const requireStub = (id) => ({});
const factory = descriptor.factory;
const exportsObj = factory(requireStub);

const { findStatsRow, startStatsRowObserver, buildMergeNode, createConfigStore, fmtCny, applyMergeRowStyles, restoreMergeRowStyles } = exportsObj;
const zhDict = (key) => ({
	"本会话费用": "本会话费用", "余额": "余额", "刷新": "刷新", "刷新中…": "刷新中…",
	"已更新 {time}": "已更新 {time}", "暂不可用": "暂不可用", "未配置 {ref}": "未配置 {ref}",
	"currencySymbol": "¥", "tooltipCost": "本会话费用估算", "tooltipBalance": "账户余额",
	"tooltipInput": "输入", "tooltipOutput": "输出", "tooltipTokens": "tokens",
	"tooltipToppedUp": "充值余额", "tooltipGranted": "赠送余额", "tooltipUpdated": "更新于 {time}",
	"tooltipPricingNote": "note", "tooltipNoModels": "暂无 token 用量"
}[key] ?? key);

// ---- findStatsRow -----------------------------------------------------
// The hidden dock anchor every case below shares (a sibling dock entry).
const anchor = new El("div");
anchor.setAttribute("data-session-cost-anchor", "");

// 0.1.5 shape: the bar is a flex container of icon pills carrying
// data-composer-stats; its counts text has NO separator ("2 轮 61 步").
const pillsRow = new El("div");
pillsRow.setAttribute("data-composer-stats", "");
const timePill = new El("span");
timePill.className = "bOPqQW_anchor";
timePill.textContent = "2 轮 61 步 · 287 tok/s";
const usagePill = new El("span");
usagePill.className = "bOPqQW_anchor";
usagePill.textContent = "6.6M tok · 缓存命中 97%";
pillsRow.appendChild(timePill);
pillsRow.appendChild(usagePill);
const pillsHost = new El("div");
pillsHost.appendChild(pillsRow);
pillsHost.appendChild(anchor);
assert.equal(findStatsRow(pillsHost), pillsRow, "0.1.5 pill bar (data-composer-stats) not found");

// ≤ 0.1.4 shape: a single text row, zh and en.
const statsRow = new El("div");
statsRow.className = "FJxK0a_root";
statsRow.textContent = "3 轮 · 5 步 | LLM 12s | 输入 1.2K tok · 输出 300 tok";
const enRow = new El("div");
enRow.textContent = "3 turns · 5 steps | LLM 12s";
const parent = new El("div");
parent.appendChild(statsRow);
parent.appendChild(anchor);
assert.equal(findStatsRow(parent), statsRow, "zh stats row not found");
const parent2 = new El("div");
parent2.appendChild(enRow);
parent2.appendChild(anchor);
assert.equal(findStatsRow(parent2), enRow, "en stats row not found");
// Newer zh wording without the middle dot, and with a leading icon glyph.
const plainRow = new El("div");
plainRow.textContent = "2 轮 61 步 · 287 tok/s";
const parent3 = new El("div");
parent3.appendChild(plainRow);
parent3.appendChild(anchor);
assert.equal(findStatsRow(parent3), plainRow, "separator-less zh stats row not found");
// A bar nested inside a dock wrapper still resolves.
const wrapper = new El("div");
const nested = new El("div");
nested.setAttribute("data-composer-stats", "");
wrapper.appendChild(nested);
const parent4 = new El("div");
parent4.appendChild(wrapper);
parent4.appendChild(anchor);
assert.equal(findStatsRow(parent4), wrapper, "nested stats bar must resolve through the wrapper");
assert.equal(findStatsRow(new El("div")), null, "empty container should return null");

// ---- buildMergeNode ---------------------------------------------------
const mergeData = (over = {}) => ({
	cost: 0.4549,
	models: [{ model: "deepseek-official/deepseek-v4-flash", inputTokens: 169013, outputTokens: 46512, cost: 0.4549 }],
	balance: { total: 6.43, toppedUp: 6.43, granted: 0 },
	totalValue: 6.43,
	hasBalance: true,
	costError: null,
	balanceError: null,
	balanceRef: null,
	refreshing: false,
	justRefreshed: null,
	onRefresh: () => {},
	summary: { updatedAt: 1786809589811 },
	lowBalanceThreshold: 10,
	...over
});
const node = buildMergeNode(zhDict, mergeData());
assert.ok(node !== null, "merge node should be built");
const text = node.textContent;
assert.ok(text.includes("¥0.4549"), `cost value missing in "${text}"`);
assert.ok(text.includes("¥6.43"), `balance value missing in "${text}"`);
assert.ok(node.hasAttribute("title"), "hover title missing");
const button = node.querySelector("button");
assert.ok(button !== null, "refresh button missing");
assert.equal(button.disabled, false);
// 0.1.5 pill parity: the cost reading leads with its own glyph, and the label
// and value are separate elements (no trailing separator space baked in).
assert.ok(node.querySelector("svg") !== null, "cost glyph missing");
assert.ok(node.querySelectorAll(".sco_mergeVal").length === 2, "cost and balance values must be separate elements");
assert.equal(node.querySelector(".sco_mergeSep").textContent, "|", "cost and balance must be separated");
// The label is its own element: the spacing between glyph, label and value is
// the flex gap, so no literal space is baked into the text nodes.
assert.ok(node.textContent.includes("cost¥0.4549"), `label and value must be adjacent text nodes in "${text}"`);

// Threshold behavior: 6.43 < 10 → warn (red); 6.43 < 5 → no warn (black).
const warnVal = node.querySelector("[data-warn=true]");
assert.ok(warnVal !== null, "balance below threshold must be marked warn");
assert.equal(warnVal.textContent, "¥6.43", "the warn element must be the balance value");
const noWarn = buildMergeNode(zhDict, mergeData({ lowBalanceThreshold: 5 }));
assert.equal(noWarn.querySelector("[data-warn=true]"), null, "balance above threshold must not be marked warn");

// Identical rebuilds must be stable (outerHTML compare used by sync()).
const node2 = buildMergeNode(zhDict, mergeData());
assert.equal(node.outerHTML, node2.outerHTML, "identical data must produce identical node HTML");

// Nothing to show → null (used to clean up when the row loses content).
assert.equal(buildMergeNode(zhDict, {
	cost: null, models: [], balance: null, totalValue: null, hasBalance: false,
	costError: null, balanceError: null, balanceRef: null, refreshing: false, justRefreshed: null, onRefresh: () => {}, summary: null, lowBalanceThreshold: 10
}), null, "empty state should build no node");

// ---- startStatsRowObserver (the late-appearing 0.1.5 bar) -------------
// Regression for the DSH 0.1.5 breakage: `StatsPills` renders NOTHING until
// the session has steps or tokens, so at mount time the dock container holds
// only our anchor. The merge used to be attached by observing the container's
// own childList, which never fires when the bar mounts one level down — the
// observer now spans the container subtree, so the bar appearing later is
// still picked up.
const liveHost = new El("div");
root.appendChild(liveHost);
const liveAnchor = new El("div");
liveAnchor.setAttribute("data-session-cost-anchor", "");
liveHost.appendChild(liveAnchor);
const liveBar = new El("div");
liveBar.setAttribute("data-composer-stats", "");
const livePill = new El("span");
livePill.textContent = "2 轮 61 步";
liveBar.appendChild(livePill);
const mergeCalls = [];
const disposeObserver = startStatsRowObserver(liveAnchor, () => {
	mergeCalls.push(Date.now());
	return buildMergeNode(zhDict, mergeData());
});
assert.equal(mergeCalls.length, 1, "observer must probe the merge state once up front");

// The bar mounts later, exactly like StatsPills flipping from null to a bar.
liveHost.appendChild(liveBar);
const observer = MutationObserverStub.instances[MutationObserverStub.instances.length - 1];
assert.ok(observer.targets.includes(liveHost), "the observer must watch the dock container");
assert.equal(observer.options[0].subtree, true, "the observer must span the container subtree");
assert.equal(observer.options[0].childList, true, "the observer must watch childList");
observer.fire();
const appended = liveBar.querySelector("[data-session-cost-merge]");
assert.ok(appended !== null, "bar appearing after mount must receive the merge");
assert.equal(liveBar.style.getPropertyValue("max-width"), "none", "the bar must be widened for the appended row");

// A second sync with identical data must keep the SAME node (listener intact).
const sameNode = liveBar.querySelector("[data-session-cost-merge]");
observer.fire();
assert.equal(liveBar.querySelector("[data-session-cost-merge]"), sameNode, "identical state must not rebuild the merge node");

// Teardown removes the node, restores the inline styles and disconnects.
disposeObserver();
assert.equal(liveBar.querySelector("[data-session-cost-merge]"), null, "teardown must remove the merge node");
assert.equal(liveBar.style.getPropertyValue("max-width"), "", "teardown must restore the bar's inline styles");
assert.ok(observer.disconnected > 0, "teardown must disconnect the observer");
assert.equal(startStatsRowObserver(null, () => null)(), void 0, "a missing anchor must be a safe no-op");
// With nothing to display there is no bar to decorate: no observer is built.
const observerCount = MutationObserverStub.instances.length;
assert.equal(startStatsRowObserver(liveAnchor, () => null)(), void 0, "an empty merge state must be a safe no-op");
assert.equal(MutationObserverStub.instances.length, observerCount, "an empty merge state must not install an observer");

// ---- createConfigStore (settings-scope backed) ------------------------
// The store wraps a bound settings scope; exercise it with a controllable
// mock scope instead of a live one (the live scope needs the browser +
// Host settings transport).
function createMockScope(initial) {
	const listeners = new Set();
	let snapshot = initial;
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		set: async (field, value) => {
			snapshot = { ...snapshot, value: { ...(snapshot.value ?? {}), [field]: value } };
			for (const l of listeners) l();
		},
		unset: async (field) => {
			const value = { ...snapshot.value };
			delete value[field];
			snapshot = { ...snapshot, value };
			for (const l of listeners) l();
		},
		// test helper: publish an arbitrary snapshot (scope-load simulation)
		publish: (next) => { snapshot = next; for (const l of listeners) l(); }
	};
}

const mock = createMockScope({ status: "loading", value: void 0, writable: false, mode: "host" });
const store = createConfigStore(mock);
assert.equal(store.getSnapshot().lowBalanceThreshold, 10, "loading must fall back to default 10");
assert.equal(store.getSnapshot().status, "loading");

// ready → resolved values flow through
mock.publish({ status: "ready", value: { lowBalanceThreshold: 15 }, writable: true, mode: "host" });
assert.equal(store.getSnapshot().lowBalanceThreshold, 15);

// unavailable → defaults again
mock.publish({ status: "unavailable", value: void 0, writable: false, mode: "host" });
assert.equal(store.getSnapshot().lowBalanceThreshold, 10, "unavailable must fall back to default");

// set() delegates to the scope (async) and sanitizes before writing
mock.publish({ status: "ready", value: { lowBalanceThreshold: 10 }, writable: true, mode: "host" });
await store.set({ lowBalanceThreshold: -3 });
assert.equal(mock.getSnapshot().value.lowBalanceThreshold, 10, "negative threshold must be sanitized before the write");
await store.set({ lowBalanceThreshold: 25 });
assert.equal(mock.getSnapshot().value.lowBalanceThreshold, 25, "valid threshold must write through the scope");
await store.set({ lowBalanceThreshold: 10 });
assert.equal(mock.getSnapshot().value.lowBalanceThreshold, 10);

// subscribe notifications fire on scope changes
let notified = 0;
const off = store.subscribe(() => notified++);
mock.publish({ status: "ready", value: { lowBalanceThreshold: 10 }, writable: true, mode: "host" });
assert.equal(notified, 1, "scope publish must notify store listeners");
off();
mock.publish({ status: "ready", value: { lowBalanceThreshold: 5 }, writable: true, mode: "host" });
assert.equal(notified, 1, "unsubscribed listener must not fire");
store.dispose();

// ---- merge-row styles (apply/restore round-trip) ----------------------
// The built-in StatsLine root caps at 748px with overflow:hidden + ellipsis
// (DSH rc.7+), clipping the appended merge node; applyMergeRowStyles widens +
// unclips the row, restoreMergeRowStyles puts the prior inline values back.
const styledRow = new El("div");
styledRow.style.setProperty("max-width", "900px");
styledRow.style.setProperty("overflow", "hidden");
applyMergeRowStyles(styledRow);
assert.equal(styledRow.style.getPropertyValue("max-width"), "none", "merge must widen the row");
assert.equal(styledRow.style.getPropertyValue("overflow"), "visible", "merge must unclip the row");
assert.equal(styledRow.style.getPropertyValue("text-overflow"), "clip", "merge must drop the ellipsis");
applyMergeRowStyles(styledRow);
assert.equal(styledRow.style.getPropertyValue("max-width"), "none", "re-apply must be idempotent");
restoreMergeRowStyles(styledRow);
assert.equal(styledRow.style.getPropertyValue("max-width"), "900px", "prior max-width must be restored");
assert.equal(styledRow.style.getPropertyValue("overflow"), "hidden", "prior overflow must be restored");
assert.equal(styledRow.style.getPropertyValue("text-overflow"), "", "absent text-overflow must be removed again");
restoreMergeRowStyles(styledRow);
assert.equal(styledRow.style.getPropertyValue("max-width"), "900px", "double restore must be a no-op");
const untouchedRow = new El("div");
restoreMergeRowStyles(untouchedRow);
applyMergeRowStyles(untouchedRow);
restoreMergeRowStyles(untouchedRow);
assert.equal(untouchedRow.style.getPropertyValue("max-width"), "", "plain row must end untouched");
assert.equal(untouchedRow.style.getPropertyValue("overflow"), "", "plain row must end untouched (overflow)");
assert.equal(applyMergeRowStyles(null), void 0, "null row must be a safe no-op");

// ---- fmtCny -----------------------------------------------------------
assert.equal(fmtCny("7.09", 2), "7.09", "numeric string should format");
assert.equal(fmtCny(0.45493556, 4), "0.4549");
assert.equal(fmtCny(null, 2), "—");

console.log("client DOM smoke test passed");
