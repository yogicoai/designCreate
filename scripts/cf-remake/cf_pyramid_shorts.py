"""
요기보 피라미드 CF 리메이크 — 숏폼(세로 9:16, 1080×1920) 판.

가로 최종본(cf_pyramid.py + 2026-10-01 수정: 애착소파 아래 잘라냄 · HOT Colors 쓰러지는 1.1초 컷)과
장면·박자·음원은 같고, 배치만 세로에 맞게 다시 짰다(사용자 요청 2026-10-01 「숏폼 형식으로 · 자막 배치 변경」).

  · 글자·제품 장면: 세로 화면에 맞춰 다시 배치. 자막은 숏츠·릴스 버튼에 안 가리는 자리(위 230 ~ 아래 1500px)에 둔다.
  · 스튜디오 실사(단색·그라데이션 배경): 사람을 덜 자르도록 가로를 넉넉히 쓰고, 위(와 아래)는 가장자리 색을 이어 채운다.
    자막은 그 이어 붙인 벽에 색 글자로 올린다(밝은 벽이라 흰 글자는 안 읽힌다).
  · 실제 방이 배경인 실사(HOT Colors · 휴식): 첫 프레임을 AI 로 위아래만 넓힌 정지 그림(plate)을 배경으로 깔고,
    클립의 카메라 움직임(천천히 다가감)을 재서 그 그림을 같이 움직인다 — 영상 전체를 AI 로 다시 뽑지 않아 원본 화질 그대로다.
  · 제품 그림(pyr_base_gray.png)은 컨펌받은 가로 영상의 특허 장면에서 다시 뗀 것(명암만 남긴 회색) — 색은 여기서 입힌다.

사용: python cf_pyramid_shorts.py <출력.mp4> <자산폴더>
      python cf_pyramid_shorts.py --stills <접두어> <자산폴더> <초> [<초> ...]     확인용 정지 화면
      python cf_pyramid_shorts.py --extract-base <가로 최종본.mp4> <pyr_base_gray.png>   제품 그림 다시 떼기
"""
import math, os, random, subprocess, sys
from functools import lru_cache
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
def extract_base(video, out):
    """제품 그림 다시 떼기 — 가로 최종본(1080p·30fps) 특허 장면의 분홍 피라미드(약 835px)를 명암만 남긴 회색 PNG 로.
    분홍(239,0,102) 렌더를 되돌린다: 그늘은 R/239, 하이라이트는 1 + G/233.75. 회전 10·sin(1.3t)° 도 되돌린다.
    (원형 피라미드 원본 pyr_base.png 가 이 PC 에 없어서 컨펌받은 영상에서 다시 뗐다 — 색을 입히면 원본 장면과 똑같다.)"""
    f, t0 = 510, 14.933
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{(f + 0.3) / 30:.4f}", "-i", video, "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    rgb = np.frombuffer(raw, np.uint8).reshape(1080, 1920, 3).astype(np.float32)
    sat = cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)[..., 1] / 255
    alpha = np.clip((sat - 0.16) / 0.16, 0, 1)
    _, lab, st, _ = cv2.connectedComponentsWithStats((alpha > 0.5).astype(np.uint8))
    keep = cv2.dilate((lab == (1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA])))).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    alpha = alpha * keep
    shade = np.minimum(rgb[..., 0] / 239.0, 1.0) + np.clip(rgb[..., 1] - 6, 0, None) / 233.75
    gray = np.clip(shade * 153, 0, 255)
    im = Image.fromarray(np.dstack([gray, gray, gray, alpha * 255]).astype(np.uint8), "RGBA")
    ys, xs = np.nonzero(alpha > 0.5)
    im = im.crop((xs.min() - 20, ys.min() - 20, xs.max() + 21, ys.max() + 21))
    im = im.rotate(-10 * math.sin((f / 30 - t0) * 1.3), resample=Image.BICUBIC, expand=True)
    bb = im.getchannel("A").point(lambda v: 255 if v > 40 else 0).getbbox()
    im.crop((bb[0] - 6, bb[1] - 6, bb[2] + 6, bb[3] + 6)).save(out)
    print("제품 그림 ->", out)


if len(sys.argv) > 1 and sys.argv[1] == "--extract-base":
    extract_base(sys.argv[2], sys.argv[3])
    sys.exit(0)

STILLS = len(sys.argv) > 1 and sys.argv[1] == "--stills"
if STILLS:
    PREFIX, A, TIMES = sys.argv[2], sys.argv[3], [float(x) for x in sys.argv[4:]]
else:
    OUT, A = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else HERE)
