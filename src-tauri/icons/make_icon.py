#!/usr/bin/env python3
"""落笔生花应用图标生成器：1024x1024 PNG，暗底 + 「墨」字 + 朱红印章点缀。"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

SIZE = 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角矩形底（macOS 风格大圆角，深色渐变近似：纯深灰 + 轻微内发光）
def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)

margin = 60
rounded_rect(d, (margin, margin, SIZE - margin, SIZE - margin), 210, (28, 28, 30, 255))

# 底部轻微蓝色氛围光
glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse((SIZE // 2 - 360, SIZE - 420, SIZE // 2 + 360, SIZE + 200), fill=(74, 144, 217, 60))
glow = glow.filter(ImageFilter.GaussianBlur(120))
img.alpha_composite(glow)

# 「墨」字（优先系统中文字体）
font = None
font_path = None
candidates = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
]
for path in candidates:
    if os.path.exists(path):
        try:
            font = ImageFont.truetype(path, 560, index=0)
            font_path = path
            break
        except Exception:
            continue
if font is None:
    raise SystemExit("no CJK font found")

d = ImageDraw.Draw(img)
text = "墨"
bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
tx = (SIZE - tw) / 2 - bbox[0]
ty = (SIZE - th) / 2 - bbox[1] - 40
# 墨色渐变感：白字 + 微蓝描边
d.text((tx, ty), text, font=font, fill=(240, 240, 245, 255), stroke_width=6, stroke_fill=(74, 144, 217, 90))

# 朱红印章小方块（右下角，写「画」）
seal_size = 190
sx, sy = SIZE - margin - seal_size - 60, SIZE - margin - seal_size - 60
d.rounded_rectangle((sx, sy, sx + seal_size, sy + seal_size), radius=28, fill=(196, 52, 44, 255))
seal_font = ImageFont.truetype(font_path, 110, index=0)
sb = d.textbbox((0, 0), "画", font=seal_font)
d.text(
    (sx + (seal_size - (sb[2] - sb[0])) / 2 - sb[0], sy + (seal_size - (sb[3] - sb[1])) / 2 - sb[1]),
    "画", font=seal_font, fill=(255, 244, 235, 255),
)

img.save(OUT)
print("written:", OUT)
