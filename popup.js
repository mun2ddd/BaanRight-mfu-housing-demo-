const MYMEMORY_URL = "https://api.mymemory.translated.net/get";

const LANDMARKS = [
  { keywords: ["ฟ้าไทย", "fah thai", "ตลาดฟ้าไทย"], name: "Fah Thai market area", approxNote: "~5\u20138 min / 3\u20133.5 km from MFU (typical for this area)" }
];

const REPLY_TEMPLATES = [
  { id: "avail", en: "Hi, is this room still available?" },
  { id: "view", en: "Can I schedule a viewing this weekend?" },
  { id: "deposit", en: "Is the deposit negotiable?" },
  { id: "utilities", en: "What utilities are included in the price?" },
  { id: "foreigner", en: "Do you accept international students as tenants?" }
];

const els = {};
document.querySelectorAll("[id]").forEach((el) => (els[el.id] = el));

let currentMode = "text";
let lastResult = null;
let expandedSavedId = null; // tracks which saved item currently has details open
let savedQuery = "";
let photoTray = []; // { id, src, selected } — photos waiting to be attached to a listing

init();

async function init() {
  bindTabs();
  bindModeButtons();
  bindRun();
  bindSave();
  bindAlerts();
  bindReply();
  bindTheme();
  bindPhotos();
  bindSavedToolbar();
  bindShortcut();
  bindDraft();

  applyTheme(await loadTheme());

  // Load the existing photo tray FIRST so a right-click photo below appends
  // to it instead of overwriting it.
  photoTray = (await storeGet("photoTray")).photoTray || photoTray;

  // Restore the in-progress draft — the popup can close at any moment
  // (losing focus, opening a file dialog), so never lose the user's work.
  const { draft } = await storeGet("draft");
  if (draft && typeof draft === "object") {
    els.thaiText.value = draft.text || "";
    els.sourceLinkInput.value = draft.link || "";
    if (draft.result) {
      lastResult = draft.result;
      renderResult(lastResult);
    }
  }

  const { pendingText } = await storeGet("pendingText");
  if (pendingText) {
    els.thaiText.value = pendingText;
    // The restored result belongs to the previous text \u2014 don't show it next to the new one.
    lastResult = null;
    els.result.classList.add("hidden");
    // Save the selection as the draft BEFORE removing it from storage: the popup
    // closes whenever the user clicks the page, and the text must survive that.
    await storeSet({ draft: { text: pendingText, link: els.sourceLinkInput.value, result: null } });
    await storeRemove("pendingText");
    setActiveTab("translate");
  }

  // Photo grabbed via right-click → "Save image to BaanRight"
  const { pendingImage } = await storeGet("pendingImage");
  if (pendingImage) {
    await storeRemove("pendingImage");
    const added = addPhoto(pendingImage, { persist: true });
    setActiveTab("translate");
    if (added) toast("Photo added \u2014 tick it before you save the listing");
  }

  renderPhotoTray();
  renderSaved();
  renderAlerts();
  renderReplyOptions();
}

// ---------- Storage helpers (degrade gracefully if storage is unavailable) ----------
async function storeGet(keys) {
  try { return await chrome.storage.local.get(keys); }
  catch (e) { console.warn("storage get failed", e); return {}; }
}
async function storeSet(obj) {
  try { await chrome.storage.local.set(obj); }
  catch (e) { console.warn("storage set failed", e); }
}
async function storeRemove(key) {
  try { await chrome.storage.local.remove(key); }
  catch (e) { console.warn("storage remove failed", e); }
}

// ---------- Toasts ----------
function toast(message, kind = "ok") {
  if (!els.toastWrap) return;
  const t = document.createElement("div");
  t.className = `toast ${kind === "error" ? "err" : ""}`;
  t.textContent = message;
  els.toastWrap.appendChild(t);
  const show = () => t.classList.add("show");
  requestAnimationFrame(show);
  setTimeout(show, 80); // fallback: rAF can be throttled while the page isn't visible
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 260);
  }, 2600);
}

