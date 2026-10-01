"""
요기보 맥스 CF 리메이크 — 36.94초 전체를 한 번에 렌더링한다 (리메이크 3탄, 팟·피라미드 다음).

구간 시각은 레퍼런스(유튜브 「전세계가 반한 마법의 소파, Yogibo!」 36.94초 · 30컷) 장면 전환 실측이라
회사 원본 음원 박자와 그대로 맞는다. 화면 톤은 피라미드 리메이크와 같다(사용자 요청 2026-10-01 「피라미드 느낌으로」):
단색 컬러블록 + Pretendard 키네틱 타이포 + 제품이 톡 떨어져 말랑하게 튀는 모션.

맥스 모양·크기가 틀리면 안 된다(사용자가 여러 번 짚었다) — 그래서
  · 제품 그림은 레퍼런스 속 공식 CG 를 떼어내(max_sprite_*.png) 코드로 색만 입힌다.
  · 모델 실사는 이관 컷(맥스 크기가 정확한 원본)을 16:9 로 넓혀 영상화했거나, 크기 측정을 통과한 컷만 쓴다.
스톡 영상이던 우주비행사 → 구름 위 무중력(여성D), 컬러 파우더 → 컬러 맥스가 터져 나오는 코드 모션으로 바꿨다.

v1.1 (사용자 요청 2026-10-01 「역동적인 컨셉으로」): 흰 스튜디오에 가만히 앉아 있던 의자·리클라이너·침대·힐링 컷을
버리고, 크게 움직이는 거실 장면으로 바꿨다(의자에서 다리를 차올리며 털썩, 리클라이너에서 기지개, 러그 위에 드러눕기).
소파&침대 자리는 아이들이 맥스에 앉아 게임하며 신나는 장면.
첫 프레임은 오려 붙이지 않는다 — 합성은 배경과 사람이 따로 노는 티가 났다(사용자 지적). 맥스 크기가 정확한 이관 컷
자체를 nano_banana_pro 로 편집해 배경을 거실로 바꾼 한 장으로 만들었다(사람·맥스·배경을 한 번에 그림).

사용: python cf_max.py <출력.mp4> [자산폴더]
"""
import math, os, random, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cf_full import (W, H, clamp01, ease_out_back, ease_out_cubic, ease_in_out,  # noqa: E402
                     text_layer, blit, trim_alpha, pop_text)
from cf_pyramid import solid, ease_in, blit_squash, drop_pose, soft_shadow, recolor  # noqa: E402

FPS_NUM, FPS_DEN = 24000, 1001
FPS = FPS_NUM / FPS_DEN
A = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))

CREAM, INK, WHITE = (246, 241, 231), (22, 22, 26), (255, 255, 255)
LILAC, BLUSH, MINT, SKY = (217, 204, 245), (246, 190, 206), (198, 240, 231), (206, 228, 247)
AQUA = (0, 117, 189)

# 맥스 18색 (DB products.Max.colors)
MAX_COLORS = {
    "aqua": (0, 117, 189), "navy": (29, 57, 93), "olive": (102, 139, 1), "darkgrey": (53, 59, 62),
    "lightgrey": (168, 155, 142), "choco": (88, 62, 48), "cherry": (121, 6, 25), "wine": (122, 3, 31),
    "coral": (234, 61, 25), "orange": (238, 120, 12), "yellow": (235, 205, 0), "rose": (239, 0, 102),
    "blossom": (229, 185, 200), "purple": (100, 77, 154), "deeppurple": (95, 42, 56), "lavender": (205, 167, 219),
    "pastelblue": (190, 221, 239), "mint": (176, 238, 231),
}

# 레퍼런스 장면 전환 실측(초) — 음원 박자와 맞는 자리
B = [0, 2.461, 2.961, 4.087, 4.546, 5.088, 8.050, 8.759, 10.344, 11.136, 12.262, 12.679, 13.639, 14.306,
     15.390, 17.100, 17.893, 19.269, 19.978, 20.729, 21.522, 22.231, 22.731, 24.024, 24.441, 25.901,
     27.361, 28.654, 30.447, 33.600, 35.100, 36.943]

