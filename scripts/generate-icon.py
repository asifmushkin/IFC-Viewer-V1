from PIL import Image, ImageDraw

icon = Image.new('RGBA', (20, 20), (30, 30, 30, 255))
draw = ImageDraw.Draw(icon)
draw.rectangle((2, 2, 17, 17), outline=(255, 140, 0, 255), width=2)
draw.line((4, 10, 16, 10), fill=(255, 140, 0, 255), width=2)
draw.line((10, 4, 10, 16), fill=(255, 140, 0, 255), width=2)
icon.save('assets/icon.png')
