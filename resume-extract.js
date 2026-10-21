// Turn an uploaded resume file into plain text. Libraries are injected so the same
// code runs in the extension (offscreen document) and in Node tests.

const MAX_CHARS = 20000;

const decodeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

export function tidy(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/[ \t ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CHARS);
}

export function docxToText(bytes, fflate) {
  const files = fflate.unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("不是有效的 .docx 文件");
  const s = fflate.strFromU8(xml)
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeXml(s));
}

export async function pdfToText(bytes, pdfjs) {
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, 20); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let out = "";
    for (const it of content.items) {
      out += it.str;
      if (it.hasEOL) out += "\n";
      else if (it.str && !/\s$/.test(it.str)) out += " ";
    }
    pages.push(out);
  }
  await doc.destroy();
  const text = tidy(pages.join("\n\n"));
  if (!text) throw new Error("PDF 里没有可提取的文字（可能是扫描件）");
  return text;
}

export async function extractResume(bytes, filename, { pdfjs, fflate }) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return pdfToText(bytes, pdfjs);
  if (ext === "docx") return docxToText(bytes, fflate);
  if (ext === "txt" || ext === "md") return tidy(new TextDecoder().decode(bytes));
  if (ext === "doc") throw new Error("不支持旧版 .doc，请另存为 .docx 或 PDF");
  throw new Error("只支持 PDF、DOCX、TXT、MD");
}