# 실사 클립: (파일, 시작 오프셋) — 클립마다 가장 좋은 구간을 골라 넣는다
CLIPS = {
    "topWD": ("x_topWD.mp4", 1.0), "topWB": ("x_topWB.mp4", 1.2), "kids": ("x_kids.mp4", 1.5),
    "fabric": ("x_fabric.mp4", 0.9), "chair": ("x_one_chair.mp4", 0.5), "recl": ("x_one_recl.mp4", 0.8),
    "bed": ("x_dyn_kids.mp4", 2.85), "lift": ("x_lift.mp4", 1.0), "zero": ("x_zero.mp4", 0.8),
    "tiredE": ("m_office_e.mp4", 2.3), "tiredB": ("m_office_b.mp4", 2.6), "heal": ("x_one_rug.mp4", 1.8),
    "fashion": ("x_one_recl.mp4", 2.0),
}


# ── 제품 그림 ─────────────────────────────────────────────
ASSETS = {}
_TINT = {}


def sprite(shape, color):
    """공식 CG 맥스(shape: lying·upright·chair·recliner·bed·tilt)에 color 를 입힌 것. 한 번 만들면 재사용."""
    key = (shape, color)
    if key not in _TINT:
        _TINT[key] = recolor(ASSETS[shape], MAX_COLORS[color])
    return _TINT[key]


def grad_text(text, weight, size, stops):
    """글자 모양대로 가로 그라데이션을 채운 레이어 (Colorful·Transforming 용)."""
    lay = text_layer(text, weight, size, WHITE)
    w, h = lay.size
    xs = np.linspace(0, 1, w)
    cols = np.zeros((w, 3), np.float32)
    for i in range(len(stops) - 1):
        a, b = i / (len(stops) - 1), (i + 1) / (len(stops) - 1)
        m = (xs >= a) & (xs <= b)
        t = ((xs[m] - a) / (b - a))[:, None]
        cols[m] = np.array(stops[i]) * (1 - t) + np.array(stops[i + 1]) * t
    img = np.broadcast_to(cols[None, :, :], (h, w, 3)).astype(np.uint8)
    out = Image.fromarray(np.ascontiguousarray(img), "RGB").convert("RGBA")
    out.putalpha(lay.getchannel("A"))
    return out


RAINBOW = [(255, 84, 104), (255, 170, 60), (255, 226, 70), (80, 214, 130), (70, 170, 255), (170, 110, 255)]


def load_assets():
    for shape in ("lying", "upright", "chair", "recliner", "bed", "tilt"):
        ASSETS[shape] = trim_alpha(Image.open(os.path.join(A, f"max_sprite_{shape}.png")).convert("RGBA"))
    ASSETS["logo"] = Image.open(os.path.join(A, "yogibo_logo3_on.png")).convert("RGBA")
    rnd = random.Random(11)
    names = list(MAX_COLORS)
    ASSETS["burst"] = [(rnd.uniform(0, 2 * math.pi), rnd.uniform(0.55, 1.2), rnd.uniform(-200, 200),
                        rnd.choice(("lying", "tilt")), names[i % len(names)]) for i in range(22)]
    ASSETS["fly"] = [(rnd.uniform(-0.2, 1.2), rnd.uniform(-0.3, 1.3), rnd.uniform(0.5, 1.1), rnd.uniform(-40, 40),
                      rnd.choice(("lying", "tilt")), names[(i * 5) % len(names)]) for i in range(16)]


