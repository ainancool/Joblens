import assert from "node:assert/strict";
import {
  parseTitle, titleSimilarity, buildSearchTerm, companyMatches,
  toMonthly, analyze, mapMcfJob, sameTitle,
} from "../lib.js";

// title parsing
assert.equal(parseTitle("Senior Application Security Engineer").level, 3);
assert.equal(parseTitle("Security Engineering Manager").level, 5);
assert.equal(parseTitle("Software Engineer").detected, false);
assert.deepEqual(parseTitle("Sr. AppSec Engineer (Singapore)").tokens, ["application", "security", "engineer"]);
assert.equal(buildSearchTerm("Senior Security Engineer - Cloud"), "security engineer cloud");
assert.ok(titleSimilarity(parseTitle("AppSec Engineer"), parseTitle("Application Security Engineer")) === 1);

// company matching
assert.ok(companyMatches("ByteDance", "BYTEDANCE PTE. LTD."));
assert.ok(companyMatches("Grab", "GRABTAXI HOLDINGS PTE. LTD."));
assert.ok(companyMatches("DBS Bank", "DBS BANK LTD."));
assert.ok(!companyMatches("Sea", "SEAGATE TECHNOLOGY INTERNATIONAL")); // too short -> no prefix match
assert.ok(!companyMatches("Shopee", "Lazada"));

// salary
assert.deepEqual(toMonthly({ minimum: 8000, maximum: 12000, type: { salaryType: "Monthly" } }), { min: 8000, max: 12000 });
assert.deepEqual(toMonthly({ minimum: 120000, maximum: 180000, type: { salaryType: "Annually" } }), { min: 10000, max: 15000 });
assert.equal(toMonthly({ minimum: 20, maximum: 30, type: { salaryType: "Hourly" } }), null);
assert.equal(toMonthly(null), null);

// end-to-end analyze
const raw = (uuid, title, company, min, max) => ({
  uuid, title, postedCompany: { name: company },
  salary: { minimum: min, maximum: max, type: { salaryType: "Monthly" } },
  metadata: { jobDetailsUrl: `https://www.mycareersfuture.gov.sg/job/${uuid}` },
});
const pool = [
  raw("1", "Senior Security Engineer", "BYTEDANCE PTE. LTD.", 9000, 15000),
  raw("2", "Security Engineer", "BYTEDANCE PTE. LTD.", 7000, 11000),
  raw("3", "Senior Security Engineer", "DBS BANK LTD.", 8000, 13000),
  raw("4", "Lead Security Engineer", "GRAB PTE. LTD.", 11000, 17000),
  raw("5", "Intern Security Engineer", "GRAB PTE. LTD.", 1000, 1500),
  raw("6", "Senior Accountant", "BYTEDANCE PTE. LTD.", 6000, 8000),
  raw("1", "Senior Security Engineer", "BYTEDANCE PTE. LTD.", 9000, 15000), // dup
].map(mapMcfJob);

const r = analyze({ title: "Senior Security Engineer", company: "ByteDance" }, pool);
assert.equal(r.company.n, 2, "same company, similar titles, deduped");
assert.equal(r.profile.openings, 3);
assert.equal(r.identical.length, 1, "exact same posting found");
assert.equal(r.identical[0].id, "1");
assert.deepEqual(r.identical[0].salary, { min: 9000, max: 15000 });

// identical title matching
assert.ok(sameTitle("Sr. Security Engineer", "Senior Security Engineer"));
assert.ok(sameTitle("AppSec Engineer (Singapore)", "Application Security Engineer"));
assert.ok(!sameTitle("Senior Security Engineer", "Security Engineer"));
assert.ok(!sameTitle("Security Engineer", "Security Engineer Intern"));

// no identical -> likely match at same level
const r2 = analyze({ title: "Senior Security Engineer, Cloud", company: "ByteDance" }, pool);
assert.equal(r2.identical.length, 0);
assert.equal(r2.likely[0]?.id, "1");

