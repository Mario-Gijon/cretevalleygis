FROM qgis/qgis-server:3.44.16-noble@sha256:67ecbe09d66df2d6c5e554c43f4f2800eba7fc42998953fabb57505ec96b5878

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv --system-site-packages /opt/backend-venv \
    && /opt/backend-venv/bin/pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

ENV PYTHONPATH=/app:/io/scripts \
    QGIS_PREFIX_PATH=/usr \
    QT_QPA_PLATFORM=offscreen \
    TERRAIN_REGION_ROOT=/io/data/terrain/regions \
    TERRAIN_SCRIPT_PATH=/io/scripts/prepare-terrain.py \
    PUBLIC_QGIS_WMS_URL=http://localhost:8085/ogc/world

EXPOSE 7200

CMD ["/opt/backend-venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7200", "--workers", "1"]
