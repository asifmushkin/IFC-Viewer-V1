from PIL import Image, ImageDraw, ImageFont

icon = Image.new('RGBA', (64, 64), (30, 30, 30, 255))
draw = ImageDraw.Draw(icon)

# background border
for i in range(2):
    draw.rectangle((2 + i, 2 + i, 61 - i, 61 - i), outline=(255, 140, 0, 255))

# text layout
text = "SBF_BIM/GIS"
font = ImageFont.load_default()
try:
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
except AttributeError:
    bbox = font.getbbox(text)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
text_x = (64 - text_width) // 2
text_y = (64 - text_height) // 2

# draw text with contrast
draw.text((text_x, text_y), text, font=font, fill=(255, 140, 0, 255))

# scale down to 20x20 for Power BI icon
icon = icon.resize((20, 20), Image.LANCZOS)
icon.save('assets/icon.png')
