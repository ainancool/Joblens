// Pure helpers: title parsing, company matching, salary stats. No network, no DOM.

const SENIORITY = [
  // [level, regex]
  [0, /\b(intern|internship|trainee|graduate|fresh)\b/],
  [1, /\b(junior|jr|associate|entry)\b/],
  [3, /\b(senior|sr|snr)\b/],
  [4, /\b(lead|staff|principal|architect)\b/],
  [5, /\b(manager|head|director|avp|vp|vice president|chief)\b/],
];

const STOPWORDS = new Set([
  "and", "or", "of", "the", "a", "an", "for", "to", "in", "with", "at", "on",
  "i", "ii", "iii", "iv", "1", "2", "3", "4", "contract", "permanent",
  "full", "time", "part", "remote", "hybrid", "singapore", "sg", "apac", "asia",
  "pacific", "global", "regional", "urgent", "new",
]);

const SENIORITY_WORDS = new Set([
  "intern", "internship", "trainee", "graduate", "fresh", "junior", "jr",
  "associate", "entry", "senior", "sr", "snr", "lead", "staff", "principal",
  "manager", "head", "director", "avp", "vp", "vice", "president", "chief", "mid",
]);

// Common synonyms so "SWE" and "Software Engineer" line up.
const SYNONYMS = {
  swe: ["software", "engineer"],
  sde: ["software", "engineer"],
  dev: ["developer"],
  eng: ["engineer"],
  engineering: ["engineer"],
  appsec: ["application", "security"],
  infosec: ["information", "security"],
  cybersecurity: ["cyber", "security"],
  devsecops: ["devsecops", "security"],
  ml: ["machine", "learning"],
  ai: ["ai"],
  pm: ["product", "manager"],
};

