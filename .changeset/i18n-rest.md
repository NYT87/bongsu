---
"@bongsu/web": patch
---

Every string in the app goes through the translation catalogue (`i18n.ts`), with no wording change; a test fails on English text left in the app's JSX or on a key the catalogue doesn't have.
