"""
요기보 팟 CF 리메이크 — 노란 타이포/제품 카드를 코드로 렌더링한다.
글자는 AI 가 아니라 여기서 실제 글꼴(Pretendard)로 그리므로 한글이 깨지지 않는다.
사용: python cf_cards.py <카드이름> <출력.mp4>
"""
import math, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1920, 1080
FPS_NUM, FPS_DEN = 24000, 1001                      # 레퍼런스와 같은 23.976fps — 음악 박자를 맞추려고
FONT = r"C:/Users/Yogibo Design/Desktop/imgCreate/fonts/PretendardVariable.ttf"
SP = r"C:/Users/YOGIBO~1/AppData/Local/Temp/claude/c--Users-Yogibo-Design-Desktop-imgCreate/0b7908b6-bb66-4fb2-92ce-5dcfd7df4943/scratchpad"

# 레퍼런스 실측: 가운데 #F9DB06, 모서리 #F3C80F 로 어두워지는 원형 그라데이션
def yellow_bg():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / math.sqrt(2)
    d = np.clip(d, 0, 1) ** 1.6
    c0, c1 = np.array([249, 219, 6], np.float32), np.array([243, 200, 15], np.float32)
    img = c0[None, None, :] * (1 - d[..., None]) + c1[None, None, :] * d[..., None]
    return Image.fromarray(img.astype(np.uint8), "RGB")

def ease_out_back(x, s=1.70158):
    x = min(max(x, 0.0), 1.0) - 1
    return x * x * ((s + 1) * x + s) + 1

def ease_out_cubic(x):
    x = min(max(x, 0.0), 1.0)
    return 1 - (1 - x) ** 3

def font(size, weight):
    f = ImageFont.truetype(FONT, size)
    f.set_variation_by_axes([weight])
    return f

