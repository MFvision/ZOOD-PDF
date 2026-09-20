#!/usr/bin/env python3
"""A CMYK output ("printer") ICC profile for tests only: test-press-cmyk.icc.

It is structurally a real ICC v2.1 output profile - class `prtr`, CMYK data,
Lab connection space, the tags an output profile must have (desc, cprt,
wtpt, A2B0-2, B2A0-2, gamt) as 8-bit LUTs - so PDF/X-4 conversion and
validation can be tested without a press's own profile, which Warraq may not
bundle. Its colours come from a naive subtractive model (CMYK -> RGB ->
sRGB -> Lab D50) and describe no real press: never use it to print.

Written by Warraq; released with the repository (Apache-2.0).
Run: python3 tests/fixtures/icc/make_test_press.py
"""
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))


def s15(v):
    return struct.pack('>i', int(round(v * 65536)))


def srgb_to_lab(r, g, b):
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = lin(r), lin(g), lin(b)
    # sRGB to XYZ, Bradford-adapted to D50.
    x = 0.4360747 * r + 0.3850649 * g + 0.1430804 * b
    y = 0.2225045 * r + 0.7168786 * g + 0.0606169 * b
    z = 0.0139322 * r + 0.0971045 * g + 0.7141733 * b
    xn, yn, zn = 0.9642, 1.0, 0.8249

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116
    fx, fy, fz = f(x / xn), f(y / yn), f(z / zn)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def lab_to_srgb(L, a, b):
    fy = (L + 16) / 116
    fx = fy + a / 500
    fz = fy - b / 200

    def finv(t):
        return t ** 3 if t ** 3 > 216 / 24389 else (116 * t - 16) / (24389 / 27)
    x, y, z = 0.9642 * finv(fx), 1.0 * finv(fy), 0.8249 * finv(fz)
    r = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z
    g = -0.9787684 * x + 1.9161415 * y + 0.0334540 * z
    bb = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z

    def gam(c):
        c = min(max(c, 0.0), 1.0)
        return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
    return gam(r), gam(g), gam(bb)


def enc_lab(L, a, b):
    clamp = lambda v: max(0, min(255, int(round(v))))
    return bytes([clamp(L * 255 / 100), clamp(a + 128), clamp(b + 128)])


def lut8(inputs, outputs, grid, fn):
    data = b'mft1' + b'\0' * 4 + bytes([inputs, outputs, grid, 0])
    for i in range(9):
        data += s15(1.0 if i in (0, 4, 8) else 0.0)
    data += bytes(range(256)) * inputs
    total = grid ** inputs
    for index in range(total):
        coords = []
        rest = index
        for _ in range(inputs):
            coords.append(rest % grid)
            rest //= grid
        coords.reverse()
        data += fn([c / (grid - 1) for c in coords])
    data += bytes(range(256)) * outputs
    return data


def cmyk_to_lab(v):
    c, m, y, k = v
    r, g, b = (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
    return enc_lab(*srgb_to_lab(r, g, b))


def lab_to_cmyk(v):
    L, a, b = v[0] * 100, v[1] * 255 - 128, v[2] * 255 - 128
    r, g, bb = lab_to_srgb(L, a, b)
    k = 1 - max(r, g, bb)
    if k >= 0.999:
        return bytes([0, 0, 0, 255])
    c = (1 - r - k) / (1 - k)
    m = (1 - g - k) / (1 - k)
    y = (1 - bb - k) / (1 - k)
    to = lambda t: max(0, min(255, int(round(t * 255))))
    return bytes([to(c), to(m), to(y), to(k)])


def text_desc(s):
    a = s.encode('ascii') + b'\0'
    body = b'desc' + b'\0' * 4 + struct.pack('>I', len(a)) + a
    body += struct.pack('>II', 0, 0) + struct.pack('>H', 0) + b'\0' + b'\0' * 67
    return body


def main():
    a2b = lut8(4, 3, 5, cmyk_to_lab)
    b2a = lut8(3, 4, 9, lab_to_cmyk)
    gamt = lut8(3, 1, 2, lambda v: b'\0')
    tags = [
        (b'desc', text_desc('Warraq test press (CMYK, not for printing)')),
        (b'cprt', b'text' + b'\0' * 4 + b'Warraq test fixture, Apache-2.0\0'),
        (b'wtpt', b'XYZ ' + b'\0' * 4 + s15(0.9642) + s15(1.0) + s15(0.8249)),
        (b'A2B0', a2b), (b'A2B1', a2b), (b'A2B2', a2b),
        (b'B2A0', b2a), (b'B2A1', b2a), (b'B2A2', b2a),
        (b'gamt', gamt),
    ]
    offset = 128 + 4 + 12 * len(tags)
    table = struct.pack('>I', len(tags))
    blobs = b''
    for sig, data in tags:
        while (offset + len(blobs)) % 4:
            blobs += b'\0'
        table += sig + struct.pack('>II', offset + len(blobs), len(data))
        blobs += data
    body = table + blobs
    while len(body) % 4:
        body += b'\0'
    size = 128 + len(body)
    header = struct.pack('>I', size) + b'\0' * 4 + bytes([2, 0x10, 0, 0])
    header += b'prtr' + b'CMYK' + b'Lab '
    header += struct.pack('>6H', 2026, 9, 19, 0, 0, 0)
    header += b'acsp' + b'\0' * 4 + b'\0' * 4 + b'\0' * 4 + b'\0' * 4 + b'\0' * 8
    header += b'\0' * 4  # rendering intent
    header += s15(0.9642) + s15(1.0) + s15(0.8249)
    header += b'\0' * 4  # creator
    header += b'\0' * (128 - len(header))
    assert len(header) == 128
    with open(os.path.join(HERE, 'test-press-cmyk.icc'), 'wb') as f:
        f.write(header + body)


if __name__ == '__main__':
    main()
