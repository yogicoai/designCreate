"""
요기보 팟 CF 리메이크 — 33.03초 전체를 한 번에 렌더링한다.

구간 시각은 레퍼런스 장면 전환 실측(18구간)이라 회사 원본 음원 박자와 그대로 맞는다.
글자·로고·노란 카드는 전부 여기서 그린다(한글은 Pretendard, 영어는 OFL Fraunces) — AI 는 글자를 그리지 않는다.
실사 구간은 Seedance 클립(720p)을 1080p 로 올려 쓴다.

사용: python cf_full.py <출력.mp4> [자산폴더]
"""
import math, os, subprocess, sys
from functools import lru_cache
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1920, 1080
FPS_NUM, FPS_DEN = 24000, 1001
FPS = FPS_NUM / FPS_DEN
A = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
KR_FONT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "fonts", "PretendardVariable.ttf")   # 저장소 fonts/ — PC 가 바뀌어도 그대로
EN_FONT = os.path.join(A, "Fraunces.ttf")          # OFL — Cooper Black 라이선스가 확인되면 여기만 바꾼다

GREEN, PINK, TEAL, MINT = (40, 136, 24), (248, 88, 88), (88, 184, 200), (62, 224, 197)
WHITE, INK = (255, 255, 255), (26, 26, 26)

# 레퍼런스 장면 전환 실측(초)
B = [0, 2.169, 5.589, 7.966, 9.718, 9.885, 11.178, 12.596, 13.889, 16.725,
     18.101, 21.313, 22.564, 25.067, 26.693, 28.529, 29.905, 30.739, 33.033]

# 실사 클립: (파일, 시작 오프셋) — 클립마다 가장 좋은 구간을 골라 넣는다
CLIPS = {
    "A": ("cfA.mp4", 2.6), "B": ("cfB.mp4", 3.2), "C": ("cfC.mp4", 3.0),
    "D": ("cfD.mp4", 1.3), "E": ("cfE.mp4", 2.4), "F": ("cfF.mp4", 1.5), "G": ("cfG.mp4", 3.1),
    # v2 — 노란 제품 카드 대신 장점을 직접 보여주는 실사 (사용자 요청 2026-09-30)
    "H": ("cfH.mp4", 2.4), "I": ("cfI.mp4", 3.2), "J": ("cfJ.mp4", 1.7),
}
# v3 — 사용자 요청 2026-09-30: A 여성B→여성E, E 여성E→여성B(원본은 컷 중간에 얼굴이 바뀜),
# I 팟이 너무 작게 나와 실측(95×85cm, 여성D 173cm)으로 다시. 세 컷 모두 Seedance 2.5 1080p.
CLIPS.update({"A": ("cfA3.mp4", 2.3), "E": ("cfE3.mp4", 1.9), "I": ("cfI3.mp4", 3.0)})
# v4 — D 도 팟이 발받침처럼 작게 나와 다시(사용자 요청 2026-09-30): 서 있을 때 팟 윗면이 허리, 앉으면 발이 뜬다.
CLIPS.update({"D": ("cfD4.mp4", 1.7)})


# ── 기본 도구 ─────────────────────────────────────────────
def clamp01(x):
    return min(max(x, 0.0), 1.0)


def ease_out_back(x, s=1.70158):
    x = clamp01(x) - 1
    return x * x * ((s + 1) * x + s) + 1


def ease_out_cubic(x):
    return 1 - (1 - clamp01(x)) ** 3


def ease_in_out(x):
    x = clamp01(x)
    return 3 * x * x - 2 * x * x * x