export function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9+#/ ]+/g, " ")
    .replace(/\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTitle(title) {
  const t = normalizeText(title);
  let level = 2; // default: mid
  let detected = false;
  for (const [lvl, re] of SENIORITY) {
    if (re.test(t)) {
      level = lvl;
      detected = true;
      // keep the highest matched level ("Senior Manager" -> manager)
    }
  }
  const tokens = [];
  for (const w of t.split(" ")) {
    if (!w || STOPWORDS.has(w) || SENIORITY_WORDS.has(w)) continue;
    for (const x of SYNONYMS[w] || [w]) if (!tokens.includes(x)) tokens.push(x);
  }
  return { level, detected, tokens };
}

export function titleSimilarity(a, b) {
  const A = new Set(a.tokens);
  const B = new Set(b.tokens);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function buildSearchTerm(title) {
  return parseTitle(title).tokens.slice(0, 5).join(" ");
}

const COMPANY_NOISE =
  /\b(pte|ltd|limited|private|inc|llc|llp|plc|corp|corporation|co|company|holdings|group|singapore|sg|asia|pacific|international|technologies|technology|tech)\b/g;

export function normalizeCompany(name) {
  return (name || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(COMPANY_NOISE, " ")
    .replace(/\s+/g, "")
    .trim();
}

export function companyMatches(a, b) {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

// Convert an MCF salary object into monthly SGD {min, max}, or null.
export function toMonthly(salary) {
  if (!salary) return null;
  let min = Number(salary.minimum);
  let max = Number(salary.maximum);
  if (!Number.isFinite(min) && !Number.isFinite(max)) return null;
  if (!Number.isFinite(min)) min = max;
  if (!Number.isFinite(max)) max = min;
  if (min <= 0 && max <= 0) return null;
  const type = (salary.type?.salaryType || salary.salaryType || "Monthly").toLowerCase();
  if (type.startsWith("annual") || type.startsWith("year")) {
    min /= 12;
    max /= 12;
  } else if (!type.startsWith("month")) {
    return null; // hourly/daily: not comparable, skip
  }
  if (max < min) [min, max] = [max, min];
  if (min < 500 || max > 100000) return null; // obvious junk
  return { min: Math.round(min), max: Math.round(max) };
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

export function summarize(jobs) {
  const mids = jobs.map((j) => (j.salary.min + j.salary.max) / 2).sort((a, b) => a - b);
  const n = mids.length;
  return {
    n,
    p25: percentile(mids, 0.25),
    p50: percentile(mids, 0.5),
    p75: percentile(mids, 0.75),
    lowest: n ? Math.min(...jobs.map((j) => j.salary.min)) : null,
    highest: n ? Math.max(...jobs.map((j) => j.salary.max)) : null,
    confidence: n >= 15 ? "high" : n >= 5 ? "medium" : n > 0 ? "low" : "none",
  };
}

// ---------- skills / keywords ----------
// Terms we look for in both the JD and MCF postings. Matching is whole-word, case-insensitive.
export const SKILL_TERMS = [
  // languages
  "python", "java", "go", "golang", "rust", "c++", "c#", "javascript", "typescript", "kotlin", "swift", "scala", "ruby", "php", "sql", "bash", "powershell",
  // cloud / infra
  "aws", "gcp", "azure", "kubernetes", "docker", "terraform", "ansible", "linux", "ci/cd", "jenkins", "github actions", "gitlab", "serverless", "microservices",
  // data / ml
  "spark", "kafka", "airflow", "hadoop", "pandas", "pytorch", "tensorflow", "machine learning", "llm", "nlp", "data pipeline", "etl", "snowflake", "bigquery", "tableau", "power bi",
  // web / mobile
  "react", "vue", "angular", "node.js", "django", "flask", "spring", "graphql", "rest api", "ios", "android",
  // security
  "application security", "appsec", "product security", "cloud security", "network security", "devsecops", "threat modeling", "threat modelling",
  "secure code review", "code review", "sast", "dast", "sca", "penetration testing", "pentest", "red team", "blue team", "bug bounty",
  "vulnerability management", "incident response", "siem", "soar", "edr", "xdr", "soc", "iam", "pki", "cryptography", "owasp", "waf",
  "secure boot", "fuzzing", "firmware", "embedded", "hardware security", "iot", "trusted execution", "reverse engineering",
  "zero trust", "dlp", "forensics", "malware", "threat intelligence", "iso 27001", "nist", "pci dss", "soc 2", "mas trm", "pdpa", "gdpr",
  "burp suite", "splunk", "crowdstrike", "semgrep", "checkmarx", "veracode", "snyk", "fortify", "wiz", "cspm", "kms", "hsm",
  // general
  "agile", "scrum", "stakeholder management", "project management", "risk management", "compliance", "audit", "governance",
];
const TERM_RES = SKILL_TERMS.map((t) => [
  t, new RegExp(`(^|[^a-z0-9+#])${t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![a-z0-9+#])`, "i"),
]);
const TERM_ALIAS = { golang: "go", pentest: "penetration testing", "threat modelling": "threat modeling", appsec: "application security" };

export function findSkills(text) {
  if (!text) return [];
  const out = new Set();
  for (const [t, re] of TERM_RES) if (re.test(text)) out.add(TERM_ALIAS[t] || t);
  return [...out];
}

const stripHtml = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// Map a raw MCF search result to our shape.
export function mapMcfJob(r) {
  const company = r.hiringCompany?.name || r.postedCompany?.name || "";
  const hidden = r.metadata?.isHideSalary === true;
  const yrs = Number(r.minimumYearsExperience);
  const skillNames = (r.skills || []).map((x) => (typeof x === "string" ? x : x?.skill)).filter(Boolean);
  return {
    id: r.uuid || r.metadata?.jobPostId || "",
    title: r.title || "",
    company,
    salary: hidden ? null : toMonthly(r.salary),
    minYears: Number.isFinite(yrs) && r.minimumYearsExperience !== null ? yrs : null,
    url:
      r.metadata?.jobDetailsUrl ||
      (r.uuid ? `https://www.mycareersfuture.gov.sg/job/${r.uuid}` : ""),
    levels: (r.positionLevels || []).map((p) => p.position).filter(Boolean),
    // Only the matched terms are kept (not the whole description) to keep the cache small.
    skills: findSkills([r.title, skillNames.join(" , "), stripHtml(r.description).slice(0, 6000)].join(" \n ")),
    postedAt: r.metadata?.newPostingDate || r.metadata?.originalPostingDate || "",
  };
}

const SENIORITY_CANON = { sr: "senior", snr: "senior", jr: "junior", vice: "vp", president: "vp" };

// Full title tokens INCLUDING seniority words, canonicalised, for "same job" checks.
export function fullTitleTokens(title) {
  const out = [];
  for (const w of normalizeText(title).split(" ")) {
    if (!w || STOPWORDS.has(w)) continue;
    const c = SENIORITY_CANON[w] || w;
    for (const x of SYNONYMS[c] || [c]) if (!out.includes(x)) out.push(x);
  }
  return out;
}

export function sameTitle(a, b) {
  const A = fullTitleTokens(a);
  const B = fullTitleTokens(b);
  if (!A.length || A.length !== B.length) return false;
  const S = new Set(B);
  return A.every((x) => S.has(x));
}

// ---------- JD parsing ----------
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };
const NUM = String.raw`(\d{1,2}|${Object.keys(WORDNUM).join("|")})`;
const YRS = String.raw`(?:years?|yrs?)`;
const EXP_PATTERNS = [
  // 5-8 years / 5 to 8 yrs / 5+ - 8 years
  new RegExp(String.raw`${NUM}\s*\+?\s*(?:-|–|—|to)\s*${NUM}\s*\+?\s*${YRS}`, "gi"),
  // 5+ years / minimum 5 years / at least five years / 5 years
  new RegExp(String.raw`(?:minimum(?:\s+of)?|at\s+least|min\.?)?\s*${NUM}\s*(\+)?\s*${YRS}`, "gi"),
  // 5年以上 / 3-5年
  /(\d{1,2})\s*(?:-|–|至|到)?\s*(\d{1,2})?\s*年(?:以上)?(?:[^。\n]{0,12})经验/g,
];
const toNum = (s) => (s == null ? null : WORDNUM[s.toLowerCase()] ?? Number(s));

/**
 * Pull the required years of experience out of JD text.
 * Prefers matches whose surrounding text mentions "experience"; among those, the first one
 * (JDs usually state the headline requirement first). Returns {min, max, text} or null.
 */
export function parseExperience(text) {
  if (!text) return null;
  const cands = [];
  for (const re of EXP_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      let a = toNum(m[1]);
      let b = re === EXP_PATTERNS[0] || re === EXP_PATTERNS[2] ? toNum(m[2]) : null;
      if (!Number.isFinite(a) || a > 30 || (b != null && (b > 40 || b < a))) continue;
      const around = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80).toLowerCase();
      const isExp = /experience|exp\.|经验|track record|working in|in the field/.test(around);
      const near = text.slice(Math.max(0, m.index - 12), m.index + m[0].length + 15).toLowerCase();
      const isNoise = /years? old|\bago\b|warranty|founded|anniversary|history|in business/.test(near);
      if (isNoise) continue;
      cands.push({ min: a, max: b, text: m[0].trim(), index: m.index, isExp });
    }
  }
  if (!cands.length) return null;
  const pool = cands.some((c) => c.isExp) ? cands.filter((c) => c.isExp) : cands;
  pool.sort((x, y) => x.index - y.index);
  const { min, max, text: t } = pool[0];
  return { min, max, text: t };
}

// Years of experience → our seniority scale (1 junior … 4 lead/principal).
export function levelFromYears(y) {
  if (y == null) return null;
  if (y <= 1) return 1;
  if (y <= 4) return 2;
  if (y <= 7) return 3;
  return 4;
}

export function compareSalary(s, ref) {
  if (!s || !ref) return null;
  if (s.max < ref.min) return "lower";
  if (s.min > ref.max) return "higher";
  return "similar";
}

/**
 * Similar jobs at other postings: ranked by title similarity, JD skill overlap and years.
 * ref is the salary range we compare against (same job, else market P25–P75).
 */
// The role part of a title: the text before the first ", " / " - " / "(" / "|" / ":".
// "Staff / Senior Security Engineer, Firmware Test, SSD" -> "Staff / Senior Security Engineer".
// What follows is usually the team or product ("Firmware Test, SSD"); that context is compared
// through the JD skills instead, so it doesn't drag the title score down.
export function roleTokens(title) {
  const head = String(title || "").split(/,|\s[-–—|:]\s|\(|\|/)[0];
  const toks = parseTitle(head).tokens;
  return toks.length ? toks : parseTitle(title).tokens;
}

// Mean of Jaccard and overlap coefficient: "Security Engineer" vs "Product Security Engineer"
// counts as close, while unrelated roles still score low.
export function roleSimilarity(a, b) {
  const A = new Set(roleTokens(a)), B = new Set(roleTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const overlap = inter / Math.min(A.size, B.size);
  return (jaccard + overlap) / 2;
}

export const RELATED_WEIGHTS = { title: 0.3, skills: 0.5, years: 0.2 };

export function relatedJobs(target, all, { level, years, yearsRange, jdSkills, ref, excludeIds }) {
  const want = new Set(jdSkills);
  const seen = new Set();
  const scored = [];
  for (const j of all) {
    if (excludeIds.has(j.id)) continue;
    const matched = (j.skills || []).filter((x) => want.has(x));
    const roleSim = roleSimilarity(target.title, j.title);
    // Keep jobs with a similar role, or a different title but clearly overlapping work (≥2 JD skills).
    if (roleSim < 0.4 && matched.length < 2) continue;
    if (level != null && j.level != null && Math.abs(j.level - level) > 1) continue;
    const dupKey = normalizeCompany(j.company) + "|" + fullTitleTokens(j.title).sort().join(" ");
    if (seen.has(dupKey)) continue; // reposts of the same ad
    seen.add(dupKey);
    const skillScore = want.size ? matched.length / Math.min(want.size, 6) : 0.5;
    const gap = yearsGap(j.minYears, yearsRange || (years != null ? { min: years } : null));
    const yearsScore = gap == null ? 0.5 : Math.max(0, 1 - gap / 4);
    const W = RELATED_WEIGHTS;
    const score = W.title * roleSim + W.skills * Math.min(1, skillScore) + W.years * yearsScore;
    if (score < 0.35) continue;
    scored.push({ ...j, score: Math.round(score * 100), matchedSkills: matched.slice(0, 6), salaryCompare: compareSalary(j.salary, ref) });
  }
  scored.sort((a, b) => b.score - a.score || byDateDesc(a, b));
  return scored.slice(0, 40);
}

const byDateDesc = (a, b) => (b.postedAt || "").localeCompare(a.postedAt || "");
const MIN_SAMPLE = 5;
const YEARS_TOLERANCE = 2;

/**
 * Which MCF "minimum years" values count as the same seniority as the JD.
 * A range in the JD ("3-5 years") uses the whole range, widened by 1 year each side (2-6).
 * A single value ("5+ years") keeps ±2 (3-7).
 */
export function yearsWindow(y) {
  if (!y || y.min == null) return null;
  if (y.max != null && y.max > y.min) return { lo: Math.max(0, y.min - 1), hi: y.max + 1 };
  return { lo: Math.max(0, y.min - YEARS_TOLERANCE), hi: y.min + YEARS_TOLERANCE };
}

// Distance (in years) from an MCF requirement to the JD's own range; 0 when inside it.
export function yearsGap(minYears, y) {
  if (!y || y.min == null || minYears == null) return null;
  const hi = y.max != null && y.max > y.min ? y.max : y.min;
  return minYears < y.min ? y.min - minYears : minYears > hi ? minYears - hi : 0;
}

/**
 * Given the LinkedIn job and a pool of MCF jobs, produce the comparison.
 * target: { title, company, years?: {min, max} } — years come from the JD.
 * - identical: same company + same title (incl. seniority) → the posting itself
 * - likely: same company, same level, very similar title
 * - company / market: salary stats filtered by title similarity, level, and JD years
 * - profile: what MCF says about the company overall
 */
export function analyze(target, pool, extraRelated = []) {
  const t = parseTitle(target.title);
  const years = target.years?.min ?? null;

  // Level: title wins; otherwise infer from JD years.
  let level = null;
  let levelSource = null;
  if (t.detected) { level = t.level; levelSource = "title"; }
  else if (years != null) { level = levelFromYears(years); levelSource = "jd"; }

  const seen = new Set();
  const all = [];
  for (const j of pool) {
    const key = j.id || j.url || `${j.company}|${j.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = parseTitle(j.title);
    // MCF postings without a seniority word: infer from their own min-years field.
    const jl = p.detected ? p.level : levelFromYears(j.minYears);
    all.push({ ...j, sim: titleSimilarity(t, p), level: jl, levelDetected: p.detected });
  }

  const win = yearsWindow(target.years);
  // For "same job" matching a missing requirement isn't held against a posting…
  const yearsClose = (j) => !win || j.minYears == null || (j.minYears >= win.lo && j.minYears <= win.hi);
  // …but salary statistics only count postings whose stated requirement fits the JD.
  const yearsFit = (j) => !win || (j.minYears != null && j.minYears >= win.lo && j.minYears <= win.hi);
  const levelClose = (j) => level == null || j.level == null || Math.abs(j.level - level) <= 1;

  // Apply the years filter, but fall back if it leaves too few data points.
  const withYears = (list) => {
    if (years == null) return { list, years: "none" };
    const f = list.filter(yearsFit);
    if (f.length >= MIN_SAMPLE || f.length === list.length) return { list: f, years: "applied" };
    return { list, years: "relaxed" };
  };

  const ofCompany = all.filter((j) => companyMatches(j.company, target.company));
  const identical = ofCompany.filter((j) => sameTitle(j.title, target.title)).sort(byDateDesc);
  const likely = identical.length
    ? []
    : ofCompany
        .filter((j) => j.sim >= 0.66 && (level == null || j.level === level) && yearsClose(j))
        .sort((a, b) => b.sim - a.sim || byDateDesc(a, b));

  const withSalary = (xs) => xs.filter((j) => j.salary);
  const co = withYears(withSalary(ofCompany).filter((j) => j.sim >= 0.34));
  const mk = withYears(withSalary(all).filter((j) => j.sim >= 0.5 && levelClose(j)));

  const byRelevance = (a, b) =>
    b.sim - a.sim ||
    (win ? (yearsGap(a.minYears, target.years) ?? 99) - (yearsGap(b.minYears, target.years) ?? 99) : 0) ||
    b.salary.max - a.salary.max;
  const companyWithSalary = withSalary(ofCompany);
  const marketStats = summarize(mk.list);
  const hit = identical.find((j) => j.salary) || likely.find((j) => j.salary);
  const ref = hit
    ? { min: hit.salary.min, max: hit.salary.max, source: "same" }
    : marketStats.n >= 3
      ? { min: marketStats.p25, max: marketStats.p75, source: "market" }
      : null;
  const jdSkills = findSkills(target.description || "");
  // Salary uses the title's level; related jobs use what the JD actually asks for (years),
  // falling back to the title only when the JD states no years.
  const relatedLevel = years != null ? levelFromYears(years) : level;
  const relatedLevelSource = years != null ? "jd" : levelSource;
  const extra = extraRelated.map((j) => {
    const p = parseTitle(j.title);
    return { ...j, sim: titleSimilarity(t, p), level: p.detected ? p.level : levelFromYears(j.minYears), levelDetected: p.detected };
  });
  const related = relatedJobs(target, [...all, ...extra], {
    level: relatedLevel, years, yearsRange: target.years || null, jdSkills, ref,
    excludeIds: new Set([...identical, ...likely].map((j) => j.id)),
  });
  return {
    parsed: t,
    criteria: { tokens: t.tokens, level, levelSource, years: target.years || null, tolerance: YEARS_TOLERANCE, skills: jdSkills },
    related: { ref, jobs: related, level: relatedLevel, levelSource: relatedLevelSource },
    identical: identical.slice(0, 3),
    likely: likely.slice(0, 3),
    company: { ...summarize(co.list), years: co.years, examples: co.list.sort(byRelevance).slice(0, 5) },
    market: { ...summarize(mk.list), years: mk.years, examples: mk.list.sort(byRelevance).slice(0, 5) },
    profile: {
      name: ofCompany[0]?.company || "",
      openings: ofCompany.length,
      disclosed: companyWithSalary.length,
      salary: summarize(companyWithSalary),
      recent: [...ofCompany].sort(byDateDesc).slice(0, 5),
    },
  };
}


// ---------- broader market search ----------
const ROLE_NOUNS = new Set(["engineer", "developer", "analyst", "manager", "architect", "scientist", "consultant",
  "specialist", "designer", "administrator", "officer", "researcher", "tester", "auditor", "programmer"]);
const ROLE_SYNONYMS = {
  "security engineer": ["cybersecurity engineer", "information security engineer", "product security engineer"],
  "security analyst": ["cyber security analyst", "soc analyst"],
  "security architect": ["cybersecurity architect", "cloud security architect"],
  "software engineer": ["software developer", "backend engineer"],
  "software developer": ["software engineer"],
  "data engineer": ["data platform engineer", "etl developer"],
  "data scientist": ["machine learning engineer", "data analyst"],
  "devops engineer": ["site reliability engineer", "platform engineer"],
  "cloud engineer": ["cloud infrastructure engineer", "devops engineer"],
  "product manager": ["product owner"],
  "network engineer": ["network security engineer"],
};
const GENERIC_WORDS = new Set(["test", "team", "global", "apac", "remote", "hybrid", "contract", "ssd", "temp"]);

/**
 * Several MCF searches that find the same kind of work under other titles:
 * the title itself, its core role, common alternative titles, the role in other domains
 * named in the title ("firmware security"), and the JD's multi-word skills.
 */
export function relatedQueries(title, jdSkills = [], max = 6) {
  const toks = parseTitle(title).tokens;
  const qs = [];
  const add = (q) => { q = (q || "").trim(); if (q && !qs.includes(q)) qs.push(q); };
  add(toks.slice(0, 5).join(" "));
  const ri = toks.findIndex((x) => ROLE_NOUNS.has(x));
  const syn = [], domain = [];
  if (ri > 0) {
    const core = `${toks[ri - 1]} ${toks[ri]}`;
    add(core);
    syn.push(...(ROLE_SYNONYMS[core] || []));
    for (const w of toks.filter((x, i) => i !== ri && i !== ri - 1 && !GENERIC_WORDS.has(x) && x.length > 2)) {
      domain.push(`${w} ${toks[ri - 1]}`);
    }
  } else if (ri === 0 && toks[1]) {
    add(`${toks[1]} ${toks[0]}`);
  }
  const skillQs = jdSkills.filter((x) => x.includes(" "));
  // interleave so every kind of query gets a slot
  for (let i = 0; qs.length < max && i < 4; i++) {
    for (const list of [domain, syn, skillQs]) if (list[i] && qs.length < max) add(list[i]);
  }
  return qs.slice(0, max);
}

// ---------- Jooble (optional, user-supplied key) ----------
// Salary on Jooble is free text ("$5,000 - $7,000 per month", "SGD 90k-120k a year").
export function parseSalaryText(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(/,/g, "");
  if (/(usd|us\$|eur|€|£|rm\b|myr|inr|₹|php|idr|aud|hkd)/.test(t)) return null; // other currencies
  const nums = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(k\b)?/g)]
    .map((m) => parseFloat(m[1]) * (m[2] ? 1000 : 1))
    .filter((n) => n >= 5);
  if (!nums.length) return null;
  const min = nums[0], max = nums[1] ?? nums[0];
  let per = /hour|\bhr\b|per h/.test(t) ? "hour"
    : /\bday\b|daily/.test(t) ? "day"
    : /year|annum|annual|p\.a|yearly|\/yr/.test(t) ? "year"
    : /month|mth|\/mo\b|monthly/.test(t) ? "month" : null;
  if (!per) per = max >= 40000 ? "year" : "month";
  if (per === "hour" || per === "day") return null;
  return toMonthly({ minimum: min, maximum: max, type: { salaryType: per === "year" ? "Annually" : "Monthly" } });
}

export function mapJoobleJob(j) {
  const snippet = stripHtml(j.snippet || "");
  const yrs = parseExperience(snippet);
  return {
    id: "jooble:" + (j.id ?? j.link ?? `${j.company}|${j.title}`),
    source: "jooble",
    title: stripHtml(j.title || "").trim(),
    company: (j.company || "").trim(),
    salary: parseSalaryText(j.salary),
    salaryText: (j.salary || "").trim(),
    minYears: yrs ? yrs.min : null,
    url: j.link || "",
    location: j.location || "",
    levels: [],
    skills: findSkills([j.title, snippet].join(" \n ")),
    postedAt: j.updated || "",
  };
}
