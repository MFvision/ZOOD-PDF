#!/usr/bin/env python3
"""Puts an App Store version of ZOOD PDF together through the App Store
Connect API, so nobody has to drag 40 pictures into a browser:

  1. makes (or finds) the iOS version, e.g. 0.2.0,
  2. attaches the uploaded build once Apple has processed it,
  3. writes "What's new" (and fills an English page if there is none),
  4. uploads the framed pictures into the iPhone 6.9", iPad 13" and iPhone
     Duo slots of each language (only those slots: other sizes are left as
     they are),
  5. with --submit, sends the version to App Review.

The key comes from App Store Connect → Users and Access → Integrations →
App Store Connect API (App Manager role): pass its .p8 file, Key ID and
Issuer ID. Nothing is stored. Only Python 3 and the openssl command are needed.

  python3 scripts/ios/asc-release.py --key ~/Downloads/AuthKey_XXXX.p8 \
      --key-id XXXX --issuer xxxxxxxx-... --version 0.2.0 --build 202611042038 \
      --pictures ~/Desktop/zood-app-store-pictures-0.2.0 [--submit]

--probe lists the version's languages, picture slots and the slot names
Apple accepts, and changes nothing.
"""
import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.appstoreconnect.apple.com/v1"
APP_ID = "6816571917"

# Picture folder name -> the App Store's slot. The Duo's name is found at
# run time (see duo_slot), since Apple added it after this was written.
SLOTS = {
    "iPhone-17-Pro-Max": "APP_IPHONE_67",
    "iPad-Pro-13-inch-M5": "APP_IPAD_PRO_3GEN_129",
}

WHATS_NEW = {
    "ar": "• الصفحة الرئيسية تجمع كل الأدوات، في شكل التبويبات والشكل الكلاسيكي.\n"
          "• OneDrive وGoogle Drive على الرئيسية، مع اختيار حساب العمل أو الحساب الشخصي.\n"
          "• «أضف إلى مستنداتي» لأي ملف فتحته من خارج التطبيق.\n"
          "• صفحتان متجاورتان على الآيباد وعلى iPhone Duo المفتوح.\n"
          "• مساعد ZOOD يعمل على جهازك، وتحسينات في الثبات والسرعة.",
    "en": "• Home shows every tool, in both the Tabs and the Classic menu style.\n"
          "• OneDrive and Google Drive on Home, with a choice of work or personal account.\n"
          "• Add to My documents for any file you open from outside the app.\n"
          "• Two pages side by side on iPad and on an unfolded iPhone Duo.\n"
          "• Ask ZOOD runs on your device, plus steadier and faster everywhere.",
}

EN_PAGE = {
    "description": (
        "A PDF editor built for Arabic from the first line. Text stays joined and right to left, "
        "and search finds a word with or without its tashkeel.\n\n"
        "Read: two pages side by side on iPad and on an unfolded iPhone Duo, night mode, and read aloud.\n"
        "Sign and fill: draw your signature once, and fill forms from your saved details after you check them.\n"
        "Scan: photograph paper, ID cards and whiteboards, and the Arabic text becomes searchable and copyable.\n"
        "Edit and organise: mark up and highlight, reorder pages, combine files, add a password, "
        "or redact what nobody should see.\n"
        "Ask ZOOD: summaries, answers and translation on the device itself. No account, no key, no uploads.\n"
        "Remote: present and control ZOOD PDF on your computer from your phone, and send files between them."
    ),
    "keywords": "pdf,sign,scanner,scan,merge,convert,word,arabic,reader,editor,forms,ipad,ocr,annotate",
    "promotionalText": "Ask ZOOD runs on your iPhone, with no internet. Summarise a file, ask about it, "
                       "sign it and send it. Your files never leave your phone.",
    "supportUrl": "https://pdf.zoodrealty.com/help/",
    "marketingUrl": "https://pdf.zoodrealty.com/",
}


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def der_to_raw(der):
    # ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } -> r||s, 32 bytes each.
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = b""
    for _ in range(2):
        assert der[i] == 0x02
        n = der[i + 1]
        v = der[i + 2:i + 2 + n].lstrip(b"\0")
        out += v.rjust(32, b"\0")
        i += 2 + n
    return out


