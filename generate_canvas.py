import matplotlib.pyplot as plt
import matplotlib.patches as patches
import matplotlib.patheffects as pe
import numpy as np
import os

output_path = os.path.join(os.path.dirname(__file__), 'mineral-repose-canvas.png')

# ─── Canvas setup ─────────────────────────────────────────────────────────────
W, H = 100, 141.4   # A4 proportions
fig = plt.figure(figsize=(10, 14.14), dpi=180)
fig.patch.set_facecolor('#F1F0EC')
ax = fig.add_axes([0, 0, 1, 1])
ax.set_facecolor('#F1F0EC')
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis('off')

# ─── Palette ──────────────────────────────────────────────────────────────────
bg      = '#F1F0EC'
surface = '#FFFFFF'
border  = '#DDDBD4'
muted   = '#8A8882'
warm    = '#6A6458'
dark    = '#1A1A1A'
accent  = '#1F3347'
danger  = '#8B2E2E'
success = '#235C3F'
faint   = '#F6F5F1'

# ─── Ledger lines (horizontal, very thin) ─────────────────────────────────────
for y in np.arange(18, 130, 6.5):
    ax.plot([7, 93], [y, y], color=border, linewidth=0.22, alpha=0.65)

# Left index line
ax.plot([7, 7], [15, 130], color=border, linewidth=0.45, alpha=0.5)

# ─── Title block ──────────────────────────────────────────────────────────────
ax.text(50, 120.5, 'MINERAL', ha='center', va='center',
        fontsize=56, fontfamily='Garamond', fontweight='normal',
        color=accent, alpha=0.92)
ax.text(50, 109, 'REPOSE', ha='center', va='center',
        fontsize=56, fontfamily='Garamond', fontweight='normal',
        color=accent, alpha=0.92)

# Rule below title
ax.plot([20, 80], [102.5, 102.5], color=border, linewidth=0.55)

# Subtitle
ax.text(50, 99.8, 'U M A   F I L O S O F I A   D E   D E S I G N', ha='center', va='center',
        fontsize=5.2, fontfamily='Segoe UI', color=muted, alpha=0.85)

# ─── Color palette swatches ───────────────────────────────────────────────────
palette_colors = [bg, faint, border, muted, warm, dark, accent, success, danger]
sw_w  = (86) / len(palette_colors) - 0.5
sw_h  = 5.5
sw_y  = 88.5
sw_x0 = 7
gap   = 0.5
for i, c in enumerate(palette_colors):
    x = sw_x0 + i * (sw_w + gap)
    r = patches.Rectangle((x, sw_y), sw_w, sw_h,
                           facecolor=c, edgecolor=border, linewidth=0.18)
    ax.add_patch(r)

ax.plot([7, 93], [87.2, 87.2], color=border, linewidth=0.3, alpha=0.6)

# ─── Main card ────────────────────────────────────────────────────────────────
card = patches.FancyBboxPatch((9, 26), 82, 55,
                              boxstyle='round,pad=0.3',
                              facecolor=surface, edgecolor=border, linewidth=0.4,
                              zorder=2)
ax.add_patch(card)

# Card internal h-grid
for y_g in [34, 42, 50, 58, 66, 74]:
    ax.plot([10.5, 89.5], [y_g, y_g], color=border, linewidth=0.18,
            linestyle='--', alpha=0.45, zorder=3)

# Y-axis ghost labels inside card
for i, (y_g, val) in enumerate(zip([34, 50, 66], ['1.000', '2.000', '3.500'])):
    ax.text(10, y_g, val, ha='right', va='center', fontsize=4.2,
            fontfamily='Segoe UI', color=muted, alpha=0.6, zorder=3)

# Bar chart
bars_data = [0.38, 0.62, 0.44, 0.81, 0.55, 0.68, 0.31, 0.90, 0.47, 0.73, 0.59, 0.85]
bar_w   = 4.8
spacing = 1.6
x0      = 12.5
y_base  = 28
max_h   = 44

for i, v in enumerate(bars_data):
    h = v * max_h
    x = x0 + i * (bar_w + spacing)
    # Muted bar body
    b = patches.Rectangle((x, y_base), bar_w, h,
                           facecolor=faint, edgecolor=border, linewidth=0.22, zorder=3)
    ax.add_patch(b)
    # Accent cap (top 10%)
    cap = patches.Rectangle((x, y_base + h - max(1.0, h * 0.08)), bar_w, max(1.0, h * 0.08),
                             facecolor=accent, edgecolor='none', alpha=0.38, zorder=4)
    ax.add_patch(cap)

