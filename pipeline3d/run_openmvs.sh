#!/usr/bin/env bash
# Step 5 of pipeline3d/README.md: dense cloud, mesh and texture from a COLMAP model (OpenMVS, CPU build).
#
# Env vars:
#   ZONE_DIR   zone folder (zones/<id>)                                                  (required)
#   MODEL      COLMAP model to use                          (default: $ZONE_DIR/colmap/sparse/0)
#   COLMAP     path to colmap(.exe)                                    (default: colmap on PATH)
#   OPENMVS    folder with the OpenMVS executables       (default: InterfaceCOLMAP etc. on PATH)
#   RES        densify resolution level: 0 = full size (≤1080p input), 1 = half (4K input) (default 0)
#   CLEAN      1 = remove floating bits and close small holes in the mesh                 (default 1)
# Output: $ZONE_DIR/mvs/street.glb + street_0.png (keep them together: the texture is a separate file).
# OpenMVS writes its console output to <Tool>-*.log files in $ZONE_DIR/mvs, not to the terminal.
set -euo pipefail
: "${ZONE_DIR:?set ZONE_DIR to the zone folder}"
MODEL=${MODEL:-$ZONE_DIR/colmap/sparse/0}
COLMAP=${COLMAP:-colmap}
RES=${RES:-0}
CLEAN=${CLEAN:-1}
mvs() { if [ -n "${OPENMVS:-}" ]; then "$OPENMVS/$1" "${@:2}"; else "$1" "${@:2}"; fi; }
OUT="$ZONE_DIR/mvs"
rm -rf "$OUT"

echo "[1/5] undistort (OpenMVS needs PINHOLE cameras)"
"$COLMAP" image_undistorter --image_path "$ZONE_DIR/frames" --input_path "$MODEL" --output_path "$OUT" --output_type COLMAP
cd "$OUT"

echo "[2/5] import into OpenMVS"
mvs InterfaceCOLMAP -i . -o scene.mvs --image-folder images/ -w .

echo "[3/5] densify (the slow step: ~10 s per frame on a laptop CPU)"
mvs DensifyPointCloud scene.mvs --resolution-level "$RES" --number-views 6 -w .

echo "[4/5] mesh"
CLEANUP=()
if [ "$CLEAN" = 1 ]; then CLEANUP=(--remove-spurious 30 --close-holes 50 --smooth 2); fi
mvs ReconstructMesh scene_dense.mvs "${CLEANUP[@]}" -w .

echo "[5/5] texture + export glb"
# Seam leveling off: with it, this build blacked out every textured face (photo-sampled faces 2 % -> 98 %
# without it). Empty colour gray (8421504) instead of the default orange for faces no photo saw.
mvs TextureMesh scene_dense.mvs --mesh-file scene_dense_mesh.ply --decimate 0.5 \
  --global-seam-leveling 0 --local-seam-leveling 0 --empty-color 8421504 --export-type glb -o street.mvs -w .
ls -la street.glb street_0.png
echo DONE