class ASC:
    def __init__(self, key, key_id, issuer):
        self.key, self.key_id, self.issuer = key, key_id, issuer
        self.token, self.exp = None, 0

    def jwt(self):
        if self.token and time.time() < self.exp - 60:
            return self.token
        now = int(time.time())
        self.exp = now + 15 * 60
        head = b64url(json.dumps({"alg": "ES256", "kid": self.key_id, "typ": "JWT"}).encode())
        body = b64url(json.dumps({"iss": self.issuer, "iat": now, "exp": self.exp, "aud": "appstoreconnect-v1"}).encode())
        signing = f"{head}.{body}".encode()
        der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", self.key], input=signing,
                             capture_output=True, check=True).stdout
        self.token = f"{head}.{body}.{b64url(der_to_raw(der))}"
        return self.token

    def call(self, method, path, body=None, ok_missing=False):
        url = path if path.startswith("http") else API + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.jwt()}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            if ok_missing and e.code == 404:
                return None
            raise SystemExit(f"{method} {path} -> {e.code}\n{text}")

    def all(self, path):
        out, url = [], path
        while url:
            page = self.call("GET", url)
            out += page.get("data", [])
            url = page.get("links", {}).get("next")
        return out


def lang_of(locale):
    return locale.split("-")[0].lower()


def find_version(asc, version):
    versions = asc.all(f"/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS&limit=50")
    for v in versions:
        if v["attributes"]["versionString"] == version:
            return v
    print(f"creating version {version}")
    return asc.call("POST", "/appStoreVersions", {"data": {
        "type": "appStoreVersions",
        "attributes": {"platform": "IOS", "versionString": version, "releaseType": "AFTER_APPROVAL"},
        "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})["data"]


def attach_build(asc, version_id, build_number):
    for attempt in range(60):
        builds = asc.all(f"/builds?filter[app]={APP_ID}&filter[version]={build_number}&limit=5")
        if builds and builds[0]["attributes"]["processingState"] == "VALID":
            asc.call("PATCH", f"/appStoreVersions/{version_id}/relationships/build",
                     {"data": {"type": "builds", "id": builds[0]["id"]}})
            print(f"build {build_number} attached")
            return
        state = builds[0]["attributes"]["processingState"] if builds else "not there yet"
        print(f"build {build_number}: {state}; waiting")
        time.sleep(60)
    raise SystemExit("the build was not processed within an hour")


def localizations(asc, version_id):
    return asc.all(f"/appStoreVersions/{version_id}/appStoreVersionLocalizations")


def write_texts(asc, version_id, locs):
    langs = {lang_of(l["attributes"]["locale"]) for l in locs}
    if "en" not in langs:
        print("adding the English page")
        asc.call("POST", "/appStoreVersionLocalizations", {"data": {
            "type": "appStoreVersionLocalizations",
            "attributes": {"locale": "en-US", "whatsNew": WHATS_NEW["en"], **EN_PAGE},
            "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": version_id}}}}})
        locs = localizations(asc, version_id)
    for l in locs:
        lang = lang_of(l["attributes"]["locale"])
        text = WHATS_NEW.get(lang, WHATS_NEW["en"])
        try:
            asc.call("PATCH", f"/appStoreVersionLocalizations/{l['id']}", {"data": {
                "type": "appStoreVersionLocalizations", "id": l["id"], "attributes": {"whatsNew": text}}})
            print(f"what's new written for {l['attributes']['locale']}")
        except SystemExit as e:
            # The first version of an app has no "What's new" field.
            print(f"what's new not taken for {l['attributes']['locale']}: {str(e)[:200]}")
    return locs


def duo_slot(asc, loc_id):
    """Asks Apple for the slot names it accepts and picks the Duo's."""
    req_body = {"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": "NOT_A_SLOT"},
                         "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": loc_id}}}}}
    try:
        asc.call("POST", "/appScreenshotSets", req_body)
    except SystemExit as e:
        text = str(e)
        names = [w.strip("[]\",. ") for w in text.replace(",", " ").split() if w.strip("[]\",. ").startswith("APP_")]
        duo = [n for n in names if "DUO" in n or "FOLD" in n]
        print("slots Apple accepts:", ", ".join(sorted(set(names))) or text[:400])
        return duo[0] if duo else None
    return None


