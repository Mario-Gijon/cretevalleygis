#!/usr/bin/env bash
set -euo pipefail

/usr/bin/python3 /io/scripts/prepare-world.py

# Topography is optional: a missing or inaccessible DEM must not prevent the
# Natural Earth project and the local map viewer from starting.
if ! /usr/bin/python3 /io/scripts/prepare-terrain.py; then
  echo "WARNING: terrain preparation failed; Natural Earth remains available." >&2
fi

# The global 60-second model is optional too; OSM and the local map remain
# available if NOAA is temporarily unreachable.
if ! /usr/bin/python3 /io/scripts/prepare-global-terrain.py; then
  echo "WARNING: ETOPO preparation failed; remaining map layers stay available." >&2
fi
