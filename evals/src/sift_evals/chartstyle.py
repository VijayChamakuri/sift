"""One chart style for the project pages, shared with TrustGate, CommitCompass, JudgeGate and Sift.

Plain and quiet so the figures sit inside a written page: sans labels that match the page's tables,
left-aligned regular-weight titles, a light horizontal grid and no box. The four series colours
pass a colour-blind separation check (OKLab ΔE >= 14 between neighbours under protan/deutan/tritan).
"""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from cycler import cycler  # noqa: E402

INK, INK2, MUTED, GRID = "#1c1b19", "#47443e", "#77736a", "#ebe6db"
BLUE, ORANGE, PURPLE, GREEN = "#2b62ad", "#d0732e", "#8156a8", "#2f8f5b"
SERIES = (BLUE, ORANGE, PURPLE, GREEN)  # fixed order, never cycled
NEUTRAL = "#a8a397"  # reference rows and baselines
FLAG = "#a3261b"  # reserved for "broke the budget"; never a series colour

RC = {
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "savefig.facecolor": "white",
    "font.family": "sans-serif",
    "font.sans-serif": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
    "font.size": 9.5,
    "axes.titlesize": 10.5,
    "axes.titleweight": "normal",
    "axes.titlelocation": "left",
    "axes.titlecolor": INK,
    "axes.titlepad": 10,
    "axes.labelsize": 9.5,
    "axes.labelcolor": INK2,
    "axes.edgecolor": MUTED,
    "axes.linewidth": 0.8,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "axes.grid.axis": "y",
    "axes.axisbelow": True,
    "axes.prop_cycle": cycler(color=list(SERIES)),
    "grid.color": GRID,
    "grid.linewidth": 0.8,
    "xtick.color": MUTED,
    "ytick.color": MUTED,
    "xtick.labelcolor": INK2,
    "ytick.labelcolor": INK2,
    "xtick.labelsize": 8.5,
    "ytick.labelsize": 8.5,
    "ytick.major.size": 0,
    "legend.frameon": False,
    "legend.fontsize": 8.5,
    "legend.labelcolor": INK2,
    "lines.linewidth": 1.8,
    "lines.markersize": 5,
    "patch.linewidth": 0,
    "savefig.dpi": 200,
    "savefig.bbox": "tight",
    "savefig.pad_inches": 0.12,
}


def apply() -> None:
    plt.rcParams.update(RC)  # type: ignore[arg-type]  # rcParams keys are typed as literals
