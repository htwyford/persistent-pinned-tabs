"use strict";

// Persistent Pinned Tabs
//
// storage.local:   pins          [{ id, url, title }] in tab-strip order
//                  closeBehavior "reset" | "unpin"
//                  dedupedPins   true once the one-time duplicate cleanup has run
//                  prunedPins    true once the one-time hidden pin cleanup has run
// storage.session: tabPins       { [tabId]: pinId } for live tabs
//                  placeholders  [tabId] tabs we opened for a pin, which give way
//                                if Firefox then restores the pin's original tab
//                  ready         true once this browser session has been reconciled
// sessions API:    each pinned tab carries its pinId as a tab value
//
// Firefox gives a tab a new id whenever it restores one: after a restart, or
// when it puts pinned tabs back in a new window after the last one was closed
// on macOS. The tab value survives that, so a restored tab can reclaim its pin
// instead of looking like a tab the user just pinned.

const PIN_TAG = "pinId";
const BLANK_URLS = new Set(["about:blank", "about:newtab", "about:home"]);
const SETTLE_QUIET_MS = 1000;
const SETTLE_MAX_MS = 15000;

// Every handler runs through this queue so storage reads/writes never interleave.
let queue = Promise.resolve();
function serial(fn) {
  queue = queue.then(fn).catch((e) => console.error("[pinned-tabs]", e));
  return queue;
}

async function getPins() {
  const { pins = [] } = await browser.storage.local.get("pins");
  return pins;
}

async function getCloseBehavior() {
  const { closeBehavior = "reset" } = await browser.storage.local.get("closeBehavior");
  return closeBehavior;
}

async function getTabPins() {
  const { tabPins = {} } = await browser.storage.session.get("tabPins");
  return tabPins;
}

async function isReady() {
  const { ready = false } = await browser.storage.session.get("ready");
  return ready;
}

async function normalTabs() {
  const tabs = await browser.tabs.query({ windowType: "normal" });
  return tabs.filter((t) => !t.incognito);
}

async function getPinTag(tabId) {
  try {
    return await browser.sessions.getTabValue(tabId, PIN_TAG);
  } catch {
    return undefined;
  }
}

async function setPinTag(tabId, pinId) {
  try {
    await browser.sessions.setTabValue(tabId, PIN_TAG, pinId);
  } catch (e) {
    console.warn("[pinned-tabs] could not tag tab", tabId, e);
  }
}

async function getPlaceholders() {
  const { placeholders = [] } = await browser.storage.session.get("placeholders");
  return placeholders;
}

function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Wait until session restore stops adding tabs.
async function settle() {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < SETTLE_MAX_MS) {
    const count = (await normalTabs()).length;
    if (count === last && count > 0) return;
    last = count;
    await new Promise((r) => setTimeout(r, SETTLE_QUIET_MS));
  }
}

async function targetWindowId(preferred) {
  if (preferred != null) return preferred;
  try {
    const win = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
    if (!win.incognito) return win.id;
  } catch {}
  const wins = await browser.windows.getAll({ windowTypes: ["normal"] });
  return wins.find((w) => !w.incognito)?.id;
}

// Open a pin as a pinned tab. Firefox refuses pinned+discarded in one call, so
// create it discarded (unloaded, like an Arc pinned tab) and pin it afterwards.
async function openPin(pin, windowId, index, tabPins) {
  let tab;
  try {
    tab = await browser.tabs.create({
      url: pin.url,
      windowId,
      index,
      active: false,
      discarded: true,
      title: pin.title || undefined,
    });
  } catch {
    try {
      tab = await browser.tabs.create({ url: pin.url, windowId, index, active: false });
    } catch (e) {
      // Privileged URLs (about:config, file:) can't be opened by extensions.
      console.warn("[pinned-tabs] could not open", pin.url, e);
      return null;
    }
  }
  // Record the association before pinning, so the pinned-change handler
  // (queued behind us) recognises the tab instead of minting a new pin.
  tabPins[tab.id] = pin.id;
  await browser.storage.session.set({
    tabPins,
    placeholders: [...(await getPlaceholders()), tab.id],
  });
  await setPinTag(tab.id, pin.id);
  await browser.tabs.update(tab.id, { pinned: true });
  await browser.tabs.move(tab.id, { index });
  return tab;
}

