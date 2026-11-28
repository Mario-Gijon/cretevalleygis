import { getDistance, offset } from "ol/sphere.js";

export type GeographicLineCoordinate = [longitude: number, latitude: number];

export type ElevationProfileSample = {
  distanceMeters: number;
  longitude: number;
  latitude: number;
  elevationMeters: number | null;
  sourceZoom?: number;
  pixelGroundDistanceMeters?: number;
};

export type ElevationProfileStatistics = {
  totalDistanceMeters: number;
  initialElevationMeters: number | null;
  finalElevationMeters: number | null;
  minimumElevationMeters: number | null;
  maximumElevationMeters: number | null;
  meanElevationMeters: number | null;
  maximumReliefMeters: number | null;
  cumulativeAscentMeters: number;
  cumulativeDescentMeters: number;
  validSampleCount: number;
  totalSampleCount: number;
  coveragePercent: number;
  meanSampleSpacingMeters: number;
  minimumSourceZoom: number | null;
  maximumSourceZoom: number | null;
  minimumPixelGroundDistanceMeters: number | null;
  maximumPixelGroundDistanceMeters: number | null;
  requestedTileCount: number;
};

export type ElevationProfileResult = {
  samples: ElevationProfileSample[];
  statistics: ElevationProfileStatistics;
};

export type ElevationProfilePlan = {
  samples: Array<Omit<ElevationProfileSample, "elevationMeters" | "sourceZoom" | "pixelGroundDistanceMeters">>;
  totalDistanceMeters: number;
  sourceZoom: number;
  targetSpacingMeters: number;
};

export const ELEVATION_PROFILE_LIMITS = {
  maximumSamples: 500,
  maximumNewTileRequests: 64,
  maximumConcurrentSamples: 4,
  minimumZoom: 2,
  maximumZoom: 15,
  minimumSampleSpacingMeters: 30,
} as const;

const TILE_SIZE = 256;
const EARTH_CIRCUMFERENCE_METERS = 2 * Math.PI * 6_378_137;

function initialBearingRadians(start: GeographicLineCoordinate, end: GeographicLineCoordinate): number {
  const [longitude1, latitude1] = start.map((value) => (value * Math.PI) / 180) as GeographicLineCoordinate;
  const [longitude2, latitude2] = end.map((value) => (value * Math.PI) / 180) as GeographicLineCoordinate;
  const deltaLongitude = longitude2 - longitude1;
  return Math.atan2(
    Math.sin(deltaLongitude) * Math.cos(latitude2),
    Math.cos(latitude1) * Math.sin(latitude2)
      - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude),
  );
}

function groundPixelDistanceMeters(zoom: number, latitudeDegrees: number): number {
  return (EARTH_CIRCUMFERENCE_METERS / (2 ** zoom * TILE_SIZE))
    * Math.max(0.05, Math.cos((latitudeDegrees * Math.PI) / 180));
}

function chooseSourceZoom(totalDistanceMeters: number, segmentCount: number, coordinates: GeographicLineCoordinate[]): number {
  const maximumAbsoluteLatitude = Math.max(...coordinates.map((coordinate) => Math.abs(coordinate[1])));
  const minimumGroundScale = Math.max(0.05, Math.cos((maximumAbsoluteLatitude * Math.PI) / 180));
  for (let zoom = ELEVATION_PROFILE_LIMITS.maximumZoom; zoom >= ELEVATION_PROFILE_LIMITS.minimumZoom; zoom -= 1) {
    const tileGroundWidth = (EARTH_CIRCUMFERENCE_METERS / (2 ** zoom)) * minimumGroundScale;
    const estimatedTileCount = segmentCount + (totalDistanceMeters / tileGroundWidth) * 1.5;
    if (estimatedTileCount <= ELEVATION_PROFILE_LIMITS.maximumNewTileRequests) return zoom;
  }
  return ELEVATION_PROFILE_LIMITS.minimumZoom;
}

