"""
요기보 맥스 CF 리메이크 v2 — 원본 레퍼런스 느낌 그대로 (사용자 요청 2026-10-01 「원래 레퍼런스 느낌」).

v1(cf_max.py)이 피라미드 톤으로 바꾼 것이라면, 이쪽은 레퍼런스 구성을 그대로 따른다:
검정·흰 글자 카드(한글은 그라데이션, 영문은 Cooper 풍 세리프 = OFL Fraunces) + 흰 바탕의 파란 공식 CG 맥스.
레퍼런스가 실사였던 자리만 우리 모델로 바꿨다 — Transforming 두 컷, 원단, 우주(우주비행사 → 우주에 떠 있는 여성A),
지치고 힘든(엄마와 뛰노는 아이들) · 몸과 마음이(남성E), 힐링(러그 위 여성B), Colorful 파우더(생성 영상).
맥스가 나오는 거실 실사는 이관 컷(맥스 크기가 정확한 원본) 자체를 편집해 배경을 바꾼 한 장에서 영상화했다
(오려 붙인 합성은 티가 나서 버렸다). 우주 장면만 이관 컷을 오려 우주 배경에 띄운 것.

구간 시각·음원·도구는 cf_max.py 와 같다(그 모듈을 불러 쓴다).
사용: python cf_max_ref.py <출력.mp4> [자산폴더]
"""
import math, os, random, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cf_max as base  # noqa: E402
from cf_max import (W, H, B, FPS_NUM, FPS_DEN, FPS, A, RAINBOW,  # noqa: E402
                    sprite, grad_text, live, close_readers, READERS, color_ring, s_30b)
from cf_full import clamp01, ease_out_back, ease_out_cubic, ease_in_out, text_layer, blit, pop_text  # noqa: E402
from cf_pyramid import solid, soft_shadow  # noqa: E402

BLACK, WHITE, INK = (8, 8, 10), (255, 255, 255), (20, 20, 22)
ICE = [(245, 248, 255), (175, 215, 255), (105, 160, 255)]          # 흰 → 하늘 → 파랑 (레퍼런스 한글 카드)
PASTEL = [(255, 186, 214), (190, 236, 226), (140, 190, 255)]         # 분홍 → 민트 → 파랑
TEAL = [(120, 225, 214), (70, 170, 205)]

# 이 버전의 실사 클립 — base.ClipReader 가 base.CLIPS 를 찾으므로 그쪽을 바꿔 둔다
base.CLIPS.clear()
base.CLIPS.update({
    "topWD": ("x_topWD.mp4", 1.0), "topWB": ("x_topWB.mp4", 1.2), "fabric": ("x_fabric.mp4", 0.9),
    "space": ("v2_space.mp4", 0.4), "mom": ("v2_mom.mp4", 1.0), "man": ("v2_man.mp4", 1.0),
    "heal": ("x_one_rug.mp4", 1.8), "powder": ("v2_powder.mp4", 0.4),
})


def raw(shape):
    """레퍼런스 CG 그대로의 파란 맥스."""
    return base.ASSETS[shape]


def en_card(text, t, size=170, bg=WHITE, color=INK):
    c = solid(bg)
    k = ease_out_cubic(t / 0.25)
    blit(c, text_layer(text, "en", size, color), W / 2, H / 2 + 18 * (1 - k), scale=0.96 + 0.04 * k + 0.01 * t, alpha=k)
    return c


def kr_card(text, t, stops, size=150, bg=BLACK, weight=760):
    c = solid(bg)
    k = ease_out_cubic(t / 0.22)
    blit(c, grad_text(text, weight, size, stops), W / 2, H / 2 + 14 * (1 - k), alpha=k)
    return c


def cg_card(shape, t, T, height=720, rot0=-10):
    """흰 바탕에 파란 공식 CG 맥스 — 살짝 돌며 자리 잡는다(레퍼런스의 회전 CG 느낌)."""
    c = solid(WHITE)
    sp = raw(shape)
    k = ease_out_cubic(t / 0.45)
    s = height / max(sp.width, sp.height) * (0.9 + 0.1 * k)
    soft_shadow(c, W / 2, H / 2 + sp.height * s * 0.5 + 6, sp.width * s * 0.8, 0.12)    # 맥스 바닥 바로 아래
    blit(c, sp, W / 2, H / 2, scale=s, rot=rot0 * (1 - k) + 2 * math.sin(t * 1.5))
    return c


# ── 장면들 ────────────────────────────────────────────────
def s_intro(t, T):
    c = solid(BLACK)
    sp = raw("lying")
    blit(c, sp, 190 + 30 * t, 70 + 12 * t, scale=1500 / sp.width, rot=-32, alpha=0.95)       # 왼쪽 위 모서리에 걸친 큰 맥스
    k = ease_out_cubic((t - 0.25) / 0.45)
    a = text_layer("The Disruptive ", "en", 78, WHITE)
    b = grad_text("Furniture", "en", 78, [(150, 205, 255), (95, 150, 255)])
    wa, wb = a.width - 80, b.width - 80
    x0 = W / 2 - (wa + wb) / 2
    blit(c, a, x0 + wa / 2, H / 2 + 20 * (1 - k), alpha=k)
    blit(c, b, x0 + wa + wb / 2, H / 2 + 20 * (1 - k), alpha=k)
    return c


