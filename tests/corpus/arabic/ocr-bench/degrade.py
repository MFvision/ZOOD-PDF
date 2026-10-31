import json, subprocess, sys, numpy as np, io, os
from PIL import Image, ImageFilter
S = sys.argv[1]
jobs = json.load(open('jobs.json'))
rng = np.random.default_rng(7)
for j in jobs:
    subprocess.run(['pdftoppm', '-r', '300', '-gray', '-png', '-singlefile', f'{j}.pdf', f'/tmp/{j}'], check=True)
    img = Image.open(f'/tmp/{j}.png').convert('L')
    W, H = img.size
    # clean office scan: 300 dpi grey, tint, light noise, 0.4 degree
    a = np.asarray(img.rotate(0.4, Image.BICUBIC, fillcolor=255)).astype(np.float32)
    a = a * 0.9 + 18 + rng.normal(0, 5, a.shape)
    clean = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    # office MFP: 200 dpi, 1 bit, 0.8 degree, specks, then drawn at 300 like the app does
    small = img.resize((W * 2 // 3, H * 2 // 3), Image.LANCZOS).rotate(-0.8, Image.BICUBIC, fillcolor=255).filter(ImageFilter.GaussianBlur(0.5))
    b = np.asarray(small).astype(np.float32) + rng.normal(0, 18, (small.size[1], small.size[0]))
    bw = (b > 165).astype(np.uint8) * 255
    sp = rng.random(bw.shape) < 0.0008; bw[sp] = 0
    mfp = Image.fromarray(bw).resize((W, H), Image.NEAREST)
    # phone photo: 150 dpi effective, blur, uneven light, 2.5 degree, JPEG 45
    ph = img.resize((W // 2, H // 2), Image.LANCZOS).rotate(2.5, Image.BICUBIC, fillcolor=235).filter(ImageFilter.GaussianBlur(0.9))
    p = np.asarray(ph).astype(np.float32)
    yy, xx = np.mgrid[0:p.shape[0], 0:p.shape[1]]
    light = 0.62 + 0.38 * (xx / p.shape[1]) * (0.7 + 0.3 * yy / p.shape[0])
    p = p * light + rng.normal(0, 7, p.shape)
    ph = Image.fromarray(np.clip(p, 0, 255).astype(np.uint8))
    buf = io.BytesIO(); ph.save(buf, 'JPEG', quality=45); ph = Image.open(buf).resize((W, H), Image.BICUBIC)
    for tag, im in [('clean', clean), ('mfp', mfp), ('photo', ph)]:
        d = f'{S}/bench/office-{tag}-{j}'; os.makedirs(d, exist_ok=True); im.save(f'{d}/p1.png')
        open(f'{S}/truth/office-{tag}-{j}.txt', 'w').write(open(f'{j}.txt').read())
print('ok')