# ── 실사 클립 읽기 ────────────────────────────────────────
class ClipReader:
    def __init__(self, key, dur, size):
        src, off = CLIPS[key]
        w, h = size
        self.size = size
        self.p = subprocess.Popen(["ffmpeg", "-loglevel", "quiet", "-ss", str(off), "-i", os.path.join(A, src), "-t", str(dur + 0.3),
                                   "-vf", f"fps={FPS_NUM}/{FPS_DEN},scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h},setsar=1",
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
    if key not in READERS:
        READERS[key] = ClipReader(key, scene_dur, size)
    return READERS[key].frame()


def close_readers():
    for k in list(READERS):
        READERS.pop(k).close()


def caption(c, text, t, t0, y=H - 230, size=112, weight=880, grow=True):
    pop_text(c, text_layer(text, weight, size, WHITE, shadow=True), W / 2, y, t, t0, grow=grow)


def card(bg, text, t, color=INK, size=190, weight=930, shape=None, tint="aqua"):
    """글자 카드 — 단색 바탕에 큰 글자가 톡. shape 를 주면 그 모양의 맥스가 아래에서 말랑하게 떨어진다."""
    c = solid(bg)
    pop_text(c, text_layer(text, weight, size, color), W / 2, H / 2 - (150 if shape else 0), t, 0.02, dur=0.26)
    if shape:
        sp = sprite(shape, tint)
        h, sx, sy = drop_pose(t, 0.18)
        soft_shadow(c, W / 2, H - 110, 420 * (1 - 0.5 * h), 0.14)
        blit_squash(c, sp, W / 2, H - 110 - h * 700, 400, sx, sy)
    return c


# ── 장면들 (t 는 장면 안 시각, T 는 장면 길이) ────────────
def s_intro(t, T):
    c = solid(CREAM)
    sp = sprite("lying", "navy")                                       # 레퍼런스 첫 컷처럼 구석에 걸친 큰 맥스
    blit(c, sp, 330 + 40 * t, H - 120 - 10 * t, scale=1500 / sp.width, rot=18 - 3 * t)
    k = ease_out_cubic(t / 0.35)
    blit(c, text_layer("The Disruptive Furniture", 800, 92, INK), W / 2 + 60, H / 2 - 60 + 30 * (1 - k), alpha=k)
    return c


def s_logo(t, T):
    c = solid(LILAC)
    blit(c, ASSETS["logo"], W / 2, H / 2, scale=1.25 * ease_out_back(t / 0.4), alpha=clamp01(t / 0.12))
    return c


def s_hero(t, T):
    c = solid(SKY)
    sp = sprite("lying", "aqua")
    h, sx, sy = drop_pose(t, 0.24)
    soft_shadow(c, W / 2, H - 230, 900 * (1 - 0.5 * h), 0.16)
    blit_squash(c, sp, W / 2, H - 230 - h * 900, 330, sx, sy, rot=2 * math.sin(t * 3))
    return c


def s_trans1(t, T):
    c = live("topWD", T)
    pop_text(c, grad_text("Transforming", 900, 150, [(255, 255, 255), (255, 226, 70), (255, 170, 60)]), W / 2, H / 2, t, 0.03)
    return c


def s_trans2(t, T):
    c = live("topWB", T)
    blit(c, grad_text("Transforming", 900, 150, [(255, 255, 255), (170, 225, 255), (120, 170, 255)]), W / 2, H / 2)
    return c


def s_adapt(t, T):
    """내 몸에 맞게 → 알아서 → 변형된다 — 맥스가 기둥·의자·리클라이너·침대로 차례로 바뀐다."""
    c = solid(MINT)
    seq = [("upright", 0.0), ("chair", 0.85), ("recliner", 1.55), ("bed", 2.2)]
    for i, (shape, t0) in enumerate(seq):
        t1 = seq[i + 1][1] if i + 1 < len(seq) else T + 1
        if t0 - 0.12 <= t < t1:
            a = clamp01((t - t0 + 0.12) / 0.12) * (1 - clamp01((t - t1 + 0.12) / 0.12))
            k = ease_out_back((t - t0) / 0.3)
            sp = sprite(shape, "aqua")
            blit(c, sp, W * 0.70, H / 2 + 40, scale=(560 / max(sp.width, sp.height)) * (0.85 + 0.15 * k), alpha=a)
    x = W * 0.33
    if t < 1.1:
        pop_text(c, text_layer("내 몸에", 880, 120, INK), x - 150, H / 2, t, 0.05, grow=False)
        pop_text(c, text_layer("맞게", 930, 120, AQUA), x + 170, H / 2, t, 0.45, dur=0.25)
    elif t < 1.9:
        pop_text(c, text_layer("알아서", 930, 150, INK), x, H / 2, t, 1.12, dur=0.25)
    else:
        pop_text(c, text_layer("변형된다", 950, 150, AQUA), x, H / 2, t, 1.92, dur=0.25)
    return c


def s_durable(t, T):
    c = live("kids", T)
    lay = text_layer("Durable", 930, 170, WHITE, shadow=True)
    k = ease_out_cubic(t / 0.2)
    x = W / 2 - 700 * (1 - k)
    if k < 0.98:
        for i in range(1, 4):
            blit(c, lay, x - i * 50 * (1 - k), H - 170, alpha=0.18)
    blit(c, lay, x, H - 170)                                          # 위쪽은 점프하는 아이들 머리 자리
    return c


def s_patent(t, T):
    c = live("fabric", T)
    caption(c, "특허 기반의 기술력", t, 0.12, y=H / 2 + 200, size=100, grow=False)
    return c


def s_chair_t(t, T):
    return card(LILAC, "의자", t, shape="chair", tint="aqua")


def s_chair(t, T):
    return live("chair", T)


def s_recl_t(t, T):
    return card(BLUSH, "리클라이너", t, shape="recliner", tint="rose")


def s_recl(t, T):
    return live("recl", T)


def s_sofa_t(t, T):
    return card(MINT, "소파 & 침대", t, shape="bed", tint="navy")


def s_bed(t, T):
    return live("bed", T)


def s_light(t, T):
    c = live("lift", T)
    caption(c, "Super Light", t, 0.1, y=H - 170, size=130, weight=930)
    return c


def s_zero1(t, T):
    c = live("zero", B[17] - B[15])                                  # 뒤 장면(s_zero2)까지 한 번에 읽어 이어 쓴다
    caption(c, "구름 위처럼", t, 0.08, y=H - 190, size=104)
    return c


def s_zero2(t, T):
    c = live("zero", T)                                               # 같은 클립을 이어서 읽는다(앞 장면에서 연 것)
    caption(c, "무중력 편안함", t, 0.05, y=H - 190, size=118, weight=920)
    return c


def s_relax(t, T):
    return card(SKY, "Relaxing", t, color=INK, size=170, weight=900)


def s_tired1(t, T):
    c = live("tiredE", T)
    pop_text(c, text_layer("지치고 힘든", 920, 120, WHITE, shadow=True), 150, H / 2 - 20, t, 0.08, anchor="l")
    return c


def s_tired2(t, T):
    c = live("tiredB", T)
    lay = text_layer("몸과 마음이", 920, 120, WHITE, shadow=True)
    pop_text(c, lay, W - 150 - lay.width, H / 2 - 20, t, 0.08, anchor="l")
    return c


def s_heal_t(t, T):
    return card((20, 44, 52), "힐링", t, color=(120, 230, 214), size=180)


def s_heal_t2(t, T):
    return card(WHITE, "힐링되다", t, color=(0, 150, 150), size=170)


def s_heal(t, T):
    return live("heal", T)


def s_colorful_t(t, T):
    c = solid(INK)
    blit(c, grad_text("Colorful", 950, 260, RAINBOW), W / 2, H / 2, scale=0.8 + 0.25 * ease_out_cubic(t / T))
    return c


def s_colorful(t, T):
    c = solid(INK)
    u = ease_out_cubic(t / 0.7)
    for ang, dist, spin, shape, col in ASSETS["burst"]:              # 가운데서 컬러 맥스가 사방으로 터져 나온다
        sp = sprite(shape, col)
        x = W / 2 + math.cos(ang) * dist * 1050 * u
        y = H / 2 + math.sin(ang) * dist * 620 * u
        blit(c, sp, x, y, scale=(260 / sp.width) * (0.35 + 0.9 * u), rot=spin * u)
    blit(c, text_layer("Colorful", 950, 200, WHITE, shadow=True), W / 2, H / 2, scale=0.9 + 0.1 * u)
    return c


def color_ring(c, t, radius_x, radius_y, scale_w, spin):
    names = list(MAX_COLORS)
    n = 24
    for i in range(n):
        a = 2 * math.pi * i / n + spin
        x, y = W / 2 + radius_x * math.cos(a), H / 2 + radius_y * math.sin(a)
        k = ease_out_back((t - 0.02 * i) / 0.3)
        sp = sprite("lying", names[i % len(names)])
        blit(c, sp, x, y, scale=(scale_w / sp.width) * k, rot=-math.degrees(a) + 90)


def s_30a(t, T):
    c = solid(WHITE)
    color_ring(c, t, 700, 400, 230, 0.25 * t)
    pop_text(c, text_layer("30가지", 950, 150, INK), W / 2, H / 2 - 90, t, 0.25, dur=0.25)
    pop_text(c, text_layer("이상의 컬러로", 900, 96, INK), W / 2, H / 2 + 60, t, 0.45, dur=0.25)
    return c


def s_30b(t, T):
    c = solid(WHITE)
    u = ease_in_out(t / T)
    color_ring(c, 10, 700 - 250 * u, 400 - 140 * u, 230 - 60 * u, 0.25 * (1.46 + t) + 0.6 * u)
    blit(c, text_layer("30가지 이상의 컬러로", 900, 90, INK), W / 2, H / 2, scale=1 - 0.35 * u)
    return c


FASHION = ["aqua", "rose", "olive", "yellow", "orange", "lavender", "navy"]
FASHION_SRC = (170, 225)            # 패션 장면 영상 속 맥스(아쿠아)의 색상각 범위 — 햇빛 받은 면은 채도가 낮아 0.2 까지 받는다


def recolor_frame(frame, rgb, hue_range=FASHION_SRC, sat_min=0.2):
    """영상 한 프레임에서 hue_range 안의 맥스만 골라 명암은 두고 색만 바꾼다(모델 옷·피부·배경은 그대로)."""
    a = np.asarray(frame.convert("RGB")).astype(np.float32)
    hsv = np.asarray(frame.convert("RGB").convert("HSV")).astype(np.float32)
    hue, sat, val = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255, hsv[..., 2] / 255
    m = ((hue > hue_range[0]) & (hue < hue_range[1]) & (sat > sat_min) & (val > 0.1)).astype(np.float32)
    lum = (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]) / 255
    ref = float(np.median(lum[m > 0])) if m.any() else 0.4
    shade = np.clip(lum / max(ref, 1e-3), 0, 1.6)[..., None]
    col = np.array(rgb, np.float32)[None, None, :]
    tinted = np.where(shade <= 1, col * shade, col + (255 - col) * (shade - 1) / 0.6 * 0.55)
    mm = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5))).astype(np.float32)[..., None] / 255
    out = a * (1 - mm) + np.clip(tinted, 0, 255) * mm
    return Image.fromarray(out.astype(np.uint8), "RGB").convert("RGBA")