// Versions before 1.0.3 saved an extra pin each time Firefox restored a pinned
// tab into a new window, so a pin with no open tab is a leftover, not something
// the user is missing: Firefox restores pinned tabs itself. Runs once, and drops
// those pins instead of opening them. Returns true if it dropped any.
//
// If no pinned tabs are open at all, Firefox didn't restore anything (it may be
// set to clear data on quit), so nothing can be told apart: keep them all.
async function pruneHiddenPinsOnce(pins, tabs, tabPins) {
  const { prunedPins = false } = await browser.storage.local.get("prunedPins");
  if (prunedPins) return false;
  const open = new Set(Object.values(tabPins));
  const hidden = pins.filter((p) => !open.has(p.id));
  if (!open.size || !hidden.length) {
    await browser.storage.local.set({ prunedPins: true });
    return false;
  }
  // The oldest pin for a site is the one the user made; later ones are pages the
  // tab wandered to. Keep the user's original as the page the open tab resets to.
  const kept = pins.filter((p) => open.has(p.id));
  for (const pin of kept) {
    const original = pins.find((p) => origin(p.url) === origin(pin.url));
    if (original && !open.has(original.id)) {
      pin.url = original.url;
      pin.title = original.title;
    }
  }
  await browser.storage.local.set({ pins: kept, prunedPins: true });
  return true;
}

// Match stored pins to live tabs, then open any pin that has no tab.
async function reconcile(windowId) {
  const pins = await getPins();
  const tabs = await normalTabs();
  const tabPins = await getTabPins();

  const live = new Set(tabs.map((t) => t.id));
  for (const id of Object.keys(tabPins)) {
    if (!live.has(Number(id))) delete tabPins[id];
  }

  const claimed = new Set(Object.values(tabPins));
  let candidates = tabs.filter((t) => t.pinned && !(t.id in tabPins));

  const claim = (pin, tab) => {
    tabPins[tab.id] = pin.id;
    claimed.add(pin.id);
    candidates = candidates.filter((t) => t !== tab);
  };

  // A tab carrying a pin's tag is that pin, wherever it has navigated since.
  const byId = new Map(pins.map((p) => [p.id, p]));
  for (const tab of [...candidates]) {
    const pin = byId.get(await getPinTag(tab.id));
    if (!pin) continue;
    if (claimed.has(pin.id)) candidates = candidates.filter((t) => t !== tab);
    else claim(pin, tab);
  }

  // Tabs from before tags existed: exact URL, then same origin, then whatever
  // is left in order, which covers a pinned tab that was navigated elsewhere.
  const passes = [
    (pin, tab) => tab.url === pin.url,
    (pin, tab) => origin(tab.url) !== null && origin(tab.url) === origin(pin.url),
    () => true,
  ];
  for (const matches of passes) {
    for (const pin of pins) {
      if (claimed.has(pin.id)) continue;
      const tab = candidates.find((t) => matches(pin, t));
      if (tab) claim(pin, tab);
    }
  }
  await browser.storage.session.set({ tabPins });
  for (const [tabId, pinId] of Object.entries(tabPins)) await setPinTag(Number(tabId), pinId);

  if (await pruneHiddenPinsOnce(pins, tabs, tabPins)) return;

  const missing = pins.filter((p) => !claimed.has(p.id));
  if (!missing.length) return;
  const winId = await targetWindowId(windowId);
  if (winId == null) return;
  for (const pin of missing) {
    await openPin(pin, winId, pins.indexOf(pin), tabPins);
  }
}

