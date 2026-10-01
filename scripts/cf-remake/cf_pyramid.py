"""
요기보 피라미드 CF 리메이크 — 35.28초 전체를 한 번에 렌더링한다.

구간 시각은 레퍼런스(요기보 피라미드 35초 · 18컷) 장면 전환 실측이라 회사 원본 음원 박자와 그대로 맞는다.
화면은 요즘 톤으로 바꿨다(사용자 요청 2026-09-30): 네온 삼각 터널 · 무지개 블롭 · 3D 미끄럼틀 · 이모지 대신
단색 컬러블록 배경 + Pretendard 한 가지 서체의 키네틱 타이포 + 제품이 '툭' 떨어져 말랑하게 튀는 모션.
레퍼런스에 없던 모델 연출은 실사 11컷(Seedance 2.5)으로 넣었다 — 피라미드는 아이에게 딱 맞는 크기라 아이 위주.

제품 컷아웃은 노란 배경(#F9DB06)으로 뽑아 여기서 빼낸다. 모양 기준은 이관 컷(cand_pyramid_*)의
'말랑한 삼각뿔' — DB 형태 설명(양파 돔)은 틀렸다.

사용: python cf_pyramid.py <출력.mp4> [자산폴더]
"""
import math, os, random, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cf_full import (W, H, clamp01, ease_out_back, ease_out_cubic, ease_in_out,  # noqa: E402
                     text_layer, blit, trim_alpha, pop_text)

FPS = 30
A = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))

CREAM, INK, WHITE = (246, 241, 231), (22, 22, 26), (255, 255, 255)
PINK, MINT, LILAC = (239, 0, 102), (47, 224, 200), (217, 204, 245)
BLUSH, SKY, SAFFRON = (246, 190, 206), (196, 226, 243), (245, 184, 46)

# 레퍼런스 장면 전환 실측(초) — 음원 박자와 맞는 자리
B = [0, 0.7, 1.6, 2.5, 4.5, 5.6, 7.167, 8.3, 9.967, 12.0, 13.633, 14.933, 17.2,
     20.167, 21.033, 21.3, 22.567, 23.6, 25.2, 27.233, 29.3, 31.5, 32.4, 35.283]

# 실사 클립: (파일, 시작 오프셋) — 클립마다 가장 좋은 구간을 골라 넣는다
CLIPS = {
    "tok": ("p_tok.mp4", 1.4), "size": ("p_size.mp4", 2.3), "relax": ("p_relax.mp4", 1.2),
    "q1": ("p_q1.mp4", 1.0), "q2": ("p_q2.mp4", 1.8), "q3": ("p_q3.mp4", 0.5), "q4": ("p_q4.mp4", 0.8),
    "attach": ("p_attach.mp4", 0.5), "durable": ("p_durable.mp4", 0.6),
    "colors": ("p_colors.mp4", 0.2), "rest": ("p_rest.mp4", 0.3),
}


# ── 기본 도구 ─────────────────────────────────────────────
def solid(rgb):
    return Image.new("RGBA", (W, H), rgb + (255,))


def ease_in(x):
    x = clamp01(x)
    return x * x


def blit_squash(canvas, img, cx, bottom, height, sx=1.0, sy=1.0, rot=0.0, alpha=1.0):
    """바닥(bottom) 기준으로 세워 얹는다. 착지 때 눌렸다 튀는 모양을 sx·sy 로 만든다."""
    if height <= 2 or alpha <= 0.01:
        return
    k = height / img.height
    w, h = max(1, int(img.width * k * sx)), max(1, int(img.height * k * sy))
    part = img.resize((w, h), Image.LANCZOS)
    if rot:
        part = part.rotate(rot, resample=Image.BICUBIC, expand=True)
    if alpha < 1:
        part.putalpha(part.getchannel("A").point(lambda v: int(v * alpha)))
    x0, y0 = int(cx - part.width / 2), int(bottom - part.height)
    if x0 >= W or y0 >= H or x0 + part.width <= 0 or y0 + part.height <= 0:
        return                                              # 아직 화면 밖(떨어지기 전)
    canvas.alpha_composite(part, (max(0, x0), max(0, y0)),
                           (max(0, -x0), max(0, -y0)))


