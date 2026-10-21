// Runs on claude.ai and chatgpt.com. It does nothing unless SG Job Lens opened this exact tab
// to deliver a prompt: the background worker keeps one pending prompt per tab it created, and
// this script fetches it once and types it into the chat box. It never presses send — the user does.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout, every = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const v = fn();
        if (v) return v;
      } catch (_) {}
      await sleep(every);
    }
    return null;
  }

  const COMPOSERS = [
    "#prompt-textarea",
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    "textarea",
  ];
  const visible = (e) => e && e.isConnected && e.getClientRects().length > 0;
  const findComposer = () => {
    for (const s of COMPOSERS) {
      const e = [...document.querySelectorAll(s)].find(visible);
      if (e) return e;
    }
    return null;
  };
  const textOf = (c) => (c.tagName === "TEXTAREA" ? c.value : c.innerText || c.textContent || "");

  function fill(c, text) {
    c.focus();
    if (c.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(c, text);
      c.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // Rich editors (ProseMirror) listen for real editing input; insertText goes through it.
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(c);
    sel.addRange(range);
    if (!document.execCommand("insertText", false, text)) {
      c.textContent = text;
      c.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  (async () => {
    // Ask for the prompt a few times: the tab can load before the worker has stored it.
    let pending = null;
    for (let i = 0; i < 20 && !pending; i++) {
      try {
        pending = (await chrome.runtime.sendMessage({ type: "takePendingPrompt" }))?.pending || null;
      } catch (_) {}
      if (!pending) await sleep(500);
    }
    if (!pending) return;

    const report = (status, detail = "") =>
      chrome.runtime.sendMessage({ type: "aiDelivery", status, detail, target: pending.target }).catch(() => {});

    const composer = await waitFor(findComposer, 30000);
    if (!composer) {
      return report("failed", "没找到输入框，可能需要先登录。登录后回到插件再点一次发送。");
    }
    fill(composer, pending.prompt);
    const filled = await waitFor(() => textOf(composer).trim().length > Math.min(50, pending.prompt.length / 2), 5000);
    if (!filled) return report("failed", "没能把内容填进输入框。");

    // Leave the cursor at the end of the text so the user can review and press Enter / Send.
    try {
      composer.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
    report("filled");
  })();
})();
