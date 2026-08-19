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
	}
	get textContent() {
		if (this._text !== "") return this._text;
		return this.children.map((c) => c.textContent).join("");
	}
	set textContent(value) {
		this._text = String(value);
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
		const match = (el) => {
			if (selector.startsWith("[")) {
				const m = /^\[([\w-]+)(?:=(["']?)(.*?)\2)?\]$/.exec(selector);
				if (m !== null) {
					if (m[3] === void 0) return el.hasAttribute(m[1]);
					return el.getAttribute(m[1]) === m[3];
				}
				return false;
			}
			if (selector.startsWith(".")) return el.attrs.get("class")?.split(/\s+/).includes(selector.slice(1)) ?? false;
			return el.tagName === selector.toUpperCase();
		};
		const walk = (el) => {
			if (match(el)) return el;
			for (const child of el.children) {
				const hit = walk(child);
				if (hit !== null) return hit;
			}
			return null;
		};
		return walk(this);
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
vm.runInThisContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"));
assert.ok(descriptor !== null, "client bundle did not self-register");
const requireStub = (id) => ({});
const factory = descriptor.factory;
const exportsObj = factory(requireStub);

const { findStatsRow, buildMergeNode, createConfigStore, fmtCny } = exportsObj;
const zhDict = (key) => ({
	"本会话费用": "本会话费用", "余额": "余额", "刷新": "刷新", "刷新中…": "刷新中…",
	"已更新 {time}": "已更新 {time}", "暂不可用": "暂不可用", "未配置 {ref}": "未配置 {ref}",
	"currencySymbol": "¥", "tooltipCost": "本会话费用估算", "tooltipBalance": "账户余额",
	"tooltipInput": "输入", "tooltipOutput": "输出", "tooltipTokens": "tokens",
	"tooltipToppedUp": "充值余额", "tooltipGranted": "赠送余额", "tooltipUpdated": "更新于 {time}",
	"tooltipPricingNote": "note", "tooltipNoModels": "暂无 token 用量"
}[key] ?? key);

// ---- findStatsRow -----------------------------------------------------
const statsRow = new El("div");
statsRow.className = "FJxK0a_root";
statsRow.textContent = "3 轮 · 5 步 | LLM 12s | 输入 1.2K tok · 输出 300 tok";
const enRow = new El("div");
enRow.textContent = "3 turns · 5 steps | LLM 12s";
const anchor = new El("div");
anchor.setAttribute("data-session-cost-anchor", "");
const parent = new El("div");
parent.appendChild(statsRow);
parent.appendChild(anchor);
assert.equal(findStatsRow(parent), statsRow, "zh stats row not found");
const parent2 = new El("div");
parent2.appendChild(enRow);
parent2.appendChild(anchor);
assert.equal(findStatsRow(parent2), enRow, "en stats row not found");
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
assert.equal(store.getSnapshot().displayMode, "dock", "loading must fall back to dock");
assert.equal(store.getSnapshot().lowBalanceThreshold, 10, "loading must fall back to default 10");
assert.equal(store.getSnapshot().status, "loading");

// ready → resolved values flow through
mock.publish({ status: "ready", value: { displayMode: "stats", lowBalanceThreshold: 15 }, writable: true, mode: "host" });
assert.equal(store.getSnapshot().displayMode, "stats");
assert.equal(store.getSnapshot().lowBalanceThreshold, 15);

// unavailable → defaults again
mock.publish({ status: "unavailable", value: void 0, writable: false, mode: "host" });
assert.equal(store.getSnapshot().displayMode, "dock", "unavailable must fall back to dock");
assert.equal(store.getSnapshot().lowBalanceThreshold, 10, "unavailable must fall back to default");

// set() delegates to the scope (async) and sanitizes before writing
mock.publish({ status: "ready", value: { displayMode: "dock", lowBalanceThreshold: 10 }, writable: true, mode: "host" });
await store.set({ displayMode: "stats" });
assert.equal(mock.getSnapshot().value.displayMode, "stats", "set must write displayMode through the scope");
await store.set({ lowBalanceThreshold: -3 });
assert.equal(mock.getSnapshot().value.lowBalanceThreshold, 10, "negative threshold must be sanitized before the write");
await store.set({ lowBalanceThreshold: 25 });
assert.equal(mock.getSnapshot().value.lowBalanceThreshold, 25, "valid threshold must write through the scope");
await store.set({ displayMode: "dock", lowBalanceThreshold: 10 });
assert.equal(mock.getSnapshot().value.displayMode, "dock");

// subscribe notifications fire on scope changes
let notified = 0;
const off = store.subscribe(() => notified++);
mock.publish({ status: "ready", value: { displayMode: "dock", lowBalanceThreshold: 10 }, writable: true, mode: "host" });
assert.equal(notified, 1, "scope publish must notify store listeners");
off();
mock.publish({ status: "ready", value: { displayMode: "stats", lowBalanceThreshold: 10 }, writable: true, mode: "host" });
assert.equal(notified, 1, "unsubscribed listener must not fire");
store.dispose();

// ---- fmtCny -----------------------------------------------------------
assert.equal(fmtCny("7.09", 2), "7.09", "numeric string should format");
assert.equal(fmtCny(0.45493556, 4), "0.4549");
assert.equal(fmtCny(null, 2), "—");

console.log("client DOM smoke test passed");