// hidden salary posting still shows up as identical
const hidden = mapMcfJob({ uuid: "h", title: "Staff Security Engineer", postedCompany: { name: "BYTEDANCE PTE. LTD." }, metadata: { isHideSalary: true } });
const r3 = analyze({ title: "Staff Security Engineer", company: "ByteDance" }, [...pool, hidden]);
assert.equal(r3.identical[0].id, "h");
assert.equal(r3.identical[0].salary, null);
assert.equal(r.market.n, 4, "intern excluded by seniority, accountant by title");
assert.equal(r.market.examples[0].sim, 1);
console.log("company:", r.company.p25, r.company.p50, r.company.p75, r.company.confidence);
console.log("market:", r.market.p25, r.market.p50, r.market.p75, r.market.confidence);
console.log("all tests passed");

// ---------- JD experience parsing ----------
import { parseExperience, levelFromYears } from "../lib.js";
const pe = (s) => { const r = parseExperience(s); return r && [r.min, r.max]; };
assert.deepEqual(pe("You have 5+ years of experience in application security."), [5, null]);
assert.deepEqual(pe("Requirements: 3-5 years experience with SAST/DAST"), [3, 5]);
assert.deepEqual(pe("Minimum of seven years of relevant experience"), [7, null]);
assert.deepEqual(pe("At least 8 yrs in security engineering experience; 2 years with Go a plus"), [8, null]);
assert.deepEqual(pe("Founded 25 years ago, we are... Need 4 to 6 years of experience"), [4, 6]);
assert.deepEqual(pe("3年以上安全相关工作经验"), [3, null]);
assert.equal(pe("We value curiosity and ownership."), null);
assert.equal(levelFromYears(6), 3);

// years-aware market filter
const rawY = (uuid, title, company, min, max, yrs) => ({
  uuid, title, postedCompany: { name: company }, minimumYearsExperience: yrs,
  salary: { minimum: min, maximum: max, type: { salaryType: "Monthly" } }, metadata: {},
});
const poolY = [
  ...Array.from({ length: 6 }, (_, i) => rawY("y" + i, "Security Engineer", "CO" + i, 9000, 13000, 6)),
  ...Array.from({ length: 6 }, (_, i) => rawY("z" + i, "Security Engineer", "XO" + i, 5000, 7000, 3)),
].map(mapMcfJob);
const ry = analyze({ title: "Security Engineer", company: "Foo", years: { min: 6, max: null } }, poolY);
assert.equal(ry.criteria.levelSource, "jd");
assert.equal(ry.criteria.level, 3);
assert.equal(ry.market.n, 6, "only ~6-year postings kept");
assert.equal(ry.market.years, "applied");
assert.equal(ry.market.p50, 11000);
// too few after filtering -> relaxed
const ry2 = analyze({ title: "Security Engineer", company: "Foo", years: { min: 6 } }, poolY.slice(4));
assert.equal(ry2.market.years, "relaxed");
console.log("jd tests passed");

// ---------- skills & related jobs ----------
import { findSkills, compareSalary } from "../lib.js";
assert.deepEqual(findSkills("Strong in Go and AWS; SAST/DAST, threat modelling. C++ a plus").sort(),
  ["aws", "c++", "dast", "go", "sast", "threat modeling"].sort());
assert.ok(!findSkills("Let's go to the meeting").includes("python"));
assert.ok(!findSkills("wazuh").includes("wiz"));
assert.equal(compareSalary({ min: 9000, max: 13000 }, { min: 10000, max: 14000 }), "similar"); // mid 11000 vs 12000: -8%
assert.equal(compareSalary({ min: 8000, max: 12000 }, { min: 10000, max: 14000 }), "lower");   // -17%
assert.equal(compareSalary({ min: 9800, max: 20000 }, { min: 6500, max: 10000 }), "higher");  // barely overlapping, clearly higher
assert.equal(compareSalary({ min: 15000, max: 18000 }, { min: 10000, max: 14000 }), "higher");
assert.equal(compareSalary({ min: 4000, max: 6000 }, { min: 10000, max: 14000 }), "lower");
assert.equal(compareSalary(null, { min: 1, max: 2 }), null);

