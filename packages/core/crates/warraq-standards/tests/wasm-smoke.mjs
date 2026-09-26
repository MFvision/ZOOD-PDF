// Node smoke test of standards.* in the real wasm build (no browser):
//   bash scripts/build-wasm.sh && node packages/core/crates/warraq-standards/tests/wasm-smoke.mjs
// validate → convert (with the bundled Liberation font as a blob) → the output validates clean.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../..");
const pkg = path.join(root, "packages/ui/src/wasm/pkg");
const wasm = await import(pathToFileURL(path.join(pkg, "warraq_core.js")).href);
wasm.initSync({ module: readFileSync(path.join(pkg, "warraq_core_bg.wasm")) });
const { WarraqDocument } = wasm;

const call = (doc, method, params = {}, blobs = []) => {
  const r = doc.call(method, JSON.stringify(params), blobs);
  return { json: typeof r.json === "string" ? JSON.parse(r.json) : r.json, blobs: r.blobs };
};

for (const fixture of ["sample-en.pdf", "sample-ar.pdf"]) {
  const bytes = new Uint8Array(readFileSync(path.join(root, "tests/fixtures", fixture)));
  const doc = WarraqDocument.open(bytes, undefined);
  for (const profile of ["pdfa-1b", "pdfa-2b", "pdfa-2u", "pdfa-3b", "pdfx-4"]) {
    const before = call(doc, "standards.validate", { profile }).json;
    assert.equal(before.conforms, false, `${fixture} ${profile} before`);
    const fonts = before.fontsNeeded.map((stem) => new Uint8Array(readFileSync(path.join(root, "packages/ui/assets/fonts/liberation", `${stem}.ttf`))));
    const c = call(doc, "standards.convert", { profile, now: Date.now(), tzOffsetMinutes: 180 }, fonts);
    assert.equal(c.json.after.conforms, true, `${fixture} ${profile}: ${JSON.stringify(c.json.after.findings)}`);
    const out = WarraqDocument.open(new Uint8Array(c.blobs[0]), undefined);
    const again = call(out, "standards.validate", { profile }).json;
    assert.equal(again.errorCount, 0, `${fixture} ${profile} reopened`);
    out.free();
  }
  const pf = call(doc, "standards.preflight").json;
  assert.ok(pf.fontCount > 0 && pf.pageCount === 2);
  doc.free();
}
console.log("standards wasm smoke OK");
