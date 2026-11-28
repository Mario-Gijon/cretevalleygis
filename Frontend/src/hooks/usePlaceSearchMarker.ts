import { useCallback, useState } from "react";
import Feature from "ol/Feature.js";
import Point from "ol/geom/Point.js";
import type Geometry from "ol/geom/Geometry.js";
import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import { fromLonLat } from "ol/proj.js";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style.js";

export function usePlaceSearchMarker() {
  const [source] = useState(() => new VectorSource<Feature<Geometry>>({ wrapX: false }));
  const [layer] = useState(() => new VectorLayer({
    source,
    style: new Style({
      image: new CircleStyle({
        radius: 9,
        fill: new Fill({ color: "#c2e812" }),
        stroke: new Stroke({ color: "#05294c", width: 2.5 }),
      }),
    }),
    zIndex: 31,
  }));

  const clear = useCallback(() => source.clear(true), [source]);
  const show = useCallback((longitude: number, latitude: number) => {
    source.clear(true);
    source.addFeature(new Feature(new Point(fromLonLat([longitude, latitude]))));
  }, [source]);

  return { layer, show, clear };
}
