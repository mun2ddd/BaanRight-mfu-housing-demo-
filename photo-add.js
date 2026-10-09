// Photo uploader tab — exists because the native file chooser closes the
// extension popup on macOS, so file picking happens on a normal tab here.
// Added photos are appended to the same photoTray the popup renders.

const els = {};
document.querySelectorAll("[id]").forEach((el) => (els[el.id] = el));

let added = []; // photos added this session, for the local preview

init();

function init() {
  renderPreview(); // show what's already in the tray when the tab opens

  els.filePicker.addEventListener("change", () => {
    ingest([...(els.filePicker.files || [])]);
    els.filePicker.value = "";
  });

  // Drag & drop
  ["dragover", "dragenter"].forEach((ev) =>
    els.dropLabel.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropLabel.classList.add("active");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    els.dropLabel.addEventListener(ev, (e) => {
      e.preventDefault();
      els.dropLabel.classList.remove("active");
    })
  );
  els.dropLabel.addEventListener("drop", (e) => {
    ingest([...(e.dataTransfer?.files || [])]);
  });

  // Paste
  document.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) ingest(files);
  });
}

async function ingest(files) {
  if (!files.length) return;
  let okCount = 0;
  for (const file of files) {
    try {
      const src = await fileToDataUrl(file);
      const stored = await storeGet("photoTray");
      const tray = stored.photoTray || [];
      if (tray.some((p) => p.src === src)) continue;
      tray.unshift({ id: Date.now() + Math.random(), src, selected: true });
      await storeSet({ photoTray: tray });
      added.unshift(src);
      okCount++;
    } catch (err) {
      console.warn(err);
      toast(`Couldn't read ${file.name || "image"}`, "error");
    }
  }
  if (okCount) {
    showStatus(`${okCount} photo${okCount > 1 ? "s" : ""} added to your tray`, "ok");
    toast(`${okCount} added to the BaanRight tray`);
    renderPreview();
  }
}

async function renderPreview() {
  // Render the real tray from storage (falls back to this session's adds
  // when storage is unavailable), so this tab always mirrors the popup.
  const stored = await storeGet("photoTray");
  const tray = Array.isArray(stored.photoTray) ? stored.photoTray : [];
  const list = tray.length ? tray.map((p) => p.src) : added;

  els.preview.innerHTML = list
    .map((src) => `<div class="photo-thumb selected"><img src="${escAttr(src)}" alt="" /></div>`)
    .join("");

  if (els.emptyHint) els.emptyHint.classList.toggle("hidden", list.length > 0);
  if (els.countChip) els.countChip.textContent = `${list.length} in tray`;
}

// ---------- Helpers (shared logic, mirrored from popup.js) ----------
function fileToDataUrl(file, maxW = 1000) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Not an image"));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / (img.width || maxW));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("Not a readable image"));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function storeGet(keys) {
  try { return await chrome.storage.local.get(keys); }
  catch (e) { console.warn("storage get failed", e); return {}; }
}
async function storeSet(obj) {
  try { await chrome.storage.local.set(obj); return true; }
  catch (e) { console.warn("storage set failed", e); return false; }
}

function showStatus(message, kind) {
  els.status.textContent = message;
  els.status.className = `status ${kind}`;
}

function toast(message, kind = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${kind === "error" ? "err" : ""}`;
  t.textContent = message;
  els.toastWrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => t.classList.add("show"), 80);
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 260);
  }, 2600);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
function escAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
