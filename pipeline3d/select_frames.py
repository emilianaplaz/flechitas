"""Picks the sharpest frame in each time window of a video, so blurred frames never reach COLMAP.

Reads the video directly (no temporary folder of thousands of frames), scores every frame with the
variance of the Laplacian (higher = sharper), keeps the best one per window, and drops a window
whose best frame is still clearly blurred compared with the rest of the video.

Usage: python -I select_frames.py <video> <out_dir> [per_second=3] [prefix=a]
Writes <out_dir>/<prefix>_00001.jpg … and <out_dir>/frames.csv (name, time_s, sharpness), which
the georeference step uses to match frames to GPS by time.
"""
import csv
import sys
from pathlib import Path

import cv2
import numpy as np

video, out_dir = sys.argv[1], Path(sys.argv[2])
per_second = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
prefix = sys.argv[4] if len(sys.argv) > 4 else "a"
out_dir.mkdir(parents=True, exist_ok=True)

cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
window = max(1, round(fps / per_second))  # frames per window

best = []  # (sharpness, time_s, frame) per window
cur = None
i = 0
while True:
    ok, frame = cap.read()
    if not ok:
        break
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    # Score on a downscaled copy: faster, and less sensitive to sensor noise than full resolution.
    small = cv2.resize(gray, (640, int(640 * gray.shape[0] / gray.shape[1])))
    score = cv2.Laplacian(small, cv2.CV_64F).var()
    if cur is None or score > cur[0]:
        cur = (score, i / fps, frame)
    i += 1
    if i % window == 0:
        best.append(cur)
        cur = None
if cur is not None:
    best.append(cur)
cap.release()

scores = np.array([b[0] for b in best])
floor = 0.35 * np.median(scores)  # a window whose sharpest frame is this blurred is useless
kept = [b for b in best if b[0] >= floor]

with open(out_dir / "frames.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["name", "time_s", "sharpness"])
    for k, (score, t, frame) in enumerate(kept, 1):
        name = f"{prefix}_{k:05d}.jpg"
        cv2.imwrite(str(out_dir / name), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        w.writerow([name, f"{t:.3f}", f"{score:.1f}"])

print(f"{i} frames read at {fps:.1f} fps, {len(best)} windows, kept {len(kept)} (dropped {len(best) - len(kept)} blurred)")
print(f"sharpness of kept frames: median {np.median([b[0] for b in kept]):.0f}, min {min(b[0] for b in kept):.0f}")