function allocateSegmentIntervals(lengths: number[], intervalCount: number, totalLength: number): number[] {
  const result = lengths.map(() => 1);
  const remaining = intervalCount - result.length;
  if (remaining <= 0 || totalLength <= 0) return result;

  const extras = lengths.map((length) => (remaining * length) / totalLength);
  let assigned = 0;
  for (let index = 0; index < extras.length; index += 1) {
    const whole = Math.floor(extras[index]);
    result[index] += whole;
    assigned += whole;
  }
  const remainderOrder = extras
    .map((portion, index) => ({ index, remainder: portion - Math.floor(portion) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remaining - assigned; index += 1) result[remainderOrder[index].index] += 1;
  return result;
}

/**
 * Builds a geodesic sampling plan that includes every line vertex. Every
 * segment is sampled independently, so a multi-segment route is never reduced
 * to a straight line from its first coordinate to its last.
 */
export function createElevationProfilePlan(
  coordinates: GeographicLineCoordinate[],
  maximumSamples = ELEVATION_PROFILE_LIMITS.maximumSamples,
): ElevationProfilePlan {
  if (coordinates.length < 2) throw new Error("La línea necesita al menos dos vértices.");
  if (coordinates.length > maximumSamples) {
    throw new Error(`La línea supera el máximo de ${maximumSamples} muestras posibles; simplifícala antes de generar el perfil.`);
  }
  for (const [longitude, latitude] of coordinates) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
      || longitude < -180 || longitude > 180 || Math.abs(latitude) > 85.05112878) {
      throw new Error("La línea contiene coordenadas fuera de la cobertura Web Mercator.");
    }
  }

  const segmentLengths = coordinates.slice(1).map((coordinate, index) => getDistance(coordinates[index], coordinate));
  const totalDistanceMeters = segmentLengths.reduce((sum, distance) => sum + distance, 0);
  if (!Number.isFinite(totalDistanceMeters) || totalDistanceMeters <= 0) {
    throw new Error("La línea no tiene una longitud geográfica válida.");
  }

  const segmentCount = segmentLengths.length;
  const sourceZoom = chooseSourceZoom(totalDistanceMeters, segmentCount, coordinates);
  const meanLatitude = coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) / coordinates.length;
  const sourcePixelDistance = groundPixelDistanceMeters(sourceZoom, meanLatitude);
  const targetSpacingMeters = Math.max(
    ELEVATION_PROFILE_LIMITS.minimumSampleSpacingMeters,
    sourcePixelDistance * 2,
  );
  const maximumIntervals = Math.max(1, maximumSamples - 1);
  const intervalCount = Math.min(
    maximumIntervals,
    Math.max(segmentCount, Math.ceil(totalDistanceMeters / targetSpacingMeters)),
  );
  const intervalsPerSegment = allocateSegmentIntervals(segmentLengths, intervalCount, totalDistanceMeters);

  const samples: ElevationProfilePlan["samples"] = [{
    distanceMeters: 0,
    longitude: coordinates[0][0],
    latitude: coordinates[0][1],
  }];
  let cumulativeDistance = 0;

  for (let segmentIndex = 0; segmentIndex < segmentLengths.length; segmentIndex += 1) {
    const start = coordinates[segmentIndex];
    const end = coordinates[segmentIndex + 1];
    const segmentLength = segmentLengths[segmentIndex];
    const intervals = intervalsPerSegment[segmentIndex];
    const bearing = initialBearingRadians(start, end);

    for (let step = 1; step <= intervals; step += 1) {
      const fraction = step / intervals;
      const [longitude, latitude] = step === intervals
        ? end
        : offset(start, segmentLength * fraction, bearing);
      samples.push({
        distanceMeters: cumulativeDistance + segmentLength * fraction,
        longitude,
        latitude,
      });
    }
    cumulativeDistance += segmentLength;
  }

  return { samples, totalDistanceMeters, sourceZoom, targetSpacingMeters };
}

export function calculateElevationProfileStatistics(
  samples: ElevationProfileSample[],
  totalDistanceMeters: number,
  requestedTileCount: number,
): ElevationProfileStatistics {
  const valid = samples.filter((sample) => Number.isFinite(sample.elevationMeters));
  const elevations = valid.map((sample) => sample.elevationMeters as number);
  const sourceZooms = valid.flatMap((sample) => sample.sourceZoom === undefined ? [] : [sample.sourceZoom]);
  const pixelDistances = valid.flatMap((sample) => (
    sample.pixelGroundDistanceMeters === undefined ? [] : [sample.pixelGroundDistanceMeters]
  ));

  let ascent = 0;
  let descent = 0;
  let weightedElevation = 0;
  let coveredDistance = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous.elevationMeters === null || current.elevationMeters === null) continue;
    const difference = current.elevationMeters - previous.elevationMeters;
    if (difference > 0) ascent += difference;
    else descent += Math.abs(difference);
    const distance = Math.max(0, current.distanceMeters - previous.distanceMeters);
    weightedElevation += ((previous.elevationMeters + current.elevationMeters) / 2) * distance;
    coveredDistance += distance;
  }

  const minimumElevationMeters = elevations.length ? Math.min(...elevations) : null;
  const maximumElevationMeters = elevations.length ? Math.max(...elevations) : null;
  const fallbackMean = elevations.length
    ? elevations.reduce((sum, elevation) => sum + elevation, 0) / elevations.length
    : null;

  return {
    totalDistanceMeters,
    initialElevationMeters: samples[0]?.elevationMeters ?? null,
    finalElevationMeters: samples[samples.length - 1]?.elevationMeters ?? null,
    minimumElevationMeters,
    maximumElevationMeters,
    meanElevationMeters: coveredDistance > 0 ? weightedElevation / coveredDistance : fallbackMean,
    maximumReliefMeters: minimumElevationMeters === null || maximumElevationMeters === null
      ? null
      : maximumElevationMeters - minimumElevationMeters,
    cumulativeAscentMeters: ascent,
    cumulativeDescentMeters: descent,
    validSampleCount: valid.length,
    totalSampleCount: samples.length,
    coveragePercent: samples.length ? (valid.length / samples.length) * 100 : 0,
    meanSampleSpacingMeters: samples.length > 1 ? totalDistanceMeters / (samples.length - 1) : 0,
    minimumSourceZoom: sourceZooms.length ? Math.min(...sourceZooms) : null,
    maximumSourceZoom: sourceZooms.length ? Math.max(...sourceZooms) : null,
    minimumPixelGroundDistanceMeters: pixelDistances.length ? Math.min(...pixelDistances) : null,
    maximumPixelGroundDistanceMeters: pixelDistances.length ? Math.max(...pixelDistances) : null,
    requestedTileCount,
  };
}
