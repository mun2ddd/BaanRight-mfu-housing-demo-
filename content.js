// Shows a small floating button near selected text so a student can select
// a Thai post (e.g. inside a Facebook group they're already a member of)
// and send just that selected text to the extension. This never fetches
// anything from the page on its own and never reads a URL — it only acts
// on text the user has explicitly highlighted.

let floatBtn = null;

function removeButton() {
  if (floatBtn) {
    floatBtn.remove();
    floatBtn = null;
  }
}

document.addEventListener("mouseup", () => {
  removeButton();
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : "";
  if (text.length < 10 || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  floatBtn = document.createElement("button");
  floatBtn.textContent = "\uD83C\uDF10 Translate with BaanRight";
  Object.assign(floatBtn.style, {
    position: "fixed",
    top: `${Math.max(rect.top - 38, 4)}px`,
    left: `${Math.min(rect.left, window.innerWidth - 210)}px`,
    zIndex: 2147483647,
    background: "linear-gradient(135deg, #0f6e56, #1d9e75)",
    color: "white",
    border: "1px solid rgba(255,255,255,0.25)",
    borderRadius: "999px",
    padding: "7px 14px",
    fontSize: "12.5px",
    fontWeight: "600",
    fontFamily: "Segoe UI, -apple-system, sans-serif",
    cursor: "pointer",
    boxShadow: "0 6px 16px rgba(15,110,86,0.4)",
    transform: "translateY(0)",
    transition: "transform 0.15s ease, box-shadow 0.15s ease"
  });

  floatBtn.addEventListener("mouseenter", () => {
    floatBtn.style.transform = "translateY(-1px)";
    floatBtn.style.boxShadow = "0 9px 22px rgba(15,110,86,0.5)";
  });
  floatBtn.addEventListener("mouseleave", () => {
    floatBtn.style.transform = "translateY(0)";
    floatBtn.style.boxShadow = "0 6px 16px rgba(15,110,86,0.4)";
  });

  floatBtn.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection
  floatBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "TRANSLATE_SELECTION", text });
    removeButton();
  });

  document.body.appendChild(floatBtn);
});

document.addEventListener("mousedown", (e) => {
  if (floatBtn && e.target !== floatBtn) removeButton();
});