// Rewrite the stored pin list from the pinned tabs that exist right now.
async function rebuild() {
  if (!(await isReady())) return;
  const pins = await getPins();
  const tabPins = await getTabPins();
  const placeholders = await getPlaceholders();
  const byId = new Map(pins.map((p) => [p.id, p]));

  const tabs = (await normalTabs())
    .filter((t) => t.pinned)
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const liveIds = new Set(tabs.map((t) => t.id));

  const nextPins = [];
  const nextTabPins = {};
  const replaced = new Set();
  for (const tab of tabs) {
    if (replaced.has(tab.id)) continue;
    let pin = byId.get(tabPins[tab.id]);
    if (!pin) {
      // A tab we don't recognise may be one Firefox restored under a new id.
      const tagged = byId.get(await getPinTag(tab.id));
      if (tagged) {
        const holder = Object.keys(tabPins)
          .map(Number)
          .find((id) => id !== tab.id && liveIds.has(id) && tabPins[id] === tagged.id);
        if (holder === undefined) {
          pin = tagged;
        } else if (placeholders.includes(holder)) {
          // We reopened this pin before Firefox restored the real tab.
          replaced.add(holder);
          delete tabPins[holder];
          delete nextTabPins[holder];
          pin = tagged;
        }
        // Otherwise the pin's own tab is open, so this is a copy of it (for
        // example from Duplicate Tab) and becomes a pin of its own.
      }
    }
    if (!pin) pin = { id: crypto.randomUUID(), url: tab.url, title: tab.title };
    tabPins[tab.id] = pin.id;
    await setPinTag(tab.id, pin.id);
    if (!nextPins.includes(pin)) nextPins.push(pin);
    nextTabPins[tab.id] = pin.id;
  }

  // A pin with no live tab (its window was closed) stays in its old slot until
  // the next reconcile reopens it. Pins are only dropped by removePin().
  pins.forEach((pin, i) => {
    if (!nextPins.includes(pin)) nextPins.splice(Math.min(i, nextPins.length), 0, pin);
  });

  await browser.storage.local.set({ pins: nextPins });
  await browser.storage.session.set({ tabPins: nextTabPins });
  // The mapping is already gone, so onRemoved won't reopen these.
  if (replaced.size) await browser.tabs.remove([...replaced]);
}

async function removePin(pinId) {
  const pins = (await getPins()).filter((p) => p.id !== pinId);
  await browser.storage.local.set({ pins });
}

// Versions before 1.0.3 could save the same page as several pins. Runs once.
// Leaves a copy alone if it has been navigated away, since it may be in use.
async function dedupePinsOnce() {
  const { dedupedPins = false } = await browser.storage.local.get("dedupedPins");
  if (dedupedPins) return;
  const pins = await getPins();
  const tabPins = await getTabPins();
  const tabs = await normalTabs();
  const seen = new Set();
  const kept = [];
  const extras = [];
  for (const pin of pins) {
    if (!seen.has(pin.url)) {
      seen.add(pin.url);
      kept.push(pin);
      continue;
    }
    const tab = tabs.find((t) => tabPins[t.id] === pin.id);
    if (tab && !tab.discarded && tab.url !== pin.url) {
      kept.push(pin);
      continue;
    }
    if (tab) {
      delete tabPins[tab.id];
      extras.push(tab.id);
    }
  }
  await browser.storage.local.set({ pins: kept, dedupedPins: true });
  await browser.storage.session.set({ tabPins });
  if (extras.length) await browser.tabs.remove(extras);
}

// Wait for session restore only when it may still be running: at browser
// startup, or after an update (Firefox applies updates at startup). After a
// fresh install or a mid-session enable the tabs are already there, and
// waiting would ignore whatever the user pins in the meantime.
async function init({ waitForRestore = false } = {}) {
  if (await isReady()) return;
  if (waitForRestore) await settle();
  await reconcile();
  await dedupePinsOnce();
  await browser.storage.session.set({ ready: true });
  await rebuild();
}

async function pinForTab(tabId) {
  const tabPins = await getTabPins();
  const pins = await getPins();
  return pins.find((p) => p.id === tabPins[tabId]) ?? null;
}

async function resetTab(tabId) {
  const pin = await pinForTab(tabId);
  if (!pin) return;
  try {
    await browser.tabs.update(tabId, { url: pin.url });
  } catch (e) {
    console.warn("[pinned-tabs] could not reset to", pin.url, e);
  }
}

async function setPinUrl(tabId) {
  const pin = await pinForTab(tabId);
  if (!pin) return;
  const tab = await browser.tabs.get(tabId);
  const pins = await getPins();
  const target = pins.find((p) => p.id === pin.id);
  target.url = tab.url;
  target.title = tab.title;
  await browser.storage.local.set({ pins });
}