// ---------- Theme ----------
async function loadTheme() {
  const { theme } = await storeGet("theme");
  if (theme === "dark" || theme === "light") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (els.themeToggle) els.themeToggle.textContent = theme === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19";
}

function bindTheme() {
  els.themeToggle.addEventListener("click", async () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    await storeSet({ theme: next });
    toast(next === "dark" ? "Dark mode on" : "Light mode on");
  });
}

// ---------- Tabs ----------
function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
}

function setActiveTab(name) {
  document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
  const panel = document.getElementById(`panel-${name}`);
  if (panel) panel.classList.remove("hidden");
  document.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active);
  });
}

// ---------- Input mode ----------
function bindModeButtons() {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentMode = btn.dataset.mode;
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
      els.thaiText.classList.toggle("hidden", currentMode !== "text");
      els.imageDrop.classList.toggle("hidden", currentMode !== "image");
    });
  });

  // The native file dialog closes the popup on macOS, and OCR isn't wired
  // up anyway — so block the picker and explain instead of killing the popup.
  els.imageInput.addEventListener("click", (e) => {
    e.preventDefault();
    const msg = "Screenshot OCR isn't in this build \u2014 paste the post's text, or use + Add / right-click to save photos.";
    showStatus(els.runStatus, msg, "error");
    toast("Screenshot OCR isn't in this build yet", "error");
  });
}

// ---------- Translation ----------
async function translateChunk(text, sourceLang, targetLang) {
  const params = new URLSearchParams({ q: text, langpair: `${sourceLang}|${targetLang}` });
  const res = await fetch(`${MYMEMORY_URL}?${params.toString()}`);
  if (!res.ok) {
    // HTTP 429 = the free quota / rate limit, not a broken request.
    if (res.status === 429) throw new Error("Free translation limit reached \u2014 try again later (it resets daily)");
    throw new Error(`Translate request failed (${res.status})`);
  }
  const data = await res.json();
  const out = data?.responseData?.translatedText || "";
  // MyMemory reports quota/limit problems with HTTP 200 and a warning *inside*
  // translatedText — never treat that as a real translation.
  const status = Number(data?.responseStatus ?? 200);
  const isWarning = /^(MYMEMORY WARNING|QUERY LENGTH LIMIT|PLEASE SELECT TWO DISTINCT)/i.test(out.trim());
  if (status !== 200 || isWarning) {
    const quota = status === 429 || /MYMEMORY WARNING/i.test(out);
    throw new Error(quota
      ? "Free translation limit reached \u2014 try again later (it resets daily)"
      : "Translation service returned an error");
  }
  return out;
}

function splitIntoChunks(text, maxBytes = 450) {
  const lines = text.split(/\n+/).filter(Boolean);
  const chunks = [];
  let current = "";
  const byteLen = (s) => new TextEncoder().encode(s).length;

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (byteLen(candidate) > maxBytes && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

async function translateLong(text, sourceLang, targetLang) {
  const chunks = splitIntoChunks(text);
  const results = [];
  for (const chunk of chunks) {
    results.push(await translateChunk(chunk, sourceLang, targetLang));
  }
  return results.join(" ");
}

// ---------- Field extraction ----------
function extractPrice(text) {
  let m = text.match(/ค่าเช่า[:\s]*([\d,]{3,})\s*(บาท)?/);
  if (m) return `${m[1]} THB/month`;
  m = text.match(/([\d]{1,3}(?:,\d{3})+|\d{3,6})\s*(?:บาท)?\s*\/?\s*(?:เดือน)/);
  if (m) return `${m[1]} THB/month`;
  m = text.match(/(\d[\d,]{2,})\s*บาทเท่านั้น/);
  if (m) return `${m[1]} THB/month`;
    return null;
}

// Thai digits (๐-๙) → ASCII, so "๔,๕๐๐" parses like "4,500".
function normalizeDigits(s) {
    return String(s || "").replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0E50));
}