def drop_pose(u, fall=0.3):
    """떨어져서 '툭' 착지하고 말랑하게 튀는 동안의 (높이 비율 0~1, sx, sy)."""
    if u < fall:
        return 1 - ease_in(u / fall), 0.92, 1.08            # 떨어지는 중: 살짝 길쭉
    v = u - fall
    wob = math.exp(-7 * v) * math.cos(20 * v)               # 눌림 → 되튐 → 가라앉음
    return 0.0, 1 + 0.22 * wob, 1 - 0.2 * wob


def soft_shadow(canvas, cx, y, w, alpha=0.18):
    """바닥에 닿은 자리의 옅은 타원 그림자. 흐림이 판 가장자리에서 잘려 네모가 되지 않게 여백을 둔다."""
    ew, eh = int(w), max(2, int(w * 0.16))
    blur = eh / 3
    pad = int(blur * 3) + 2
    sh = Image.new("RGBA", (ew + 2 * pad, eh + 2 * pad), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((pad, pad, pad + ew - 1, pad + eh - 1), fill=(0, 0, 0, int(255 * alpha)))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    x0, y0 = int(cx - sh.width / 2), int(y - sh.height / 2)
    if x0 >= 0 and y0 >= 0 and x0 + sh.width <= W and y0 + sh.height <= H:
        canvas.alpha_composite(sh, (x0, y0))


def rounded_triangle(size, rgb, radius=0.12):
    """꼭짓점이 둥근 정삼각형 — 4배로 그려 줄여서 가장자리를 매끈하게."""
    S = size * 4
    im = Image.new("L", (S, S), 0)
    h = S * math.sqrt(3) / 2
    pts = [(S / 2, (S - h) / 2), (S, (S + h) / 2), (0, (S + h) / 2)]
    ImageDraw.Draw(im).polygon(pts, fill=255)
    im = im.filter(ImageFilter.GaussianBlur(S * radius / 3)).point(lambda v: 255 if v > 128 else 0)
    im = im.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), rgb + (255,))
    out.putalpha(im)
    return out