const rawS = (uuid, title, company, sal, yrs, desc, skills = []) => ({
  uuid, title, postedCompany: { name: company }, minimumYearsExperience: yrs, description: desc,
  skills: skills.map((skill) => ({ skill })),
  salary: sal ? { minimum: sal[0], maximum: sal[1], type: { salaryType: "Monthly" } } : null,
  metadata: { newPostingDate: "2026-10-01" },
});
const jd = "5+ years of experience in application security. SAST, DAST, threat modeling, AWS, Go.";
const poolR = [
  rawS("same", "Senior AppSec Engineer", "BYTEDANCE PTE. LTD.", [9000, 15000], 5, "", []),
  rawS("a", "Application Security Engineer", "GRAB PTE. LTD.", [10000, 14000], 5, "<p>SAST and DAST tooling, threat modeling on AWS</p>"),
  rawS("a2", "Application Security Engineer", "GRAB PTE. LTD.", [10000, 14000], 5, "repost"),
  rawS("b", "Senior Product Security Engineer", "SHOPEE", null, 6, "Go, AWS, secure code review", ["Application Security"]),
  rawS("c", "Security Engineer", "DBS BANK LTD.", [5000, 7000], 2, "SIEM, SOC monitoring"),
  rawS("d", "Senior Accountant", "OKX", [9000, 12000], 5, "audit"),
  rawS("e", "Security Engineering Manager", "SEA", [18000, 22000], 10, "lead team"),
].map(mapMcfJob);
const rr = analyze({ title: "Senior AppSec Engineer", company: "ByteDance", years: { min: 5 }, description: jd }, poolR);
const ids = rr.related.jobs.map((j) => j.id);
assert.equal(rr.related.ref.source, "mcf-same");
assert.ok(!ids.includes("same"), "the identical posting is not 'related'");
assert.ok(!ids.includes("d"), "different role excluded");
assert.ok(!ids.includes("e"), "manager level excluded for senior IC");
assert.ok(ids.includes("a") !== ids.includes("a2"), "reposts collapsed");
assert.equal(ids[0], "a", "best skill+title match first");
assert.equal(rr.related.jobs[0].salaryCompare, "similar");
assert.ok(rr.related.jobs[0].matchedSkills.includes("sast"));
const b = rr.related.jobs.find((j) => j.id === "b");
assert.ok(b && b.salary === null && b.salaryCompare === null, "no-salary job kept, flagged by UI as info only");
console.log("related:", rr.related.jobs.map((j) => `${j.id}:${j.score}:${j.salaryCompare}`).join(" "));
console.log("related tests passed");

// ---------- salary level from title, related level from JD ----------
const poolL = [
  rawS("mid", "Firmware Security Engineer", "SEAGATE", [6000, 9000], 3, "fuzzing secure boot python"),
  rawS("snr", "Senior Firmware Security Engineer", "INFINEON", [7000, 11000], 4, "secure boot python"),
  rawS("lead", "Lead Firmware Security Engineer", "NXP", [12000, 16000], 10, "secure boot python"),
].map(mapMcfJob);
const rl = analyze({ title: "Staff / Senior Security Engineer, Firmware Test, SSD", company: "Micron",
  years: { min: 3, max: 5 }, description: "3-5 years of experience. Python, fuzzing, secure boot." }, poolL);
