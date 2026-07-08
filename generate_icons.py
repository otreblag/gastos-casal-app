"""
Gera todos os ícones do app a partir das cores do logo Anna e Gabriel:
  - assets/icon.png        512x512  (electron-builder)
  - assets/icon.ico        multi-size .ico para Windows
  - assets/tray-icon.png  64x64 redondo (system tray)
"""
from PIL import Image, ImageDraw, ImageFont
import math, os, struct, zlib

# ─── Paleta do logo ───────────────────────────────────────────────────────────
BG     = (52, 75, 98)     # #344B62  slate-blue do fundo
CREAM  = (237, 233, 222)  # #EDE9DE  cream dos elementos

ASSETS = os.path.join(os.path.dirname(__file__), 'assets')
os.makedirs(ASSETS, exist_ok=True)

# ─── Função: desenhar o mark (barras + linha de tendência) ────────────────────
def draw_mark(draw, cx, cy, scale=1.0, color=CREAM):
    """
    Desenha o mark (gráfico de barras + seta de tendência) centrado em (cx,cy).
    scale multiplica todas as dimensões (base ~200px de altura total do mark).
    """
    s = scale
    lw = max(1, round(7 * s))  # line width

    # Dimensões das 3 barras
    bw  = round(52 * s)
    gap = round(20 * s)
    # Alturas relativas (visual do logo: barra 1 média, barra 2 pequena, barra 3 alta)
    h1 = round(160 * s)
    h2 = round(100 * s)
    h3 = round(230 * s)

    total_w = 3 * bw + 2 * gap
    x0 = cx - total_w // 2
    base_y = cy + round(130 * s)   # base das barras

    # Coordenadas X do centro de cada barra
    bx = [x0 + i * (bw + gap) for i in range(3)]

    # Desenha barras
    for i, (bxi, hi) in enumerate(zip(bx, [h1, h2, h3])):
        draw.rectangle([bxi, base_y - hi, bxi + bw, base_y], fill=color)

    # Linha de tendência (dip + rise + seta)
    # Pontos: começa no topo da barra 1, desce ao vale entre 1-2, sobe além da barra 3
    p0 = (bx[0] + bw // 2,          base_y - h1 + round(20 * s))
    p1 = (bx[1] + bw // 2,          base_y - h2 + round(80 * s))  # vale
    p2 = (bx[2] + bw // 2,          base_y - h3 - round(10 * s))  # topo barra 3
    p3 = (bx[2] + bw + round(60*s), base_y - h3 - round(70*s))    # seta
    pts = [p0, p1, p2, p3]

    for i in range(len(pts) - 1):
        draw.line([pts[i], pts[i+1]], fill=color, width=lw)

    # Cabeça da seta
    angle = math.atan2(p3[1] - p2[1], p3[0] - p2[0])
    arr_len = round(28 * s)
    arr_angle = math.pi / 6
    ax1 = (p3[0] - arr_len * math.cos(angle - arr_angle),
           p3[1] - arr_len * math.sin(angle - arr_angle))
    ax2 = (p3[0] - arr_len * math.cos(angle + arr_angle),
           p3[1] - arr_len * math.sin(angle + arr_angle))
    draw.line([p3, ax1], fill=color, width=lw)
    draw.line([p3, ax2], fill=color, width=lw)

# ─── Criar icon.png 512x512 ───────────────────────────────────────────────────
def make_icon_png(path, size=512):
    img  = Image.new('RGBA', (size, size), BG + (255,))
    draw = ImageDraw.Draw(img)

    # Mark no terço superior-central
    mark_cy = int(size * 0.42)
    draw_mark(draw, size // 2, mark_cy, scale=size / 512)

    # Texto "ANNA E GABRIEL"
    font_size_main = max(8, int(size * 0.072))
    font_size_sub  = max(6, int(size * 0.048))
    try:
        font_main = ImageFont.truetype("arial.ttf", font_size_main)
        font_sub  = ImageFont.truetype("arial.ttf", font_size_sub)
    except:
        font_main = ImageFont.load_default()
        font_sub  = font_main

    text_main = "ANNA E GABRIEL"
    text_sub  = "Controle Financeiro"

    # Simula letter-spacing adicionando espaços entre letras
    spaced = "  ".join(text_main)

    y_main = int(size * 0.77)
    y_sub  = int(size * 0.855)

    # Centro horizontal
    bbox_m = draw.textbbox((0, 0), spaced, font=font_main)
    bbox_s = draw.textbbox((0, 0), text_sub, font=font_sub)
    x_main = (size - (bbox_m[2] - bbox_m[0])) // 2
    x_sub  = (size - (bbox_s[2] - bbox_s[0])) // 2

    draw.text((x_main, y_main), spaced,    fill=CREAM, font=font_main)
    draw.text((x_sub,  y_sub),  text_sub,  fill=CREAM, font=font_sub)

    img.save(path, 'PNG')
    print(f'  icon.png ({size}x{size}) → {path}')
    return img


# ─── Criar tray-icon.png: redondo, só o mark ─────────────────────────────────
def make_tray_icon(path, size=64):
    # Renderiza em 4x para anti-aliasing
    big = size * 4
    img  = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Círculo de fundo
    draw.ellipse([0, 0, big - 1, big - 1], fill=BG + (255,))

    # Mark centralizado (sem texto — muito pequeno para ler)
    draw_mark(draw, big // 2, big // 2 - round(big * 0.04), scale=big / 680)

    # Reduz com anti-aliasing
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path, 'PNG')
    print(f'  tray-icon.png ({size}x{size}) → {path}')


# ─── Criar .ico com múltiplos tamanhos ────────────────────────────────────────
def make_ico(path, base_img):
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs  = []
    for s in sizes:
        resized = base_img.resize((s, s), Image.LANCZOS)
        imgs.append(resized)

    # Salva como ICO multi-size (PIL exige redimensionar a partir da maior imagem)
    img_256 = base_img.resize((256, 256), Image.LANCZOS).convert('RGBA')
    img_256.save(
        path,
        format='ICO',
        sizes=[(s, s) for s in sizes]
    )
    print(f'  icon.ico ({", ".join(str(s) for s in sizes)}px) → {path}')


# ─── Gera tudo ────────────────────────────────────────────────────────────────
print('Gerando ícones...')
icon_path  = os.path.join(ASSETS, 'icon.png')
ico_path   = os.path.join(ASSETS, 'icon.ico')
tray_path  = os.path.join(ASSETS, 'tray-icon.png')

base = make_icon_png(icon_path, size=512)
make_ico(ico_path, base)
make_tray_icon(tray_path, size=64)

print('Pronto.')