function extractDeposit(text) {
    // Covers ประกัน / ประกันห้อง / เงินประกัน / มัดจำ, with or without a comma or unit.
      const m = text.match(/(?:ประกัน(?:ห้อง|ความเสียหาย)?|มัดจำ)[:\s]*(\d[\d,]*)\s*(เดือน|บาท)?/);
      if (!m) return null;
      const raw = m[1].replace(/,+$/, "");
      const n = Number(raw.replace(/,/g, ""));
      if (m[2] === "เดือน") return `${raw} month(s) rent`;
      if (m[2] === "บาท") return `${raw} THB`;
      // No unit: a small number is almost certainly months, a big one is baht.
    return n <= 12 ? `${raw} month(s) rent (approx.)` : `${raw} THB (approx.)`;
}

function extractPhone(text) {
  const matches = text.match(/0\d{1,2}[-\s]?\d{3}[-\s]?\d{3,4}/g);
  if (!matches) return null;
  const unique = [...new Set(matches.map((s) => s.trim()))];
  return unique.join(", ");
}

function extractLocation(text) {
  // Drop phone numbers / contact words that trail the location in listings,
  // e.g. "ซอยแม่จันใต้ 3 โทร 081-234-5678" → "ซอยแม่จันใต้ 3".
  const clean = (s) => (s || "")
    .replace(/\s+(?:โทร|เบอร์|tel|phone|call)\s*:?\s*\S*.*$/i, "")
    .replace(/\s+0\d{1,2}(?:[-\s]?\d{3}){1,2}.*$/, "")
    .trim();

  const patterns = [
    /ทำเล\s*[:：]\s*([^\n]+)/,
    /(ซอย[^\n,]+)/,
    /(ห่างจาก[^\n,]+|ห่างมอ[^\n,]+|ใกล้[^\n,]+)/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (!m) continue;
      const value = clean(m[1]);
    if (value) return value;
  }
  return null;
}

function extractAvailability(text) {
  if (/พร้อมเข้าอยู่/.test(text)) return "Ready to move in";
  if (/ห้องว่าง|บ้านว่าง|ว่างให้เช่า/.test(text)) return "Available now";
  return null;
}

// ---------- Distance detection ----------
function detectDistance(text) {
    const linkMatch = text.match(/https?:\/\/(?:maps\.app\.goo\.gl|g\.co\/kgs|goo\.gl\/maps|www\.google\.com\/maps)\S+/i);
    const kmNear = text.match(/(\d+(?:\.\d+)?)\s*(?:กม\.?|km)/i); // แก้ไขการอ่านเลขทศนิยม
    const stated = text.match(/(\d+)\s*(นาที|min)/i);              // ย้ายขึ้นมาไว้ก่อน if (linkMatch)

    if (linkMatch) {
        const extras = [];
        if (kmNear) extras.push(`≈${kmNear[1]} km`);
        if (stated) extras.push(`${stated[1]} min from MFU, as stated`);
        const extraPart = extras.length ? ` (${extras.join(", ")})` : "";
        return { text: `Map link provided by landlord${extraPart}`, link: linkMatch[0] };
    }

    if (stated) {
        return { text: `${stated[1]} min from MFU (stated in listing)`, link: null };
    }

    for (const landmark of LANDMARKS) {
        if (landmark.keywords.some((k) => text.toLowerCase().includes(k.toLowerCase()))) {
            return { text: `${landmark.name} \u2014 ${landmark.approxNote}`, link: null };
        }
    }

    return { text: "Distance not stated \u2014 check the listing manually", link: null };
}

// ---------- Run translate/extract ----------
function bindRun() {
  els.runBtn.addEventListener("click", runExtraction);
}

function bindShortcut() {
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      setActiveTab("translate");
      runExtraction();
    }
  });
}

function isMacPlatform() {
  const p = navigator.userAgentData?.platform || navigator.platform || "";
  return /mac/i.test(p);
}

// ---------- Draft autosave (popup can close without warning) ----------
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    await storeSet({
      draft: {
        text: els.thaiText.value,
        link: els.sourceLinkInput.value,
        result: lastResult
      }
    });
  }, 250);
}