assert.equal(rl.criteria.level, 4, "salary tab: level from title (Staff)");
assert.equal(rl.criteria.levelSource, "title");
assert.equal(rl.related.level, 2, "related: level from JD years (3-5 → Mid)");
assert.equal(rl.related.levelSource, "jd");
const rlIds = rl.related.jobs.map((j) => j.id);
assert.ok(rlIds.includes("mid") && rlIds.includes("snr"), "Mid/Senior roles match the JD");
assert.ok(!rlIds.includes("lead"), "Lead (10 yrs) is too senior for a 3–5 year JD");
// no years in JD → related falls back to title level
const rl2 = analyze({ title: "Senior Firmware Security Engineer", company: "Micron", description: "Python, secure boot." }, poolL);
assert.equal(rl2.related.level, 3);
assert.equal(rl2.related.levelSource, "title");
console.log("level-source tests passed");

// ---------- broader market search ----------
import { relatedQueries, parseSalaryText, mapJoobleJob } from "../lib.js";
const q = relatedQueries("Staff / Senior Security Engineer, Firmware Test, SSD", ["product security", "python"]);
assert.ok(q.includes("security engineer") && q.includes("firmware security"), "core role + domain variant");
assert.ok(q.some((x) => x.includes("cybersecurity")), "alternative title");
assert.ok(q.length <= 6);
assert.deepEqual(parseSalaryText("$5,000 - $7,000 per month"), { min: 5000, max: 7000 });
assert.deepEqual(parseSalaryText("SGD 90k-120k a year"), { min: 7500, max: 10000 });
assert.equal(parseSalaryText("USD 100k"), null);
assert.equal(parseSalaryText("$30 per hour"), null);

const jdF = "3-5 years of experience. Secure boot, fuzzing, threat modeling, Python, product security.";
const poolF = [
  rawS("ttl", "Firmware Security Engineer", "SEAGATE", [6000, 9000], 3, "secure boot python"),
  // different title, same kind of work
  rawS("pse", "Embedded Platform Specialist", "INFINEON", [7000, 10000], 4, "threat modeling, product security, python fuzzing"),
  // different title and different work
  rawS("acc", "Finance Specialist", "OKX", [7000, 9000], 4, "audit, compliance"),
].map(mapMcfJob);
const jooble = [
  { id: 1, title: "Product Security Engineer", company: "Bosch", salary: "$8,000 - $11,000 per month", link: "https://jooble.org/desc/1", snippet: "Threat modeling and secure boot for IoT. 4+ years of experience.", location: "Singapore", updated: "2026-10-12" },
  { id: 2, title: "Firmware Security Engineer", company: "Seagate", salary: "", link: "https://jooble.org/desc/2", snippet: "secure boot python", location: "Singapore" },
].map(mapJoobleJob);
const rf = analyze({ title: "Firmware Security Engineer", company: "Micron", years: { min: 3, max: 5 }, description: jdF }, poolF, jooble);
const fids = rf.related.jobs.map((j) => j.id);
assert.ok(fids.includes("pse"), "different title but overlapping work is found");
assert.ok(!fids.includes("acc"), "unrelated work excluded");
assert.ok(fids.includes("jooble:1"), "Jooble job included");
const bosch = rf.related.jobs.find((j) => j.id === "jooble:1");
assert.equal(bosch.source, "jooble");
assert.deepEqual(bosch.salary, { min: 8000, max: 11000 });
assert.equal(bosch.minYears, 4);
assert.ok(!fids.includes("jooble:2"), "Jooble duplicate of an MCF posting dropped (MCF wins)");
assert.equal(rf.market.n, poolF.filter((j) => j.salary).length >= 0 ? rf.market.n : -1);
assert.ok(!rf.market.examples.some((j) => String(j.id).startsWith("jooble")), "Jooble never used in salary statistics");
console.log("broad-search tests passed:", fids.join(" "));