@lru_cache(maxsize=1)
def yellow_bg():
    """레퍼런스 실측: 가운데 #F9DB06 → 모서리 #F3C80F 원형 그라데이션."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / math.sqrt(2)
    d = np.clip(d, 0, 1) ** 1.6
    c0, c1 = np.array([249, 219, 6], np.float32), np.array([243, 200, 15], np.float32)
    return Image.fromarray((c0 * (1 - d[..., None]) + c1 * d[..., None]).astype(np.uint8), "RGB").convert("RGBA")


@lru_cache(maxsize=256)
def kr(size, weight=880):
    f = ImageFont.truetype(KR_FONT, max(4, int(size)))
    f.set_variation_by_axes([weight])
    return f


@lru_cache(maxsize=256)
def en(size):
    f = ImageFont.truetype(EN_FONT, max(4, int(size)))
    f.set_variation_by_axes([144, 900, 100, 0])     # 광학크기 · 굵기 · 부드러움 · 삐뚤빼뚤
    return f


@lru_cache(maxsize=512)
def text_layer(text, font_key, size, color, shadow=False):
    """글자 한 덩어리를 투명 레이어로 만든다. font_key 가 숫자면 한글 굵기, "en" 이면 영어.
    shadow=True 면 실사 위 가독성용 옅은 그림자."""
    f = kr(size, font_key) if isinstance(font_key, int) else en(size)
    l, t, r, b = f.getbbox(text)
    pad = 40
    layer = Image.new("RGBA", (r - l + pad * 2, b - t + pad * 2), (0, 0, 0, 0))
    if shadow:
        sh = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).text((pad - l + 3, pad - t + 4), text, font=f, fill=(0, 0, 0, 120))
        layer.alpha_composite(sh.filter(ImageFilter.GaussianBlur(5)))
    ImageDraw.Draw(layer).text((pad - l, pad - t), text, font=f, fill=color + (255,))
    return layer


def blit(canvas, img, cx, cy, scale=1.0, alpha=1.0, rot=0.0):
    """img 를 (cx, cy) 가운데에 scale·rot·alpha 로 얹는다. 화면 밖은 잘라서 계산을 줄인다."""
    if scale <= 0.005 or alpha <= 0.005:
        return
    if rot:
        img = img.rotate(rot, resample=Image.BICUBIC, expand=True)
    w, h = img.width * scale, img.height * scale
    x0, y0 = cx - w / 2, cy - h / 2
    dx0, dy0, dx1, dy1 = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
    if dx1 <= dx0 or dy1 <= dy0:
        return
    sx0, sy0 = (dx0 - x0) / scale, (dy0 - y0) / scale
    sx1, sy1 = (dx1 - x0) / scale, (dy1 - y0) / scale
    part = img.crop((int(sx0), int(sy0), max(int(sx0) + 1, math.ceil(sx1)), max(int(sy0) + 1, math.ceil(sy1))))
    part = part.resize((max(1, int(dx1 - dx0)), max(1, int(dy1 - dy0))), Image.LANCZOS)
    if alpha < 1:
        part.putalpha(part.getchannel("A").point(lambda v: int(v * alpha)))
    canvas.alpha_composite(part, (int(dx0), int(dy0)))


def key_yellow(path, size=(W, H)):
    """노란 배경을 빼고 투명 PNG 로. 테두리 색 번짐은 우리 노란 배경 위에선 안 보인다."""
    src = Image.open(path).convert("RGB").resize(size, Image.LANCZOS)
    hsv = np.asarray(src.convert("HSV")).astype(np.float32)
    hue, sat, val = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255, hsv[..., 2] / 255
    bg = (hue > 38) & (hue < 64) & (sat > 0.72) & (val > 0.70)
    alpha = Image.fromarray(((~bg) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    out = src.convert("RGBA")
    out.putalpha(alpha)
    return out


def trim_alpha(img, pad=6):
    bb = img.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
    return img.crop((bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad)) if bb else img


def ring_sprites(path, n=8):
    full = key_yellow(path)
    m = np.asarray(full.getchannel("A")) > 128
    ys, xs = np.nonzero(m)
    ang = (np.degrees(np.arctan2(ys - H / 2, xs - W / 2)) + 360 + 90) % 360
    sector = np.round(ang / (360 / n)).astype(int) % n
    out = []
    for i in range(n):
        sel = sector == i
        x0, x1, y0, y1 = xs[sel].min(), xs[sel].max(), ys[sel].min(), ys[sel].max()
        out.append({"img": full.crop((x0 - 4, y0 - 4, x1 + 5, y1 + 5)), "cx": (x0 + x1) / 2, "cy": (y0 + y1) / 2, "i": i})
    return out   # 시계방향: 0 네이비 1 체리 2 코랄 3 다크그레이 4 올리브 5 민트 6 아쿠아 7 퍼플


# ── 자산 ──────────────────────────────────────────────────
ASSETS = {}


def make_vinyl(R):
    """검은 LP — 홈은 동심원이라 회전해도 같아 보이므로 한 번만 그린다."""
    im = Image.new("RGBA", (2 * R, 2 * R), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((0, 0, 2 * R - 1, 2 * R - 1), fill=(14, 14, 14, 255))
    for r in range(int(R * 0.47), R - 6, 5):
        g = 26 + (r * 7919) % 9
        d.ellipse((R - r, R - r, R + r, R + r), outline=(g, g, g, 255), width=1)
    hl = Image.new("RGBA", im.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.pieslice((0, 0, 2 * R - 1, 2 * R - 1), 200, 235, fill=(255, 255, 255, 34))
    hd.pieslice((0, 0, 2 * R - 1, 2 * R - 1), 20, 55, fill=(255, 255, 255, 26))
    im.alpha_composite(hl.filter(ImageFilter.GaussianBlur(18)))
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, 2 * R - 1, 2 * R - 1), fill=255)
    im.putalpha(Image.fromarray(np.minimum(np.asarray(im.getchannel("A")), np.asarray(mask))))
    return im


def load_assets():
    ASSETS["ring"] = ring_sprites(os.path.join(A, "cf_ring.png"))
    ASSETS["navy"] = trim_alpha(key_yellow(os.path.join(A, "prod_navy.png"), (2752, 1536)))
    ASSETS["cluster"] = trim_alpha(key_yellow(os.path.join(A, "prod_cluster.png"), (2752, 1536)))
    ASSETS["red"] = key_yellow(os.path.join(A, "prod_red.png"))
    ASSETS["logo"] = Image.open(os.path.join(A, "yogibo_logo3_on.png")).convert("RGBA")
    ASSETS["vinyl"] = make_vinyl(1100)


# ── 실사 클립 읽기 ────────────────────────────────────────
class ClipReader:
    def __init__(self, key, dur):
        src, off = CLIPS[key]
        self.p = subprocess.Popen(["ffmpeg", "-loglevel", "quiet", "-ss", str(off), "-i", os.path.join(A, src), "-t", str(dur + 0.3),
                                   "-vf", f"fps={FPS_NUM}/{FPS_DEN},scale={W}:{H}:flags=lanczos,setsar=1",
                                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
        self.last = None

    def frame(self):
        buf = self.p.stdout.read(W * H * 3)
        if len(buf) == W * H * 3:
            self.last = Image.frombytes("RGB", (W, H), buf).convert("RGBA")
        return self.last.copy() if self.last else Image.new("RGBA", (W, H), (0, 0, 0, 255))

    def close(self):
        try:
            self.p.stdout.close()
            self.p.kill()
        except Exception:
            pass


READERS = {}


def live(key, scene_dur):
    if key not in READERS:
        for k in list(READERS):
            READERS.pop(k).close()
        READERS[key] = ClipReader(key, scene_dur)
    return READERS[key].frame()


def pop_text(c, layer, x, y, t, t0, dur=0.28, anchor="c", grow=True):
    """t0 에 톡 튀어나오는 글자. anchor: c 가운데, l 왼쪽 기준(x 가 글자 왼쪽 끝)."""
    if t < t0:
        return
    k = ease_out_back((t - t0) / dur) if grow else 1.0
    a = clamp01((t - t0) / (0.08 if grow else 0.22))
    rise = 0 if grow else 24 * (1 - ease_out_cubic((t - t0) / 0.25))
    cx = x + (layer.width * k / 2 if anchor == "l" else 0)
    blit(c, layer, cx, y + rise, scale=k, alpha=a)


# ── 장면들 (t 는 장면 안 시각, T 는 장면 길이) ────────────
def s01_intro(t, T):
    c = yellow_bg().copy()
    z = 1 + 3.4 * ease_in_out((t - 0.45) / 1.55)
    R = 497 * z
    blit(c, ASSETS["vinyl"], W / 2, H / 2, scale=R / 1100)
    r = 212 * z
    lab = Image.new("RGBA", (int(2 * r) + 2, int(2 * r) + 2), (0, 0, 0, 0))
    ImageDraw.Draw(lab).ellipse((0, 0, 2 * r, 2 * r), fill=(249, 219, 6, 255))
    blit(c, lab, W / 2, H / 2)
    a_txt = 1 - clamp01((t - 0.7) / 0.25)
    blit(c, text_layer("Discover the Feel", "en", 30, GREEN), W / 2, H / 2, scale=z * 0.9, alpha=a_txt, rot=-140 * t)
    a_logo = clamp01((t - 0.85) / 0.3)
    rot_logo = -38 * (1 - ease_out_cubic((t - 0.85) / 0.9))
    blit(c, ASSETS["logo"], W / 2, H / 2, scale=(r * 1.25) / ASSETS["logo"].width, alpha=a_logo, rot=rot_logo)
    return c


def s02_titles(t, T):
    c = yellow_bg().copy()
    pod = ASSETS["navy"]
    if t < 1.08:                                     # The Disruptive Furniture — 위아래로 잔상 줄
        base = text_layer("The Disruptive Furniture", "en", 74, GREEN)
        for off in (-2, -1, 0, 1, 2):
            blit(c, base, W / 2, H / 2 + off * 96 - 30 * t, alpha=(1.0 if off == 0 else 0.28) * clamp01(t / 0.12))
    elif t < 2.23:                                   # POD — 가운데 O 는 네이비 팟
        u = t - 1.08
        k = ease_out_cubic(u / 0.22)
        blit(c, text_layer("P", "en", 430, GREEN), W / 2 - 430 - 380 * (1 - k), H / 2 + 10)
        blit(c, text_layer("D", "en", 430, GREEN), W / 2 + 430 + 380 * (1 - k), H / 2 + 10)
        blit(c, pod, W / 2, H / 2 + 20, scale=(330 / pod.height) * ease_out_back(u / 0.3), rot=8 * math.sin(u * 3.2))
        pop_text(c, text_layer("우리의 일상을", 900, 92, WHITE, shadow=True), W / 2, H / 2 + 10, u, 0.82)
    else:                                            # 팟하게 Level up!
        u = t - 2.23
        blit(c, pod, W / 2, H / 2 + 8 * math.sin(u * 4), scale=380 / pod.height)
        pop_text(c, text_layer("팟하게", 900, 104, PINK), W / 2 - 430, H / 2, u, 0.05, dur=0.45)
        pop_text(c, text_layer("Level up!", "en", 104, PINK), W / 2 + 470, H / 2, u, 0.18, dur=0.45)
    return c


def ring_frame(c, u):
    rot = math.radians(10 * u)
    for s in ASSETS["ring"]:
        k = ease_out_back((u - 0.05 * s["i"]) / 0.35)
        dx, dy = s["cx"] - W / 2, s["cy"] - H / 2
        x = W / 2 + dx * math.cos(rot) - dy * math.sin(rot)
        y = H / 2 + dx * math.sin(rot) + dy * math.cos(rot) + 6 * math.sin(2 * math.pi * 0.8 * u + s["i"])
        blit(c, s["img"], x, y, scale=k, rot=3 * math.sin(2 * math.pi * 0.6 * u + s["i"]))


def s03_pot(t, T):
    c = yellow_bg().copy()
    pod = ASSETS["navy"]
    if t < 0.46:                                     # 팟으로 확 파고든다
        blit(c, pod, W / 2, H / 2, scale=(380 / pod.height) * math.exp(math.log(7.5) * ease_in_out(t / 0.46)))
    elif t < 1.76:                                   # 8색 원 + 팟
        u = t - 0.46
        ring_frame(c, u)
        pop_text(c, text_layer("팟", 900, 300, (226, 35, 26)), W / 2, H / 2 - 10, u, 0.25, dur=0.35)
    else:                                            # 팟팟팟 — 분홍 글자가 화면을 채운다
        u = t - 1.76
        ring_frame(c, 1.3 + u)
        lay = text_layer("팟", 900, 150, PINK)
        for row in range(3):
            for col in range(5):
                pop_text(c, lay, W / 2 + (col - 2) * 250, H / 2 + (row - 1) * 230, u, 0.025 * (row * 5 + col), dur=0.2)
    return c


def s04_beanbag(t, T):
    c = yellow_bg().copy()
    pod = ASSETS["navy"]
    if t < 0.85:
        blit(c, pod, W / 2 + 330, H / 2 + 60, scale=1050 / pod.height, rot=-6)
        k = ease_out_cubic(t / 0.25)
        blit(c, text_layer("Bean", "en", 190, MINT), W / 2 - 330 - 300 * (1 - k), H / 2)
        blit(c, text_layer("Bag", "en", 190, WHITE, shadow=True), W / 2 + 180 + 300 * (1 - k), H / 2)
    else:
        u = t - 0.85
        blit(c, pod, W / 2, H / 2 + 8 * math.sin(u * 5), scale=(360 / pod.height) * ease_out_back(u / 0.25))
        for sx in (-1, 1):
            blit(c, ASSETS["logo"], W / 2 + sx * 520, H / 2 + 10, scale=0.95 * ease_out_back((u - 0.06) / 0.3))
    return c


def s05_flash(t, T):
    a = 1 - abs(t / T - 0.5) * 0.6
    return Image.blend(yellow_bg().copy(), Image.new("RGBA", (W, H), (255, 255, 255, 255)), clamp01(a))


def s06_office(t, T):
    c = live("A", T)
    pop_text(c, text_layer("팍팍한", 920, 128, WHITE, shadow=True), 160, H / 2 - 20, t, 0.12, anchor="l")
    lay = text_layer("일상을", 920, 128, WHITE, shadow=True)
    pop_text(c, lay, W - 160 - lay.width, H / 2 - 20, t, 0.62, anchor="l")
    return c


def s07_game(t, T):
    c = live("B", T)
    pop_text(c, text_layer("더", 900, 70, WHITE, shadow=True), 150, H / 2 - 110, t, 0.08, anchor="l")
    pop_text(c, text_layer("재미있게!", 920, 128, WHITE, shadow=True), 120, H / 2, t, 0.14, anchor="l")
    return c


def s08_read(t, T):
    c = live("C", T)
    pop_text(c, text_layer("더 감미롭게!", 920, 124, WHITE, shadow=True), W / 2 - 360, H / 2 - 40, t, 0.1)
    return c


def s09_colors(t, T):
    c = yellow_bg().copy()
    cl = ASSETS["cluster"]
    blit(c, cl, W / 2, H / 2, scale=(860 / cl.height) * (0.94 + 0.08 * t / T) * ease_out_back(t / 0.35), rot=4 * math.sin(t * 1.4))
    parts = [("30", 930, 300, 0.12, False), ("가지", 900, 150, 0.12, False), ("이상의", 900, 150, 0.9, True), ("색상", 900, 150, 1.55, True)]
    layers = [(text_layer(s, w, z, WHITE, shadow=True), t0, gap) for s, w, z, t0, gap in parts]
    total = sum(l.width - 80 + (40 if gap else 0) for l, _, gap in layers)
    x = W / 2 - total / 2
    for l, t0, gap in layers:
        if gap:
            x += 40
        pop_text(c, l, x - 40, H / 2 + (0 if l.height > 300 else 50), t, t0, anchor="l")
        x += l.width - 80
    return c


def s10_colorful(t, T):
    c = yellow_bg().copy()
    ring = ASSETS["ring"]
    spots = [(7, -620, -260, 3.2), (6, 700, -120, 3.6), (2, -760, 300, 2.6), (3, 120, 330, 4.2), (5, 560, 380, 2.4), (1, -150, -420, 2.2)]
    for idx, dx, dy, sc in spots:
        drift = 60 * t
        blit(c, ring[idx]["img"], W / 2 + dx + (drift if dx > 0 else -drift), H / 2 + dy, scale=sc * (1 + 0.15 * t), rot=10 * math.sin(t * 2 + idx))
    blit(c, text_layer("Colorful", "en", 220, WHITE, shadow=True), W / 2, H / 2, scale=0.55 + 1.4 * ease_in_out(t / T), alpha=clamp01(t / 0.1))
    return c


def s11_sit(t, T):
    if t < 1.55:
        c = live("D", 1.55)
        pop_text(c, text_layer("어떻게 앉아도", 900, 104, WHITE, shadow=True), W / 2, H / 2 - 60, t, 0.1)
    else:
        u = t - 1.55
        c = live("E", T - 1.55)
        lay = text_layer("즐겁다", 920, 118, WHITE, shadow=True)
        if u > 0.25:
            for dx in (-560, 560):
                blit(c, lay, W / 2 + dx, H / 2 - 40, scale=0.82, alpha=0.35 * clamp01((u - 0.25) / 0.15))
        pop_text(c, lay, W / 2, H / 2 - 40, u, 0.06)
    return c


def s12_durable(t, T):
    c = live("H", T)                                  # 아이가 팟 위에서 뛰어도 멀쩡하다
    lay = text_layer("Durable", "en", 200, WHITE, shadow=True)
    k = ease_out_cubic(t / 0.25)
    x = W / 2 - 700 * (1 - k)
    if k < 0.98:                                      # 들어올 때만 가로 잔상
        for i in range(1, 5):
            blit(c, lay, x - i * 45 * (1 - k), H / 2, alpha=0.18)
    blit(c, lay, x, H / 2)
    return c


def s13_light_conform(t, T):
    if t < 1.15:                                      # 한 손으로 번쩍 드는 팟 — 4.7kg
        c = live("I", 1.15)
        pop_text(c, text_layer("Super Light", "en", 150, WHITE, shadow=True), W / 2, H / 2 - 60, t, 0.12)
    else:                                             # 기대는 순간 몸 모양대로 감싸는 팟
        u = t - 1.15
        c = live("J", T - 1.15)
        pop_text(c, text_layer("Conforming to the body", "en", 92, WHITE, shadow=True), W / 2, 190, u, 0.05, grow=False)
    return c


def s14_soft(t, T):
    c = live("F", T)
    pop_text(c, text_layer("Soft", "en", 190, WHITE, shadow=True), W / 2, H / 2, t, 0.1)
    return c


def s15_heal(t, T):
    c = live("G", T)
    pop_text(c, text_layer("몸과 마음을", 820, 70, WHITE, shadow=True), 120, 400, t, 0.05, anchor="l", grow=False)
    pop_text(c, text_layer("힐링하다", 920, 124, WHITE, shadow=True), 120, 500, t, 0.2, anchor="l", grow=False)
    return c


def s16_rest(t, T):
    c = yellow_bg().copy()
    parts = [("휴식 할", INK, 0.0), ("땐", INK, 0.35), ("요기보", TEAL, 0.7)]
    lays = [(text_layer(s, 820, 100, col), t0) for s, col, t0 in parts]
    total = sum(l.width - 80 for l, _ in lays) + 30 * (len(lays) - 1)
    x = W / 2 - total / 2
    for l, t0 in lays:
        if t >= t0:
            k = ease_out_cubic((t - t0) / 0.22)
            blit(c, l, x + (l.width - 80) / 2, H / 2 + 20 * (1 - k), alpha=k)
        x += l.width - 80 + 30
    return c


def s17_discover(t, T):
    c = yellow_bg().copy()
    u = t / T
    s = math.exp(math.log(46) * u ** 2.2)
    blit(c, text_layer("Discover the Feel", "en", 64, GREEN), W / 2 + 40 * (s - 1), H / 2, scale=s)
    if u > 0.82:
        c = Image.blend(c, Image.new("RGBA", (W, H), (255, 255, 255, 255)), clamp01((u - 0.82) / 0.18))
    return c


def s18_logo(t, T):
    c = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    k = ease_out_cubic(t / 0.45)
    blit(c, ASSETS["logo"], W / 2, H / 2, scale=0.95 * (0.9 + 0.1 * k), alpha=k)
    return c


SCENES = [s01_intro, s02_titles, s03_pot, s04_beanbag, s05_flash, s06_office, s07_game, s08_read, s09_colors,
          s10_colorful, s11_sit, s12_durable, s13_light_conform, s14_soft, s15_heal, s16_rest, s17_discover, s18_logo]


def scene_at(t):
    return max(k for k in range(len(SCENES)) if B[k] <= t + 1e-6)


def render_stills(times, out_prefix):
    """확인용 — 지정한 시각의 프레임만 PNG 로 뽑는다(실사 구간 제외 권장)."""
    load_assets()
    for t in times:
        i = scene_at(t)
        SCENES[i](t - B[i], B[i + 1] - B[i]).convert("RGB").save(f"{out_prefix}_{t:05.2f}.jpg", quality=88)
        for k in list(READERS):
            READERS.pop(k).close()


def main(out):
    load_assets()
    n_total = round(B[-1] * FPS)
    tmp = out.replace(".mp4", "_noaudio.mp4")
    enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                            "-r", f"{FPS_NUM}/{FPS_DEN}", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "17",
                            "-pix_fmt", "yuv420p", tmp], stdin=subprocess.PIPE)
    for f in range(n_total):
        t = f / FPS
        i = scene_at(t)
        enc.stdin.write(SCENES[i](t - B[i], B[i + 1] - B[i]).convert("RGB").tobytes())
        if f % 48 == 0:
            print(f"{t:5.1f}s / {B[-1]}s", flush=True)
    enc.stdin.close()
    enc.wait()
    for k in list(READERS):
        READERS.pop(k).close()
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-i", os.path.join(A, "ref_pod33_audio.m4a"),
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
                    "-movflags", "+faststart", out], check=True)
    os.remove(tmp)
    print("완료 ->", out)


if __name__ == "__main__":
    main(sys.argv[1])
