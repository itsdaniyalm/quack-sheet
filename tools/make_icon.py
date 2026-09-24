"""Generate the QuackSheet icon: a yellow duck sitting on a spreadsheet.

Writes assets/quacksheet.ico, assets/quacksheet.png (1024 px), app/web/favicon.png and app/web/logo.png.
Needs Pillow (dev-only):  .venv\\Scripts\\python.exe -m pip install pillow
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SS = 1024  # drawing canvas; shapes are specified on a 256 grid and scaled

BG_TOP = (59, 130, 246)
BG_BOTTOM = (29, 78, 216)
SHEET = (255, 255, 255)
HEADER = (219, 234, 254)
GRID = (191, 211, 245)
DUCK = (255, 200, 61)
WING = (244, 172, 0)
BEAK = (255, 128, 31)
EYE = (25, 32, 48)


def s(*v):
    return [round(x * SS / 256) for x in v]


def tile(draw_fn):
    img = Image.new("RGBA", (SS, SS), (0, 0, 0, 0))
    grad = Image.new("RGBA", (SS, SS))
    gd = ImageDraw.Draw(grad)
    for y in range(SS):
        t = y / (SS - 1)
        gd.line([(0, y), (SS, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)) + (255,))
    mask = Image.new("L", (SS, SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(s(4, 4, 252, 252), radius=s(56)[0], fill=255)
    img.paste(grad, (0, 0), mask)
    draw_fn(ImageDraw.Draw(img))
    return img


def duck(d, halo):
    """Duck facing right; halo > 0 draws a white sticker outline first."""
    o = halo
    color = SHEET if halo else None

    def ell(box, fill):
        x0, y0, x1, y1 = box
        d.ellipse(s(x0 - o, y0 - o, x1 + o, y1 + o), fill=color or fill)

    def poly(pts, fill):
        if o:
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            pts = [(x + (x - cx) / max(abs(x - cx), 1e-6) * o * 0.7 if x != cx else x,
                    y + (y - cy) / max(abs(y - cy), 1e-6) * o * 0.7 if y != cy else y) for x, y in pts]
        d.polygon([tuple(s(x, y)) for x, y in pts], fill=color or fill)

    dx = -14  # shift left so the beak and halo stay inside the tile
    poly([(112 + dx, 186), (92 + dx, 146), (138 + dx, 168)], DUCK)    # tail
    ell((106 + dx, 150, 234 + dx, 234), DUCK)                          # body
    ell((160 + dx, 88, 232 + dx, 160), DUCK)                           # head
    ell((214 + dx, 118, 252 + dx, 146), BEAK)                          # beak
    if not halo:
        ell((134 + dx, 176, 198 + dx, 214), WING)                      # wing
        ell((196 + dx, 108, 212 + dx, 124), EYE)                       # eye
        ell((203 + dx, 111, 208 + dx, 116), SHEET)                     # eye highlight
        d.line(s(220 + dx, 132, 248 + dx, 132), fill=(214, 96, 12), width=s(3)[0])  # beak line


def full(d):
    d.rounded_rectangle(s(34, 40, 178, 204), radius=s(14)[0], fill=SHEET)
    d.rounded_rectangle(s(34, 40, 178, 82), radius=s(14)[0], fill=HEADER)
    d.rectangle(s(34, 68, 178, 82), fill=HEADER)
    w = s(4)[0]
    for x in (82, 130):
        d.line(s(x, 40, x, 204), fill=GRID, width=w)
    for y in (82, 122, 162):
        d.line(s(34, y, 178, y), fill=GRID, width=w)
    duck(d, halo=8)
    duck(d, halo=0)


def small(d):
    """16-24 px: just a big duck head on a sheet corner, so it reads at tiny sizes."""
    d.rounded_rectangle(s(30, 30, 150, 150), radius=s(18)[0], fill=SHEET)
    d.line(s(30, 90, 150, 90), fill=GRID, width=s(12)[0])
    d.line(s(90, 30, 90, 150), fill=GRID, width=s(12)[0])
    d.ellipse(s(76, 76, 226, 226), fill=SHEET)
    d.ellipse(s(88, 88, 214, 214), fill=DUCK)
    d.ellipse(s(186, 138, 250, 180), fill=BEAK)
    d.ellipse(s(146, 116, 178, 148), fill=EYE)


def main():
    big = tile(full)
    tiny = tile(small)
    os.makedirs(os.path.join(ROOT, "assets"), exist_ok=True)
    big.save(os.path.join(ROOT, "assets", "quacksheet.png"))
    big.resize((64, 64), Image.LANCZOS).save(os.path.join(ROOT, "app", "web", "favicon.png"))
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "app", "web", "logo.png"))

    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [(tiny if n <= 24 else big).resize((n, n), Image.LANCZOS) for n in sizes]
    ico = os.path.join(ROOT, "assets", "quacksheet.ico")
    frames[-1].save(ico, format="ICO", sizes=[(n, n) for n in sizes], append_images=frames[:-1])
    print("wrote", ico)


if __name__ == "__main__":
    main()
