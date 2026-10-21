// Runs on linkedin.com. Only reads the job being viewed (title, company, location, JD) and
// hands it to the extension's side panel. All UI lives in sidepanel.html, so the page is never covered.

(() => {
  // ---------- extraction ----------
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const first = (sels, scope = document) => {
    for (const s of sels) {
      const el = scope.querySelector(s);
      if (text(el)) return el;
    }
    return null;
  };

  function fromJsonLd() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : data["@graph"] || [data];
        const jp = items.find((x) => x && x["@type"] === "JobPosting");
        if (jp) {
          return {
            title: jp.title || "",
            company: jp.hiringOrganization?.name || "",
            location: jp.jobLocation?.address?.addressLocality || jp.jobLocation?.[0]?.address?.addressLocality || "",
          };
        }
      } catch (_) {}
    }
    return null;
  }

  function fromDom() {
    const titleEl = first([
      ".job-details-jobs-unified-top-card__job-title h1",
      ".job-details-jobs-unified-top-card__job-title",
      ".jobs-unified-top-card__job-title",
      ".top-card-layout__title",
      ".jobs-search__job-details h1",
      ".job-view-layout h1",
      "main h1",
    ]);
    if (!titleEl) return null;

    let companyEl = first([
      ".job-details-jobs-unified-top-card__company-name a",
      ".job-details-jobs-unified-top-card__company-name",
      ".jobs-unified-top-card__company-name",
      ".topcard__org-name-link",
    ]);
    if (!companyEl) {
      // Generic fallback: first /company/ link in the same details pane.
      const pane = titleEl.closest(".jobs-search__job-details, .job-view-layout, main, section") || document;
      companyEl = [...pane.querySelectorAll('a[href*="/company/"]')].find((a) => text(a));
    }

    const locEl = first([
      ".job-details-jobs-unified-top-card__primary-description-container .tvm__text",
      ".job-details-jobs-unified-top-card__bullet",
      ".jobs-unified-top-card__bullet",
      ".topcard__flavor--bullet",
    ]);

    let loc = text(locEl);
    const co = text(companyEl);
    if (!loc && companyEl) {
      // New LinkedIn layout: "Google • Singapore (On-site)" in the line that holds the company link.
      let line = companyEl.parentElement;
      for (let i = 0; i < 3 && line && !/[•·]/.test(text(line)); i++) line = line.parentElement;
      const parts = text(line).split(/\s*[•·]\s*/).map((x) => x.trim()).filter(Boolean);
      const idx = parts.findIndex((x) => x.includes(co));
      const cand = parts[idx + 1] || "";
      if (cand && cand.length < 80 && !/ago|applicant|前|申请/i.test(cand)) loc = cand;
    }
    return { title: text(titleEl), company: co, location: loc };
  }

  function fromDocTitle() {
    // "(3) Senior Security Engineer | ByteDance | LinkedIn"
    const parts = document.title.replace(/^\(\d+\)\s*/, "").split(" | ");
    if (parts.length >= 3 && /linkedin/i.test(parts.at(-1))) {
      return { title: parts[0], company: parts[1], location: "" };
    }
    return null;
  }

  function jobId() {
    const m = location.pathname.match(/\/jobs\/view\/(\d+)/);
    return m ? m[1] : new URLSearchParams(location.search).get("currentJobId") || "";
  }

  const MAX_JD = 30000;

  // Serialise a subtree to text WITHOUT relying on innerText: innerText skips content that is
  // hidden behind LinkedIn's "see more" (display:none / clamped), which truncated the JD.
  const BLOCK_TAGS = new Set(["P", "DIV", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "TABLE", "TR", "BLOCKQUOTE", "PRE"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "BUTTON", "SVG", "NOSCRIPT", "TEMPLATE", "IMG", "INPUT", "SELECT", "TEXTAREA"]);
  function serialize(rootEl) {
    let out = "";
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, " "); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      // LinkedIn renders visible text twice: aria-hidden copy + screen-reader copy. Keep one.
      if (n.getAttribute("aria-hidden") === "true") return;
      if (tag === "BR") { out += "\n"; return; }
      if (tag === "LI") out += "\n- ";
      else if (BLOCK_TAGS.has(tag)) out += "\n";
      for (const c of n.childNodes) walk(c);
      if (BLOCK_TAGS.has(tag) || tag === "LI") out += "\n";
    };
    walk(rootEl);
    return out;
  }
  const clean = (t) =>
    t.replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n- \n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s*(…\s*)?(see more|show more|see less|show less|显示更多|查看更多|收起)\s*$/i, "")
      .trim().slice(0, MAX_JD);

  // LinkedIn's newer layout uses generated class names, so locate the JD by its heading:
  // start at "About the job" and widen to the largest ancestor that is still only the JD
  // (stop before it would include the job title or another section such as "About the company").
  const JD_HEADINGS = /^(about the job|about this job|job description|职位描述|关于职位|关于此职位|职位详情)$/i;
  const OTHER_SECTIONS = /^(about the company|meet the hiring team|people you can reach out to|job match|similar jobs|more jobs|people also viewed|关于公司|招聘团队|相似职位)$/i;
  function fromHeading() {
    const scope = document.querySelector("main") || document.body;
    const heads = [...scope.querySelectorAll("h1, h2, h3, h4, strong, span")].filter(
      (e) => JD_HEADINGS.test(text(e)) && !e.closest("#sg-job-lens")
    );
    for (const h of heads) {
      let best = null;
      for (let p = h.parentElement, i = 0; p && p !== document.body && i < 12; p = p.parentElement, i++) {
        if (p.querySelector("h1")) break;
        // the top card (title + Apply/Save buttons) is a sibling of the JD; never swallow it
        if ([...p.querySelectorAll("button, a")].some((b) => /^(easy apply|apply|save|申请|保存)$/i.test(text(b)))) break;
        const others = [...p.querySelectorAll("h2, h3, h4, strong, span")].some((x) => x !== h && OTHER_SECTIONS.test(text(x)));
        if (others) break;
        if ((p.textContent || "").length > 60000) break;
        best = p;
      }
      if (!best) continue;
      const t = clean(serialize(best)).replace(new RegExp("^" + text(h).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*", "i"), "");
      if (t.length > 50) return t;
    }
    return "";
  }

  function fromJsonLdDescription() {
    for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(sc.textContent);
        const jp = (Array.isArray(d) ? d : d["@graph"] || [d]).find((x) => x && x["@type"] === "JobPosting");
        if (jp?.description) {
          // DOMParser documents are inert (no script execution), so this is a safe way to strip tags.
          const doc = new DOMParser().parseFromString(String(jp.description), "text/html");
          return clean(serialize(doc.body));
        }
      } catch (_) {}
    }
    return "";
  }

  // Try every strategy and keep the longest result: a truncated preview always loses to the full text.
  function description() {
    const cands = [];
    for (const sel of ["#job-details", ".jobs-description__content", ".jobs-description-content__text",
      ".jobs-box__html-content", ".show-more-less-html__markup", ".description__text"]) {
      const e = document.querySelector(sel);
      if (e) cands.push(clean(serialize(e)));
    }
    cands.push(fromHeading(), fromJsonLdDescription());
    return cands.reduce((a, b) => (b.length > a.length ? b : a), "");
  }

  function extract() {
    if (!location.pathname.startsWith("/jobs")) return null;
    const id = jobId();
    if (!id) return null;
    const job = fromDom() || fromJsonLd() || fromDocTitle();
    if (!job?.title || !job?.company) return null;
    return { id, ...job, description: description() };
  }


  // ---------- messaging ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "getJob") sendResponse({ job: extract() });
  });

  // Push changes (new job, or JD finished loading) so an open panel updates without polling.
  let lastSig = "";
  setInterval(() => {
    const j = extract();
    const sig = j ? `${j.id}|${j.title}|${j.company}|${j.location}|${j.description.length}` : "";
    if (sig === lastSig) return;
    lastSig = sig;
    chrome.runtime.sendMessage({ type: "jobChanged", job: j }).catch(() => {});
  }, 1000);
})();