// --- Events ---------------------------------------------------------------

browser.runtime.onStartup.addListener(() => serial(() => init({ waitForRestore: true })));

browser.runtime.onInstalled.addListener(({ reason }) => {
  serial(() => init({ waitForRestore: reason !== "install" }));
  browser.menus.create({
    id: "reset-pin",
    title: "Reset to Pinned URL",
    contexts: ["tab"],
  });
  browser.menus.create({
    id: "set-pin-url",
    title: "Make This the Pinned URL",
    contexts: ["tab"],
  });
});

browser.tabs.onUpdated.addListener(
  (tabId, change, tab) =>
    serial(async () => {
      if (tab.incognito) return;
      if (change.pinned === false && (await isReady())) {
        const pin = await pinForTab(tabId);
        if (pin) await removePin(pin.id);
        await browser.sessions.removeTabValue(tabId, PIN_TAG).catch(() => {});
      }
      if ("pinned" in change) return rebuild();
      // A tab pinned while still blank adopts the first real page it loads.
      if (change.url && !BLANK_URLS.has(change.url)) {
        const pin = await pinForTab(tabId);
        if (pin && BLANK_URLS.has(pin.url)) await setPinUrl(tabId);
      }
    }),
  { properties: ["pinned", "url"] }
);

browser.tabs.onCreated.addListener((tab) => {
  if (tab.pinned) serial(rebuild);
});

// Once the user has switched to a tab we opened, it stays even if the original
// turns up later: they may be using it.
browser.tabs.onActivated.addListener(({ tabId }) =>
  serial(async () => {
    const placeholders = await getPlaceholders();
    if (placeholders.includes(tabId)) {
      await browser.storage.session.set({ placeholders: placeholders.filter((id) => id !== tabId) });
    }
  })
);

browser.tabs.onMoved.addListener(() => serial(rebuild));
browser.tabs.onAttached.addListener(() => serial(rebuild));

browser.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) =>
  serial(async () => {
    // Window closing (including quitting Firefox): keep the pins as they are.
    if (isWindowClosing || !(await isReady())) return;
    const pin = await pinForTab(tabId);
    if (!pin) return;
    const tabPins = await getTabPins();
    delete tabPins[tabId];
    await browser.storage.session.set({ tabPins });
    if ((await getCloseBehavior()) === "reset") {
      const pins = await getPins();
      await openPin(pin, windowId, pins.findIndex((p) => p.id === pin.id), tabPins);
    } else {
      await removePin(pin.id);
    }
    await rebuild();
  })
);

// Closing the last window on macOS leaves Firefox running with no tabs. When a
// new window appears and no pinned tabs are open anywhere, bring them back.
browser.windows.onCreated.addListener((win) =>
  serial(async () => {
    if (win.type !== "normal" || win.incognito || !(await isReady())) return;
    const pinned = (await normalTabs()).filter((t) => t.pinned);
    if (!pinned.length) await reconcile(win.id);
  })
);

browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.contexts.includes("tab")) return;
  const visible = !!(tab?.pinned && (await pinForTab(tab.id)));
  await browser.menus.update("reset-pin", { visible });
  await browser.menus.update("set-pin-url", { visible });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "reset-pin") serial(() => resetTab(tab.id));
  if (info.menuItemId === "set-pin-url") serial(() => setPinUrl(tab.id));
});

browser.commands.onCommand.addListener((command, tab) => {
  if (command === "reset-pinned-tab" && tab) serial(() => resetTab(tab.id));
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "remove-pin") {
    return serial(async () => {
      const tabPins = await getTabPins();
      const tabId = Object.keys(tabPins).find((id) => tabPins[id] === msg.id);
      // Unpinning the live tab queues the onUpdated handler, which then finds
      // no pin to remove.
      await removePin(msg.id);
      if (tabId) await browser.tabs.update(Number(tabId), { pinned: false });
    });
  }
});

// Covers the extension being enabled mid-session, when neither onStartup nor
// onInstalled fires. Deferred so that, at browser startup, onStartup's
// settling init() is queued first; init() is a no-op once ready.
setTimeout(() => serial(init), 1000);
