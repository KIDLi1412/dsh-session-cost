// DOM-stub smoke test for the client bundle's pure-ish pieces:
// loads lib/client.js through its __ModuleLoader__ factory with a minimal DOM
// shim, then exercises findStatsRow, buildMergeNode and configStore.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

// ---- minimal DOM shim ------------------------------------------------
/** CSSStyleDeclaration stand-in: properties plus the setProperty/getPropertyValue API. */
class Style {
	constructor() { this._map = new Map(); }
	// A real declaration exposes every property as an own accessor; the code
	// under test assigns `style.left = …` directly, so mirror those two.
	get left() { return this._map.get("left")?.value ?? ""; }
	set left(value) { this._map.set("left", { value: String(value), priority: "" }); }
	get top() { return this._map.get("top")?.value ?? ""; }
	set top(value) { this._map.set("top", { value: String(value), priority: "" }); }
	get visibility() { return this._map.get("visibility")?.value ?? ""; }
	set visibility(value) { this._map.set("visibility", { value: String(value), priority: "" }); }
	getPropertyValue(name) { return this._map.get(name)?.value ?? ""; }
	getPropertyPriority(name) { return this._map.get(name)?.priority ?? ""; }
	setProperty(name, value, priority = "") { this._map.set(name, { value: String(value), priority: priority || "" }); }
	removeProperty(name) { this._map.delete(name); }
}

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
		this.hidden = false;
		// Layout is stubbed: a fixed positive box keeps placePanel's arithmetic
		// finite, and getBoundingClientRect mirrors where the element sits.
		this.offsetWidth = 320;
		this.offsetHeight = 160;
		this.rect = { top: 100, bottom: 124, left: 40, right: 140, width: 100, height: 24 };
		this.style = new Style();
	}
	// Real DOM semantics: a text node's content IS its data, and writing a
	// string replaces every child. The earlier "own text first" shortcut hid
	// exactly the bug this shim is meant to catch (a text write on a container
	// wiping its child elements).
	get textContent() {
		if (this.children.length > 0) return this.children.map((c) => c.textContent).join("");
		return this._text;
	}
	set textContent(value) {
		this._text = String(value);
		this.children = [];
	}
	getBoundingClientRect() { return this.rect; }
	contains(node) {
		let current = node;
		while (current !== null && current !== void 0) {
			if (current === this) return true;
			current = current.parentElement;
		}
		return false;
	}
	dispatchEvent(event) {
		for (const fn of this.handlers[event.type] ?? []) fn(event);
		return true;
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
	replaceWith(other) {
		if (this.parentElement === null) return;
		const parent = this.parentElement;
		const index = parent.children.indexOf(this);
		if (index !== -1) parent.children[index] = other;
		other.parentElement = parent;
		this.parentElement = null;
	}
	setAttribute(name, value) { this.attrs.set(name, String(value)); }
	getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
	removeAttribute(name) { this.attrs.delete(name); }
	hasAttribute(name) { return this.attrs.has(name); }
	addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
	querySelector(selector) {
		const hits = this.querySelectorAll(selector);
		return hits.length === 0 ? null : hits[0];
	}
	querySelectorAll(selector) {
		// Compound-aware, deliberately tiny: split the comma list, then split
		// each selector into simple parts (`[attr…]`, `.class`, `tag`) and
		// require every part to match — enough for `[slot][flag]` lookups.
		const groups = selector.split(",").map((group) => {
			const parts = [];
			const pattern = /\[[^\]]*\]|\.[\w-]+|[A-Za-z][\w-]*/g;
			let hit;
			while ((hit = pattern.exec(group)) !== null) parts.push(hit[0]);
			return parts;
		});
		const matchesPart = (el, part) => {
			if (part.startsWith("[")) {
				const m = /^\[([\w-]+)(?:=(["']?)(.*?)\2)?\]$/.exec(part);
				if (m === null) return false;
				if (m[3] === void 0) return el.hasAttribute(m[1]);
				return el.getAttribute(m[1]) === m[3];
			}
			if (part.startsWith(".")) return el.attrs.get("class")?.split(/\s+/).includes(part.slice(1)) ?? false;
			return el.tagName === part.toUpperCase();
		};
		const matches = (el) => groups.some((parts) => parts.length > 0 && parts.every((part) => matchesPart(el, part)));
		const found = [];
		// Descendants only: querySelectorAll never matches the element itself.
		const walk = (el) => {
			for (const child of el.children) {
				if (matches(child)) found.push(child);
				walk(child);
			}
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
const body = new El("body");
root.appendChild(body);
const documentListeners = new Map();
const document = {
	createElement: (tag) => new El(tag),
	createElementNS: (_ns, tag) => new El(tag),
	createTextNode: (text) => {
		const node = new El("#text");
		node.textContent = String(text);
		return node;
	},
	querySelector: () => null,
	head: new El("head"),
	body,
	documentElement: root,
	addEventListener(type, fn) {
		if (!documentListeners.has(type)) documentListeners.set(type, []);
		documentListeners.get(type).push(fn);
	},
	removeEventListener(type, fn) {
		const list = documentListeners.get(type);
		if (list === void 0) return;
		const at = list.indexOf(fn);
		if (at !== -1) list.splice(at, 1);
	}
};
/** Fire every document-level listener of one type (outside-click / Escape). */
function fireDocument(type, event = {}) {
	for (const fn of [...(documentListeners.get(type) ?? [])]) fn({ type, target: null, ...event });
}

/** Minimal Event stand-in for the node's disposal event. */
class EventStub {
	constructor(type) { this.type = type; }
}

// ---- load the client bundle ------------------------------------------
let descriptor = null;
globalThis.window = {
	__ModuleLoader__: { load: (m) => { descriptor = m; } },
	addEventListener: () => {},
	innerWidth: 1280,
	innerHeight: 800
};
globalThis.document = document;
globalThis.MutationObserver = MutationObserverStub;
globalThis.Event = EventStub;
vm.runInThisContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"));
assert.ok(descriptor !== null, "client bundle did not self-register");
const requireStub = (id) => ({});
const factory = descriptor.factory;
const exportsObj = factory(requireStub);

const { findStatsRow, startStatsRowObserver, buildMergeNode, createConfigStore, fmtCny, applyMergeRowStyles, restoreMergeRowStyles } = exportsObj;
const zhDict = (key) => ({
	"cost": "费用", "balance": "余额", "费用": "费用", "余额": "余额", "刷新": "刷新", "刷新中…": "刷新中…",
	"已更新 {time}": "已更新 {time}", "暂不可用": "暂不可用", "未配置 {ref}": "未配置 {ref}",
	"currencySymbol": "¥", "tooltipCost": "本会话费用估算", "tooltipBalance": "账户余额",
	"tooltipInput": "输入", "tooltipOutput": "输出", "tooltipTokens": "tokens",
	"tooltipPeak": "peak", "tooltipOffpeak": "offpeak", "tooltipLegacy": "legacy",
	"tooltipToppedUp": "充值余额", "tooltipGranted": "赠送余额", "tooltipUpdated": "更新于 {time}",
	"tooltipPricingNote": "note", "tooltipNoModels": "暂无 token 用量", "unpriced": "未计价"
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
	models: [
		{ model: "deepseek-official/deepseek-v4-flash", inputTokens: 169013, outputTokens: 46512, cost: 0.4549, price: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 } },
		{ model: "deepseek-official/deepseek-v4-pro", inputTokens: 1000, outputTokens: 500, cost: 0.02, price: { input: 4.5 }, peakCost: 0.01, offpeakCost: 0.01 }
	],
	balance: { total: 6.43, toppedUp: 6.43, granted: 0 },
	totalValue: 6.43,
	hasBalance: true,
	costError: null,
	balanceError: null,
	balanceRef: null,
	refreshing: false,
	justRefreshed: null,
	open: false,
	onToggle: () => {},
	onRefresh: () => {},
	summary: { updatedAt: 1786809589811 },
	lowBalanceThreshold: 10,
	...over
});

// The panel is portaled to document.body (so the bar's overflow cannot clip
// it). Each node registers its own panel here so a test can address the panel
// of the node it just built rather than whichever one body lists first.
const panelsByNode = new WeakMap();
const nodePanel = (node) => panelsByNode.get(node) ?? null;
const built = (dict, data) => {
	const element = buildMergeNode(dict, data);
	if (element !== null) panelsByNode.set(element, body.querySelectorAll("[data-slot=panel]").at(-1) ?? null);
	return element;
};

// The trigger is a pill button (the ship's `.pill` recipe) whose label carries
// the two readings; the panel is the old hover tooltip, portaled and hidden.
const node = built(zhDict, mergeData());
assert.ok(node !== null, "merge node should be built");
const trigger = node.querySelector("[data-slot=trigger]");
assert.ok(trigger !== null, "trigger pill missing");
assert.equal(trigger.tagName, "BUTTON", "the trigger must be a button");
assert.equal(trigger.className, "sco_mergeBtn", "the trigger must wear the pill class");
assert.equal(trigger.getAttribute("aria-expanded"), "false", "a closed panel must report aria-expanded=false");
assert.equal(trigger.getAttribute("aria-haspopup"), "dialog", "the trigger must advertise its dialog");
assert.ok(trigger.querySelector("svg") !== null, "the trigger must lead with its ¥ glyph");
const triggerText = trigger.textContent;
assert.ok(triggerText.includes("费用 ¥0.4549"), `cost reading missing in "${triggerText}"`);
assert.ok(triggerText.includes("余额 ¥6.43"), `balance reading missing in "${triggerText}"`);
assert.equal(trigger.querySelector(".sco_mergeSep").textContent, "·", "the two readings must be joined by the official middot");
// The values carry the pill tier's regular weight (no bold) and keep their
// figures tabular, so they line up with the built-in readings.
assert.equal(trigger.querySelectorAll("span.sco_mergeAmount").length, 2, "both amounts must carry the tabular figure span");
// The leading glyph is a banknote, not a currency symbol: the label already
// carries the unit, so the icon must say WHAT is counted instead of repeating it.
const triggerIcon = trigger.querySelector("[data-slot=trigger-icon]");
assert.equal(triggerIcon.querySelector("rect") !== null, true, "the trigger glyph must be the banknote outline");
assert.equal(triggerIcon.querySelector("text"), null, "the glyph must not spell a currency symbol");
assert.equal(node.querySelectorAll(".sco_mergeVal").length, 2, "cost and balance values must be separate elements");
assert.equal(node.hasAttribute("title"), false, "the hover title must be gone (the panel replaced it)");

// The panel is portaled to document.body (so the bar's overflow cannot clip
// it), which is why it is looked up through the node's registration above.
const panel = nodePanel(node);
assert.ok(panel !== null, "details panel missing");assert.equal(panel.hidden, true, "the panel must start closed");
assert.equal(panel.getAttribute("role"), "dialog", "the panel must be a dialog");
// Panel content: title total, one row pair per model, balance split.
assert.equal(panel.querySelector("[data-slot=title-value]").textContent, "¥0.4549", "title total missing");
assert.equal(panel.querySelectorAll("[data-slot=row-label]").length, 5, "two model rows + balance + toppedUp + granted expected");
const modelValue = panel.querySelectorAll("[data-slot=row-value]")[0].textContent;
assert.ok(modelValue.includes("输入 169,013") && modelValue.includes("¥0.4549"), `model row malformed: "${modelValue}"`);
// A model that billed two periods appends the 峰谷 split.
const splitValue = panel.querySelectorAll("[data-slot=row-value]")[1].textContent;
assert.ok(splitValue.includes("peak ¥0.01") && splitValue.includes("offpeak ¥0.01"), `billing split missing: "${splitValue}"`);
// A model with no pricing entry is flagged instead of reading as free.
const unpricedNode = built(zhDict, mergeData({
	models: [{ model: "deepseek-official/deepseek-v99", inputTokens: 10, outputTokens: 5, cost: 0, price: null }]
}));
const unpricedRow = nodePanel(unpricedNode).querySelector("[data-slot=row-value]");
assert.ok(unpricedRow.textContent.includes("未计价"), `an unpriced model must be flagged: "${unpricedRow.textContent}"`);
assert.equal(unpricedRow.getAttribute("data-warn"), "true", "the unpriced flag must be a warning");
assert.equal(panel.querySelector("[data-slot=panel-balance]").textContent, "¥6.43", "panel balance missing");
assert.ok(panel.querySelector("[data-slot=panel-note]").textContent.length > 0, "the pricing note must be shown");
const refresh = panel.querySelector("[data-slot=refresh]");
assert.ok(refresh !== null, "refresh button missing");
assert.equal(refresh.disabled, false);
assert.ok(panel.querySelector("[data-slot=panel-updated]").textContent.includes("更新于"), "update time missing");
assert.equal(panel.parentElement.tagName, "BODY", "the panel must be portaled to body so the bar cannot clip it");

// Threshold behavior: 6.43 < 10 → warn (red); 6.43 < 5 → no warn.
const warnVal = node.querySelector("[data-slot=balance][data-warn=true]");
assert.ok(warnVal !== null, "balance below threshold must be marked warn");
assert.ok(warnVal.textContent.includes("¥6.43"), "the warn element must be the balance reading");
const noWarn = buildMergeNode(zhDict, mergeData({ lowBalanceThreshold: 5 }));
assert.equal(noWarn.querySelector("[data-slot=balance][data-warn=true]"), null, "balance above threshold must not be marked warn");

// An open panel keeps its open flag on the node; its OWNER places it once the
// node is in the DOM (`startStatsRowObserver` calls placeOpenPanel), so a
// freshly built node is correctly not placed yet.
const openNode = buildMergeNode(zhDict, mergeData({ open: true }));
panelsByNode.set(openNode, body.querySelectorAll("[data-slot=panel]").at(-1) ?? null);
const openPanel = nodePanel(openNode);
assert.equal(openPanel.hidden, false, "an open panel must not be hidden");
assert.equal(openPanel.getAttribute("role"), "dialog");
assert.equal(openNode.querySelector("[data-slot=trigger]").getAttribute("aria-expanded"), "true");
assert.equal(openPanel.style.visibility, "", "an unplaced panel must not claim to be visible");

// Escaping not offered: the panel closes on Escape and on an outside pointerdown.
const toggleCalls = [];
const interactive = buildMergeNode(zhDict, mergeData({ open: true, onToggle: (open) => toggleCalls.push(open) }));
panelsByNode.set(interactive, body.querySelectorAll("[data-slot=panel]").at(-1) ?? null);
const interactivePanel = nodePanel(interactive);
interactive.querySelector("[data-slot=trigger]").dispatchEvent(new EventStub("click"));
assert.deepEqual(toggleCalls, [true], "clicking an open pill must ask to close it");
fireDocument("keydown", { key: "Escape" });
assert.deepEqual(toggleCalls, [true, true], "Escape must ask to close the panel");
fireDocument("pointerdown", { target: new El("div") });
assert.deepEqual(toggleCalls, [true, true, true], "an outside pointerdown must ask to close the panel");
fireDocument("pointerdown", { target: interactivePanel });
assert.equal(toggleCalls.length, 3, "a pointerdown inside the panel must not close it");
// Disposal drops the document listeners and the portaled panel.
interactive.dispatchEvent(new EventStub("session-cost:dispose"));
fireDocument("keydown", { key: "Escape" });
assert.equal(toggleCalls.length, 3, "a disposed node must stop reacting to document events");
assert.equal(interactivePanel.parentElement, null, "disposal must remove the portaled panel");

// Nothing to show → null (used to clean up when the row loses content).
assert.equal(buildMergeNode(zhDict, {
	cost: null, models: [], balance: null, totalValue: null, hasBalance: false,
	costError: null, balanceError: null, balanceRef: null, refreshing: false, justRefreshed: null, open: false, onToggle: () => {}, onRefresh: () => {}, summary: null, lowBalanceThreshold: 10
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
// Nothing to build against yet: no bar, so no candidate is even asked for. The
// observer is installed anyway — that is the point of this regression.
assert.equal(mergeCalls.length, 0, "no bar yet means no merge candidate is built");
assert.ok(MutationObserverStub.instances.length > 0, "the observer must be installed before any data exists");

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

// Teardown removes the node, restores the inline styles and disconnects.
disposeObserver();
assert.equal(liveBar.querySelector("[data-session-cost-merge]"), null, "teardown must remove the merge node");
assert.equal(liveBar.style.getPropertyValue("max-width"), "", "teardown must restore the bar's inline styles");
assert.ok(observer.disconnected > 0, "teardown must disconnect the observer");
assert.equal(startStatsRowObserver(null, () => null)(), void 0, "a missing anchor must be a safe no-op");

// A data change patches values in place: same node, same trigger (listener
// intact, panel open) with the new readings. The shape stays identical here —
// the same segments are present — which is exactly when patching applies.
let liveState = mergeData({ open: true });
const disposePatched = startStatsRowObserver(liveAnchor, () => buildMergeNode(zhDict, liveState));
const patched = liveBar.querySelector("[data-session-cost-merge]");
const patchedTrigger = patched.querySelector("[data-slot=trigger]");
const patchedPanel = body.querySelectorAll("[data-slot=panel]").at(-1);
assert.equal(patchedPanel.hidden, false, "an open panel must survive the mount");
assert.equal(patchedPanel.style.visibility, "visible", "the mounted panel must be placed");
assert.equal(patchedPanel.style.top, "132px", "the mounted panel must sit above its trigger");
liveState = mergeData({ open: true, cost: 1.5, totalValue: 2.5 });
MutationObserverStub.instances.at(-1).fire();
const afterPatch = liveBar.querySelector("[data-session-cost-merge]");
assert.equal(afterPatch, patched, "an update must patch the node, not replace it");
assert.equal(afterPatch.querySelector("[data-slot=trigger]"), patchedTrigger, "the trigger element must be preserved");
assert.ok(afterPatch.querySelector("[data-slot=cost]").textContent.includes("¥1.5"), "the cost reading must update");
assert.ok(afterPatch.querySelector("[data-slot=balance]").textContent.includes("¥2.5"), "the balance reading must update");
assert.equal(body.querySelectorAll("[data-slot=panel]").at(-1), patchedPanel, "the panel element must be preserved");
assert.equal(patchedPanel.hidden, false, "the patch must not close an open panel");
// The candidate node built for the patch is discarded with its own panel, so a
// sync never leaks a panel into document.body.
const panelsInBody = body.querySelectorAll("[data-slot=panel]").length;
MutationObserverStub.instances.at(-1).fire();
assert.equal(body.querySelectorAll("[data-slot=panel]").length, panelsInBody, "a sync must not leak a panel");
disposePatched();
assert.equal(patchedPanel.parentElement, null, "teardown must remove the portaled panel");

// The DATA, not just the bar, can arrive late: on a freshly started host the
// first summary/balance responses are still in flight while the component
// mounts. An empty merge state must therefore still install the observer (the
// earlier bail-out is exactly why the pill only showed up after a page reload
// had warmed the data), and the merge must appear once the payload lands.
const emptyStateHost = new El("div");
root.appendChild(emptyStateHost);
const emptyAnchor = new El("div");
emptyAnchor.setAttribute("data-session-cost-anchor", "");
emptyStateHost.appendChild(emptyAnchor);
const emptyBar = new El("div");
emptyBar.setAttribute("data-composer-stats", "");
emptyStateHost.appendChild(emptyBar);
let payload = null; // nothing fetched yet
const observerCount = MutationObserverStub.instances.length;
const disposeEmpty = startStatsRowObserver(emptyAnchor, () => (payload === null ? null : buildMergeNode(zhDict, payload)));
assert.equal(MutationObserverStub.instances.length, observerCount + 1, "an empty merge state must still install an observer");
assert.equal(emptyBar.querySelector("[data-session-cost-merge]"), null, "no data yet means no merge node");
// The payload arrives; the next mutation must attach the merge.
payload = mergeData();
MutationObserverStub.instances.at(-1).fire();
assert.ok(emptyBar.querySelector("[data-session-cost-merge]") !== null, "the merge must attach when the data arrives after mount");
disposeEmpty();
assert.equal(emptyBar.querySelector("[data-session-cost-merge]"), null, "teardown must remove the late-attached merge");
assert.equal(startStatsRowObserver(null, () => null)(), void 0, "a missing anchor must be a safe no-op");

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
