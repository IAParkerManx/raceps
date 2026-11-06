"""Night grade for the GTI Night Run poster photo.

Photo: Bradley De Melo on Pexels (pexels.com/photo/18690925), free to use and edit.
Usage: python -I grade_photo.py <source.jpg> <out.jpg>
"""
import sys
import numpy as np
import cv2

src, out_path = sys.argv[1], sys.argv[2]
W, H = 2382, 3369  # A4 at 288 dpi

raw = cv2.imread(src)
h0, w0 = raw.shape[:2]
crop_h = int(w0 * H / W)
raw = raw[:crop_h]                       # lose the floor, keep the ceiling for the type
raw = cv2.resize(raw, (W, H), interpolation=cv2.INTER_AREA)

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
u, v = xx / W, yy / H


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# --- hide the number plate (privacy) ---
PLATE = (0.076, 0.574, 0.117, 0.610)  # left, top, right, bottom as fractions
x0, y0, x1, y1 = int(PLATE[0] * W), int(PLATE[1] * H), int(PLATE[2] * W), int(PLATE[3] * H)
mask = np.zeros((H, W), np.float32)
mask[y0:y1, x0:x1] = 1
mask = cv2.GaussianBlur(mask, (0, 0), 6)[..., None]
plate_fill = cv2.GaussianBlur(raw, (0, 0), 40).astype(np.float32) * 0.10
img = raw.astype(np.float32) * (1 - mask) + plate_fill * mask
img = np.clip(img, 0, 255).astype(np.uint8)

# --- colour: everything goes cold and neutral, only true reds survive ---
hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV_FULL).astype(np.float32)
hue, sat = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255
red = np.exp(-(np.minimum(np.abs(hue), 360 - np.abs(hue)) / 17) ** 2) * smooth(0.25, 0.5, sat)
lin = (img.astype(np.float32) / 255) ** 2.2          # BGR, linear
grey = (lin @ np.array([0.0722, 0.7152, 0.2126], np.float32))[..., None]
keep = (0.05 + 0.95 * red)[..., None]
lin = np.clip(grey + (lin - grey) * keep * 1.25, 0, None)
lin = lin * np.array([1.10, 1.015, 0.93], np.float32) ** (1 - red[..., None])  # cool

# --- light: pull the room down until the car is the only thing in it ---
car_cx, car_cy = 0.48, 0.565
pool = np.exp(-(((u - car_cx) / 0.56) ** 2 + ((v - car_cy) / 0.20) ** 2))
floor = np.exp(-(((u - car_cx) / 0.62) ** 2 + ((v - 0.70) / 0.13) ** 2)) * smooth(0.60, 0.68, v)
gain = 0.035 + 0.74 * pool + 0.15 * floor
top = smooth(0.46, 0.24, v)                           # ceiling falls to black, for the type
gain *= (1 - 0.985 * top)
bottom = smooth(0.74, 0.95, v)
gain *= (1 - 0.96 * bottom)
gain *= (1 - 0.62 * smooth(0.665, 0.73, v))           # quiet the concrete in front of the car
gain *= 1 - 0.45 * np.exp(-(((u - 0.10) / 0.22) ** 2 + ((v - 0.70) / 0.05) ** 2))
lin *= gain[..., None]

# the room behind the car drops away: mid greys (walls, pillars) sink, highlights stay
room = smooth(0.66, 0.60, v)[..., None]
sunk = np.minimum(lin, 1.7 * lin ** 1.9)
lin = lin * (1 - room) + sunk * room

# the car itself keeps its own exposure, lifted slightly
car_box = np.exp(-(((u - 0.49) / 0.42) ** 4 + ((v - 0.565) / 0.105) ** 4))
lin *= (1 + 0.22 * car_box)[..., None]

# --- glow from the highlights ---
bright = np.clip(lin - 0.16, 0, None)
lin += cv2.GaussianBlur(bright, (0, 0), 10) * 0.22 + cv2.GaussianBlur(bright, (0, 0), 60) * 0.20

# --- film curve ---
a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
x = np.clip(lin * 1.5, 0, None)
tm = np.clip((x * (a * x + b)) / (x * (c * x + d) + e), 0, 1)
out = tm ** (1 / 2.2)

# --- fine grain and dither, so the blacks never band ---
rng = np.random.default_rng(3)
grain = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 1.0)
grain /= grain.std()
out = out + grain[..., None] * 0.0085 + (rng.random((H, W, 3), dtype=np.float32) - 0.5) / 255
bgr = (np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8)
cv2.imwrite(out_path, bgr, [cv2.IMWRITE_JPEG_QUALITY, 94, cv2.IMWRITE_JPEG_OPTIMIZE, 1])
print("wrote", out_path, W, H)
