Hi! While testing the extension I found a few cases where the
extracted details were wrong.fixes and adds tests.

## Fixes
- **Deposit**: "มัดจำ 1,000" was shown as "1 month(s) rent" and
  "มัดจำ 2000" as "2000 months". It now reads amounts with commas,
  "ประกันห้อง", and unit-less numbers (<= 12 = months, otherwise baht).
- **Location**: "พื้นที่ใช้สอย" (floor area) was used as the location.
  It is no longer matched.
- **Distance**: a map link hid the stated minutes ("5 นาที"); both are
  now shown. Decimal km (e.g. 2.5) is read correctly. When nothing is
  stated, the "Distance not stated" message is shown instead of a blank.
- **Thai digits**: "๔,๕๐๐" now parses as 4,500.
- **Translation quota**: MyMemory returns HTTP 200 with a warning inside
  translatedText when the free quota runs out. That text was displayed
  and saved as the translation. It now shows an error instead.
- **Clear button**: also hides the result and clears the saved draft.
- Ctrl+Enter no longer starts a second run while one is in progress.

## Tests
Added `tests/extractors.test.js` (10 tests, no dependencies).
Run with `node --test`.

## Notes
- Unit-less deposit rule (<= 12 = months) is my assumption; happy to
  change it
