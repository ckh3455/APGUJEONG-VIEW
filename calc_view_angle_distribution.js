const fs = require("fs");
const path = require("path");

const BASE = "/workspace/current_v26";
const ORIGIN_LON = 127.03255;
const ORIGIN_LAT = 37.52545;
const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LON = 111320 * Math.cos(toRadians(ORIGIN_LAT));
const EXTERIOR_HULL_TOLERANCE_M = 2;
const FACADE_SAMPLE_STEP_M = 2;

function toRadians(deg) { return deg * Math.PI / 180; }
function toDegrees(rad) { return rad * 180 / Math.PI; }
function lonLatToXY(lon, lat) { return { x: (lon - ORIGIN_LON) * METERS_PER_DEG_LON, y: (lat - ORIGIN_LAT) * METERS_PER_DEG_LAT }; }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function bearingTo(from, to) { return (toDegrees(Math.atan2(to.x - from.x, to.y - from.y)) + 360) % 360; }
function normalizeAngle(degrees) { return ((degrees % 360) + 360) % 360; }
function closestPointOnSegment(p, a, b) {
  const ab = { x: b.x - a.x, y: b.y - a.y };
  const len2 = ab.x * ab.x + ab.y * ab.y;
  if (len2 === 0) return a;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / len2));
  return { x: a.x + ab.x * t, y: a.y + ab.y * t };
}
function pointSegmentDistance(point, a, b) { return distance(point, closestPointOnSegment(point, a, b)); }
function distanceToSegments(point, segments) {
  let best = Number.POSITIVE_INFINITY;
  for (const segment of segments || []) best = Math.min(best, pointSegmentDistance(point, segment.a, segment.b));
  return best;
}
function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
function convexHull(points) {
  const unique = [];
  const seen = new Set();
  for (const point of points) {
    const key = `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
    if (!seen.has(key)) { seen.add(key); unique.push(point); }
  }
  if (unique.length <= 3) return unique;
  unique.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
function segmentsFromPoints(points) {
  const segments = [];
  for (let i = 0; i < points.length; i += 1) segments.push({ a: points[i], b: points[(i + 1) % points.length] });
  return segments;
}
function polylineLength(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) total += distance(points[i], points[i + 1]);
  return total;
}
function raySegmentDistance(origin, bearingDeg, a, b) {
  const rad = toRadians(bearingDeg);
  const d = { x: Math.sin(rad), y: Math.cos(rad) };
  const v = { x: b.x - a.x, y: b.y - a.y };
  const w = { x: a.x - origin.x, y: a.y - origin.y };
  const cr = d.x * v.y - d.y * v.x;
  if (Math.abs(cr) < 1e-9) return null;
  const t = (w.x * v.y - w.y * v.x) / cr;
  const u = (w.x * d.y - w.y * d.x) / cr;
  if (t >= 0 && u >= 0 && u <= 1) return t;
  return null;
}
function ringCentroid(ring) {
  let x = 0, y = 0;
  for (const point of ring) { x += point.x; y += point.y; }
  return { x: x / ring.length, y: y / ring.length };
}
function ringSegments(ring) {
  const segments = [];
  for (let i = 0; i < ring.length; i += 1) segments.push({ a: ring[i], b: ring[(i + 1) % ring.length], index: i });
  return segments;
}
function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const pi = ring[i], pj = ring[j];
    const intersects = ((pi.y > point.y) !== (pj.y > point.y)) &&
      (point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x);
    if (intersects) inside = !inside;
  }
  return inside;
}
function pointAlongSegment(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
function sampleFacadeSegments(footprint, stepMeters = FACADE_SAMPLE_STEP_M) {
  const samples = [];
  for (const segment of footprint.segments) {
    const len = distance(segment.a, segment.b);
    if (!Number.isFinite(len) || len === 0) continue;
    const count = Math.max(1, Math.ceil(len / stepMeters));
    for (let i = 0; i < count; i += 1) {
      const t0 = i / count, t1 = (i + 1) / count;
      samples.push({
        point: pointAlongSegment(segment.a, segment.b, (t0 + t1) / 2),
        a: pointAlongSegment(segment.a, segment.b, t0),
        b: pointAlongSegment(segment.a, segment.b, t1),
        length: len / count,
        segmentIndex: segment.index
      });
    }
  }
  return samples;
}
function normalizeRing(coords) {
  const ring = coords.map(([lon, lat]) => lonLatToXY(lon, lat));
  const first = ring[0], last = ring[ring.length - 1];
  if (first && last && first.x === last.x && first.y === last.y) ring.pop();
  return ring;
}
function normalizeZoneId(value) {
  const text = String(value || "").trim();
  if (text.includes("2")) return "2";
  if (text.includes("3")) return "3";
  if (text.includes("4")) return "4";
  if (text.includes("5")) return "5";
  return text;
}
function normalizedFloorCount(props) {
  const zoneId = normalizeZoneId(props.zone || props.source_zone || "");
  if (zoneId === "2" && String(props.dong || "").trim() === "105") return 65;
  return Number(props.floors || 0);
}
function normalizedFloorHeight(props) {
  const raw = Number(props.floor_h);
  if (Number.isFinite(raw) && raw > 0 && raw < 20) return raw;
  if (Number.isFinite(raw) && raw >= 1000 && raw < 10000) return raw / 1000;
  const zoneId = normalizeZoneId(props.zone || props.source_zone || "");
  if (zoneId === "2" || zoneId === "3") return 3.692;
  const floors = normalizedFloorCount(props);
  const piloti = Number(props.piloti_m || 0);
  const height = Number(props.height_m || props.height || 0);
  if (floors > 0 && height > piloti) return (height - piloti) / floors;
  return 3.692;
}
function totalBuildingHeight(props) {
  const floors = normalizedFloorCount(props);
  const floorH = normalizedFloorHeight(props);
  const piloti = Number(props.piloti_m || 0);
  const height = Number(props.height_m || props.height || 0);
  const bodyHeight = floors > 0 && floorH > 0 ? floors * floorH : 0;
  const expectedTotal = bodyHeight + piloti;
  const tolerance = 0.25;
  if (!Number.isFinite(height) || height <= 0) return expectedTotal > 0 ? expectedTotal : 20;
  if (bodyHeight > 0 && Math.abs(height - bodyHeight) <= tolerance) return height + piloti;
  if (expectedTotal > 0 && Math.abs(height - expectedTotal) <= tolerance) return height;
  if (piloti > 0 && bodyHeight > 0 && height < expectedTotal - piloti * 0.45) return height + piloti;
  return height;
}
function featureIdValue(feature, fallbackIndex) {
  const props = feature.properties || {};
  const fid = props.fid;
  if (fid !== null && fid !== undefined && String(fid).trim() !== "") return fid;
  return fallbackIndex + 1;
}
function cloneFeatureWithZone(feature, zoneId, fallbackIndex = 0) {
  const props = { ...(feature.properties || {}) };
  const sourceFid = featureIdValue(feature, fallbackIndex);
  props.source_fid = sourceFid;
  props.source_zone = zoneId;
  props.fid = `${zoneId}-${sourceFid}`;
  return { type: "Feature", properties: props, geometry: feature.geometry };
}
function prepareFootprints(features) {
  const footprints = [];
  const dongPointGroups = new Map();
  for (const feature of features) {
    const geometry = feature.geometry;
    const props = feature.properties || {};
    if (!geometry) continue;
    const rings = [];
    if (geometry.type === "Polygon") rings.push(normalizeRing(geometry.coordinates[0]));
    else if (geometry.type === "MultiPolygon") for (const polygon of geometry.coordinates) rings.push(normalizeRing(polygon[0]));
    for (const ring of rings) {
      const footprint = {
        fid: props.fid,
        props,
        zoneId: normalizeZoneId(props.zone || props.source_zone || ""),
        zoneName: String(props.zone || props.source_zone || "").trim(),
        dong: props.dong,
        unitType: String(props.unit_type || "").trim(),
        floors: normalizedFloorCount(props),
        piloti: Number(props.piloti_m || 0),
        floorH: normalizedFloorHeight(props),
        height: Number(props.height_m || 0),
        totalHeight: totalBuildingHeight(props),
        ring,
        center: ringCentroid(ring),
        segments: ringSegments(ring)
      };
      footprint.groupKey = `${footprint.zoneName}:${footprint.dong || ""}`;
      footprints.push(footprint);
      if (!dongPointGroups.has(footprint.groupKey)) dongPointGroups.set(footprint.groupKey, []);
      dongPointGroups.get(footprint.groupKey).push(...ring);
    }
  }
  const dongHullSegments = new Map();
  for (const [dongKey, points] of dongPointGroups.entries()) {
    dongHullSegments.set(dongKey, segmentsFromPoints(convexHull(points)));
  }
  for (const footprint of footprints) {
    const group = dongPointGroups.get(footprint.groupKey) || footprint.ring;
    footprint.groupCenter = ringCentroid(group);
    footprint.groupHullSegments = dongHullSegments.get(footprint.groupKey) || footprint.segments;
  }
  return footprints;
}
function buildRiverContext(geojson) {
  const segments = [], pointsForScan = [];
  let lineCount = 0, sourceLength = 0;
  for (const feature of geojson.features || []) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates || [];
    for (const line of lines) {
      const points = line.map(([lon, lat]) => lonLatToXY(lon, lat));
      if (points.length < 2) continue;
      lineCount += 1;
      sourceLength += polylineLength(points);
      pointsForScan.push(...points);
      for (let i = 0; i < points.length - 1; i += 1) {
        const segment = { a: points[i], b: points[i + 1] };
        segments.push(segment);
        const segmentLength = distance(segment.a, segment.b);
        const samples = Math.max(1, Math.floor(segmentLength / 25));
        for (let j = 1; j < samples; j += 1) {
          const t = j / samples;
          pointsForScan.push({ x: segment.a.x + (segment.b.x - segment.a.x) * t, y: segment.a.y + (segment.b.y - segment.a.y) * t });
        }
      }
    }
  }
  return { segments, points: pointsForScan, lineCount, sourceLength };
}
function nearestRayHit(origin, bearing, segments) {
  let best = null;
  for (const segment of segments) {
    const t = raySegmentDistance(origin, bearing, segment.a, segment.b);
    if (t !== null && t > 0 && (!best || t < best.distance)) best = { distance: t, segment };
  }
  return best;
}
function rayReachesRiver(origin, bearing, expectedDistance, riverSegments) {
  const hit = nearestRayHit(origin, bearing, riverSegments);
  if (!hit || !Number.isFinite(hit.distance)) return false;
  if (Number.isFinite(expectedDistance)) return Math.abs(hit.distance - expectedDistance) <= 2.5;
  return hit.distance > 2;
}
function rayBlockerProfile(origin, bearing, maxDistance, sourceFootprint, footprints) {
  let internalBlocked = false;
  const hits = [];
  for (const footprint of footprints) {
    if (String(footprint.fid) === String(sourceFootprint.fid)) continue;
    for (const segment of footprint.segments) {
      const t = raySegmentDistance(origin, bearing, segment.a, segment.b);
      if (t === null || t <= 2 || t >= maxDistance) continue;
      if (String(footprint.groupKey) === String(sourceFootprint.groupKey)) {
        internalBlocked = true;
        continue;
      }
      hits.push({
        zoneName: footprint.zoneName,
        dong: footprint.dong,
        unitType: footprint.unitType,
        distance: t,
        height: Number(footprint.totalHeight || footprint.height || 0),
        floors: Number(footprint.floors || 0)
      });
    }
  }
  hits.sort((a, b) => a.distance - b.distance);
  let maxBlockerHeight = 0;
  const effectiveBlockers = [];
  for (const hit of hits) {
    if (hit.height > maxBlockerHeight) {
      maxBlockerHeight = hit.height;
      effectiveBlockers.push(hit);
    }
  }
  return { internalBlocked, maxBlockerHeight, blockers: effectiveBlockers };
}
function floorEyeHeight(footprint, floor) {
  const piloti = Number.isFinite(footprint.piloti) ? footprint.piloti : 0;
  const floorH = Number.isFinite(footprint.floorH) && footprint.floorH > 0 ? footprint.floorH : 3.3;
  const raw = piloti + Math.max(0, floor - 0.5) * floorH;
  const capHeight = Number(footprint.totalHeight || footprint.height || 0);
  return capHeight > 0 ? Math.min(raw, capHeight + 1.5) : raw;
}
function viewRayLeavesBuilding(samplePoint, targetPoint, footprint) {
  const d = distance(samplePoint, targetPoint);
  if (!Number.isFinite(d) || d === 0) return false;
  const testPoint = { x: samplePoint.x + ((targetPoint.x - samplePoint.x) / d) * 0.8, y: samplePoint.y + ((targetPoint.y - samplePoint.y) / d) * 0.8 };
  if (pointInRing(testPoint, footprint.ring)) return false;
  return distanceToSegments(samplePoint, footprint.groupHullSegments) <= EXTERIOR_HULL_TOLERANCE_M;
}
function isBetterAngleProfile(candidate, current) {
  if (!current) return true;
  const candidateHeight = Number(candidate.blockerHeight || 0);
  const currentHeight = Number(current.blockerHeight || 0);
  if (candidateHeight !== currentHeight) return candidateHeight < currentHeight;
  return Number(candidate.distance || 0) < Number(current.distance || 0);
}
function buildAngleProfiles(candidates) {
  const byAngle = new Map();
  for (const candidate of candidates) {
    const current = byAngle.get(candidate.angle);
    if (isBetterAngleProfile(candidate, current)) {
      byAngle.set(candidate.angle, {
        angle: candidate.angle,
        order: candidate.angle,
        distance: candidate.distance,
        blockerHeight: candidate.blockerHeight,
        blockers: candidate.blockers,
        sample: candidate.sample
      });
    }
  }
  return [...byAngle.values()].sort((a, b) => a.order - b.order);
}
function collectFacadeCandidates(footprint, footprints, riverContext) {
  const samples = sampleFacadeSegments(footprint);
  const candidates = [];
  for (const sample of samples) {
    for (const target of riverContext.points) {
      if (!viewRayLeavesBuilding(sample.point, target, footprint)) continue;
      const exactAngle = bearingTo(sample.point, target);
      const angle = normalizeAngle(Math.round(exactAngle));
      const targetDistance = distance(sample.point, target);
      if (!rayReachesRiver(sample.point, exactAngle, targetDistance, riverContext.segments)) continue;
      const blockerProfile = rayBlockerProfile(sample.point, exactAngle, targetDistance, footprint, footprints);
      if (blockerProfile.internalBlocked) continue;
      candidates.push({ angle, distance: targetDistance, blockerHeight: blockerProfile.maxBlockerHeight, blockers: blockerProfile.blockers, sample });
    }
  }
  return { samples, angleProfiles: buildAngleProfiles(candidates) };
}
function summarizeOpenGaps(openRays) {
  if (!openRays.length) return { total: 0, gapCount: 0, maxGap: 0, gaps: [] };
  const buildGap = (start, end, rays) => ({ start, end, size: Math.round(end.order - start.order + 1) });
  const gaps = [];
  let start = openRays[0], prev = openRays[0], currentRays = [openRays[0]];
  for (let i = 1; i < openRays.length; i += 1) {
    const ray = openRays[i];
    const diff = ((ray.order - prev.order) + 360) % 360;
    if (diff <= 1.01) { currentRays.push(ray); prev = ray; }
    else { gaps.push(buildGap(start, prev, currentRays)); start = ray; prev = ray; currentRays = [ray]; }
  }
  gaps.push(buildGap(start, prev, currentRays));
  if (gaps.length > 1 && gaps[0].start.order === 0 && gaps[gaps.length - 1].end.order === 359) {
    const first = gaps.shift();
    const last = gaps.pop();
    gaps.unshift({ start: last.start, end: first.end, size: last.size + first.size });
  }
  const total = gaps.reduce((sum, gap) => sum + gap.size, 0);
  const maxGap = gaps.reduce((max, gap) => Math.max(max, gap.size), 0);
  return { total, gapCount: gaps.length, maxGap, gaps };
}
function summarizeFacadeCandidates(candidateData, observerHeight) {
  const allOpenRays = [];
  for (const profile of candidateData.angleProfiles || []) {
    if (profile.blockerHeight >= observerHeight) continue;
    allOpenRays.push({ angle: profile.angle, order: profile.angle, distance: profile.distance });
  }
  return summarizeOpenGaps(allOpenRays.sort((a, b) => a.order - b.order)).total;
}
function binLabel(angle) {
  if (angle <= 0) return "0도";
  const start = Math.floor((angle - 1) / 10) * 10 + 1;
  const end = start + 9;
  return `${start}-${end}도`;
}

const zoneFiles = {
  "2": "apgujeong_2_units.geojson",
  "3": "apg3_unit_polygon.geojson",
  "4": "apgujeong_4_units.geojson",
  "5": "apgujeong_5_units.geojson"
};

const allFeatures = [];
for (const [zoneId, file] of Object.entries(zoneFiles)) {
  const data = JSON.parse(fs.readFileSync(path.join(BASE, file), "utf8"));
  (data.features || []).forEach((feature, index) => allFeatures.push(cloneFeatureWithZone(feature, zoneId, index)));
}
const footprints = prepareFootprints(allFeatures);
const riverContext = buildRiverContext(JSON.parse(fs.readFileSync(path.join(BASE, "hangang_line_all.geojson"), "utf8")));

const summary = {};
for (const zoneId of Object.keys(zoneFiles)) {
  summary[zoneId] = { units: 0, floorUnits: 0, bins: {}, angleSum: 0, min: Infinity, max: -Infinity };
}

const sorted = footprints.slice().sort((a, b) => String(a.zoneId).localeCompare(String(b.zoneId)) || String(a.dong).localeCompare(String(b.dong)));
let done = 0;
for (const footprint of sorted) {
  const zone = summary[footprint.zoneId];
  if (!zone) continue;
  zone.units += 1;
  const candidateData = collectFacadeCandidates(footprint, footprints, riverContext);
  const floors = Math.max(1, Math.round(footprint.floors || 1));
  for (let floor = 1; floor <= floors; floor += 1) {
    const angle = summarizeFacadeCandidates(candidateData, floorEyeHeight(footprint, floor));
    const label = binLabel(angle);
    zone.bins[label] = (zone.bins[label] || 0) + 1;
    zone.floorUnits += 1;
    zone.angleSum += angle;
    zone.min = Math.min(zone.min, angle);
    zone.max = Math.max(zone.max, angle);
  }
  done += 1;
  if (done % 20 === 0) console.error(`processed ${done}/${sorted.length}`);
}

const labels = ["0도"];
for (let s = 1; s <= 191; s += 10) labels.push(`${s}-${s + 9}도`);
const rows = [];
for (const [zoneId, zone] of Object.entries(summary)) {
  for (const label of labels) {
    const count = zone.bins[label] || 0;
    if (!count) continue;
    rows.push({
      zone: `${zoneId}구역`,
      range: label,
      count,
      percent: +(count / zone.floorUnits * 100).toFixed(1)
    });
  }
}
const totals = Object.fromEntries(Object.entries(summary).map(([zoneId, zone]) => [zoneId, {
  zone: `${zoneId}구역`,
  units: zone.units,
  floorUnits: zone.floorUnits,
  avgAngle: +(zone.angleSum / zone.floorUnits).toFixed(1),
  minAngle: zone.min,
  maxAngle: zone.max
}]));

fs.writeFileSync(path.join(BASE, "view_angle_distribution.json"), JSON.stringify({ river: { lineCount: riverContext.lineCount, lengthM: Math.round(riverContext.sourceLength), scanPoints: riverContext.points.length }, totals, rows }, null, 2));
console.log(JSON.stringify({ river: { lineCount: riverContext.lineCount, lengthM: Math.round(riverContext.sourceLength), scanPoints: riverContext.points.length }, totals, rows }, null, 2));