# ── 제품 컷아웃 ───────────────────────────────────────────
def key_yellow_soft(path):
    """노란 배경과 그 위 옅은 그림자까지 뺀다(원래 크기 유지). 피라미드 색 중 노랑은 없다."""
    src = Image.open(path).convert("RGB")
    hsv = np.asarray(src.convert("HSV")).astype(np.float32)
    hue, sat, val = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255, hsv[..., 2] / 255
    bg = (hue > 36) & (hue < 68) & (sat > 0.5) & (val > 0.3)
    alpha = Image.fromarray(((~bg) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    out = src.convert("RGBA")
    out.putalpha(alpha)
    return out


def recolor(base, rgb):
    """원형 피라미드 한 장의 명암(그림자·하이라이트·솔기)은 그대로 두고 색만 입힌다.
    모든 색이 같은 모양이 된다 — 색마다 따로 생성하면 파이거나 기우는 등 모양이 흔들렸다."""
    a = np.asarray(base).astype(np.float32)
    lum = (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]) / 255
    solid_px = a[..., 3] > 200
    ref = float(np.median(lum[solid_px])) if solid_px.any() else 0.7
    shade = np.clip(lum / max(ref, 1e-3), 0, 1.6)[..., None]
    col = np.array(rgb, np.float32)[None, None, :]
    out = np.where(shade <= 1, col * shade, col + (255 - col) * (shade - 1) / 0.6 * 0.55)
    out = np.clip(out, 0, 255)
    return Image.fromarray(np.dstack([out, a[..., 3:4]]).astype(np.uint8), "RGBA")


PYR_COLORS = {
    "pink": (239, 0, 102), "green": (122, 201, 67), "blue": (36, 56, 216), "mint": (47, 224, 200),
    "lavender": (184, 156, 240), "cherry": (121, 6, 25), "charcoal": (58, 61, 64), "greige": (189, 178, 166),
    "blush": (229, 185, 200), "sky": (190, 221, 239), "peach": (247, 169, 135), "navy": (31, 42, 90),
    "lilac": (201, 182, 228),
}

ASSETS = {}


def load_assets():
    # 제품은 전부 이관 컷(cand_pyramid_blossompink_b_jp1)의 피라미드를 원형 그대로 떼어낸 한 장에서 나온다(사용자 요청 2026-10-01)
    base = trim_alpha(key_yellow_soft(os.path.join(A, "pyr_base.png")))
    for name, rgb in PYR_COLORS.items():
        ASSETS[name] = recolor(base, rgb)
    ASSETS["hero_pink"], ASSETS["hero_mint"], ASSETS["hero_stripe"] = ASSETS["pink"], ASSETS["mint"], ASSETS["navy"]
    g = Image.open(os.path.join(A, "giza.png")).convert("RGBA")
    ASSETS["giza"] = g.resize((W, int(g.height * W / g.width)), Image.LANCZOS).crop((0, 0, W, H))
    ASSETS["logo"] = Image.open(os.path.join(A, "yogibo_logo3_on.png")).convert("RGBA")
    ASSETS["tri"] = rounded_triangle(760, WHITE)
    rnd = random.Random(7)
    ASSETS["beads"] = [(rnd.uniform(0.05, 0.95), rnd.uniform(0, 1), rnd.uniform(9, 26), rnd.uniform(0.25, 0.7))
                       for _ in range(34)]
    ASSETS["burst"] = [(rnd.uniform(0, 2 * math.pi), rnd.uniform(0.55, 1.15), rnd.uniform(-160, 160), rnd.choice(
        ["pink", "blue", "mint", "green", "lavender", "cherry", "charcoal", "navy", "blush", "sky", "peach", "lilac"]))
        for _ in range(16)]


# ── 실사 클립 읽기 ────────────────────────────────────────
class ClipReader:
    def __init__(self, key, dur, size):
        src, off = CLIPS[key]
        w, h = size
        self.size = size
        self.p = subprocess.Popen(["ffmpeg", "-loglevel", "quiet", "-ss", str(off), "-i", os.path.join(A, src), "-t", str(dur + 0.3),
                                   "-vf", f"fps={FPS},scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},setsar=1",
                                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
        self.last = None

    def frame(self):
        w, h = self.size
        buf = self.p.stdout.read(w * h * 3)
        if len(buf) == w * h * 3:
            self.last = Image.frombytes("RGB", (w, h), buf).convert("RGBA")
        return self.last.copy() if self.last else Image.new("RGBA", (w, h), (0, 0, 0, 255))

    def close(self):
        try:
            self.p.stdout.close()
            self.p.kill()
        except Exception:
            pass


READERS = {}


def live(key, scene_dur, size=(W, H)):
    """장면 안에서 여러 클립을 동시에 읽을 수 있다(4분할). 장면이 바뀌면 close_readers 로 닫는다."""
    if key not in READERS:
        READERS[key] = ClipReader(key, scene_dur, size)
    return READERS[key].frame()


def close_readers():
    for k in list(READERS):
        READERS.pop(k).close()


def caption(c, text, t, t0, y=H - 250, size=112, weight=860):
    """실사 위 가운데 아래 자막 — 흰 글자 + 옅은 그림자, 톡 튀어나온다."""
    pop_text(c, text_layer(text, weight, size, WHITE, shadow=True), W / 2, y, t, t0)


# ── 장면들 (t 는 장면 안 시각, T 는 장면 길이) ────────────
def s_intro(t, T):
    c = solid(CREAM)
    k = ease_out_cubic(t / 0.35)
    blit(c, text_layer("The Disruptive Furniture", 700, 64, INK), W / 2, H / 2 + 30 * (1 - k), alpha=k)
    return c


def s_logo(t, T):
    c = solid(LILAC)
    lg = ASSETS["logo"]
    blit(c, lg, W / 2, H / 2, scale=1.25 * ease_out_back(t / 0.4), alpha=clamp01(t / 0.12))
    return c


def s_title(t, T):
    c = solid(BLUSH)
    pod = ASSETS["hero_pink"]
    h, sx, sy = drop_pose(t, 0.22)
    bottom = H / 2 + 250 - h * 900
    soft_shadow(c, W / 2, H / 2 + 250, 420 * (1 - 0.5 * h))
    blit_squash(c, pod, W / 2, bottom, 480, sx, sy, rot=6 * math.sin(t * 3))
    spots = [("피", 380, 300, 0.30), ("라", W - 380, 300, 0.42), ("미", 380, H - 300, 0.54), ("드", W - 380, H - 300, 0.66)]
    for s, x, y, t0 in spots:
        pop_text(c, text_layer(s, 930, 300, INK), x, y, t, t0, dur=0.22)
    return c


PALETTE3 = [("pink", W / 2 - 520), ("green", W / 2), ("blue", W / 2 + 520)]


def three_drop(c, t, starts, ground=H - 170, size=380):
    for (name, x), t0 in zip(PALETTE3, starts):
        if t < t0:
            continue
        h, sx, sy = drop_pose(t - t0)
        soft_shadow(c, x, ground, 330 * (1 - 0.6 * h), 0.16)
        blit_squash(c, ASSETS[name], x, ground - h * 1100, size, sx, sy)


def s_drop(t, T):
    c = solid((198, 240, 231))
    three_drop(c, t, (0.05, 0.55, 1.05))
    return c


def s_cute(t, T):
    c = solid((198, 240, 231))
    three_drop(c, t + 10, (0, 0, 0))                        # 이미 내려앉은 상태
    pop_text(c, text_layer("Extremely Cute!", 880, 150, INK), W / 2, 280, t, 0.05, dur=0.3)
    if t > T - 0.35:                                        # 마지막: 가운데 초록이 화면으로 튀어 다음 장면으로
        u = (t - (T - 0.35)) / 0.35
        blit(c, ASSETS["green"], W / 2, H - 360 - 200 * u, scale=(380 / ASSETS["green"].height) * (1 + 5 * ease_in(u)))
    return c


def s_tok(t, T):
    c = live("tok", T)
    pop_text(c, text_layer("귀여움이", 820, 76, WHITE, shadow=True), W / 2 - 150, H - 250, t, 0.1, grow=False)
    pop_text(c, text_layer("톡", 950, 190, (122, 201, 67), shadow=True), W / 2 + 170, H - 265, t, 0.62, dur=0.25)
    return c


def s_size(t, T):
    c = live("size", T)
    caption(c, "앙증맞은 사이즈", t, 0.08)
    return c


def s_relax(t, T):
    c = live("relax", T)
    caption(c, "Super Relaxing", t, 0.1, size=120, weight=880)
    return c


def s_quad(t, T):
    c = solid(WHITE)
    for key, (x, y) in zip(("q1", "q2", "q3", "q4"), ((0, 0), (W // 2, 0), (0, H // 2), (W // 2, H // 2))):
        c.alpha_composite(live(key, T, (W // 2, H // 2)), (x, y))
    lay = text_layer("마음까지 힐링하는", 880, 104, WHITE, shadow=True)
    pop_text(c, lay, W / 2, H / 2, t, 0.12)
    return c


def s_attach(t, T):
    c = live("attach", T)
    pop_text(c, text_layer("애착소파", 950, 170, (201, 64, 170), shadow=False), W / 2, 190, t, 0.06, dur=0.3)
    return c


def s_durable(t, T):
    c = live("durable", T)
    lay = text_layer("So Durable!", 900, 150, WHITE, shadow=True)
    k = ease_out_cubic(t / 0.22)
    x = W / 2 - 700 * (1 - k)
    if k < 0.98:
        for i in range(1, 4):
            blit(c, lay, x - i * 50 * (1 - k), 200, alpha=0.18)
    blit(c, lay, x, 200)
    return c


def s_patent(t, T):
    c = solid((236, 229, 250))
    hero = ASSETS["hero_pink"]
    for bx, by, r, sp in ASSETS["beads"]:                    # 속을 채운 비즈가 천천히 떠오른다
        y = ((by - sp * t / T * 0.6) % 1.0) * (H + 80) - 40
        d = Image.new("RGBA", (int(r * 2), int(r * 2)), (0, 0, 0, 0))
        ImageDraw.Draw(d).ellipse((0, 0, r * 2 - 1, r * 2 - 1), fill=(255, 255, 255, 235))
        c.alpha_composite(d, (int(W * (0.45 + 0.5 * bx) - r), int(y - r)))
    blit(c, hero, W * 0.66, H / 2 + 20, scale=(820 / hero.height) * (0.94 + 0.08 * t / T) * ease_out_back(t / 0.35),
         rot=10 * math.sin(t * 1.3))
    lay = text_layer("특허기반의 기술력", 880, 92, INK)
    pop_text(c, lay, 170, H / 2, t, 0.25, anchor="l", grow=False)
    return c


def zoom_on(img, s, fx, fy):
    """(fx, fy) 비율 지점을 중심으로 s 배 당긴다 — 원본이 넓게 찍힌 컷용."""
    w, h = img.width / s, img.height / s
    x0 = min(max(fx * img.width - w / 2, 0), img.width - w)
    y0 = min(max(fy * img.height - h / 2, 0), img.height - h)
    return img.crop((int(x0), int(y0), int(x0 + w), int(y0 + h))).resize((img.width, img.height), Image.LANCZOS)


def s_colors(t, T):
    c = zoom_on(live("colors", T), 1.3 + 0.05 * t / T, 0.46, 0.6)   # 방이 넓게 찍혀 아이와 피라미드를 당겨 보인다
    pop_text(c, text_layer("30가지 이상의", 820, 70, WHITE, shadow=True), W / 2, 150, t, 0.15, grow=False)
    pop_text(c, text_layer("HOT Colors", 950, 150, WHITE, shadow=True), W / 2, 255, t, 0.35, dur=0.3)
    return c


def brand_card(bg, sprite, t, grow_from=0.0):
    c = solid(bg)
    tri = ASSETS["tri"]
    blit(c, tri, W / 2, H / 2 + 40, scale=0.96 + 0.04 * math.sin(t * 4))
    k = ease_out_back((t - grow_from) / 0.35) if t >= grow_from else 0
    blit(c, sprite, W / 2, H / 2 + 110, scale=(360 / sprite.height) * k, rot=5 * math.sin(t * 3))
    blit(c, ASSETS["logo"], 330, H / 2, scale=1.0)
    blit(c, text_layer("Pyramid", 900, 120, WHITE, shadow=True), W - 380, H / 2)
    return c


def s_brand1(t, T):
    return brand_card(SAFFRON, ASSETS["hero_pink"], t, 0.05)


def s_flash(rgb):
    def f(t, T):
        return solid(rgb)
    return f


def s_brand2(t, T):
    zoom_at = T - 0.23
    if t < zoom_at:
        return brand_card((200, 186, 240), ASSETS["hero_stripe"], t, 0.02)
    u = (t - zoom_at) / 0.23                                 # 줄무늬 원단 속으로 확 파고든다
    c = brand_card((200, 186, 240), ASSETS["hero_stripe"], zoom_at)
    s = math.exp(math.log(9) * ease_in(u))
    return c.resize((int(W * s), int(H * s)), Image.BILINEAR).crop(
        (int((W * s - W) / 2), int((H * s - H) / 2 + 110 * (s - 1)), int((W * s + W) / 2), int((H * s + H) / 2 + 110 * (s - 1))))


def s_brand3(t, T):
    if t > T - 0.3:
        return solid(MINT)
    return brand_card(BLUSH, ASSETS["hero_mint"], t, 0.04)


def s_small(t, T):
    c = solid(CREAM)
    pop_text(c, text_layer("작지만", 900, 150, INK), W / 2, H / 2 - 100, t, 0.05, grow=False)
    pop_text(c, text_layer("편안함은", 900, 150, PINK), W / 2, H / 2 + 100, t, 0.45, grow=False)
    return c


def s_bigger(t, T):
    c = ASSETS["giza"].copy()
    hero = ASSETS["hero_mint"]
    rise = ease_out_cubic(t / 1.4)                          # 피라미드 뒤에서 거대한 민트 피라미드가 솟는다
    blit_squash(c, hero, W * 0.68, H * 0.86, 520 + 700 * rise)
    blit(c, text_layer("더", 820, 110, WHITE, shadow=True), 190, 330)
    if t > 0.25:
        bar = min(1.0, (t - 0.25) / 0.5)
        ImageDraw.Draw(c).rounded_rectangle((260, 322, 260 + int(260 * bar), 338), radius=8, fill=WHITE)
    pop_text(c, text_layer("욱", 820, 110, WHITE, shadow=True), 590, 330, t, 0.75, grow=False)
    lay = text_layer("크게", 950, 190, WHITE, shadow=True)
    if t > 1.0:
        blit(c, lay, 900, 320, scale=0.6 + 0.4 * ease_out_back((t - 1.0) / 0.4))
    return c


def s_burst(t, T):
    c = solid((238, 232, 250))
    if t < 0.6:                                             # 가운데서 사방으로 터져 나온다
        u = ease_out_cubic(t / 0.6)
        for ang, dist, spin, name in ASSETS["burst"]:
            sp = ASSETS[name]
            x = W / 2 + math.cos(ang) * dist * 900 * u
            y = H / 2 + math.sin(ang) * dist * 520 * u
            blit(c, sp, x, y, scale=(170 / sp.height) * (0.4 + 0.9 * u), rot=spin * u)
    else:                                                   # 로즈핑크가 꼬리를 달고 왼쪽으로 날아간다
        u = (t - 0.6) / (T - 0.6)
        hero = ASSETS["hero_pink"]
        x = W + 300 - (W + 900) * ease_in_out(u)
        for i, name in enumerate(("blue", "mint", "lavender", "charcoal", "sky")):
            sp = ASSETS[name]
            blit(c, sp, x + 330 + i * 120, H / 2 + 40 * math.sin(i + t * 6), scale=70 / sp.height, rot=40 * t + i * 30)
        blit(c, hero, x, H / 2, scale=420 / hero.height, rot=-12 + 8 * math.sin(t * 5))
    return c


def s_rest(t, T):
    c = live("rest", T)
    lay = text_layer("휴식이 필요할 땐", 860, 104, WHITE, shadow=True)
    pop_text(c, lay, W / 2, H - 230, t, 0.7, grow=False)
    return c


def s_discover(t, T):
    c = solid(CREAM)
    k = ease_out_cubic(t / 0.3)
    blit(c, text_layer("Discover the Feel", 780, 104, INK), W / 2, H / 2 + 24 * (1 - k), alpha=k)
    return c


def s_end(t, T):
    c = solid(WHITE)
    k = ease_out_cubic(t / 0.45)
    blit(c, ASSETS["logo"], W / 2, H / 2, scale=1.35 * (0.9 + 0.1 * k), alpha=k)
    return c


SCENES = [s_intro, s_logo, s_title, s_drop, s_cute, s_tok, s_size, s_relax, s_quad, s_attach, s_durable,
          s_patent, s_colors, s_brand1, s_flash(PINK), s_brand2, s_brand3, s_small, s_bigger, s_burst,
          s_rest, s_discover, s_end]
assert len(SCENES) == len(B) - 1


def scene_at(t):
    return max(k for k in range(len(SCENES)) if B[k] <= t + 1e-6)


def render_stills(times, out_prefix):
    """확인용 — 지정한 시각의 프레임만 뽑는다(실사 구간은 클립 첫 프레임이 나온다)."""
    load_assets()
    for t in times:
        i = scene_at(t)
        SCENES[i](t - B[i], B[i + 1] - B[i]).convert("RGB").save(f"{out_prefix}_{t:05.2f}.jpg", quality=88)
        close_readers()


def main(out):
    load_assets()
    n_total = round(B[-1] * FPS)
    tmp = out.replace(".mp4", "_noaudio.mp4")
    enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                            "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "17",
                            "-pix_fmt", "yuv420p", tmp], stdin=subprocess.PIPE)
    cur = -1
    for f in range(n_total):
        t = f / FPS
        i = scene_at(t)
        if i != cur:
            close_readers()
            cur = i
        enc.stdin.write(SCENES[i](t - B[i], B[i + 1] - B[i]).convert("RGB").tobytes())
        if f % 60 == 0:
            print(f"{t:5.1f}s / {B[-1]}s", flush=True)
    enc.stdin.close()
    enc.wait()
    close_readers()
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-i", os.path.join(A, "pyr_audio.m4a"),
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
                    "-movflags", "+faststart", out], check=True)
    os.remove(tmp)
    print("완료 ->", out)


if __name__ == "__main__":
    main(sys.argv[1])
