"""Georeference a COLMAP model with the GPS track recorded alongside the video (SPEC-3D-STREETS Step 4).

Puts the model in the app's local ENU frame, Three.js axes: +X east, +Y up, -Z north, metres, with
the origin at a chosen lat/lon. Uses the same flat-earth formula as src/core/geo.ts (toLocal), so the
model and the route line up in the app.

How:
  1. "Up" in the model = average of the cameras' up direction (camera y points down in the image).
     The model is rotated so that up is +Y. GPS has no reliable altitude, so the fit is done on the
     ground plane only.
  2. Each frame gets a GPS position by interpolating the track at the frame's time (frames.csv from
     select_frames.py, plus --sync seconds if video and track didn't start together).
  3. A 2D similarity (scale, heading, offset; Umeyama) maps camera centres onto those GPS points.
  4. Height: the ground under the cameras goes to y = 0 (where the app draws the road), measured
     from the sparse points under the cameras; --eye is the fallback camera height.

Writes georef.json (origin, 4x4 model->ENU matrix, residuals) and, with --glb, a copy of the mesh with
that matrix on its root node (vertices untouched; the viewer applies it).

Usage:
  python -I georef.py <colmap_txt_dir> <frames.csv> <track.json> <out_dir>
         [--origin LAT,LON] [--sync SECONDS] [--eye 1.5] [--glb in.glb]
track.json: the app's recorder format {"points": [{"t": s, "lat": .., "lon": ..}, ...]} or a plain list.
"""
import argparse
import csv
import json
import math
import struct
from pathlib import Path

import numpy as np

M_PER_DEG_LAT = 110540.0  # same constants as src/core/geo.ts
M_PER_DEG_LON = 111320.0


def enu(origin, lat, lon):
    """(east, north) metres from origin, same as geo.ts toLocal (with z = -north)."""
    return (
        (lon - origin[1]) * math.cos(math.radians(origin[0])) * M_PER_DEG_LON,
        (lat - origin[0]) * M_PER_DEG_LAT,
    )


