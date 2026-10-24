#!/usr/bin/env bash
# Step 3 of pipeline3d/README.md: camera poses from the selected frames (COLMAP, CPU build).
#
# Env vars:
#   ZONE_DIR  zone folder (zones/<id>), with frames/ from select_frames.py        (required)
#   COLMAP    path to colmap(.exe)                                                 (default: colmap on PATH)
#   VOCAB     vocabulary tree file to enable loop detection (when the walk comes back past the
#             same spot), e.g. vocab_tree_faiss_flickr100K_words32K.bin             (optional)
#   OVERLAP   frames matched to each neighbour in walking order                    (default 15)
# Output: $ZONE_DIR/colmap/{database.db,sparse/N}. Prints each sub-model's size; if there is more
# than one, merge them (README step 3, "If the model splits").
set -euo pipefail
: "${ZONE_DIR:?set ZONE_DIR to the zone folder}"
COLMAP=${COLMAP:-colmap}
OVERLAP=${OVERLAP:-15}
OUT="$ZONE_DIR/colmap"
rm -rf "$OUT"
mkdir -p "$OUT/sparse"

echo "[1/3] features"
"$COLMAP" feature_extractor --database_path "$OUT/database.db" --image_path "$ZONE_DIR/frames" \
  --ImageReader.single_camera 1 --ImageReader.camera_model SIMPLE_RADIAL \
  --FeatureExtraction.use_gpu 0 --SiftExtraction.max_num_features 8192

echo "[2/3] matching (sequential: frames are in walking order)"
LOOP=()
if [ -n "${VOCAB:-}" ]; then
  LOOP=(--SequentialMatching.loop_detection 1 --SequentialMatching.vocab_tree_path "$VOCAB")
fi
"$COLMAP" sequential_matcher --database_path "$OUT/database.db" \
  --FeatureMatching.use_gpu 0 --SequentialMatching.overlap "$OVERLAP" "${LOOP[@]}"

echo "[3/3] mapper"
"$COLMAP" mapper --database_path "$OUT/database.db" --image_path "$ZONE_DIR/frames" --output_path "$OUT/sparse"

echo "--- sub-models (more than one = the reconstruction split; see README step 3)"
for m in "$OUT"/sparse/*; do
  echo "== $m"
  "$COLMAP" model_analyzer --path "$m" 2>&1 | grep -E "Registered images|Points:|Mean reprojection" | sed 's/.*\] //'
done
echo DONE
