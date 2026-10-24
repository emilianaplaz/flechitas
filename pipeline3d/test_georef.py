"""Synthetic check of georef.py: take a real COLMAP model, move its cameras by a known scale, heading
and offset, turn that into a GPS track (with the app's lat/lon formula) plus 3 m of noise, and check
georef.py recovers the transform.

Usage: python -I pipeline3d/test_georef.py [colmap_txt_dir]
Needs a COLMAP TXT model (cameras.txt, images.txt, points3D.txt) whose image names sort in time order;
frames are assumed 1/3 s apart. Default: the pilot zone's model on the laptop that built it.
"""
import csv
import importlib.util
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
model = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Platanus\Proyecto\street3d\work\dense_txt")
if not (model / "images.txt").exists():
    print(f"skip: no COLMAP TXT model at {model}")
    sys.exit(0)

spec = importlib.util.spec_from_file_location("georef", HERE / "georef.py")
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

S_TRUE, HEADING_TRUE, OFFSET = 2.61, 37.0, (12.0, -40.0)
LAT0, LON0 = 10.4846, -66.8529

cams = g.read_cameras(model)
names = sorted(cams)
C = np.array([cams[n][1] for n in names])
up = -np.mean([cams[n][0].T @ np.array([0, 1.0, 0]) for n in names], axis=0)
up /= np.linalg.norm(up)
ex = np.cross(up, [1.0, 0, 0])
ex /= np.linalg.norm(ex)
R0 = np.stack([ex, up, np.cross(ex, up)])
Cl = C @ R0.T
th = math.radians(HEADING_TRUE)
R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
truth = (S_TRUE * (R @ Cl[:, [0, 2]].T)).T + OFFSET
noisy = truth + np.random.default_rng(3).normal(0, 3 / math.sqrt(2), truth.shape)

with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    with open(tmp / "frames.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["name", "time_s", "sharpness"])
        for k, n in enumerate(names):
            w.writerow([n, f"{k / 3:.3f}", 0])
    pts = [
        {"t": k / 3, "lat": LAT0 + (-z) / g.M_PER_DEG_LAT, "lon": LON0 + x / (math.cos(math.radians(LAT0)) * g.M_PER_DEG_LON)}
        for k, (x, z) in enumerate(noisy)
    ]
    (tmp / "track.json").write_text(json.dumps({"version": 1, "points": pts}))
    subprocess.run(
        [sys.executable, "-I", str(HERE / "georef.py"), str(model), str(tmp / "frames.csv"), str(tmp / "track.json"), str(tmp / "out"), "--origin", f"{LAT0},{LON0}"],
        check=True,
    )
    r = json.loads((tmp / "out" / "georef.json").read_text())

M = np.array(r["modelToEnu"]).reshape(4, 4).T
P = C @ M[:3, :3].T + M[:3, 3]
err = np.linalg.norm(P[:, [0, 2]] - truth, axis=1)
ok_scale = abs(r["scale"] - S_TRUE) / S_TRUE < 0.01
ok_err = float(np.median(err)) < 0.5
print(f"scale {r['scale']:.3f} (true {S_TRUE}) {'ok' if ok_scale else 'FAIL'}; "
      f"median error vs noise-free truth {np.median(err):.2f} m {'ok' if ok_err else 'FAIL'}")
sys.exit(0 if ok_scale and ok_err else 1)
