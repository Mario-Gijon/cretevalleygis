#!/usr/bin/env bash
set -euo pipefail

/usr/bin/python3 /io/scripts/prepare-world.py

# Topography is optional: a missing or inaccessible DEM must not prevent the
# Natural Earth project and the local map viewer from starting.
if ! /usr/bin/python3 /io/scripts/prepare-terrain.py; then
  echo "WARNING: terrain preparation failed; Natural Earth remains available." >&2
fi