function bindDraft() {
  els.thaiText.addEventListener("input", saveDraft);
  els.sourceLinkInput.addEventListener("input", saveDraft);
}

function showSkeleton(on) {
  els.skeleton.classList.toggle("hidden", !on);
}

async function runExtraction() {
  if (els.runBtn.disabled) return; // Ctrl+Enter must not start a second run
  const text = els.thaiText.value.trim();
  if (currentMode === "text" && !text) {
    showStatus(els.runStatus, "Paste some Thai text first.", "error");
    toast("Paste some Thai text first", "error");
    return;
  }
  if (currentMode === "image") {
    showStatus(els.runStatus, "Screenshot OCR isn't in this build \u2014 switch to Paste text.", "error");
    return;
  }

  els.runBtn.disabled = true;
  showStatus(els.runStatus, "Translating\u2026", "");
  els.result.classList.add("hidden");
  showSkeleton(true);

  try {
    const translatedText = await translateLong(text, "th", "en");
    const norm = normalizeDigits(text); //extractors see ASCII digits; translation sees the original
    const distance = detectDistance(norm);
    const sourceLink = els.sourceLinkInput.value.trim() || null;

    lastResult = {
      sourceText: text,
      sourceLink,
      translatedText,
      price: extractPrice(norm),
      deposit: extractDeposit(norm),
      location: extractLocation(norm),
      contactPhone: extractPhone(norm),
      availability: extractAvailability(norm),
      distanceText: distance.text,
      distanceLink: distance.link
    };

    renderResult(lastResult);
    saveDraft();
    showStatus(els.runStatus, "", "");
    toast("Translated \u2014 check the details below");
  } catch (err) {
    console.error(err);
    showStatus(els.runStatus, `Couldn't translate that: ${err.message}`, "error");
    toast("Translation failed \u2014 try again", "error");
  } finally {
    els.runBtn.disabled = false;
    showSkeleton(false);
  }
}

