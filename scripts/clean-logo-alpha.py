from pathlib import Path
from PIL import Image

project_root = Path(__file__).resolve().parents[1]
src = project_root / 'public/assets/kozum-logo-transparent.png'
dst = project_root / 'public/assets/kozum-logo.png'
img = Image.open(src).convert('RGBA')
pix = img.load()
for y in range(img.height):
    for x in range(img.width):
        r, g, b, _ = pix[x, y]
        neutral = max(r, g, b) - min(r, g, b) < 22
        bright = (r + g + b) / 3 > 150
        # The generated preview used a neutral light checkerboard. The logo is
        # saturated blue; remove only neutral bright pixels and retain colored
        # logo pixels, including anti-aliased blue edges.
        if neutral and bright:
            pix[x, y] = (r, g, b, 0)
        else:
            pix[x, y] = (r, g, b, 255)

bbox = img.getchannel('A').getbbox()
if bbox is None:
    raise RuntimeError('logo foreground was not detected')
img = img.crop(bbox)
img.thumbnail((256, 256), Image.Resampling.LANCZOS)
out = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
out.alpha_composite(img, ((256 - img.width) // 2, (256 - img.height) // 2))
out.save(dst, 'PNG', optimize=True)
print(f'Wrote {dst} with alpha and size {out.size}')
