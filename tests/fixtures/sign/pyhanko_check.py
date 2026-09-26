"""Independent validation of ZOOD PDF signatures with pyHanko (MIT; test-only, never bundled).

usage: python3 pyhanko_check.py ROOT.pem FILE.pdf [PASSWORD]
Prints one JSON object per embedded signature.
"""
import json
import sys

from pyhanko.keys import load_cert_from_pemder
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature, validate_pdf_timestamp
from pyhanko_certvalidator import ValidationContext


def main() -> None:
    root_path, pdf_path = sys.argv[1], sys.argv[2]
    password = sys.argv[3] if len(sys.argv) > 3 else None
    root = load_cert_from_pemder(root_path)
    with open(pdf_path, "rb") as fh:
        reader = PdfFileReader(fh, strict=False)
        if reader.encrypted:
            reader.decrypt(password or "")
        for sig in reader.embedded_signatures:
            vc = ValidationContext(
                trust_roots=[root], allow_fetching=False, revocation_mode="soft-fail"
            )
            out = {"field": sig.field_name, "type": str(sig.sig_object_type)}
            try:
                if sig.sig_object_type == "/DocTimeStamp":
                    st = validate_pdf_timestamp(sig, validation_context=vc)
                else:
                    st = validate_pdf_signature(sig, vc)
                out.update(
                    intact=bool(st.intact),
                    valid=bool(st.valid),
                    trusted=bool(st.trusted),
                    coverage=str(getattr(st, "coverage", "")),
                    modification_level=str(getattr(st, "modification_level", "")),
                    docmdp_ok=getattr(st, "docmdp_ok", None),
                    timestamp=str(getattr(st, "timestamp_validity", None) is not None),
                )
            except Exception as e:  # noqa: BLE001 - report every failure as data
                out.update(error=f"{type(e).__name__}: {e}")
            print(json.dumps(out))


if __name__ == "__main__":
    main()