function renderResult(r) {
  els.translatedText.textContent = r.translatedText || "(no translation returned)";

  if (r.price) {
    els.priceHero.textContent = `\u0E3F${r.price.replace(" THB/month", " /mo")}`;
    els.priceHero.classList.remove("hidden");
  } else {
    els.priceHero.classList.add("hidden");
  }

  const fields = [
    ["Price", r.price],
    ["Deposit", r.deposit],
    ["Location", r.location],
    ["Phone", r.contactPhone],
    ["Available", r.availability]
  ];
  els.detailsList.innerHTML = fields
    .map(([label, value]) =>
      `<div class="detail-row"><dt>${label}</dt><dd>${value ? escapeHtml(value) : "\u2014"}</dd></div>`)
    .join("");

  els.distanceText.innerHTML = r.distanceLink
    ? `${escapeHtml(r.distanceText)} \u2014 <a href="${escAttr(r.distanceLink)}" target="_blank" rel="noopener">open map</a>`
    : escapeHtml(r.distanceText);

  els.result.classList.remove("hidden");
  els.replyPanel.classList.add("hidden");
  showStatus(els.saveStatus, "", "");
  els.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- Copy translation ----------
document.addEventListener("click", async (e) => {
  if (e.target.id === "copyTransBtn") {
    const text = els.translatedText.textContent || "";
    if (!text) return;
    await copyText(text);
    toast("Translation copied");
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------- Photo tray (save images) ----------
function bindPhotos() {
  els.addPhotoBtn.addEventListener("click", () => {
    // On macOS the native file chooser closes the extension popup
    // (it loses focus), which kills the picker before a file is chosen.
    // There, pick files on a normal extension tab instead.
    const canOpenTab = typeof chrome !== "undefined" && chrome.tabs?.create && chrome.runtime?.getURL;
    if (isMacPlatform() && canOpenTab) {
      chrome.tabs.create({ url: chrome.runtime.getURL("photo-add.html") });
      toast("Opening the photo uploader tab\u2026");
      return;
    }
    els.photoInput.click();
  });

  // Paste a screenshot (Ctrl/Cmd+V) straight into the tray.
  document.addEventListener("paste", async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgItem = items.find((i) => i.type && i.type.startsWith("image/"));
    if (!imgItem) return;
    const file = imgItem.getAsFile();
    if (!file) return;
    try {
      const src = await fileToDataUrl(file);
      if (addPhoto(src, { persist: true })) toast("Pasted photo added to the tray");
    } catch (err) {
      console.warn(err);
      toast("Couldn't read the pasted image", "error");
    }
  });

  els.photoInput.addEventListener("change", async () => {
    const files = [...(els.photoInput.files || [])];
    els.photoInput.value = "";
    let added = 0;
    for (const file of files) {
      try {
        const src = await fileToDataUrl(file);
        addPhoto(src, { persist: false });
        added++;
      } catch (err) {
        console.warn(err);
        toast(`Couldn't read ${file.name}`, "error");
      }
    }
    if (added) {
      await persistTray();
      toast(`${added} photo${added > 1 ? "s" : ""} added`);
    }
  });
  els.clearTrayBtn.addEventListener("click", async () => {
    if (!photoTray.length) return;
    photoTray = [];
    await persistTray();
    renderPhotoTray();
    toast("Photos cleared");
  });
}

function addPhoto(src, { persist = true } = {}) {
  if (!src || photoTray.some((p) => p.src === src)) return false;
  photoTray.unshift({ id: Date.now() + Math.random(), src, selected: true });
  if (persist) persistTray();
  renderPhotoTray();
  return true;
}

async function persistTray() {
  await storeSet({ photoTray });
}

function renderPhotoTray() {
  if (!photoTray.length) {
    els.photoTray.innerHTML = `<span class="tray-empty">No photos yet</span>`;
    return;
  }
  els.photoTray.innerHTML = photoTray.map((p) => `
    <div class="photo-thumb ${p.selected ? "selected" : ""}" data-id="${p.id}" title="Click to attach / detach">
      <img src="${escAttr(p.src)}" alt="Listing photo" />
      <button class="photo-check" aria-label="Toggle attach">&#10003;</button>
      <button class="photo-x" data-remove="1" aria-label="Remove photo">&#10005;</button>
    </div>`).join("");

  els.photoTray.querySelectorAll(".photo-thumb").forEach((thumb) => {
    thumb.addEventListener("click", async (e) => {
      const id = Number(thumb.dataset.id);
      const item = photoTray.find((p) => p.id === id);
      if (!item) return;
      if (e.target.closest("[data-remove]")) {
        photoTray = photoTray.filter((p) => p.id !== id);
      } else {
        item.selected = !item.selected;
      }
      await persistTray();
      renderPhotoTray();
    });
  });
}

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

// ---------- Save listing ----------
function bindSave() {
  els.saveListingBtn.addEventListener("click", saveCurrentListing);
}

async function saveCurrentListing() {
  if (!lastResult) return;
  const { savedListings = [] } = await storeGet("savedListings");
  const images = photoTray.filter((p) => p.selected).map((p) => p.src);
  const listing = {
    id: Date.now(),
    savedAt: new Date().toISOString(),
    starred: false,
    images,
    ...lastResult
  };
  savedListings.unshift(listing);
  await storeSet({ savedListings });
  showStatus(els.saveStatus, "Saved to your listings.", "ok");
  toast(images.length
    ? `Saved with ${images.length} photo${images.length > 1 ? "s" : ""}`
    : "Saved to your listings");
  renderSaved();
}

// ---------- Saved list ----------
function bindSavedToolbar() {
  els.savedSearch.addEventListener("input", () => {
    savedQuery = els.savedSearch.value.trim().toLowerCase();
    renderSaved();
  });
  els.exportBtn.addEventListener("click", exportSaved);
}

function matchesQuery(l, q) {
  if (!q) return true;
  return [l.price, l.deposit, l.location, l.contactPhone, l.availability, l.distanceText, l.translatedText, l.sourceText]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
}

function renderSavedItem(l) {
  const isExpanded = expandedSavedId === l.id;
  const sourceLinkRow = l.sourceLink
    ? `<a class="chip-btn chip-link" href="${escAttr(l.sourceLink)}" target="_blank" rel="noopener">View original post</a>`
    : "";
  const phone = (l.contactPhone || "").split(",")[0].trim();

  const thumbs = (l.images || []).length
    ? `<div class="thumb-strip">
        ${l.images.slice(0, 4).map((src) =>
          `<a class="thumb" href="${escAttr(src)}" target="_blank" rel="noopener" title="Open full image"><img src="${escAttr(src)}" alt="" /></a>`).join("")}
        ${l.images.length > 4 ? `<span class="thumb-more">+${l.images.length - 4}</span>` : ""}
      </div>`
    : "";

  const detailsBlock = isExpanded
    ? `
      <div class="saved-item-details">
        <div>Translation</div>
        <p style="margin:4px 0 0;">${escapeHtml(l.translatedText || "(no translation saved)")}</p>
        <dl class="details-grid">
          <div class="detail-row"><dt>Price</dt><dd>${l.price ? escapeHtml(l.price) : "\u2014"}</dd></div>
          <div class="detail-row"><dt>Deposit</dt><dd>${l.deposit ? escapeHtml(l.deposit) : "\u2014"}</dd></div>
          <div class="detail-row"><dt>Location</dt><dd>${l.location ? escapeHtml(l.location) : "\u2014"}</dd></div>
          <div class="detail-row"><dt>Phone</dt><dd>${l.contactPhone ? escapeHtml(l.contactPhone) : "\u2014"}</dd></div>
          <div class="detail-row"><dt>Available</dt><dd>${l.availability ? escapeHtml(l.availability) : "\u2014"}</dd></div>
          <div class="detail-row"><dt>Photos</dt><dd>${(l.images || []).length || "\u2014"}</dd></div>
        </dl>
      </div>`
    : "";

  return `
    <li class="saved-item" data-id="${l.id}">
      <button class="star-btn ${l.starred ? "on" : ""}" data-action="star" title="Shortlist">&#9733;</button>
      <div class="saved-item-top">
        <span class="saved-item-price">${l.price ? escapeHtml(l.price) : "Price n/a"}</span>
        ${l.availability ? `<span class="saved-item-avail">${escapeHtml(l.availability)}</span>` : ""}
      </div>
      <div class="saved-item-loc">&#128205; ${l.location ? escapeHtml(l.location) : "Location n/a"}</div>
      ${l.distanceText ? `<div class="saved-item-dist">${escapeHtml(l.distanceText)}</div>` : ""}
      ${thumbs}
      <div class="saved-item-actions">
        <button class="chip-btn" data-action="toggle-details">${isExpanded ? "Hide details" : "View details"}</button>
        ${phone ? `<button class="chip-btn" data-action="call" data-phone="${escAttr(phone)}">Call landlord</button>` : ""}
        ${sourceLinkRow}
        ${(l.images || []).length ? `<button class="chip-btn" data-action="dl-img">Download photos</button>` : ""}
        <button class="chip-btn" data-action="remove">Remove</button>
      </div>
      ${detailsBlock}
    </li>`;
}

async function renderSaved() {
  const { savedListings = [] } = await storeGet("savedListings");
  const filtered = savedListings
    .filter((l) => matchesQuery(l, savedQuery))
    .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));

  els.savedEmpty.classList.toggle("hidden", savedListings.length > 0);
  els.noMatches.classList.toggle("hidden", !(savedListings.length > 0 && filtered.length === 0));
  els.savedList.innerHTML = filtered.map(renderSavedItem).join("");

  // Tab badge
  if (els.savedCount) {
    els.savedCount.textContent = String(savedListings.length);
    els.savedCount.classList.toggle("hidden", savedListings.length === 0);
  }

  els.savedList.querySelectorAll("[data-action='toggle-details']").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const id = Number(e.target.closest(".saved-item").dataset.id);
      expandedSavedId = expandedSavedId === id ? null : id;
      renderSaved();
    })
  );
  els.savedList.querySelectorAll("[data-action='star']").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = Number(e.target.closest(".saved-item").dataset.id);
      const { savedListings = [] } = await storeGet("savedListings");
      const item = savedListings.find((l) => l.id === id);
      if (!item) return;
      item.starred = !item.starred;
      await storeSet({ savedListings });
      toast(item.starred ? "Added to shortlist" : "Removed from shortlist");
      renderSaved();
    })
  );
  els.savedList.querySelectorAll("[data-action='remove']").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = Number(e.target.closest(".saved-item").dataset.id);
      const { savedListings = [] } = await storeGet("savedListings");
      await storeSet({ savedListings: savedListings.filter((l) => l.id !== id) });
      if (expandedSavedId === id) expandedSavedId = null;
      toast("Listing removed");
      renderSaved();
    })
  );
  els.savedList.querySelectorAll("[data-action='call']").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const phone = e.target.dataset.phone;
      if (phone) window.open(`tel:${phone}`);
    })
  );
  els.savedList.querySelectorAll("[data-action='dl-img']").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      const id = Number(e.target.closest(".saved-item").dataset.id);
      downloadListingImages(id);
    })
  );
}

