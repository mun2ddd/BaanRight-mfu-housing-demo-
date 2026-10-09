// Run with:  node --test   (Node 20+; auto-discovers tests/*.test.js)
// popup.js is a browser file that boots itself on load, so we slice out only
// the pure functions (translateChunk + extractors + distance) and evaluate
// them in an isolated vm context.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");

function between(startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  const b = src.indexOf(endMarker, a);
  assert.ok(a >= 0 && b > a, `markers not found: ${startMarker} … ${endMarker}`);
  return src.slice(a, b);
}

function load(fetchImpl) {
  const code = [
    "const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';",
    between("const LANDMARKS", "const REPLY_TEMPLATES"),
    between("async function translateChunk", "function splitIntoChunks"),
    between("function extractPrice", "// ---------- Run translate/extract"),
    "({ translateChunk, extractPrice, extractDeposit, extractLocation, extractPhone, extractAvailability, detectDistance, normalizeDigits })"
  ].join("\n");
  return vm.runInNewContext(code, { fetch: fetchImpl, URLSearchParams });
}

const api = load(async () => { throw new Error("network not expected"); });

test("deposit: months, baht, commas, ประกันห้อง, no unit", () => {
  const d = api.extractDeposit;
  assert.equal(d("ประกัน 1 เดือน"), "1 month(s) rent");
  assert.equal(d("มัดจำ 2000 บาท"), "2000 THB");
  assert.equal(d("ประกัน 1,000 บาท"), "1,000 THB");
  assert.equal(d("ประกันห้อง 2000 บาท"), "2000 THB");
  assert.equal(d("มัดจำ 1,000"), "1,000 THB (approx.)");
  assert.equal(d("มัดจำ 2000"), "2000 THB (approx.)");
  assert.equal(d("มัดจำ 2"), "2 month(s) rent (approx.)");
  assert.equal(d("มัดจำ 12"), "12 month(s) rent (approx.)");
  assert.equal(d("มัดจำ 50"), "50 THB (approx.)"); // never "50 months"
  assert.equal(d("ไม่มีประกัน"), null);
});

test("location: floor area (พื้นที่ใช้สอย) is never reported as the location", () => {
  assert.equal(api.extractLocation("ห้องว่าง พื้นที่ใช้สอย 24 ตารางเมตร มีแอร์"), null);
  assert.equal(api.extractLocation("พื้นที่ใช้สอย 24 ตารางเมตร\nซอยแม่จัน 2"), "ซอยแม่จัน 2");
});

test("location: trailing phone number is stripped", () => {
  assert.equal(api.extractLocation("ซอยแม่จันใต้ 3 โทร 081-234-5678"), "ซอยแม่จันใต้ 3");
});

test("distance: map link keeps stated minutes and km (incl. decimals)", () => {
  const r = api.detectDistance("ห่าง มอ 5นาที 3 กม. https://maps.app.goo.gl/abc");
  assert.match(r.text, /Map link provided by landlord/);
  assert.match(r.text, /5 min from MFU/);
  assert.match(r.text, /3 km/);
  assert.equal(r.link, "https://maps.app.goo.gl/abc");
  assert.match(api.detectDistance("ห่าง 2.5 km https://maps.app.goo.gl/x").text, /2\.5 km/);
});

test("distance: minutes only, Fah Thai landmark, and a clear message (never null) when nothing is stated", () => {
  assert.equal(api.detectDistance("10 นาที").text, "10 min from MFU (stated in listing)");
  assert.match(api.detectDistance("ห้องสวย").text, /Distance not stated/);
  assert.match(api.detectDistance("ใกล้ตลาดฟ้าไทย").text, /Fah Thai market area/);
});

test("Thai digits normalise so price/phone/deposit still extract", () => {
  const t = api.normalizeDigits("ค่าเช่า ๔,๕๐๐ บาท ประกัน ๒ เดือน โทร ๐๘๑-๒๓๔-๕๖๗๘");
  assert.equal(api.extractPrice(t), "4,500 THB/month");
  assert.equal(api.extractDeposit(t), "2 month(s) rent");
  assert.equal(api.extractPhone(t), "081-234-5678");
});

test("price / phone / availability basics still work", () => {
  assert.equal(api.extractPrice("ค่าเช่า 6000 บาท/เดือน"), "6000 THB/month");
  assert.equal(api.extractPrice("3500/เดือน"), "3500 THB/month");
  assert.equal(api.extractPhone("081-2345678 และ 0812345678"), "081-2345678, 0812345678");
  assert.equal(api.extractAvailability("ห้องว่าง พร้อมเข้าอยู่"), "Ready to move in");
});

const mockFetch = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });

test("translateChunk: returns real translations", async () => {
  const { translateChunk } = load(mockFetch({ responseStatus: 200, responseData: { translatedText: "Room for rent" } }));
  assert.equal(await translateChunk("ห้องเช่า", "th", "en"), "Room for rent");
});

test("translateChunk: MyMemory quota warning (HTTP 200) is an error, not a translation", async () => {
  const warn = "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. NEXT AVAILABLE IN 05 HOURS";
  const { translateChunk } = load(mockFetch({ responseStatus: 200, responseData: { translatedText: warn } }));
  await assert.rejects(() => translateChunk("x", "th", "en"), /limit reached/i);
});

test("translateChunk: responseStatus 429 / other non-200 throw; string '200' is fine", async () => {
  const q = load(mockFetch({ responseStatus: 429, responseData: { translatedText: "" } }));
  await assert.rejects(() => q.translateChunk("x", "th", "en"), /limit reached/i);
  const e = load(mockFetch({ responseStatus: "403", responseData: { translatedText: "" } }));
  await assert.rejects(() => e.translateChunk("x", "th", "en"), /error/i);
  const ok = load(mockFetch({ responseStatus: "200", responseData: { translatedText: "ok" } }));
  assert.equal(await ok.translateChunk("x", "th", "en"), "ok");
});

test("translateChunk: HTTP 429 is reported as the free limit; other HTTP errors keep their status", async () => {
  const r429 = load(mockFetch({}, false, 429));
  await assert.rejects(() => r429.translateChunk("x", "th", "en"), /limit reached/i);
  const r500 = load(mockFetch({}, false, 500));
  await assert.rejects(() => r500.translateChunk("x", "th", "en"), /failed \(500\)/);
});