def qvec2rot(w, x, y, z):
    return np.array(
        [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
            [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
            [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
        ]
    )


def read_cameras(txt_dir):
    lines = [l for l in (Path(txt_dir) / "images.txt").read_text().splitlines() if not l.startswith("#")]
    cams = {}
    for i in range(0, len(lines), 2):
        p = lines[i].split()
        if len(p) < 10:
            continue
        R = qvec2rot(*map(float, p[1:5]))
        t = np.array(list(map(float, p[5:8])))
        cams[p[9]] = (R, -R.T @ t)
    return cams


def read_points(txt_dir):
    pts = []
    for line in (Path(txt_dir) / "points3D.txt").read_text().splitlines():
        if line.startswith("#") or not line.strip():
            continue
        p = line.split()
        if float(p[7]) < 2.0:
            pts.append([float(p[1]), float(p[2]), float(p[3])])
    return np.array(pts)


def read_track(path):
    data = json.loads(Path(path).read_text())
    pts = data["points"] if isinstance(data, dict) else data
    pts = sorted(pts, key=lambda p: p["t"])
    return np.array([p["t"] for p in pts]), np.array([p["lat"] for p in pts]), np.array([p["lon"] for p in pts])


def umeyama_2d(src, dst):
    """Similarity dst ~ s * R @ src + t for 2D point sets (rows)."""
    ms, md = src.mean(0), dst.mean(0)
    a, b = src - ms, dst - md
    U, S, Vt = np.linalg.svd(b.T @ a / len(src))
    D = np.diag([1, np.sign(np.linalg.det(U @ Vt))])
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (a**2).sum(1).mean()
    return s, R, md - s * R @ ms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("colmap_txt")
    ap.add_argument("frames_csv")
    ap.add_argument("track")
    ap.add_argument("out_dir")
    ap.add_argument("--origin", help="LAT,LON of the zone origin (default: first GPS point)")
    ap.add_argument("--sync", type=float, default=0.0, help="seconds added to video time to get track time")
    ap.add_argument("--eye", type=float, default=1.5, help="camera height above the ground, m")
    ap.add_argument("--glb", help="mesh to copy with the transform on its root node")
    a = ap.parse_args()
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    cams = read_cameras(a.colmap_txt)
    times = {r["name"]: float(r["time_s"]) for r in csv.DictReader(open(a.frames_csv))}
    tt, tlat, tlon = read_track(a.track)
    origin = tuple(map(float, a.origin.split(","))) if a.origin else (float(tlat[0]), float(tlon[0]))

    names = [n for n in sorted(cams) if n in times and tt[0] <= times[n] + a.sync <= tt[-1]]
    if len(names) < 10:
        raise SystemExit(f"only {len(names)} frames overlap the GPS track; check --sync and the files")
    C = np.array([cams[n][1] for n in names])
    gps = []
    for n in names:
        t = times[n] + a.sync
        gps.append(enu(origin, np.interp(t, tt, tlat), np.interp(t, tt, tlon)))
    gps = np.array(gps)  # (east, north)

    # 1. Rotate the model so its up is +Y.
    up = -np.mean([cams[n][0].T @ np.array([0.0, 1.0, 0.0]) for n in names], axis=0)
    up /= np.linalg.norm(up)
    ref = np.array([1.0, 0.0, 0.0]) if abs(up[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
    ex = np.cross(up, ref)
    ex /= np.linalg.norm(ex)
    ez = np.cross(ex, up)
    R0 = np.stack([ex, up, ez])  # rows: new x, y, z; a proper rotation (up x ez = ex)
    Cl = C @ R0.T  # model, levelled

    # 2-3. Fit the ground plane: model (x, z) -> app (east, -north), i.e. Three.js (x, z).
    target = np.stack([gps[:, 0], -gps[:, 1]], axis=1)
    s, R2, t2 = umeyama_2d(Cl[:, [0, 2]], target)
    pred = (s * (R2 @ Cl[:, [0, 2]].T)).T + t2
    res = np.linalg.norm(pred - target, axis=1)

    # 4. Height: put the ground under the cameras at y = 0 (the app draws the road at y = 0).
    # The camera height above the ground is measured from the sparse points, now in metres thanks to
    # the GPS scale; --eye is only the fallback when there are too few points under the cameras.
    P = read_points(a.colmap_txt) @ R0.T
    drops = []
    for c in Cl[:: max(1, len(Cl) // 40)]:
        d = P - c
        horiz = np.hypot(d[:, 0], d[:, 2])
        near = d[:, 1][(horiz < np.percentile(horiz, 15)) & (d[:, 1] < 0)]
        if len(near) > 20:
            drops.append(-np.percentile(near, 10) * s)
    cam_height = float(np.median(drops)) if drops else a.eye
    ty = cam_height - float(np.median(Cl[:, 1])) * s

    # Assemble model -> ENU(three) as one 4x4: scale, level, rotate in the ground plane, translate.
    R3 = np.eye(3)
    R3[np.ix_([0, 2], [0, 2])] = R2
    M = np.eye(4)
    M[:3, :3] = s * R3 @ R0
    M[:3, 3] = [t2[0], ty, t2[1]]

    report = {
        "origin": {"lat": origin[0], "lon": origin[1]},
        "axes": "three.js: +X east, +Y up, -Z north, metres (src/core/geo.ts toLocal)",
        "modelToEnu": M.T.flatten().tolist(),  # column-major, ready for THREE.Matrix4.fromArray / glTF node.matrix
        "scale": float(s),
        "cameraHeightM": cam_height,  # measured; ~1.5 for a phone held at chest height
        "frames": len(names),
        "residualM": {"median": float(np.median(res)), "p90": float(np.percentile(res, 90)), "max": float(res.max())},
        "sync": a.sync,
    }
    (out / "georef.json").write_text(json.dumps(report, indent=2))
    print(f"{len(names)} frames, scale {s:.3f}, GPS residual median {report['residualM']['median']:.2f} m, "
          f"p90 {report['residualM']['p90']:.2f} m, max {report['residualM']['max']:.2f} m")

    if a.glb:
        put_matrix_on_glb(a.glb, out / Path(a.glb).name, report["modelToEnu"])
        print(f"wrote {out / Path(a.glb).name} (root node matrix set; copy its texture next to it)")


def put_matrix_on_glb(src, dst, matrix):
    data = open(src, "rb").read()
    jlen, _ = struct.unpack("<II", data[12:20])
    gltf = json.loads(data[20 : 20 + jlen])
    for i in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:
        node = gltf["nodes"][i]
        if any(k in node for k in ("matrix", "translation", "rotation", "scale")):
            raise SystemExit("root node already has a transform; combine them first")
        node["matrix"] = matrix
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js + data[20 + jlen :]
    open(dst, "wb").write(struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body)


if __name__ == "__main__":
    main()