async function downloadListingImages(id) {
  const { savedListings = [] } = await storeGet("savedListings");
  const item = savedListings.find((l) => l.id === id);
  if (!item || !item.images?.length) return;
  let started = 0;
  for (let i = 0; i < item.images.length; i++) {
    const src = item.images[i];
    try {
      const filename = `baanright-${id}-${i + 1}.${guessExt(src)}`;
      if (src.startsWith("data:")) {
        downloadViaAnchor(src, filename);
      } else if (src.startsWith("blob:")) {
        downloadViaAnchor(src, filename);
      } else {
        await chrome.downloads.download({ url: src, filename });
      }
      started++;
    } catch (err) {
      console.warn("download failed", err);
    }
  }
  toast(started ? `Downloading ${started} photo${started > 1 ? "s" : ""}` : "Couldn't start download", started ? "ok" : "error");
}

function guessExt(src) {
  if (src.startsWith("data:image/")) {
    const m = src.slice(5, src.indexOf(";"));
    if (m.includes("png")) return "png";
    if (m.includes("webp")) return "webp";
    if (m.includes("gif")) return "gif";
    return "jpg";
  }
  try {
    const path = new URL(src).pathname;
    const m = path.match(/\.(png|jpe?g|webp|gif)(?:$|\?)/i);
    if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
  } catch { /* not a URL */ }
  return "jpg";
}