def s_fashion(t, T):
    c = live("fashion", T)
    i = min(len(FASHION) - 1, int(t / (T / len(FASHION))))           # 박자마다 커버를 갈아입는다
    if FASHION[i] != FASHION[0]:
        c = recolor_frame(c, MAX_COLORS[FASHION[i]])
    caption(c, "패션처럼 바꾼다", t, 0.1, y=H - 190, size=112, grow=False)
    return c


def s_rest(t, T):
    c = solid(CREAM)
    for x0, y0, sp_speed, rot, shape, col in ASSETS["fly"]:          # 컬러 맥스들이 대각선으로 흘러간다
        sp = sprite(shape, col)
        x = (x0 + 0.18 * sp_speed * t) * W
        y = (y0 - 0.10 * sp_speed * t) * H
        blit(c, sp, x, y, scale=(300 / sp.width) * (0.7 + 0.4 * sp_speed), rot=rot + 8 * t)
    parts = [("휴식할", INK, 0.2), ("땐", INK, 0.55), ("요기보", AQUA, 0.9)]
    lays = [(text_layer(s, 900, 120, col), t0) for s, col, t0 in parts]
    total = sum(l.width - 80 for l, _ in lays) + 40 * (len(lays) - 1)
    x = W / 2 - total / 2
    for l, t0 in lays:
        if t >= t0:
            k = ease_out_cubic((t - t0) / 0.22)
            blit(c, l, x + (l.width - 80) / 2, H / 2 + 20 * (1 - k), alpha=k)
        x += l.width - 80 + 40
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