def s_logo(t, T):
    c = solid(WHITE)
    blit(c, base.ASSETS["logo"], W / 2, H / 2, scale=1.3 * ease_out_back(t / 0.3), alpha=clamp01(t / 0.1))
    return c


def s_hero(t, T):
    return cg_card("lying", t, T, height=620, rot0=-6)


def s_trans1(t, T):
    c = live("topWD", T)
    pop_text(c, grad_text("Transforming", "en", 140, [(255, 255, 255), (255, 232, 150), (255, 170, 205)]), W / 2, H / 2, t, 0.02)
    return c


def s_trans2(t, T):
    c = live("topWB", T)
    blit(c, grad_text("Transforming", "en", 140, [(255, 255, 255), (170, 225, 255), (140, 170, 255)]), W / 2, H / 2)
    return c


def s_adapt(t, T):
    """내 몸에 맞게 → 알아서 → (글자가 흩어졌다가) → 변형된다."""
    c = solid(BLACK)
    if t < 1.15:
        a = grad_text("내 몸에", 760, 110, ICE[:2])
        pop_text(c, a, W / 2 - 150, H / 2, t, 0.05, grow=False)
        pop_text(c, grad_text("맞게", 800, 110, ICE[1:]), W / 2 + 175, H / 2, t, 0.45, dur=0.25)
    elif t < 1.62:
        pop_text(c, grad_text("알아서", 800, 130, PASTEL[1:]), W / 2, H / 2, t, 1.15, dur=0.2)
    elif t < 2.0:
        u = ease_in_out((t - 1.62) / 0.38)                            # 글자가 흩어진다
        rnd = random.Random(3)
        for i, ch in enumerate("알아서"):
            lay = grad_text(ch, 800, 130, PASTEL[1:])
            dx, dy, rr = rnd.uniform(-420, 420), rnd.uniform(-260, 260), rnd.uniform(-90, 90)
            blit(c, lay, W / 2 + (i - 1) * 150 + dx * u, H / 2 + dy * u, scale=1 - 0.5 * u, rot=rr * u, alpha=1 - 0.6 * u)
    else:
        pop_text(c, grad_text("변형된다", 800, 130, ICE), W / 2, H / 2, t, 2.0, dur=0.25)
    return c


def s_durable(t, T):
    return en_card("Durable", t)


def s_patent(t, T):
    c = live("fabric", T)
    pop_text(c, text_layer("특허 기반의 기술력", 780, 92, WHITE, shadow=True), W / 2, H / 2 + 120, t, 0.12, grow=False)
    return c


def s_chair_t(t, T):
    return kr_card("의자", t, [(245, 246, 250), (190, 198, 220)], size=160)


def s_chair(t, T):
    return cg_card("chair", t, T, height=760)


def s_recl_t(t, T):
    return kr_card("리클라이너", t, PASTEL, size=150)


def s_recl(t, T):
    return cg_card("recliner", t, T, height=700, rot0=8)


def s_sofa_t(t, T):
    return kr_card("소파 & 침대", t, [(255, 186, 214), (180, 200, 255)], size=150)


def s_bed(t, T):
    return cg_card("bed", t, T, height=600, rot0=-5)


def s_light(t, T):
    return en_card("Super Light", t, size=160)


def s_space1(t, T):
    c = live("space", B[17] - B[15])                                   # 뒤 장면(s_space2)까지 한 번에 읽어 이어 쓴다
    blit(c, grad_text("우주 속", 800, 130, [(255, 200, 230), (205, 175, 255)]), W / 2, H / 2 + 260, alpha=0.92 * clamp01(t / 0.15))
    return c


def s_space2(t, T):
    c = live("space", T)
    blit(c, grad_text("무중력 편안함", 800, 120, [(255, 255, 255), (255, 190, 225)]), W / 2, H / 2 + 260,
         alpha=clamp01(t / 0.15))
    return c


def s_relax(t, T):
    return en_card("Relaxing", t, size=150)


def s_tired1(t, T):
    c = live("mom", T)
    pop_text(c, text_layer("지치고 힘든", 800, 112, WHITE, shadow=True), 150, 300, t, 0.06, anchor="l", grow=False)
    return c


def s_tired2(t, T):
    c = live("man", T)
    lay = text_layer("몸과 마음이", 800, 112, WHITE, shadow=True)
    pop_text(c, lay, W - 150 - lay.width, 300, t, 0.06, anchor="l", grow=False)
    return c