def upload_set(asc, loc_id, slot, files):
    sets = asc.all(f"/appStoreVersionLocalizations/{loc_id}/appScreenshotSets")
    target = next((s for s in sets if s["attributes"]["screenshotDisplayType"] == slot), None)
    if target is None:
        target = asc.call("POST", "/appScreenshotSets", {"data": {
            "type": "appScreenshotSets", "attributes": {"screenshotDisplayType": slot},
            "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": loc_id}}}}})["data"]
    else:
        for shot in asc.all(f"/appScreenshotSets/{target['id']}/appScreenshots"):
            asc.call("DELETE", f"/appScreenshots/{shot['id']}")
    for path in files[:10]:
        data = open(path, "rb").read()
        made = asc.call("POST", "/appScreenshots", {"data": {
            "type": "appScreenshots", "attributes": {"fileName": os.path.basename(path), "fileSize": len(data)},
            "relationships": {"appScreenshotSet": {"data": {"type": "appScreenshotSets", "id": target["id"]}}}}})["data"]
        for op in made["attributes"]["uploadOperations"]:
            part = data[op["offset"]:op["offset"] + op["length"]]
            req = urllib.request.Request(op["url"], data=part, method=op["method"],
                                         headers={h["name"]: h["value"] for h in op["requestHeaders"]})
            urllib.request.urlopen(req, timeout=300).read()
        asc.call("PATCH", f"/appScreenshots/{made['id']}", {"data": {
            "type": "appScreenshots", "id": made["id"],
            "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
        print(f"  {slot} {os.path.basename(path)}")


def submit(asc, version_id):
    sub = asc.call("POST", "/reviewSubmissions", {"data": {
        "type": "reviewSubmissions", "attributes": {"platform": "IOS"},
        "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})["data"]
    asc.call("POST", "/reviewSubmissionItems", {"data": {
        "type": "reviewSubmissionItems",
        "relationships": {"reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub["id"]}},
                          "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version_id}}}}})
    asc.call("PATCH", f"/reviewSubmissions/{sub['id']}", {"data": {
        "type": "reviewSubmissions", "id": sub["id"], "attributes": {"submitted": True}}})
    print("sent to App Review")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--key", required=True)
    p.add_argument("--key-id", required=True)
    p.add_argument("--issuer", required=True)
    p.add_argument("--version", default="0.2.0")
    p.add_argument("--build")
    p.add_argument("--pictures")
    p.add_argument("--probe", action="store_true")
    p.add_argument("--submit", action="store_true")
    a = p.parse_args()
    asc = ASC(os.path.expanduser(a.key), a.key_id, a.issuer)

    if a.probe:
        for v in asc.all(f"/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS&limit=10"):
            print("version", v["attributes"]["versionString"], v["attributes"]["appStoreState"])
        v = asc.all(f"/apps/{APP_ID}/appStoreVersions?filter[platform]=IOS&limit=1")[0]
        locs = localizations(asc, v["id"])
        for l in locs:
            sets = asc.all(f"/appStoreVersionLocalizations/{l['id']}/appScreenshotSets")
            print(l["attributes"]["locale"], [s["attributes"]["screenshotDisplayType"] for s in sets])
        duo_slot(asc, locs[0]["id"])
        return

    version = find_version(asc, a.version)
    vid = version["id"]
    print("version", a.version, version["attributes"].get("appStoreState"))
    if a.build:
        attach_build(asc, vid, a.build)
    locs = write_texts(asc, vid, localizations(asc, vid))
    if a.pictures:
        root = os.path.expanduser(a.pictures)
        duo = duo_slot(asc, locs[0]["id"])
        slots = dict(SLOTS)
        if duo:
            slots["iPhone-Duo"] = duo
        else:
            print("no iPhone Duo slot offered; its pictures are skipped")
        for l in locs:
            lang = lang_of(l["attributes"]["locale"])
            for folder, slot in slots.items():
                d = os.path.join(root, folder, lang if os.path.isdir(os.path.join(root, folder, lang)) else "en")
                if not os.path.isdir(d):
                    continue
                files = sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith(".png"))
                print(f"{l['attributes']['locale']}: {len(files)} pictures for {slot}")
                upload_set(asc, l["id"], slot, files)
    if a.submit:
        submit(asc, vid)


if __name__ == "__main__":
    sys.exit(main())