function downloadViaAnchor(src, filename) {
  const a = document.createElement("a");
  a.href = src;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- Export CSV ----------
async function exportSaved() {
  const { savedListings = [] } = await storeGet("savedListings");
  if (!savedListings.length) {
    toast("Nothing to export yet", "error");
    return;
  }
  const cols = ["Price", "Deposit", "Location", "Phone", "Available", "Distance", "Translation", "Source link", "Photos", "Saved at"];
  const rows = savedListings.map((l) => [
    l.price, l.deposit, l.location, l.contactPhone, l.availability,
    l.distanceText, l.translatedText, l.sourceLink, (l.images || []).length, l.savedAt
  ]);
  const csv = [cols, ...rows]
    .map((row) => row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: "baanright-saved-listings.csv", saveAs: true });
  } catch {
    downloadViaAnchor(url, "baanright-saved-listings.csv");
  }
  toast("Exporting CSV");
}

// ---------- Alerts / preferences ----------
function bindAlerts() {
  els.addAlertBtn.addEventListener("click", async () => {
    const preferredArea = els.alertArea.value.trim();
    const maxPrice = Number(els.alertPrice.value) || null;
    if (!preferredArea && !maxPrice) {
      toast("Add an area or a budget first", "error");
      return;
    }
    const { searchAlerts = [] } = await storeGet("searchAlerts");
    searchAlerts.unshift({ id: Date.now(), preferredArea, maxPrice, isActive: true });
    await storeSet({ searchAlerts });
    els.alertArea.value = "";
    els.alertPrice.value = "";
    toast("Preference added");
    renderAlerts();
  });
}