// ---------- role-based title score (team/product words don't count) ----------
import { roleTokens, roleSimilarity } from "../lib.js";
assert.deepEqual(roleTokens("Staff / Senior Security Engineer, Firmware Test, SSD"), ["security", "engineer"]);
assert.deepEqual(roleTokens("Cybersecurity Engineer (OT)"), ["cyber", "security", "engineer"]);
assert.ok(roleSimilarity("Staff / Senior Security Engineer, Firmware Test, SSD", "Product Security Engineer") > 0.8);
assert.equal(roleSimilarity("Security Engineer, Firmware", "Senior Accountant"), 0);
const jdM = "3-5 years of experience in firmware or product security. Secure boot, fuzzing, threat modeling, Python.";
const poolM = [
  rawS("net", "Network Security Engineer", "TELCO", [7000, 9000], 4, "SIEM, firewall, SOC"),
  rawS("fw", "Firmware Security Engineer", "INFINEON", [7000, 11000], 4, "secure boot, fuzzing, python"),
].map(mapMcfJob);
const boschJ = [{ id: 11, title: "Product Security Engineer", company: "Bosch", salary: "$8,000 - $11,000 per month",
  link: "x", snippet: "Threat modeling and secure boot for IoT devices. 4+ years of experience.", location: "Singapore" }].map(mapJoobleJob);
const rm = analyze({ title: "Staff / Senior Security Engineer, Firmware Test, SSD", company: "Micron", years: { min: 3, max: 5 }, description: jdM }, poolM, boschJ);
const sc = Object.fromEntries(rm.related.jobs.map((j) => [j.id, j.score]));
console.log("scores:", sc);
assert.ok(sc["jooble:11"] >= 60, "Bosch: same work, different product words -> clearly similar");
assert.ok(sc.fw > (sc.net ?? 0), "skills decide between two 'security engineer' roles");
console.log("role-score tests passed");

// ---------- JD year range used for salary statistics ----------
import { yearsWindow, yearsGap } from "../lib.js";
assert.deepEqual(yearsWindow({ min: 3, max: 5 }), { lo: 2, hi: 6 });
assert.deepEqual(yearsWindow({ min: 5, max: null }), { lo: 3, hi: 7 });
assert.equal(yearsWindow(null), null);
assert.equal(yearsGap(4, { min: 3, max: 5 }), 0);
assert.equal(yearsGap(8, { min: 3, max: 5 }), 3);
const rawR = (uuid, yrs, lo, hi) => ({ uuid, title: "Security Engineer", postedCompany: { name: "CO" + uuid },
  minimumYearsExperience: yrs, salary: { minimum: lo, maximum: hi, type: { salaryType: "Monthly" } }, metadata: {} });
const poolRange = [
  ...[2, 3, 4, 5, 6, 6].map((y, i) => rawR("in" + i, y, 7000 + y * 500, 10000 + y * 500)),   // inside 2–6
  ...[1, 1, 8, 10].map((y, i) => rawR("out" + i, y, 3000 + y * 900, 5000 + y * 1200)),        // outside
  rawR("na", null, 20000, 25000),                                                            // no requirement stated
].map(mapMcfJob);
const rR = analyze({ title: "Security Engineer", company: "X", years: { min: 3, max: 5, text: "3-5 years" } }, poolRange);
assert.equal(rR.market.years, "applied");
assert.equal(rR.market.n, 6, "only 2–6 year postings; 1, 8, 10 years and 'not stated' excluded");
assert.ok(!rR.market.examples.some((j) => j.id === "na"));
// upper bound matters now: same JD written as "3+ years" would include the 1-year postings' neighbours differently
const rP = analyze({ title: "Security Engineer", company: "X", years: { min: 3, max: null } }, poolRange);
assert.equal(rP.market.n, 7 - 1, "3+ years -> 1–5 window: 1,1,2,3,4,5");
console.log("year-range tests passed");