sys.argv = [sys.argv[0], "unused.mp4", A]     # cf_full·cf_pyramid 가 자산 폴더를 argv[2] 에서 읽는다
import cf_full      # noqa: E402
import cf_pyramid   # noqa: E402

W, H = 1080, 1920
cf_full.W, cf_full.H = W, H              # blit·pop_text 가 화면 크기를 여기서 읽는다
cf_pyramid.W, cf_pyramid.H = W, H        # solid·blit_squash·soft_shadow 도
from cf_full import clamp01, ease_out_back, ease_out_cubic, ease_in_out, text_layer, blit, pop_text  # noqa: E402
from cf_pyramid import (solid, ease_in, blit_squash, drop_pose, soft_shadow, rounded_triangle, recolor,  # noqa: E402
                        PYR_COLORS, CREAM, INK, WHITE, PINK, MINT, LILAC, BLUSH, SAFFRON)

FPS = 30
SW, SH = 1920, 1080                       # 실사 원본 크기

# 가로 최종본과 같은 장면 전환 — HOT Colors 를 19.067초에서 끊고 뒤를 1.1초 당긴 것
B = [0, 0.7, 1.6, 2.5, 4.5, 5.6, 7.167, 8.3, 9.967, 12.0, 13.633, 14.933, 17.2,
     19.066, 19.933, 20.2, 21.467, 22.5, 24.1, 26.133, 28.2, 30.4, 31.3, 34.183]

# 실사 클립: (파일, 시작 오프셋, 원본 크기)
CLIPS = {
    "tok": ("p_tok.mp4", 1.4, (1920, 1080)), "size": ("p_size.mp4", 2.3, (1920, 1080)), "relax": ("p_relax.mp4", 1.2, (1920, 1080)),
    "q1": ("p_q1.mp4", 1.0, (1280, 720)), "q2": ("p_q2.mp4", 1.8, (1280, 720)), "q3": ("p_q3.mp4", 0.5, (1280, 720)), "q4": ("p_q4.mp4", 0.8, (1280, 720)),
    "attach": ("p_attach.mp4", 0.5, (1920, 1080)), "durable": ("p_durable.mp4", 0.6, (1920, 1080)),
    "colors": ("p_colors.mp4", 0.2, (1920, 1080)), "rest": ("p_rest.mp4", 0.3, (1920, 1080)),
}

# 넓힌 배경(plate)을 쓰는 장면: (plate 파일, 배율, 왼쪽 자르기 x0(원본 px), 원본 윗변이 놓일 캔버스 y, 장면 번호)
PLATE_CFG = {
    "colors": ("plate_colors.png", 1.25, 470, 150, 12),
    "rest": ("plate_rest.png", 1.0, 458, 640, 20),
}

GREEN, BLUE, MAGENTA, VIOLET = (122, 201, 67), (36, 56, 216), (201, 64, 170), (120, 92, 214)


# ── 글자 ─────────────────────────────────────────────────
def fit(text, weight, size, color, shadow=False, max_w=940):
    """폭이 max_w 를 넘으면 글자를 줄인다 — 세로 화면은 폭이 좁다."""
    lay = text_layer(text, weight, size, color, shadow)
    while lay.width - 80 > max_w and size > 24:
        size -= 4
        lay = text_layer(text, weight, size, color, shadow)
    return lay


