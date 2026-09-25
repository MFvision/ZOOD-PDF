// Node smoke test of the wasm build (no vitest, no browser).
//   bash scripts/build-wasm.sh && node packages/core/crates/warraq-core/tests/wasm-smoke.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../../..");
const pkg = path.join(root, "packages/ui/src/wasm/pkg");
const fixtures = path.join(root, "packages/core/crates/warraq-pdf/tests/fixtures");

const wasm = await import(pathToFileURL(path.join(pkg, "warraq_core.js")).href);
wasm.initSync({ module: readFileSync(path.join(pkg, "warraq_core_bg.wasm")) });
const { WarraqDocument, callStatic } = wasm;

const call = (doc, method, params = {}, blobs = []) => {
  const r = doc.call(method, JSON.stringify(params), blobs);
  return { json: JSON.parse(r.json), blobs: r.blobs };
};
const throwsCode = (fn, code) => {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code, JSON.stringify(e));
    return;
  }
  assert.fail(`expected error ${code}`);
};

// 1. Plain document (qpdf, object streams + xref stream).
const plain = new Uint8Array(readFileSync(path.join(fixtures, "plain_objstm.pdf")));
const doc = WarraqDocument.open(plain, undefined);
const info = call(doc, "doc.info").json;
assert.equal(info.pageCount, 2);
assert.equal(info.encrypted, false);
assert.equal(info.title, "Fixture Title");

// 2. Mutation = incremental update: original bytes are a prefix.
const rotated = call(doc, "pages.rotate", { pages: [0], degrees: 90 });
const out = rotated.blobs[0];
assert.ok(out instanceof Uint8Array);
assert.deepEqual(out.subarray(0, plain.length), plain);
assert.equal(call(doc, "doc.info").json.pages[0].rotation, 90);

// 3. Encrypted AES-256 document, user password.
const r6 = new Uint8Array(readFileSync(path.join(fixtures, "qpdf_r6.pdf")));
throwsCode(() => WarraqDocument.open(r6, undefined), "password_required");
throwsCode(() => WarraqDocument.open(r6, "wrong"), "wrong_password");
const enc = WarraqDocument.open(r6, "user");
const encInfo = call(enc, "doc.info").json;
assert.equal(encInfo.passwordMatched, "user");
assert.equal(encInfo.encryption.method, "AES-256");

// 4. protect.set uses crypto.getRandomValues through getrandom's wasm_js backend.
const prot = call(doc, "protect.set", { userPassword: "كلمة", ownerPassword: "owner" }).blobs[0];
assert.deepEqual(JSON.parse(callStatic("pdf.isEncrypted", "{}", [prot]).json), {
  encrypted: true,
  needsPassword: true,
});
const reopened = WarraqDocument.open(prot, "كلمة");
assert.equal(call(reopened, "doc.info").json.pageCount, 2);

// 5. Errors are { code, message } objects.
throwsCode(() => doc.call("no.such", "{}", []), "unknown_method");
throwsCode(() => doc.call("pages.rotate", "not json", []), "invalid_params");

const methods = JSON.parse(callStatic("methods.list", "", []).json);
console.log(`wasm smoke OK — ${methods.document.length} document methods, ${methods.static.length} static`);