def draw_text_center(canvas, text, size, weight, color, cx, cy, scale=1.0, alpha=1.0):
    """글자를 따로 그려서 크기·투명도를 바꾼 뒤 (cx, cy) 가운데에 얹는다."""
    if alpha <= 0 or scale <= 0.01:
        return
    f = font(max(4, int(size * scale)), weight)
    l, t, r, b = f.getbbox(text)
    tw, th = r - l, b - t
    layer = Image.new("RGBA", (tw + 40, th + 40), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((20 - l, 20 - t), text, font=f, fill=color + (int(255 * alpha),))
    canvas.alpha_composite(layer, (int(cx - layer.width / 2), int(cy - layer.height / 2)))

def key_ring_sprites(path, n=8):
    """노란 배경을 빼고 원형으로 놓인 팟 n개를 각도로 나눠 스프라이트로 자른다."""
    src = Image.open(path).convert("RGB").resize((W, H), Image.LANCZOS)
    a = np.asarray(src).astype(np.float32) / 255.0
    hsv = np.asarray(src.convert("HSV")).astype(np.float32)
    hue, sat, val = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255, hsv[..., 2] / 255
    bg = (hue > 38) & (hue < 64) & (sat > 0.72) & (val > 0.72)
    alpha = Image.fromarray(((~bg) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    rgba = src.convert("RGBA"); rgba.putalpha(alpha)
    m = np.asarray(alpha) > 128
    ys, xs = np.nonzero(m)
    ang = (np.degrees(np.arctan2(ys - H / 2, xs - W / 2)) + 360 + 90) % 360      # 12시 방향이 0도
    sector = np.round(ang / (360 / n)).astype(int) % n
    sprites = []
    for i in range(n):
        sel = sector == i
        if sel.sum() < 500:
            continue
        x0, x1, y0, y1 = xs[sel].min(), xs[sel].max(), ys[sel].min(), ys[sel].max()
        sprites.append({"img": rgba.crop((x0 - 4, y0 - 4, x1 + 5, y1 + 5)),
                        "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2, "i": i})
    return sprites

def card_pot(t, bg, sprites):
    """'팟' — 8색 팟이 하나씩 튀어나와 천천히 돌고, 가운데에 '팟' 이 튀어 들어온다 (2.38초)."""
    frame = bg.convert("RGBA")
    rot = math.radians(10 * t)
    for s in sprites:
        k = ease_out_back((t - 0.05 * s["i"]) / 0.35)
        if k <= 0.01:
            continue
        dx, dy = s["cx"] - W / 2, s["cy"] - H / 2
        x = W / 2 + dx * math.cos(rot) - dy * math.sin(rot)
        y = H / 2 + dx * math.sin(rot) + dy * math.cos(rot) + 6 * math.sin(2 * math.pi * 0.8 * t + s["i"])
        im = s["img"].resize((max(1, int(s["img"].width * k)), max(1, int(s["img"].height * k))), Image.LANCZOS)
        im = im.rotate(3 * math.sin(2 * math.pi * 0.6 * t + s["i"]), resample=Image.BICUBIC, expand=True)
        frame.alpha_composite(im, (int(x - im.width / 2), int(y - im.height / 2)))
    k = ease_out_back((t - 0.25) / 0.35, s=2.2)
    draw_text_center(frame, "팟", 300, 880, (226, 35, 26), W / 2, H / 2 - 10, scale=k, alpha=min(1, (t - 0.25) / 0.1))
    return frame.convert("RGB")

def card_rest(t, bg, _):
    """'휴식 할 땐' — 검은 글자가 살짝 올라오며 나타난다 (1.38초)."""
    frame = bg.convert("RGBA")
    k = ease_out_cubic(t / 0.3)
    draw_text_center(frame, "휴식 할 땐", 96, 800, (26, 26, 26), W / 2, H / 2 + 24 * (1 - k), alpha=k)
    return frame.convert("RGB")

CARDS = {
    "pot":  (card_pot, 2.38, lambda: key_ring_sprites(SP + "/cf_ring.png")),
    "rest": (card_rest, 1.38, lambda: None),
}

def render(name, out):
    fn, dur, prep = CARDS[name]
    data, bg = prep(), yellow_bg()
    n = round(dur * FPS_NUM / FPS_DEN)
    p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                          "-s", f"{W}x{H}", "-r", f"{FPS_NUM}/{FPS_DEN}", "-i", "-",
                          "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", out],
                         stdin=subprocess.PIPE)
    for f in range(n):
        p.stdin.write(fn(f * FPS_DEN / FPS_NUM, bg, data).tobytes())
    p.stdin.close(); p.wait()
    print(name, "->", out, f"{n} frames")

if __name__ == "__main__":
    render(sys.argv[1], sys.argv[2])


def overlay_lines(src, start, dur, lines, out):
    """실사 클립(src)의 start~start+dur 구간을 1920x1080 으로 맞추고, 왼쪽에 흰 글자 줄들을 얹는다.
    lines: [(글자, 크기, 굵기, 나타나는 시각)] — 레퍼런스 G 컷처럼 위는 작게, 아래는 크게."""
    n = round(dur * FPS_NUM / FPS_DEN)
    dec = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", str(start), "-i", src, "-t", str(dur + 0.2),
                            "-vf", f"fps={FPS_NUM}/{FPS_DEN},scale={W}:{H}:flags=lanczos,setsar=1",
                            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                            "-s", f"{W}x{H}", "-r", f"{FPS_NUM}/{FPS_DEN}", "-i", "-",
                            "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", out],
                           stdin=subprocess.PIPE)
    size = W * H * 3
    for f in range(n):
        buf = dec.stdout.read(size)
        if len(buf) < size:
            break
        t = f * FPS_DEN / FPS_NUM
        frame = Image.frombytes("RGB", (W, H), buf).convert("RGBA")
        y = 380
        for text, sz, wt, t0 in lines:
            k = ease_out_cubic((t - t0) / 0.25)
            if k > 0:
                fnt = font(sz, wt)
                l, tp, r, b = fnt.getbbox(text)
                layer = Image.new("RGBA", (r - l + 60, b - tp + 60), (0, 0, 0, 0))
                d = ImageDraw.Draw(layer)
                d.text((30 - l + 3, 30 - tp + 4), text, font=fnt, fill=(0, 0, 0, int(90 * k)))   # 옅은 그림자
                layer = layer.filter(ImageFilter.GaussianBlur(3))
                ImageDraw.Draw(layer).text((30 - l, 30 - tp), text, font=fnt, fill=(255, 255, 255, int(255 * k)))
                frame.alpha_composite(layer, (120 - 30 + int(30 * (1 - k)), y - 30))
            y += int(sz * 1.18)
        enc.stdin.write(frame.convert("RGB").tobytes())
    enc.stdin.close(); enc.wait(); dec.stdout.close(); dec.wait()
    print("overlay ->", out, f"{n} frames")