# Trend line
xs = [x0 + i * (bar_w + spacing) + bar_w / 2 for i in range(12)]
ys = [y_base + v * max_h for v in bars_data]
ax.plot(xs, ys, color=danger, linewidth=0.75, alpha=0.38, zorder=5)
ax.scatter(xs, ys, s=4.5, color=danger, alpha=0.45, zorder=6)

# Month labels
months = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']
for i, m in enumerate(months):
    x = x0 + i * (bar_w + spacing) + bar_w / 2
    ax.text(x, y_base - 1.8, m, ha='center', va='top',
            fontsize=4.5, fontfamily='Segoe UI', color=muted, zorder=3)

# Card total annotation
ax.text(89, 76.5, 'R$ 4.820', ha='right', va='top', zorder=5,
        fontsize=10, fontfamily='Garamond', color=dark, alpha=0.72)
ax.text(89, 73.5, 'M A I   ·   2 0 2 6', ha='right', va='top', zorder=5,
        fontsize=4.5, fontfamily='Segoe UI', color=muted, alpha=0.7)

# ─── Person circles ───────────────────────────────────────────────────────────
theta = np.linspace(0, 2 * np.pi, 300)
r = 7.2

# Circle A (Gabriel)
cx1, cy1 = 20.5, 14.5
circle1 = plt.Polygon(
    list(zip(cx1 + r * np.cos(theta), cy1 + r * np.sin(theta))),
    closed=True, facecolor='none', edgecolor=accent, linewidth=0.55, alpha=0.55, zorder=1
)
ax.add_patch(circle1)
ax.text(cx1, cy1 + 0.4, 'G', ha='center', va='center',
        fontsize=12, fontfamily='Garamond', color=accent, alpha=0.65)
ax.text(cx1, cy1 - r - 1.4, 'G A B R I E L', ha='center', va='top',
        fontsize=4.2, fontfamily='Segoe UI', color=muted, alpha=0.75)

# Circle B (Anna)
cx2, cy2 = 40, 14.5
circle2 = plt.Polygon(
    list(zip(cx2 + r * np.cos(theta), cy2 + r * np.sin(theta))),
    closed=True, facecolor='none', edgecolor=danger, linewidth=0.55, alpha=0.55, zorder=1
)
ax.add_patch(circle2)
ax.text(cx2, cy2 + 0.4, 'A', ha='center', va='center',
        fontsize=12, fontfamily='Garamond', color=danger, alpha=0.65)
ax.text(cx2, cy2 - r - 1.4, 'A N N A', ha='center', va='top',
        fontsize=4.2, fontfamily='Segoe UI', color=muted, alpha=0.75)

# Thin bridge between circles
ax.plot([cx1 + r, cx2 - r], [cy1, cy2], color=border, linewidth=0.4, alpha=0.5)

# ─── Small geometric accent (right side, bottom) ──────────────────────────────
# A thin square — just edge, very subtle
sq = patches.Rectangle((74, 8), 12, 12,
                        facecolor='none', edgecolor=border, linewidth=0.4, alpha=0.5)
ax.add_patch(sq)
# Inner square (rotated feel — just another offset rect)
sq2 = patches.Rectangle((76.5, 10.5), 7, 7,
                         facecolor='none', edgecolor=muted, linewidth=0.25, alpha=0.3)
ax.add_patch(sq2)
ax.text(80, 14, 'R$', ha='center', va='center',
        fontsize=7, fontfamily='Garamond', color=muted, alpha=0.4)

# ─── Footer ───────────────────────────────────────────────────────────────────
ax.plot([7, 93], [5.5, 5.5], color=border, linewidth=0.35, alpha=0.7)
ax.text(50, 3.5, 'Gastos do Casal  ·  controle financeiro local', ha='center', va='center',
        fontsize=5, fontfamily='Segoe UI', color=muted, alpha=0.6)
ax.text(50, 1.5, '— mineral repose —', ha='center', va='center',
        fontsize=5, fontfamily='Garamond', style='italic', color=muted, alpha=0.4)

# ─── Export ───────────────────────────────────────────────────────────────────
plt.savefig(output_path, dpi=180, bbox_inches='tight',
            facecolor=bg, format='png')
plt.close()
print(f'Canvas saved: {output_path}')