# ── 실사 클립 읽기 (원래 크기 그대로 — 자르기·늘리기는 장면이 한다) ──
class Clip:
    def __init__(self, key, dur):
        src, off, (w, h) = CLIPS[key]
        self.w, self.h, self.n = w, h, 0
        self.p = subprocess.Popen(["ffmpeg", "-loglevel", "quiet", "-ss", str(off), "-i", os.path.join(A, src), "-t", str(dur + 0.3),
                                   "-vf", f"fps={FPS},setsar=1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
        self.last = np.zeros((h, w, 3), np.uint8)

    def frame(self):
        buf = self.p.stdout.read(self.w * self.h * 3)
        if len(buf) == self.w * self.h * 3:
            self.last = np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 3)
            self.n += 1
        return self.last

    def close(self):
        try:
            self.p.stdout.close()
            self.p.kill()
        except Exception:
            pass


READERS = {}


def live(key, scene_dur):
    if key not in READERS:
        READERS[key] = Clip(key, scene_dur)
    return READERS[key].frame()


def close_readers():
    for k in list(READERS):
        READERS.pop(k).close()


def rgba(arr):
    return Image.fromarray(arr).convert("RGBA")


# ── 스튜디오 실사: 가장자리 색으로 위·아래를 잇는다 ───────────
def edge_color(rows):
    """맨 위(아래) 몇 줄의 색을 가로로 훑은 한 줄 — 손끝 같은 좁은 물체는 넓은 중앙값으로 걸러 세로 줄무늬가 안 생기게."""
    r = np.clip(rows.astype(np.float32).mean(axis=0), 0, 255).astype(np.uint8)[None].repeat(5, axis=0)
    r = cv2.medianBlur(np.ascontiguousarray(r), 201)
    return cv2.GaussianBlur(r[2:3].astype(np.float32), (0, 0), 24)                  # (1, W, 3)


def studio(fr, x0, cw, rows=None, top=None, feather=14):
    """원본의 가로 [x0, x0+cw] 를 화면 폭에 맞춰 키워 놓고(기본: 아래 맞춤), 남는 위·아래는 가장자리 색을 이어 채운다.
    rows = 원본에서 쓸 세로 줄 수(아래를 잘라낼 때)."""
    src = fr[:rows, x0:x0 + cw] if rows else fr[:, x0:x0 + cw]
    sc = W / cw
    h = int(round(src.shape[0] * sc))
    part = cv2.resize(src, (W, h), interpolation=cv2.INTER_CUBIC if sc > 1 else cv2.INTER_AREA).astype(np.float32)
    if top is None:
        top = H - h
    canvas = np.empty((H, W, 3), np.float32)
    ramp = (np.arange(feather, dtype=np.float32) / feather)[:, None, None]
    if top > 0:
        e = edge_color(part[:6])
        canvas[:top] = e
        part[:feather] = e * (1 - ramp) + part[:feather] * ramp
    y1 = min(H, top + h)
    if y1 < H:
        e = edge_color(part[h - 6:h])
        canvas[y1:] = e
        part[h - feather:h] = e * ramp + part[h - feather:h] * (1 - ramp)
    canvas[max(0, top):y1] = part[max(0, -top):y1 - top]
    return np.clip(canvas, 0, 255).astype(np.uint8)


# ── 넓힌 배경(plate) 장면 ─────────────────────────────────
PLATES = {}


def read_gray(key, dur, size=(960, 540)):
    src, off, _ = CLIPS[key]
    w, h = size
    raw = subprocess.run(["ffmpeg", "-loglevel", "quiet", "-ss", str(off), "-i", os.path.join(A, src), "-t", str(dur + 0.3),
                          "-vf", f"fps={FPS},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
    n = len(raw) // (w * h)
    return np.frombuffer(raw[:n * w * h], np.uint8).reshape(n, h, w)


def camera_path(gray):
    """프레임 0 → t 의 닮음변환(배율·회전·이동) 목록. 배경 특징점을 따라가 RANSAC 으로 잡고(움직이는 사람은 걸러진다),
    프레임마다 떨리지 않게 3차식으로 다듬는다. 좌표는 원본(1920×1080) 기준.
    클립은 24fps 라 30fps 로 읽으면 다섯 장에 한 장이 앞 프레임과 같다 — 그 프레임은 배경도 앞 것과 같은 자리에 둔다
    (배경만 움직이면 이음매가 그 순간 살짝 어긋난다)."""
    n = len(gray)
    diff = [float(np.abs(gray[i].astype(np.int16) - gray[i - 1].astype(np.int16)).mean()) for i in range(1, n)]
    uniq = [0] + [i for i in range(1, n) if diff[i - 1] > 0.05]            # 새 그림이 나온 프레임
    owner = np.cumsum([1] + [1 if d > 0.05 else 0 for d in diff]) - 1      # 프레임 → 몇 번째 새 그림인지
    g0 = gray[0]
    p0 = cv2.goodFeaturesToTrack(g0, 800, 0.01, 7)
    params = []
    for i in uniq:
        p1, st, _ = cv2.calcOpticalFlowPyrLK(g0, gray[i], p0, None, winSize=(31, 31), maxLevel=4)
        ok = st.ravel() == 1
        M, _ = cv2.estimateAffinePartial2D(p0[ok], p1[ok], method=cv2.RANSAC, ransacReprojThreshold=1.5)
        if M is None:
            params.append(params[-1] if params else [0.0, 0.0, 0.0, 0.0])
            continue
        params.append([math.log(math.hypot(M[0, 0], M[1, 0])), math.atan2(M[1, 0], M[0, 0]), M[0, 2], M[1, 2]])
    P = np.array(params)
    x = np.arange(len(P))
    sm = np.stack([np.polyval(np.polyfit(x, P[:, j], 3), x) for j in range(4)], axis=1)
    resid = np.abs(P - sm).max(axis=0)
    sm -= sm[0]                                                   # 프레임 0 은 그대로
    k = SW / gray.shape[2]
    mats = []
    for ls, ang, tx, ty in sm:
        s = math.exp(ls)
        c, si = s * math.cos(ang), s * math.sin(ang)
        mats.append(np.array([[c, -si, tx * k], [si, c, ty * k], [0, 0, 1]], np.float64))
    return [mats[j] for j in owner], math.exp(sm[-1, 0]), resid


def align_plate(plate, f0):
    """plate 좌표 → 원본 프레임 0 좌표(닮음변환)를 특징점 정합으로 구하고, 원본 자리의 색을 프레임 0 에 맞춘다."""
    ph, pw = plate.shape[:2]
    ps = 1200 / pw
    Ps = cv2.resize(plate, (1200, int(ph * ps)), interpolation=cv2.INTER_AREA)
    Fs = cv2.resize(f0, (960, 540), interpolation=cv2.INTER_AREA)
    sift = cv2.SIFT_create(4000)
    k1, d1 = sift.detectAndCompute(cv2.cvtColor(Ps, cv2.COLOR_RGB2GRAY), None)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(Fs, cv2.COLOR_RGB2GRAY), None)
    good = [a for a, b in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.7 * b.distance]
    src = np.float32([k1[g.queryIdx].pt for g in good]) / ps
    dst = np.float32([k2[g.trainIdx].pt for g in good]) * (SW / 960)
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3)
    warp = cv2.warpAffine(plate, M, (SW, SH), flags=cv2.INTER_AREA).astype(np.float32)[::4, ::4]
    ref = f0.astype(np.float32)[::4, ::4]
    out = plate.astype(np.float32)
    for ch in range(3):
        a, b = np.polyfit(warp[..., ch].ravel(), ref[..., ch].ravel(), 1)
        out[..., ch] = out[..., ch] * a + b
    return np.vstack([M, [0, 0, 1]]), np.clip(out, 0, 255).astype(np.uint8), int(inl.sum()), len(good)


def prep_plate(key):
    fn, s, x0, oy, scene = PLATE_CFG[key]
    dur = B[scene + 1] - B[scene]
    gray = read_gray(key, dur)
    Ms, zoom, resid = camera_path(gray)
    src, off, _ = CLIPS[key]
    raw = subprocess.run(["ffmpeg", "-loglevel", "quiet", "-ss", str(off), "-i", os.path.join(A, src), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    f0 = np.frombuffer(raw, np.uint8).reshape(SH, SW, 3)
    plate = cv2.cvtColor(cv2.imread(os.path.join(A, fn)), cv2.COLOR_BGR2RGB)
    Ap, plate, n_in, n_all = align_plate(plate, f0)
    L = np.array([[s, 0, -x0 * s], [0, s, oy], [0, 0, 1]], np.float64)
    PLATES[key] = {"plate": plate, "A": Ap, "M": Ms, "L": L, "top": oy, "bot": oy + SH * s}
    print(f"plate {key}: 정합 {n_in}/{n_all}점 · 카메라 배율 {zoom:.3f} · 다듬기 잔차(배율 {resid[0]:.4f}, 이동 {resid[2] * 2:.1f}/{resid[3] * 2:.1f}px)", flush=True)


def plate_frame(key, fr, i, feather=36):
    """넓힌 배경을 이 프레임의 카메라 위치로 옮겨 깔고, 그 위에 원본 프레임을 얹는다(위·아래 가장자리만 부드럽게 섞는다)."""
    P = PLATES[key]
    M = P["M"][min(i, len(P["M"]) - 1)]
    T = P["L"] @ M @ P["A"]
    bg = cv2.warpAffine(P["plate"], T[:2], (W, H), flags=cv2.INTER_AREA if T[0, 0] < 1 else cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    fg = cv2.warpAffine(fr, P["L"][:2], (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    y = np.arange(H, dtype=np.float32)
    a = np.clip((y - P["top"]) / feather, 0, 1) * np.clip((P["bot"] - y) / feather, 0, 1)
    a = a[:, None, None]
    return np.clip(bg.astype(np.float32) * (1 - a) + fg.astype(np.float32) * a, 0, 255).astype(np.uint8)


# ── 자산 ──────────────────────────────────────────────────
ASSETS = {}


def load_assets():
    base = Image.open(os.path.join(A, "pyr_base_gray.png")).convert("RGBA")
    for name, rgb in PYR_COLORS.items():
        ASSETS[name] = recolor(base, rgb)
    ASSETS["logo"] = Image.open(os.path.join(A, "yogibo_logo3_on.png")).convert("RGBA")
    ASSETS["tri"] = rounded_triangle(760, WHITE)
    rnd = random.Random(7)
    ASSETS["beads"] = [(rnd.uniform(0.05, 0.95), rnd.uniform(0, 1), rnd.uniform(9, 26), rnd.uniform(0.25, 0.7)) for _ in range(34)]
    ASSETS["burst"] = [(rnd.uniform(0, 2 * math.pi), rnd.uniform(0.55, 1.15), rnd.uniform(-160, 160), rnd.choice(
        ["pink", "blue", "mint", "green", "lavender", "cherry", "charcoal", "navy", "blush", "sky", "peach", "lilac"]))
        for _ in range(16)]
    # 기자 피라미드 — 세로를 꽉 채우고 왼쪽 큰 피라미드가 보이게 자른다. 모래·피라미드(따뜻한 색)는 앞 장막으로 따로 떼어
    # 민트 피라미드가 그 '뒤에서' 솟게 한다(가로판은 앞에 얹었다).
    g = Image.open(os.path.join(A, "giza.png")).convert("RGB")
    k = H / g.height
    g = g.resize((int(g.width * k), H), Image.LANCZOS).crop((600, 0, 600 + W, H))
    hsv = np.asarray(g.convert("HSV")).astype(np.float32)
    hue, sat = hsv[..., 0] * 360 / 255, hsv[..., 1] / 255
    warm = ((hue > 12) & (hue < 60) & (sat > 0.2)).astype(np.uint8)
    warm[int(H * 0.735):] = 1                                    # 지평선 아래는 전부 앞
    warm[:int(H * 0.45)] = 0                                     # 하늘 위쪽의 누런 구름은 뒤
    warm = cv2.morphologyEx(warm, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    fg = g.convert("RGBA")
    fg.putalpha(Image.fromarray(warm * 255).filter(ImageFilter.GaussianBlur(1.5)))
    ASSETS["giza"], ASSETS["giza_fg"] = g.convert("RGBA"), fg
    for key in PLATE_CFG:
        prep_plate(key)


@lru_cache(maxsize=64)
def bead(r):
    d = Image.new("RGBA", (int(r * 2) + 2, int(r * 2) + 2), (0, 0, 0, 0))
    ImageDraw.Draw(d).ellipse((0, 0, r * 2 - 1, r * 2 - 1), fill=(255, 255, 255, 235))
    return d


# ── 장면들 (t 는 장면 안 시각, T 는 장면 길이) ────────────
def s_intro(t, T):
    """세로판은 글자 카드(The Disruptive Furniture) 대신 로고로 연다 — 사용자 요청 2026-10-01
    「이 부분 빼고 차라리 로고 나오는 걸로 · 너무 이상해」. 길이는 그대로 둬 음악 박자가 유지된다."""
    c = solid(CREAM)
    blit(c, ASSETS["logo"], W / 2, H / 2 - 40, scale=1.5 * (0.8 + 0.2 * ease_out_back(t / 0.4)))    # 첫 프레임부터 보인다(썸네일)
    return c


def s_logo(t, T):
    c = solid(LILAC)                                        # 0.7초 박자에 배경이 바뀌고, 떠 있던 로고가 한 번 톡 튄다
    pulse = 1 + 0.10 * math.exp(-8 * t) * math.cos(16 * t)
    blit(c, ASSETS["logo"], W / 2, H / 2 - 40, scale=1.5 * pulse)
    return c


def s_title(t, T):
    c = solid(BLUSH)
    ground = H / 2 + 190
    h, sx, sy = drop_pose(t, 0.22)
    soft_shadow(c, W / 2, ground, 470 * (1 - 0.5 * h))
    blit_squash(c, ASSETS["pink"], W / 2, ground - h * 1500, 540, sx, sy, rot=6 * math.sin(t * 3))
    spots = [("피", 250, 400, 0.30), ("라", W - 250, 400, 0.42), ("미", 250, 1300, 0.54), ("드", W - 250, 1300, 0.66)]
    for s, x, y, t0 in spots:
        pop_text(c, text_layer(s, 930, 300, INK), x, y, t, t0, dur=0.22)
    return c


# 세 개가 차례로 떨어진다 — 뒤에 둘(분홍·파랑), 앞 가운데에 하나(초록). 세로 화면이라 한 줄로 늘어놓으면 너무 작다.
TRIO = [("pink", 285, 1290, 400, 0.05), ("blue", 795, 1290, 400, 0.55), ("green", 540, 1440, 450, 1.05)]


def trio(c, t):
    for name, x, ground, size, t0 in TRIO:
        if t < t0:
            continue
        h, sx, sy = drop_pose(t - t0)
        soft_shadow(c, x, ground, size * 0.9 * (1 - 0.6 * h), 0.16)
        blit_squash(c, ASSETS[name], x, ground - h * 1800, size, sx, sy)


def s_drop(t, T):
    c = solid((198, 240, 231))
    trio(c, t)
    return c


def s_cute(t, T):
    c = solid((198, 240, 231))
    trio(c, t + 10)                                         # 이미 내려앉은 상태
    pop_text(c, text_layer("Extremely", 880, 170, INK), W / 2, 440, t, 0.05, dur=0.3)
    pop_text(c, text_layer("Cute!", 900, 210, INK), W / 2, 650, t, 0.2, dur=0.3)
    if t > T - 0.35:                                        # 마지막: 앞의 초록이 화면으로 튀어 다음 장면(초록 피라미드)으로
        u = (t - (T - 0.35)) / 0.35
        g = ASSETS["green"]
        blit(c, g, W / 2, 1215 - 250 * u, scale=(450 / g.height) * (1 + 5 * ease_in(u)))
    return c


def s_tok(t, T):
    c = rgba(studio(live("tok", T), 490, 939))
    pop_text(c, text_layer("귀여움이", 840, 104, INK), W / 2 - 180, 480, t, 0.1, grow=False)
    pop_text(c, text_layer("톡", 950, 260, GREEN), W / 2 + 210, 455, t, 0.62, dur=0.25)
    return c


def s_size(t, T):
    c = rgba(studio(live("size", T), 854, 982))
    pop_text(c, fit("앙증맞은 사이즈", 880, 124, PINK), W / 2, 500, t, 0.08)
    return c


def s_relax(t, T):
    c = rgba(studio(live("relax", T), 634, 1080))
    pop_text(c, text_layer("Super", 880, 170, VIOLET), W / 2, 410, t, 0.1)
    pop_text(c, text_layer("Relaxing", 880, 170, VIOLET), W / 2, 590, t, 0.22)
    return c


QUAD_Y0 = {"q1": 60, "q2": 70, "q3": 70, "q4": 36}             # 띠마다 쓸 세로 구간의 시작(원본 720 중 569줄)


def s_quad(t, T):
    canvas = np.empty((H, W, 3), np.uint8)
    for i, key in enumerate(("q1", "q2", "q3", "q4")):          # 4분할 → 가로 띠 4줄: 원본을 거의 안 자른다
        fr = live(key, T)
        y0 = QUAD_Y0[key]
        canvas[i * 480:(i + 1) * 480] = cv2.resize(fr[y0:y0 + 569], (W, 480), interpolation=cv2.INTER_AREA)
    c = rgba(canvas)
    pop_text(c, fit("마음까지 힐링하는", 880, 116, WHITE, shadow=True), W / 2, H / 2, t, 0.12)
    return c


def s_attach(t, T):
    c = rgba(studio(live("attach", T), 595, 900, rows=961))      # 아래 둥근 바닥은 가로판처럼 잘라낸다(961/1080줄)
    pop_text(c, text_layer("애착소파", 950, 210, MAGENTA), W / 2, 470, t, 0.06, dur=0.3)
    return c


def s_durable(t, T):
    c = rgba(studio(live("durable", T), 510, 900, top=470))
    lay = fit("So Durable!", 900, 150, BLUE)
    k = ease_out_cubic(t / 0.22)
    x = W / 2 - 700 * (1 - k)
    if k < 0.98:                                              # 들어올 때만 가로 잔상
        for i in range(1, 4):
            blit(c, lay, x - i * 50 * (1 - k), 300, alpha=0.18)
    blit(c, lay, x, 300)
    return c


def s_patent(t, T):
    c = solid((236, 229, 250))
    hero = ASSETS["pink"]
    for bx, by, r, sp in ASSETS["beads"]:                    # 속을 채운 비즈가 천천히 떠오른다
        y = ((by - sp * t / T * 0.6) % 1.0) * (H + 80) - 40
        c.alpha_composite(bead(round(r, 1)), (int(W * (0.04 + 0.92 * bx) - r), max(0, int(y - r))))
    blit(c, hero, W / 2, H / 2 + 180, scale=(760 / hero.height) * (0.94 + 0.08 * t / T) * ease_out_back(t / 0.35),
         rot=10 * math.sin(t * 1.3))
    pop_text(c, fit("특허기반의 기술력", 880, 112, INK), W / 2, 480, t, 0.25, grow=False)
    return c


def s_colors(t, T):
    fr = live("colors", T)
    c = rgba(plate_frame("colors", fr, READERS["colors"].n - 1))
    pop_text(c, text_layer("30가지 이상의", 820, 84, WHITE, shadow=True), W / 2, 300, t, 0.15, grow=False)
    pop_text(c, fit("HOT Colors", 950, 170, WHITE, shadow=True), W / 2, 430, t, 0.35, dur=0.3)
    return c


def brand_card(bg, sprite, t, grow_from=0.0):
    """세로: 로고(위) · 흰 삼각형 속 제품(가운데) · Pyramid(아래)."""
    c = solid(bg)
    blit(c, ASSETS["tri"], W / 2, H / 2 + 40, scale=0.96 + 0.04 * math.sin(t * 4))
    k = ease_out_back((t - grow_from) / 0.35) if t >= grow_from else 0
    blit(c, sprite, W / 2, H / 2 + 110, scale=(360 / sprite.height) * k, rot=5 * math.sin(t * 3))
    blit(c, ASSETS["logo"], W / 2, H / 2 - 470, scale=1.2)
    blit(c, text_layer("Pyramid", 900, 150, WHITE, shadow=True), W / 2, H / 2 + 470)
    return c


def s_brand1(t, T):
    return brand_card(SAFFRON, ASSETS["pink"], t, 0.05)


def s_flash(rgb):
    def f(t, T):
        return solid(rgb)
    return f


def s_brand2(t, T):
    zoom_at = T - 0.23
    if t < zoom_at:
        return brand_card((200, 186, 240), ASSETS["navy"], t, 0.02)
    u = (t - zoom_at) / 0.23                                 # 제품 속으로 확 파고든다
    c = brand_card((200, 186, 240), ASSETS["navy"], zoom_at)
    s = math.exp(math.log(9) * ease_in(u))
    cw, ch = W / s, H / s                                     # 제품(H/2+110) 이 제자리에 남도록 그 주변을 잘라 키운다
    x0, y0 = (W - cw) / 2, ((H * s - H) / 2 + 110 * (s - 1)) / s
    return c.crop((int(x0), int(y0), int(x0 + cw), int(y0 + ch))).resize((W, H), Image.BILINEAR)


def s_brand3(t, T):
    if t > T - 0.3:
        return solid(MINT)
    return brand_card(BLUSH, ASSETS["mint"], t, 0.04)


def s_small(t, T):
    c = solid(CREAM)
    pop_text(c, text_layer("작지만", 900, 190, INK), W / 2, H / 2 - 150, t, 0.05, grow=False)
    pop_text(c, text_layer("편안함은", 900, 190, PINK), W / 2, H / 2 + 90, t, 0.45, grow=False)
    return c


def s_bigger(t, T):
    c = ASSETS["giza"].copy()
    rise = ease_out_cubic(t / 1.4)                          # 기자 피라미드 '뒤에서' 거대한 민트 피라미드가 솟는다
    blit_squash(c, ASSETS["mint"], W * 0.5, 1500, 620 + 760 * rise)
    c.alpha_composite(ASSETS["giza_fg"])
    blit(c, text_layer("더", 840, 124, WHITE, shadow=True), 230, 320)
    if t > 0.25:
        bar = min(1.0, (t - 0.25) / 0.5)
        ImageDraw.Draw(c).rounded_rectangle((320, 311, 320 + int(330 * bar), 329), radius=9, fill=WHITE)
    pop_text(c, text_layer("욱", 840, 124, WHITE, shadow=True), 745, 320, t, 0.75, grow=False)
    if t > 1.0:
        blit(c, text_layer("크게", 950, 250, WHITE, shadow=True), W / 2, 530, scale=0.6 + 0.4 * ease_out_back((t - 1.0) / 0.4))
    return c


def s_burst(t, T):
    c = solid((238, 232, 250))
    if t < 0.6:                                             # 가운데서 사방으로 터져 나온다
        u = ease_out_cubic(t / 0.6)
        for ang, dist, spin, name in ASSETS["burst"]:
            sp = ASSETS[name]
            x = W / 2 + math.cos(ang) * dist * 560 * u
            y = H / 2 - 60 + math.sin(ang) * dist * 900 * u
            blit(c, sp, x, y, scale=(200 / sp.height) * (0.4 + 0.9 * u), rot=spin * u)
    else:                                                   # 로즈핑크가 꼬리를 달고 왼쪽으로 날아간다
        u = (t - 0.6) / (T - 0.6)
        hero = ASSETS["pink"]
        x = W + 330 - (W + 1000) * ease_in_out(u)
        for i, name in enumerate(("blue", "mint", "lavender", "charcoal", "sky")):
            sp = ASSETS[name]
            blit(c, sp, x + 360 + i * 130, H / 2 - 60 + 40 * math.sin(i + t * 6), scale=84 / sp.height, rot=40 * t + i * 30)
        blit(c, hero, x, H / 2 - 60, scale=500 / hero.height, rot=-12 + 8 * math.sin(t * 5))
    return c


def s_rest(t, T):
    fr = live("rest", T)
    c = rgba(plate_frame("rest", fr, READERS["rest"].n - 1))
    pop_text(c, fit("휴식이 필요할 땐", 880, 116, INK), W / 2, 320, t, 0.7, grow=False)
    return c


def s_discover(t, T):
    """슬로건 카드 — 얇은 한 줄 글자가 밋밋하다는 지적(사용자 2026-10-01 「너무 안 이쁘게 나와 · 디자인 좀」)으로
    다른 카드처럼 굵은 색 글자를 쌓고 제품을 곁들였다: 분홍 피라미드가 톡 떨어지고 Discover / the Feel 이 차례로 튄다."""
    c = solid((198, 240, 231))
    ground = 560
    h, sx, sy = drop_pose(t, 0.16)
    soft_shadow(c, W / 2, ground, 300 * (1 - 0.5 * h), 0.16)
    blit_squash(c, ASSETS["pink"], W / 2, ground - h * 900, 330, sx, sy, rot=4 * math.sin(t * 5))
    pop_text(c, fit("Discover", 950, 210, INK), W / 2, 790, t, 0.06, dur=0.24)
    the, feel = text_layer("the", 880, 130, INK), text_layer("Feel", 950, 340, PINK)
    total = (the.width - 80) + 36 + (feel.width - 80)          # 'the Feel' 한 줄 — 작은 the 는 큰 Feel 의 아랫선에 맞춘다
    x0 = W / 2 - total / 2
    pop_text(c, the, x0 + (the.width - 80) / 2, 1152, t, 0.16, dur=0.22)
    pop_text(c, feel, x0 + (the.width - 80) + 36 + (feel.width - 80) / 2, 1092, t, 0.22, dur=0.26)
    return c


def s_end(t, T):
    c = solid(WHITE)
    k = ease_out_cubic(t / 0.45)
    blit(c, ASSETS["logo"], W / 2, H / 2 - 40, scale=1.6 * (0.9 + 0.1 * k), alpha=k)
    return c


# AI 제작 안내 — 인스타그램 게시용(사용자 요청 2026-10-01). 시작 3초 동안 하단(숏츠·릴스 UI 바로 위)에 작게.
NOTICE = "본 영상은 AI로 제작되었으며 가상인물이 등장합니다"
NOTICE_SEC = 3.0


@lru_cache(maxsize=1)
def notice_layers():
    lay = text_layer(NOTICE, 640, 34, WHITE)
    w, h = lay.width - 80 + 52, 62
    pill = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(pill).rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=(22, 22, 26, 120))
    return pill, lay


def ai_notice(c, t):
    if t >= NOTICE_SEC:
        return
    a = clamp01((NOTICE_SEC - t) / 0.35)                      # 0초부터 보이고 끝에서만 사라진다
    pill, lay = notice_layers()
    blit(c, pill, W / 2, 1512, alpha=a)
    blit(c, lay, W / 2, 1512, alpha=a)


SCENES = [s_intro, s_logo, s_title, s_drop, s_cute, s_tok, s_size, s_relax, s_quad, s_attach, s_durable,
          s_patent, s_colors, s_brand1, s_flash(PINK), s_brand2, s_brand3, s_small, s_bigger, s_burst,
          s_rest, s_discover, s_end]
assert len(SCENES) == len(B) - 1


def scene_at(t):
    return max(k for k in range(len(SCENES)) if B[k] <= t + 1e-6)


def render_stills(times, out_prefix):
    """확인용 — 그 장면의 처음부터 지정 시각까지 돌려(실사 클립이 제자리까지 읽히게) 마지막 프레임만 남긴다."""
    load_assets()
    for t in times:
        i = scene_at(t)
        f0, f1 = math.ceil((B[i] - 1e-6) * FPS), int(round(t * FPS))
        c = None
        for f in range(f0, max(f0, f1) + 1):
            c = SCENES[i](f / FPS - B[i], B[i + 1] - B[i])
        ai_notice(c, t)
        c.convert("RGB").save(f"{out_prefix}_{t:05.2f}.jpg", quality=88)
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
        c = SCENES[i](t - B[i], B[i + 1] - B[i])
        ai_notice(c, t)
        enc.stdin.write(c.convert("RGB").tobytes())
        if f % 60 == 0:
            print(f"{t:5.1f}s / {B[-1]}s", flush=True)
    enc.stdin.close()
    enc.wait()
    close_readers()
    # 음원은 가로 최종본과 같은 것(2박 잘라 이어 붙인 것) — 이미 AAC 라 그대로 싣는다
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-i", os.path.join(A, "pyr_audio_cut.m4a"),
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", out], check=True)
    os.remove(tmp)
    print("완료 ->", out)


if __name__ == "__main__":
    if STILLS:
        render_stills(TIMES, PREFIX)
    else:
        main(OUT)