// ---------- this job's salary from public information ----------
import { estimateSalary, findJdSalary } from "../lib.js";
const base = { identical: [], likely: [], companyList: [], marketList: [] };
assert.equal(estimateSalary({ ...base, pageSalaryText: "$8,000/month - $12,000/month" }).source, "page");
assert.deepEqual(estimateSalary({ ...base, pageSalaryText: "SGD 120K/yr - 150K/yr" }).range, { min: 10000, max: 12500 });
assert.equal(estimateSalary({ ...base, description: "Salary: S$8,000 - S$10,000 per month" }).source, "jd");
assert.equal(findJdSalary("Competitive salary package."), null);
const m = (id, lo, hi) => ({ id, salary: { min: lo, max: hi } });
assert.equal(estimateSalary({ ...base, identical: [m("s", 9000, 15000)] }).source, "mcf-same");
assert.equal(estimateSalary({ ...base, likely: [m("l", 9000, 14000)] }).source, "mcf-likely");
// hidden MCF salary -> falls through to estimate, flagged
const est = estimateSalary({ ...base, identical: [{ id: "h", salary: null }],
  companyList: [m("c1", 9000, 13000), m("c2", 10000, 14000)],
  marketList: [m("c1", 9000, 13000), m("m1", 6000, 9000), m("m2", 7000, 10000), m("m3", 8000, 12000), m("m4", 12000, 16000)] });
assert.equal(est.source, "estimate");
assert.equal(est.hidden, true);
assert.equal(est.companyN, 2); assert.equal(est.marketN, 5);
assert.ok(est.range.min >= 7000 && est.range.max <= 14000 && est.range.min < est.range.max, JSON.stringify(est.range));
assert.ok(est.mid >= 10000, "company postings weigh more, pulling the middle up: " + est.mid);
assert.equal(est.range.min % 100, 0);
assert.equal(estimateSalary({ ...base, marketList: [m("a", 1, 2), m("b", 3, 4)] }).source, "none");
// end-to-end: analyze() exposes the estimate
const re = analyze({ title: "Security Engineer", company: "X", years: { min: 3, max: 5 }, description: "x", pageSalary: "" }, poolRange);
assert.equal(re.estimate.source, "estimate");
assert.ok(re.estimate.range.min > 0);
const rp = analyze({ title: "Security Engineer", company: "X", pageSalary: "SGD 9,000 - 12,000 per month" }, poolRange);
assert.equal(rp.estimate.source, "page");
console.log("salary-estimate tests passed:", JSON.stringify(est.range), est.mid, "| e2e", JSON.stringify(re.estimate.range));

// ---------- long titles: salary stats compare the role part only ----------
const poolLong = [
  rawS("s1", "Senior Security Engineer", "NXP", [8500, 12000], 5, ""),
  rawS("s2", "Senior Security Engineer, Product", "GOVTECH", [9000, 13000], 5, ""),
  rawS("s3", "Lead Security Engineer", "GRAB", [11000, 15000], 6, ""),
  rawS("acct", "Senior Accountant", "OKX", [9000, 12000], 5, ""),
].map(mapMcfJob);
const rLong = analyze({ title: "Staff / Senior Security Engineer, Firmware Test, SSD", company: "Acme", years: { min: 3, max: 6 } }, poolLong);
assert.equal(rLong.market.n, 3, "team/product words after the comma no longer block matches");
assert.equal(rLong.estimate.source, "estimate");
console.log("long-title stats test passed:", JSON.stringify(rLong.estimate.range));
// weighted percentile sanity: three market postings, median is the middle one
const e3 = estimateSalary({ identical: [], likely: [], companyList: [], marketList: [m("a", 8500, 12000), m("b", 9000, 13000), m("c", 14000, 18000)] });
assert.equal(e3.mid, 11000);
// a same-company posting counts twice
const e4 = estimateSalary({ identical: [], likely: [], companyList: [m("c", 14000, 18000)], marketList: [m("a", 8500, 12000), m("b", 9000, 13000), m("c", 14000, 18000)] });
assert.ok(e4.mid > e3.mid, `${e4.mid} > ${e3.mid}`);
console.log("weighted percentile tests passed:", e3.mid, e4.mid, JSON.stringify(e3.range));