def s_heal_t(t, T):
    return kr_card("힐링", t, TEAL, size=120)


def s_heal_t2(t, T):
    return kr_card("힐링되다", t, TEAL, size=130, bg=WHITE)


def s_heal(t, T):
    return live("heal", T)


def s_colorful_t(t, T):
    c = solid(BLACK)
    blit(c, grad_text("Colorful", "en", 270, RAINBOW), W / 2, H / 2, scale=0.85 + 0.2 * ease_out_cubic(t / T))
    return c


def s_colorful(t, T):
    c = live("powder", T)
    blit(c, text_layer("Colorful", "en", 190, WHITE, shadow=True), W / 2, H / 2, scale=0.95 + 0.05 * t / T)
    return c


def s_30a(t, T):
    c = solid(WHITE)
    color_ring(c, t, 700, 400, 230, 0.25 * t)
    pop_text(c, text_layer("30가지", 900, 150, INK), W / 2, H / 2 - 90, t, 0.25, dur=0.25)
    pop_text(c, text_layer("이상의 컬러로", 820, 96, INK), W / 2, H / 2 + 60, t, 0.45, dur=0.25)
    return c


FASHION_SETS = [["olive", "lightgrey", "cherry", "rose"], ["yellow", "aqua", "orange", "purple"],
                ["mint", "navy", "coral", "lavender"], ["rose", "olive", "blossom", "darkgrey"]]


def s_fashion(t, T):
    """의자 모양 맥스 네 개가 나란히 — 박자마다 커버 색이 한꺼번에 바뀐다(레퍼런스의 색 바꾸는 CG)."""
    c = solid(WHITE)
    beat = T / len(FASHION_SETS)
    cols = FASHION_SETS[min(len(FASHION_SETS) - 1, int(t / beat))]
    tb = t % beat
    for i, col in enumerate(cols):
        sp = sprite("chair", col)
        k = ease_out_back((t - 0.06 * i) / 0.3)
        pulse = 1 + 0.05 * math.exp(-10 * tb)                          # 색이 바뀌는 순간 톡
        x = W / 2 + (i - 1.5) * 380
        soft_shadow(c, x, H / 2 + 330, 300, 0.1)
        blit(c, sp, x, H / 2 + 20, scale=(640 / sp.height) * k * pulse, rot=(i - 1.5) * 4)
    pop_text(c, text_layer("패션처럼 바꾼다", 880, 116, WHITE, shadow=True), W / 2, H / 2 + 10, t, 0.15, grow=False)
    return c


def s_rest(t, T):
    """컬러 맥스들이 왼쪽 아래에서 오른쪽 위로 흘러가고, 글자는 왼쪽으로 흐르며 한 자씩 드러난다."""
    c = solid(WHITE)
    for x0, y0, spd, rot, shape, col in base.ASSETS["fly"]:
        sp = sprite(shape, col)
        x = (x0 + 0.20 * spd * t) * W
        y = (y0 - 0.14 * spd * t) * H
        blit(c, sp, x, y, scale=(320 / sp.width) * (0.7 + 0.4 * spd), rot=rot + 10 * t)
    text = "휴식할 땐 요기보"
    lay = text_layer(text, 800, 110, INK)
    shown = clamp01((t - 0.15) / 1.6)
    cut = int(lay.width * min(1.0, 0.12 + shown))                       # 왼쪽부터 드러나는 폭
    part = lay.crop((0, 0, max(1, cut), lay.height))
    drift = -120 * ease_in_out(t / T)
    blit(c, part, W / 2 - lay.width / 2 + part.width / 2 + drift, H / 2)
    return c


def s_discover(t, T):
    return en_card("Discover the Feel", t, size=110)


def s_end(t, T):
    c = solid(WHITE)
    k = ease_out_cubic(t / 0.45)
    blit(c, base.ASSETS["logo"], W / 2, H / 2, scale=1.35 * (0.9 + 0.1 * k), alpha=k)
    return c


SCENES = [s_intro, s_logo, s_hero, s_trans1, s_trans2, s_adapt, s_durable, s_patent, s_chair_t, s_chair,
          s_recl_t, s_recl, s_sofa_t, s_bed, s_light, s_space1, s_space2, s_relax, s_tired1, s_tired2,
          s_heal_t, s_heal_t2, s_heal, s_colorful_t, s_colorful, s_30a, s_30b, s_fashion, s_rest,
          s_discover, s_end]
assert len(SCENES) == len(B) - 1
CONTINUE = {s_space2: "space"}


def scene_at(t):
    return max(k for k in range(len(SCENES)) if B[k] <= t + 1e-6)


def render_stills(times, out_prefix):
    base.load_assets()
    for t in times:
        i = scene_at(t)
        SCENES[i](t - B[i], B[i + 1] - B[i]).convert("RGB").save(f"{out_prefix}_{t:05.2f}.jpg", quality=88)
        close_readers()


def main(out):
    base.load_assets()
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