async function renderAlerts() {
  const { searchAlerts = [] } = await storeGet("searchAlerts");
  els.alertsEmpty.classList.toggle("hidden", searchAlerts.length > 0);
  els.alertsListUI.innerHTML = searchAlerts
    .map(
      (a) => `
      <li class="saved-item" data-id="${a.id}">
        <div class="saved-item-top">
          <span class="saved-item-price">${a.preferredArea ? escapeHtml(a.preferredArea) : "Any area"}</span>
          <span class="saved-item-avail">${a.maxPrice ? `&#8804; ${a.maxPrice} THB` : "Any budget"}</span>
        </div>
        <div class="saved-item-actions">
          <button class="chip-btn" data-action="remove">Remove</button>
        </div>
      </li>`
    )
    .join("");
  els.alertsListUI.querySelectorAll("[data-action='remove']").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = Number(e.target.closest(".saved-item").dataset.id);
      const { searchAlerts = [] } = await storeGet("searchAlerts");
      await storeSet({ searchAlerts: searchAlerts.filter((a) => a.id !== id) });
      toast("Preference removed");
      renderAlerts();
    })
  );
}

// ---------- Reply-in-Thai generator ----------
function renderReplyOptions() {
  els.replyOptions.innerHTML = REPLY_TEMPLATES.map(
    (t) => `
    <label class="reply-option">
      <input type="checkbox" value="${t.id}" checked />
      <span>${escapeHtml(t.en)}</span>
    </label>`
  ).join("");
}

function bindReply() {
  els.toggleReplyBtn.addEventListener("click", () => {
    els.replyPanel.classList.toggle("hidden");
    if (!els.replyPanel.classList.contains("hidden")) {
      els.replyPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
  els.generateReplyBtn.addEventListener("click", generateReply);
  els.copyReplyBtn.addEventListener("click", async () => {
    await copyText(els.replyOutput.value);
    toast("Message copied \u2014 paste it to the landlord");
  });
}

async function generateReply() {
  const checked = [...els.replyOptions.querySelectorAll("input:checked")].map((i) => i.value);
  const chosen = REPLY_TEMPLATES.filter((t) => checked.includes(t.id));
  if (!chosen.length) {
    toast("Tick at least one question", "error");
    return;
  }

  els.generateReplyBtn.disabled = true;
  els.generateReplyBtn.textContent = "Translating\u2026";
  try {
    const lines = [];
    for (const t of chosen) {
      const th = await translateChunk(t.en, "en", "th");
      lines.push(th);
    }
    els.replyOutput.value = lines.join("\n");
    els.replyOutput.classList.remove("hidden");
    els.copyReplyBtn.classList.remove("hidden");
    toast("Thai message ready");
  } catch (err) {
    console.error(err);
    toast("Couldn't translate the questions", "error");
  } finally {
    els.generateReplyBtn.disabled = false;
    els.generateReplyBtn.textContent = "Generate Thai message";
  }
}

// ---------- Helpers ----------
function showStatus(el, message, kind) {
  el.textContent = message;
  el.className = `status ${kind}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return escapeHtml(str).replace(/"/g, "&quot;");
}
// ---------- Clear Text Button ----------
document.addEventListener("click", (e) => {
  if (e.target.id !== "clearTextBtn") return;
  els.thaiText.value = "";
  lastResult = null;
  els.result.classList.add("hidden");
  showStatus(els.runStatus, "", "");
  showStatus(els.saveStatus, "", "");
  saveDraft(); // otherwise the old text comes back next time the popup opens
  els.thaiText.focus();
  toast("Text cleared");
});
