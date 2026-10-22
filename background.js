import { analyze, buildSearchTerm, mapMcfJob, parseExperience, findSkills, relatedQueries, mapJoobleJob } from "./lib.js";

const MCF = "https://api.mycareersfuture.gov.sg/v2";
const PAGE_SIZE = 100;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function mcfSearch(term, pages = 2) {
  const out = [];
  for (let page = 0; page < pages; page++) {
    let data;
    try {
      const res = await fetch(`${MCF}/search?limit=${PAGE_SIZE}&page=${page}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ search: term, sortBy: ["new_posting_date"] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (e) {
      // Fallback to the GET listing endpoint.
      const q = new URLSearchParams({ search: term, limit: PAGE_SIZE, page });
      const res = await fetch(`${MCF}/jobs?${q}`);
      if (!res.ok) throw new Error(`MCF request failed (${res.status})`);
      data = await res.json();
    }
    const results = data.results || [];
    out.push(...results.map(mapMcfJob));
    if (results.length < PAGE_SIZE) break;
  }
  return out;
}

async function cached(key, fn) {
  const hit = (await chrome.storage.local.get(key))[key];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };
  const value = await fn();
  await chrome.storage.local.set({ [key]: { at: Date.now(), value } });
  return value;
}

// Run async jobs with at most `n` in flight (be gentle with the public APIs).
async function limited(tasks, n = 3) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) {
      const k = i++;
      try { out[k] = await tasks[k](); } catch (e) { out[k] = e; }
    }
  }));
  return out;
}

// ---------- Jooble: optional, the user's own key, only after they grant access ----------
const JOOBLE_ORIGIN = "https://jooble.org/*";
async function joobleConfig() {
  const key = (await chrome.storage.local.get("settings:joobleKey"))["settings:joobleKey"] || "";
  if (!key) return null;
  const granted = await chrome.permissions.contains({ origins: [JOOBLE_ORIGIN] }).catch(() => false);
  return { key, granted };
}
async function joobleSearch(key, keywords) {
  const res = await fetch(`https://jooble.org/api/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keywords, location: "Singapore", page: 1 }),
  });
  if (res.status === 403 || res.status === 401) throw new Error("Jooble key 无效或已过期");
  if (!res.ok) throw new Error(`Jooble 返回 ${res.status}`);
  const data = await res.json();
  return (data.jobs || [])
    .filter((j) => !j.location || /singapore/i.test(j.location))
    .map(mapJoobleJob);
}

async function lookup(input) {
  // JD text is parsed here (locally) and never sent anywhere; MCF/Jooble only see search keywords.
  const description = input.description || "";
  const job = { ...input, description, years: parseExperience(description) };
  const term = buildSearchTerm(job.title) || job.title;
  const queries = relatedQueries(job.title, findSkills(description));
  const jooble = await joobleConfig();
  const useJooble = !!(jooble && jooble.granted);
  const key = `lookup:v6:${job.id}|${job.company.toLowerCase()}|${job.title.toLowerCase()}|${description ? 1 : 0}|j${useJooble ? 1 : 0}|p${job.pageSalary || ""}`;
  return cached(key, async () => {
    const extraQs = queries.filter((x) => x !== term);
    const [exact, byRole, byCompany, ...wider] = await limited([
      () => mcfSearch(`${job.title} ${job.company}`, 1), // the identical posting
      () => mcfSearch(term, 2), // market, by this title
      () => (job.company ? mcfSearch(job.company, 2) : []), // company
      ...extraQs.map((q) => () => mcfSearch(q, 1)), // same work under other titles / domains
    ]);
    const ok = (x) => (Array.isArray(x) ? x : []);
    if (!Array.isArray(byRole) && !Array.isArray(exact)) throw byRole instanceof Error ? byRole : new Error("MCF 查询失败");
    const mcfPool = [...ok(exact), ...ok(byRole), ...ok(byCompany), ...wider.flatMap(ok)];

    let joobleJobs = [];
    let joobleStatus = jooble ? (jooble.granted ? { enabled: true } : { enabled: false, error: "还没允许访问 jooble.org" }) : { enabled: false };
    if (useJooble) {
      const res = await limited(queries.slice(0, 2).map((q) => () => joobleSearch(jooble.key, q)), 2);
      const err = res.find((x) => x instanceof Error);
      const seenJ = new Set();
      joobleJobs = res.flatMap(ok).filter((j) => !seenJ.has(j.id) && seenJ.add(j.id));
      joobleStatus = { enabled: true, ok: !err || joobleJobs.length > 0, count: joobleJobs.length, error: err ? err.message : null };
    }

    const result = analyze(job, mcfPool, joobleJobs);
    result.related.sources = {
      mcfQueries: queries,
      mcfCount: new Set(mcfPool.map((j) => j.id)).size,
      jooble: joobleStatus,
    };
    return { ...result, searchTerm: term, fetchedAt: new Date().toISOString() };
  });
}

// ---------- send a prompt to Claude / ChatGPT ----------
// The panel asks us to open a new chat tab; the prompt is held for that tab only and handed to
// ai-send.js running in it. Kept in session storage so it survives a worker restart.
const AI_URLS = { claude: "https://claude.ai/new", chatgpt: "https://chatgpt.com/" };
const PENDING_TTL_MS = 2 * 60 * 1000;

async function sendToAi(target, prompt) {
  const url = AI_URLS[target];
  if (!url) throw new Error("未知的 AI 目标");
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.session.set({ [`pending:${tab.id}`]: { prompt, target, at: Date.now() } });
  return { tabId: tab.id };
}

async function takePending(tabId) {
  const key = `pending:${tabId}`;
  const v = (await chrome.storage.session.get(key))[key];
  if (!v) return null;
  await chrome.storage.session.remove(key); // one-shot
  return Date.now() - v.at < PENDING_TTL_MS ? v : null;
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`pending:${tabId}`).catch(() => {}));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "sendToAi") {
    sendToAi(msg.target, String(msg.prompt || ""))
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === "takePendingPrompt") {
    const tabId = _sender.tab?.id;
    if (tabId == null) return;
    takePending(tabId).then((pending) => sendResponse({ pending }));
    return true;
  }
  if (msg?.type === "lookup") {
    lookup(msg.job)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // async response
  }
  if (msg?.type === "clearCache") {
    // Only drop salary lookups; keep user settings such as the saved resume.
    chrome.storage.local.get(null).then((all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith("lookup:"));
      return chrome.storage.local.remove(keys);
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Toolbar icon (and its keyboard shortcut) opens Chrome's side panel. The panel sits beside the
// page, so LinkedIn reflows to the narrower width instead of being covered.
const enablePanel = () => {
  try {
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});
  } catch (_) {}
};
chrome.runtime.onInstalled.addListener(enablePanel);
chrome.runtime.onStartup.addListener(enablePanel);
enablePanel();
