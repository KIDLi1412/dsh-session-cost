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
	// The list patch trims surplus cells through `lastElementChild`; a stub that
	// lacks it would turn that branch into a contained failure instead of a red
	// test.
	get lastElementChild() {
		return this.children.length === 0 ? null : this.children[this.children.length - 1];
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

/**
 * The inline properties an element carries, sorted. Used to prove the plugin
 * does NOT rewrite the built-in bar's layout: since DSH 0.1.5 the bar is a
 * centered flex row that caps and clips nothing, so it must stay untouched.
 */
const inlineStyleProps = (el) => [...el.style._map.keys()].sort();

// ---- load the client bundle ------------------------------------------
let descriptor = null;
// Timers: the stats-row observer arms a watchdog interval that repairs a merge
// the mutation stream could not report. The stub records the callbacks so the
// test can tick them by hand instead of waiting on wall-clock time.
const intervals = new Map();
let intervalSeq = 0;
function tickIntervals() {
	for (const entry of [...intervals.values()]) entry.fn();
}
globalThis.window = {
	__ModuleLoader__: { load: (m) => { descriptor = m; } },
	addEventListener: () => {},
	innerWidth: 1280,
	innerHeight: 800,
	setInterval: (fn, ms) => {
		intervalSeq += 1;
		intervals.set(intervalSeq, { fn, ms });
		return intervalSeq;
	},
	clearInterval: (id) => { intervals.delete(id); }
};
globalThis.document = document;
globalThis.MutationObserver = MutationObserverStub;
globalThis.Event = EventStub;
vm.runInThisContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"));
assert.ok(descriptor !== null, "client bundle did not self-register");
const requireStub = (id) => ({});
const factory = descriptor.factory;
const exportsObj = factory(requireStub);

const { findStatsRow, startStatsRowObserver, buildMergeNode, createConfigStore, fmtCny } = exportsObj;
const zhDict = (key) => ({
	"cost": "费用", "balance": "余额", "费用": "费用", "余额": "余额", "刷新": "刷新", "刷新中…": "刷新中…",
	"已更新 {time}": "已更新 {time}", "暂不可用": "暂不可用", "未配置 {ref}": "未配置 {ref}",
	"currencySymbol": "¥", "tooltipCost": "本会话费用估算", "tooltipBalance": "账户余额",
	"tooltipInput": "输入", "tooltipOutput": "输出", "tooltipTokens": "tokens",
	"tooltipPeak": "peak", "tooltipOffpeak": "offpeak", "tooltipLegacy": "legacy",
	"tooltipToppedUp": "充值余额", "tooltipGranted": "赠送余额", "tooltipUpdated": "更新于 {time}",
	"tooltipPricingNote": "note", "tooltipNoModels": "暂无 token 用量", "unpriced": "未计价",
	"settingsThreshold": "低余额阈值", "settingsThresholdUnit": "元", "settingsThresholdHint": "低于该值显示为红色"
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
// The leading glyph is a wallet, not a currency symbol: the label already
// carries the unit, so the icon must say WHAT is counted instead of repeating it.
const triggerIcon = trigger.querySelector("[data-slot=trigger-icon]");
assert.equal(triggerIcon.querySelector("rect") !== null, true, "the trigger glyph must be the wallet outline");
assert.equal(triggerIcon.querySelector("path") !== null, true, "the wallet needs its flap line");
assert.equal(triggerIcon.querySelector("circle") !== null, true, "the wallet needs its clasp dot");
assert.equal(triggerIcon.querySelector("text"), null, "the glyph must not spell a currency symbol");
assert.equal(node.querySelectorAll(".sco_mergeVal").length, 2, "cost and balance values must be separate elements");
assert.equal(node.hasAttribute("title"), false, "the hover title must be gone (the panel replaced it)");

// The panel is portaled to document.body (so the bar's overflow cannot clip
// it), which is why it is looked up through the node's registration above.
const panel = nodePanel(node);
assert.ok(panel !== null, "details panel missing");assert.equal(panel.hidden, true, "the panel must start closed");
assert.equal(panel.getAttribute("role"), "dialog", "the panel must be a dialog");
// Panel content: title total, one row pair per model, balance split — the
// reading grid is numbers only; the low-balance threshold field is a line of
// its own under the 更新于/⟳ row (see the dedicated case further down).
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

// A summary that has not landed yet (a restart, or a session with no priced
// usage sample yet) reads as an em dash — never a `¥—` that looks like a broken
// number. This state is now visible on its own, because the pill also renders
// while DSH's own stats bar does not exist yet. It is also the state that used
// to CRASH the merge: `rowElement` hands back a dt/dd pair, and appending the
// array itself throws in a real DOM (`appendChild` takes a node).
const pendingCost = built(zhDict, mergeData({ cost: null, models: [] }));
assert.equal(pendingCost.querySelector("[data-slot=cost]").textContent, "费用 —", "an unknown cost must not print a currency symbol");
const pendingPanel = nodePanel(pendingCost);
assert.equal(pendingPanel.querySelector("[data-slot=title-value]").textContent, "—", "the panel title must show a bare dash for an unknown cost");
const pendingRows = pendingPanel.querySelectorAll("[data-slot=row-label]");
assert.ok(pendingRows.some((row) => row.textContent === "暂无 token 用量"), "a session with no usage sample must say so in the panel");
// Every child of the panel is an element: no array (or other non-node) ever
// reaches `appendChild`.
for (const child of pendingPanel.children) assert.equal(child.nodeType, 1, "the panel must only ever contain elements");

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
const live = startStatsRowObserver(liveAnchor, () => buildMergeNode(zhDict, mergeData()));
// No bar yet, so the reading is hosted by the anchor itself (with the bar's own
// metrics) instead of being dropped with the bar it used to live in — this is
// what a cold session shows for the second before `StatsPills` renders.
assert.equal(liveBar.querySelector("[data-session-cost-merge]"), null, "no bar yet means nothing inside the bar");
assert.ok(liveAnchor.querySelector("[data-session-cost-merge]") !== null, "the merge must fall back to the anchor while no bar exists");
assert.equal(liveAnchor.getAttribute("data-solo"), "true", "the anchor must switch to its standalone layout");
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
assert.equal(liveAnchor.getAttribute("data-solo"), null, "the anchor must hide again once the bar hosts the merge");
assert.equal(liveAnchor.querySelector("[data-session-cost-merge]"), null, "the anchor must not keep a second copy");
// The bar's own layout is DSH's business. 0.1.5's `.bOPqQW_root` is a centered
// flex row (width:100%, 748px cap, gap:12px) that clips nothing, so the merge
// is simply a third item in that group — the plugin writes NO inline style
// onto it (the ≤ 0.1.4 widening patch is gone; see the styled-bar case below).
assert.deepEqual(inlineStyleProps(liveBar), [], "the plugin must not rewrite the built-in bar's layout");

// Teardown removes the node, leaves the bar untouched and disconnects.
live.dispose();
assert.equal(liveBar.querySelector("[data-session-cost-merge]"), null, "teardown must remove the merge node");
assert.deepEqual(inlineStyleProps(liveBar), [], "teardown must leave the bar's inline styles as they were");
assert.ok(observer.disconnected > 0, "teardown must disconnect the observer");
const noAnchor = startStatsRowObserver(null, () => null);
assert.equal(typeof noAnchor.dispose, "function", "a missing anchor must still hand back a handle");
noAnchor.sync();
noAnchor.dispose();

// ---- a COLD session switch must not disarm the observer ---------------
// Opening a session with no warm client cache takes about a second: React tears
// the old composer down and mounts the new one, so a mutation callback
// legitimately runs while the anchor sits in a DETACHED subtree. Re-observing
// only a CONNECTED host (the earlier guard) left the observer disconnected for
// the rest of the component's life — the reading stayed gone until a page
// reload mounted a fresh observer, which is exactly the reported bug.
const switchHost = new El("div");
root.appendChild(switchHost);
const switchAnchor = new El("div");
switchAnchor.setAttribute("data-session-cost-anchor", "");
switchHost.appendChild(switchAnchor);
const barA = new El("div");
barA.setAttribute("data-composer-stats", "");
switchHost.appendChild(barA);
const switched = startStatsRowObserver(switchAnchor, () => buildMergeNode(zhDict, mergeData()));
const switchObserver = MutationObserverStub.instances.at(-1);
assert.ok(barA.querySelector("[data-session-cost-merge]") !== null, "the merge must start inside the bar");
// The old panel goes away and a mutation is delivered while it is detached.
switchHost.remove();
switchObserver.fire();
assert.ok(switchObserver.targets.length > 0, "the observer must stay armed while the panel is detached");
assert.ok(barA.querySelector("[data-session-cost-merge]") !== null, "a detached sync must keep the merge in its bar");
// The new panel arrives: the container is back with a freshly mounted bar.
root.appendChild(switchHost);
barA.remove();
const barB = new El("div");
barB.setAttribute("data-composer-stats", "");
switchHost.appendChild(barB);
switchObserver.fire();
assert.ok(barB.querySelector("[data-session-cost-merge]") !== null, "the merge must follow the bar to its replacement");
assert.deepEqual(inlineStyleProps(barB), [], "the replacement bar must be left untouched too");

// The watchdog repairs anything the mutation stream could not report (a node
// wiped while the observer was detached, a bar re-mounted with no observable
// mutation, an anchor moved elsewhere): no page reload may be needed.
const repaired = barB.querySelector("[data-session-cost-merge]");
repaired.remove();
assert.equal(barB.querySelector("[data-session-cost-merge]"), null, "the node must be gone before the watchdog runs");
tickIntervals();
assert.ok(barB.querySelector("[data-session-cost-merge]") !== null, "the watchdog must re-attach a lost merge");
const intervalsBefore = intervals.size;
switched.dispose();
assert.equal(barB.querySelector("[data-session-cost-merge]"), null, "teardown must remove the repaired merge");
assert.equal(intervals.size, intervalsBefore - 1, "teardown must clear the watchdog");
tickIntervals();
assert.equal(barB.querySelector("[data-session-cost-merge]"), null, "a disposed observer must not resurrect the merge");

// A data change patches values in place: same node, same trigger (listener
// intact, panel open) with the new readings. The shape stays identical here —
// the same segments are present — which is exactly when patching applies.
let liveState = mergeData({ open: true });
const patched2 = startStatsRowObserver(liveAnchor, () => buildMergeNode(zhDict, liveState));
const patched = liveBar.querySelector("[data-session-cost-merge]");
const patchedTrigger = patched.querySelector("[data-slot=trigger]");
const patchedPanel = body.querySelectorAll("[data-slot=panel]").at(-1);
assert.equal(patchedPanel.hidden, false, "an open panel must survive the mount");
assert.equal(patchedPanel.style.visibility, "visible", "the mounted panel must be placed");
assert.equal(patchedPanel.style.top, "132px", "the mounted panel must sit above its trigger");
liveState = mergeData({ open: true, cost: 1.5, totalValue: 2.5 });
patched2.sync();
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
patched2.dispose();
assert.equal(patchedPanel.parentElement, null, "teardown must remove the portaled panel");

// ---- the panel's readings must move with the data too ------------------
// Every cell of the panel list IS a slot (`dt` = row-label, `dd` = row-value /
// panel-balance), and `querySelector` only matches DESCENDANTS — so the old
// `cell.querySelector("[data-slot=row-value]")` resolved to null for every row
// and `patchText` returned without writing. A manual ⟳ refresh therefore moved
// 账户余额 (a named slot patched further up) while 充值/赠送余额 and the
// per-model lines stayed frozen at their old numbers.
let refreshState = mergeData({ open: true });
const refreshLive = startStatsRowObserver(liveAnchor, () => buildMergeNode(zhDict, refreshState));
const refreshPanel = body.querySelectorAll("[data-slot=panel]").at(-1);
const panelList = refreshPanel.querySelector("[data-slot=panel-list]");
const rowLabels = (panel) => panel.querySelectorAll("[data-slot=row-label]").map((cell) => cell.textContent);
const rowValues = (panel) => panel.querySelectorAll("[data-slot=row-value]").map((cell) => cell.textContent);
assert.deepEqual(rowLabels(refreshPanel).slice(-2), ["充值余额", "赠送余额"], "the breakdown rows must start out present");
assert.ok(rowValues(refreshPanel)[2].includes("¥6.43"), "the breakdown must start at the old balance");
// The merge CONTAINS a defect instead of surfacing it (an open panel must never
// take the app down), so a broken patch shows up as a swallowed warning rather
// than a failed assertion: record them and require none.
const contained = [];
const restoreWarn = console.warn;
console.warn = (...args) => { contained.push(args.map(String).join(" ")); };

// One refresh payload: a new split, a new total, and a new per-model cost.
const repriced = mergeData().models.map((row) => ({ ...row, cost: row.cost + 0.1 }));
refreshState = mergeData({
	open: true,
	cost: 1.5,
	models: repriced,
	totalValue: 2.5,
	balance: { total: 2.5, toppedUp: 2.4, granted: 0.1 }
});
refreshLive.sync();
assert.equal(body.querySelectorAll("[data-slot=panel]").at(-1), refreshPanel, "a refresh must keep the same panel element");
const refreshed = rowValues(refreshPanel);
assert.ok(refreshed[0].includes("¥0.5549"), "the per-model cost must update in place");
assert.ok(refreshed[2].includes("¥2.4"), "充值余额 must follow the refresh");
assert.ok(refreshed[3].includes("¥0.1"), "赠送余额 must follow the refresh");
assert.ok(refreshPanel.querySelector("[data-slot=panel-balance]").textContent.includes("¥2.5"), "账户余额 must follow too");

// A row can also turn red in place (an id the pricing table has not learned).
refreshState = mergeData({
	open: true,
	cost: 1.5,
	models: [{ ...mergeData().models[0], price: null, cost: 0 }, mergeData().models[1]],
	totalValue: 2.5,
	balance: { total: 2.5, toppedUp: 2.4, granted: 0.1 }
});
refreshLive.sync();
const warnCell = refreshPanel.querySelectorAll("[data-slot=row-value]")[0];
assert.ok(warnCell.textContent.includes("未计价"), "an unpriced model must say so after the patch");
assert.equal(warnCell.getAttribute("data-warn"), "true", "the warn flag must be patched onto the row");

// The list SHRINKS when the model rows give way to 暂无 token 用量 and GROWS
// again once usage lands — all without the node's own slots changing, so both
// the surplus cells and the missing ones have to be reconciled in place.
refreshState = mergeData({ open: true, cost: null, models: [], totalValue: 2.5, balance: { total: 2.5, toppedUp: 2.4, granted: 0.1 } });
refreshLive.sync();
assert.equal(panelList.children.length, 8, "the empty state must drop the surplus model cells");
assert.ok(rowLabels(refreshPanel)[0].includes("暂无 token 用量"), "the empty state must be reachable in place");
refreshState = mergeData({ open: true, cost: 1.5, totalValue: 2.5, balance: { total: 2.5, toppedUp: 2.4, granted: 0.1 } });
refreshLive.sync();
console.warn = restoreWarn;
assert.deepEqual(contained, [], "the list patch must never fall back to a contained failure");
assert.deepEqual(rowLabels(refreshPanel).slice(0, 2), ["deepseek-v4-flash", "deepseek-v4-pro"], "the model rows must replace the empty-state row");
assert.deepEqual(rowLabels(refreshPanel).slice(-2), ["充值余额", "赠送余额"], "the breakdown rows must survive the growth");
assert.equal(panelList.children.length, 10, "the grown list must carry both model rows plus the split");
assert.equal(rowValues(refreshPanel).length, 4, "the grown list must expose four value cells");
refreshLive.dispose();
assert.equal(refreshPanel.parentElement, null, "teardown must still remove the panel after in-place growth");

// ---- the low-balance threshold lives in the panel ----------------------
// It used to be a card in 设置 → 插件 → 插件配置; it is now a line of its own in
// the panel, directly UNDER the 更新于/⟳ row (`低余额阈值 [10] 元`), so the
// reading grid stays numbers only and the place that SHOWS the color owns the
// number. The row sits outside `panel-list` and carries no patched slot, which
// is what keeps the in-place update from writing over a half-typed value.
const thresholdCommits = [];
let thresholdState = mergeData({
	open: true,
	lowBalanceThreshold: 10,
	onThreshold: (value) => thresholdCommits.push(value)
});
const thresholdLive = startStatsRowObserver(liveAnchor, () => buildMergeNode(zhDict, thresholdState));
const thresholdPanel = body.querySelectorAll("[data-slot=panel]").at(-1);
const thresholdInput = thresholdPanel.querySelector("[data-slot=threshold-input]");
assert.ok(thresholdInput !== null, "the panel must carry the threshold field");
assert.equal(thresholdInput.value, "10", "the field must start at the stored threshold");
assert.equal(thresholdInput.getAttribute("aria-label"), "低余额阈值", "the field needs a label for screen readers");
assert.equal(thresholdInput.getAttribute("data-slot"), "threshold-input", "the input is its own slot");
const settingRow = thresholdPanel.querySelector("[data-slot=panel-setting]");
assert.ok(settingRow !== null, "the field needs a row of its own");
assert.equal(settingRow.parentElement, thresholdPanel, "the setting row is a direct child of the panel");
assert.equal(settingRow.querySelector("[data-slot=panel-list]"), null, "the setting row must not be inside the reading grid");
assert.equal(thresholdPanel.querySelector("[data-slot=panel-list]").contains(settingRow), false, "the reading grid must stay numbers only");
assert.ok(settingRow.textContent.includes("低余额阈值"), "the row must carry its label");
assert.ok(settingRow.textContent.includes("元"), "the row must carry the unit");
// Order: everything in the panel, in document order — the setting row has to
// come after the 更新于/⟳ line and before the pricing note.
const panelOrder = thresholdPanel.querySelectorAll("[data-slot]").map((el) => el.getAttribute("data-slot"));
assert.ok(panelOrder.indexOf("refresh") < panelOrder.indexOf("panel-setting"), "the setting must sit under the refresh row");
assert.ok(panelOrder.indexOf("panel-updated") < panelOrder.indexOf("panel-setting"), "the setting must sit under the update time");
assert.equal(panelOrder.at(-1), "panel-note", "the pricing note stays the last line");
assert.ok(panelOrder.indexOf("panel-setting") < panelOrder.indexOf("panel-note"), "the setting sits above the note");

// Committing a value: sanitized, echoed back, handed to the owner — and the
// handler is read at EVENT time, so a new session's callback is the one used.
thresholdCommits.length = 0;
thresholdInput.value = "25";
thresholdInput.dispatchEvent(new EventStub("change"));
assert.deepEqual(thresholdCommits, [25], "a valid value must be committed as a number");
assert.equal(thresholdInput.value, "25", "the field must keep the committed value");
const enter = new EventStub("keydown");
enter.key = "Enter";
thresholdInput.value = "30";
thresholdInput.dispatchEvent(enter);
assert.deepEqual(thresholdCommits, [25, 30], "Enter must commit without blurring");
thresholdInput.value = "-3";
thresholdInput.dispatchEvent(new EventStub("change"));
assert.deepEqual(thresholdCommits, [25, 30], "a negative value must not be committed");
assert.equal(thresholdInput.value, "10", "a rejected value must snap back to the stored threshold");
thresholdInput.value = "  ";
thresholdInput.dispatchEvent(new EventStub("change"));
assert.deepEqual(thresholdCommits, [25, 30], "an emptied field must not commit");
assert.equal(thresholdInput.value, "10", "an emptied field must restore the stored threshold");

// A 30 s data refresh must NOT eat what is being typed: the threshold cell is a
// container of slots, so `patchText` skips it (this is the regression guard for
// the day someone "simplifies" the list patch into a text write).
thresholdInput.value = "42";
thresholdState = mergeData({ open: true, lowBalanceThreshold: 10, totalValue: 3.5 });
thresholdLive.sync();
assert.equal(thresholdInput.value, "42", "a data refresh must not overwrite a half-typed threshold");
assert.equal(body.querySelectorAll("[data-slot=panel]").at(-1), thresholdPanel, "the panel element must survive it");
thresholdLive.dispose();
assert.equal(thresholdPanel.parentElement, null, "teardown must remove the panel with the field");

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
assert.equal(emptyAnchor.querySelector("[data-session-cost-merge]"), null, "no data yet means no standalone node either");
// While there is nothing to show, the watchdog must not invent a node.
tickIntervals();
assert.equal(emptyBar.querySelector("[data-session-cost-merge]"), null, "the watchdog must not build a node without data");
// The payload arrives; the push from the owner must attach the merge.
payload = mergeData();
disposeEmpty.sync();
assert.ok(emptyBar.querySelector("[data-session-cost-merge]") !== null, "the merge must attach when the data arrives after mount");
disposeEmpty.dispose();
assert.equal(emptyBar.querySelector("[data-session-cost-merge]"), null, "teardown must remove the late-attached merge");
const noAnchor2 = startStatsRowObserver(null, () => null);
assert.equal(typeof noAnchor2.sync, "function", "a missing anchor must still hand back a handle");
noAnchor2.dispose();
assert.equal(intervals.size, 0, "every observer must clear its watchdog on teardown");

// ---- a throwing merge must never escape ---------------------------------
// `sync` runs inside a React effect (an uncaught error there unmounts the whole
// app) and inside a MutationObserver callback, so a defect in the merge is
// contained, reported to the console, and retried by the watchdog instead of
// taking the harness down with it.
const faultHost = new El("div");
root.appendChild(faultHost);
const faultAnchor = new El("div");
faultAnchor.setAttribute("data-session-cost-anchor", "");
faultHost.appendChild(faultAnchor);
const faultBar = new El("div");
faultBar.setAttribute("data-composer-stats", "");
faultHost.appendChild(faultBar);
let broken = true;
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args); };
let faulted;
try {
	faulted = startStatsRowObserver(faultAnchor, () => {
		if (broken) throw new Error("boom");
		return buildMergeNode(zhDict, mergeData());
	});
} finally {
	console.warn = realWarn;
}
assert.equal(faultBar.querySelector("[data-session-cost-merge]"), null, "a throwing merge must leave the bar empty, not crash");
assert.equal(warnings.length, 1, "a contained failure must be reported once");
broken = false;
faulted.sync();
assert.ok(faultBar.querySelector("[data-session-cost-merge]") !== null, "the next sync must recover after a contained failure");
faulted.dispose();
assert.equal(faultBar.querySelector("[data-session-cost-merge]"), null, "teardown must remove the recovered merge");
assert.equal(intervals.size, 0, "the faulting observer must clear its watchdog too");

// ---- click-to-open is an IN-PLACE update, not a rebuild ------------------
// The panel is portaled to document.body, so an in-place sync has to reach it
// through the node→panel registry: `node.querySelector("[data-slot=panel]")` is
// always null. While that lookup was in place every panel reading stayed frozen
// and — once the merge node stopped being rebuilt on each data change — the
// panel could not be opened at all ("点击展开失效").
const clickHost = new El("div");
root.appendChild(clickHost);
const clickAnchor = new El("div");
clickAnchor.setAttribute("data-session-cost-anchor", "");
clickHost.appendChild(clickAnchor);
const clickBar = new El("div");
clickBar.setAttribute("data-composer-stats", "");
clickHost.appendChild(clickBar);
// The owner keeps ONE state object and refreshes its fields, exactly like the
// component does (the node's handlers read it at click time).
const clickState = mergeData();
const clickObserver = startStatsRowObserver(clickAnchor, () => buildMergeNode(zhDict, clickState));
const clickNode = clickBar.querySelector("[data-session-cost-merge]");
const clickPanel = body.querySelectorAll("[data-slot=panel]").at(-1);
const clickTrigger = clickNode.querySelector("[data-slot=trigger]");
assert.equal(clickPanel.hidden, true, "the panel must start closed");
// The click only flips the owner's state; the DOM follows on the next sync.
clickTrigger.dispatchEvent(new EventStub("click"));
clickState.open = true;
clickObserver.sync();
assert.equal(clickBar.querySelector("[data-session-cost-merge]"), clickNode, "opening must not rebuild the node");
assert.equal(body.querySelectorAll("[data-slot=panel]").at(-1), clickPanel, "opening must not rebuild the panel");
assert.equal(clickPanel.hidden, false, "the panel must open in place");
assert.equal(clickPanel.style.visibility, "visible", "an opened panel must be placed above its trigger");
assert.equal(clickTrigger.getAttribute("aria-expanded"), "true", "the trigger must advertise the open panel");
// …and closing behaves the same way, without losing the elements.
clickState.open = false;
clickObserver.sync();
assert.equal(body.querySelectorAll("[data-slot=panel]").at(-1), clickPanel, "closing must not rebuild the panel");
assert.equal(clickPanel.hidden, true, "the panel must close in place");
assert.equal(clickPanel.style.visibility, "hidden", "a closed panel must be hidden outright");
assert.equal(clickTrigger.getAttribute("aria-expanded"), "false", "the trigger must advertise the closed panel");

// The panel's own readings patch in place as well — they live in the portaled
// panel, so a lookup on the merge node can never reach them.
clickState.open = true;
clickState.cost = 3.25;
clickState.totalValue = 8.75;
clickObserver.sync();
assert.equal(body.querySelectorAll("[data-slot=panel]").at(-1), clickPanel, "the panel element must survive a data update");
assert.equal(clickPanel.querySelector("[data-slot=title-value]").textContent, "¥3.25", "the panel total must patch in place");
assert.ok(clickPanel.querySelector("[data-slot=panel-balance]").textContent.includes("¥8.75"), "the panel balance must patch in place");
assert.ok(clickNode.querySelector("[data-slot=cost]").textContent.includes("¥3.25"), "the pill reading must patch in place");

// Handlers are read at CLICK time from the owner's live state object: a node
// that outlives renders must never keep calling the callback it was built with.
const refreshCalls = [];
clickState.onRefresh = () => refreshCalls.push("first");
clickObserver.sync();
clickPanel.querySelector("[data-slot=refresh]").dispatchEvent(new EventStub("click"));
clickState.onRefresh = () => refreshCalls.push("second");
clickObserver.sync();
clickPanel.querySelector("[data-slot=refresh]").dispatchEvent(new EventStub("click"));
assert.deepEqual(refreshCalls, ["first", "second"], "the refresh button must use the handler from the latest state");
const panelsAfterClick = body.querySelectorAll("[data-slot=panel]").length;
clickObserver.sync();
assert.equal(body.querySelectorAll("[data-slot=panel]").length, panelsAfterClick, "an in-place sync must not leak a panel");
clickObserver.dispose();
assert.equal(clickPanel.parentElement, null, "teardown must remove the portaled panel");
assert.equal(intervals.size, 0, "the click observer must clear its watchdog too");

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

// ---- the plugin body registers exactly one seat ------------------------
// The threshold used to have a second editor: a card in 设置 → 插件 →
// 插件配置 (`settings.plugin.item`, keyed by the settings namespace). It now
// lives in the panel, so the client must register the composer dock and
// NOTHING else — a second card would be a competing editor — while still
// binding the same settings namespace (that is what keeps the value durable in
// settings.yaml after the move).
const bound = [];
const registered = [];
const bodyScope = {
	getSnapshot: () => ({ status: "ready", value: { lowBalanceThreshold: 25 } }),
	subscribe: () => () => {},
	set: () => Promise.resolve()
};
exportsObj.apply({
	settingsScope: { bind: (spec) => { bound.push(spec); return bodyScope; } },
	effect: (fn) => { fn(); return () => {}; },
	locale: { register: (ns) => { registered.push(ns); return () => {}; } },
	slots: {
		inject: (name, callback) => callback(),
		register: (options) => { registered.push(options); return () => {}; }
	}
});
assert.deepEqual(bound, [{ namespace: "session-cost" }], "the settings scope must still bind the same namespace");
assert.deepEqual(registered.filter((entry) => typeof entry === "object").map((entry) => [entry.name, entry.id, entry.key]), [
	["conversation.composer.dock", "session-cost", void 0]
], "the composer dock must be the only slot the plugin registers");
assert.equal(exportsObj.SessionCostSettingsCard, void 0, "the settings card must not come back");
assert.equal(exportsObj.chevronDownIcon, void 0, "the settings-card chevron goes with it");

// ---- the built-in bar's own layout is never rewritten -----------------
// Up to 0.2.2 the merge widened + unclipped the stats row with inline styles,
// because the ≤ 0.1.4 `StatsLine` root capped itself at 748px (also with
// `overflow:hidden` + `text-overflow:ellipsis`) and clipped the appended tail.
// 0.1.5's `.bOPqQW_root` is a centered flex row that caps and clips nothing, so
// that patch is gone — and this case makes sure it STAYS gone: any inline write
// on the bar (a reintroduced `max-width`, an `overflow` unclip, an ellipsis
// clip) fails here, and a bar carrying an inline value of its own must still
// hold exactly that value afterwards.
const styledRow = new El("div");
styledRow.setAttribute("data-composer-stats", "");
styledRow.style.setProperty("max-width", "900px");
const styledAnchor = new El("div");
styledAnchor.setAttribute("data-session-cost-anchor", "");
const styledHost = new El("div");
root.appendChild(styledHost);
styledHost.appendChild(styledRow);
styledHost.appendChild(styledAnchor);
const styledLive = startStatsRowObserver(styledAnchor, () => buildMergeNode(zhDict, mergeData()));
assert.ok(styledRow.querySelector("[data-session-cost-merge]") !== null, "the merge must attach to that bar");
assert.deepEqual(inlineStyleProps(styledRow), ["max-width"], "the bar's own inline styles must survive the merge");
assert.equal(styledRow.style.getPropertyValue("max-width"), "900px", "the bar's own max-width must not be overwritten");
assert.equal(styledRow.style.getPropertyValue("overflow"), "", "no overflow unclip may be written");
assert.equal(styledRow.style.getPropertyValue("text-overflow"), "", "no ellipsis clip may be written");
styledLive.sync();
assert.deepEqual(inlineStyleProps(styledRow), ["max-width"], "a re-sync must not add styles either");
styledLive.dispose();
assert.deepEqual(inlineStyleProps(styledRow), ["max-width"], "teardown must leave the bar exactly as DSH set it");

// ---- fmtCny -----------------------------------------------------------
assert.equal(fmtCny("7.09", 2), "7.09", "numeric string should format");
assert.equal(fmtCny(0.45493556, 4), "0.4549");
assert.equal(fmtCny(null, 2), "—");

console.log("client DOM smoke test passed");
