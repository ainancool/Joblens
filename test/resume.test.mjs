import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fflate from "../vendor/fflate.js";
import * as pdfjs from "../vendor/pdf.min.mjs";
import { extractResume } from "../resume-extract.js";

const here = new URL("./fixtures/", import.meta.url);
const bytes = (f) => new Uint8Array(readFileSync(new URL(f, here)));

const d = await extractResume(bytes("resume.docx"), "resume.docx", { pdfjs, fflate });
assert.match(d, /JY Tan/);
assert.match(d, /SAST & DAST rollout, threat modeling <AWS>/, "entities decoded");
assert.ok(d.split("\n").length >= 3, "paragraphs kept on separate lines");

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
const p = await extractResume(bytes("resume.pdf"), "CV.PDF", { pdfjs, fflate });
assert.match(p, /JY Tan - Security Engineer/);
assert.match(p, /Page two: Education/);

assert.equal(await extractResume(new TextEncoder().encode("  hello\r\n\r\n\r\nworld  "), "a.txt", {}), "hello\n\nworld");
await assert.rejects(extractResume(new Uint8Array(), "a.doc", {}), /docx/);
await assert.rejects(extractResume(new Uint8Array(), "a.png", {}), /只支持/);
console.log("resume extraction tests passed");