SCENES = [s_intro, s_logo, s_hero, s_trans1, s_trans2, s_adapt, s_durable, s_patent, s_chair_t, s_chair,
          s_recl_t, s_recl, s_sofa_t, s_bed, s_light, s_zero1, s_zero2, s_relax, s_tired1, s_tired2,
          s_heal_t, s_heal_t2, s_heal, s_colorful_t, s_colorful, s_30a, s_30b, s_fashion, s_rest,
          s_discover, s_end]
assert len(SCENES) == len(B) - 1
# 같은 클립을 두 장면에 걸쳐 이어 읽는 쌍 — 장면이 바뀌어도 읽던 것을 닫지 않는다
CONTINUE = {s_zero2: "zero"}


def scene_at(t):
    return max(k for k in range(len(SCENES)) if B[k] <= t + 1e-6)


def render_stills(times, out_prefix):
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
                            "-r", f"{FPS_NUM}/{FPS_DEN}", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "17",
                            "-pix_fmt", "yuv420p", tmp], stdin=subprocess.PIPE)
    cur = -1
    for f in range(n_total):
        t = f / FPS
        i = scene_at(t)
        if i != cur:
            keep = CONTINUE.get(SCENES[i])
            for k in list(READERS):
                if k != keep:
                    READERS.pop(k).close()
            cur = i
        enc.stdin.write(SCENES[i](t - B[i], B[i + 1] - B[i]).convert("RGB").tobytes())
        if f % 48 == 0:
            print(f"{t:5.1f}s / {B[-1]}s", flush=True)
    enc.stdin.close()
    enc.wait()
    close_readers()
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-i", os.path.join(A, "max_audio.m4a"),
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
                    "-movflags", "+faststart", out], check=True)
    os.remove(tmp)
    print("완료 ->", out)


if __name__ == "__main__":
    main(sys.argv[1])
