import fs from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(900_000);

page.on('console', msg => {
  const text = msg.text();
  if (/error|fail|계산 완료|reference|handicap/i.test(text)) {
    console.log(`[browser:${msg.type()}] ${text}`);
  }
});
page.on('pageerror', error => console.error('[pageerror]', error.message));

await page.route('**/*', async route => {
  const url = route.request().url();
  if (
    url.startsWith('http://127.0.0.1:8000/') ||
    url.startsWith('https://cesium.com/downloads/cesiumjs/') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  ) {
    await route.continue();
    return;
  }
  await route.abort();
});

await page.goto('http://127.0.0.1:8000/index.html', {
  waitUntil: 'domcontentloaded',
  timeout: 300_000
});

await page.waitForFunction(() => {
  try {
    return typeof analyzeViewsForZone === 'function' &&
      typeof summarizeFacadeCandidates === 'function' &&
      typeof openCandidateForFloor === 'function' &&
      typeof buildAngleProfiles === 'function' &&
      Array.isArray(footprints) && footprints.length >= 200 &&
      Array.isArray(activeRiverSegments) && activeRiverSegments.length > 0;
  } catch {
    return false;
  }
}, null, { timeout: 300_000 });

const result = await page.evaluate(async () => {
  await analyzeViewsForZone('ALL', { force: true });

  const bucketOrder = [
    '10% 이하', '10-20%', '21-30%', '31-40%', '41-50%',
    '51-60%', '61-70%', '71-80%', '81-90%', '91-100%', '100% 이상'
  ];
  const zoneIds = ['2', '3', '4', '5'];
  const bandOrder = ['1-20층', '21-40층', '41-60층', '61층 이상'];

  function bandForFloor(floor) {
    if (floor <= 20) return '1-20층';
    if (floor <= 40) return '21-40층';
    if (floor <= 60) return '41-60층';
    return '61층 이상';
  }

  function bucketForRate(rate) {
    if (rate <= 10) return '10% 이하';
    if (rate <= 20) return '10-20%';
    if (rate <= 30) return '21-30%';
    if (rate <= 40) return '31-40%';
    if (rate <= 50) return '41-50%';
    if (rate <= 60) return '51-60%';
    if (rate <= 70) return '61-70%';
    if (rate <= 80) return '71-80%';
    if (rate <= 90) return '81-90%';
    if (rate < 100) return '91-100%';
    return '100% 이상';
  }

  function angleSetFromCandidateData(candidateData, observerHeight) {
    const set = new Set();
    for (const profile of candidateData.angleProfiles || []) {
      if (openCandidateForFloor(profile, observerHeight)) set.add(Number(profile.angle));
    }
    return set;
  }

  // 같은 동 내부 관통 여부는 기존 후보 생성 단계에서 이미 제거됐다.
  // 여기서는 특정 인접 구역만 차폐체 목록에서 제외하여 반사실적 조망각을 만든다.
  const barrierGroups = [];
  const seenBarrierGroups = new Set();
  for (const footprint of footprints) {
    const groupKey = footprint.groupKey || `${footprint.zoneName}:${footprint.dong || ''}`;
    if (seenBarrierGroups.has(groupKey)) continue;
    seenBarrierGroups.add(groupKey);
    barrierGroups.push({
      groupKey,
      zoneId: normalizeZoneId(footprint.zoneName),
      zoneName: footprint.zoneName,
      dong: footprint.dong,
      unitType: footprint.unitType,
      segments: footprint.groupBarrierSegments || footprint.segments || [],
      height: blockerOcclusionHeight(footprint),
      floors: blockerOcclusionFloors(footprint)
    });
  }

  function blockerProfileExcluding(origin, bearing, maxDistance, sourceFootprint, excludedZoneId) {
    const hits = [];
    for (const group of barrierGroups) {
      if (group.groupKey === sourceFootprint.groupKey) continue;
      if (group.zoneId === excludedZoneId) continue;
      for (const segment of group.segments) {
        const t = raySegmentDistance(origin, bearing, segment.a, segment.b);
        if (t === null || t <= 2 || t >= maxDistance) continue;
        hits.push({
          zoneName: group.zoneName,
          dong: group.dong,
          unitType: group.unitType,
          distance: t,
          height: group.height,
          floors: group.floors
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
    return { maxBlockerHeight, blockers: effectiveBlockers };
  }

  function counterfactualData(footprint, currentData, excludedZoneId) {
    const candidates = [];
    for (const candidate of currentData.candidates || []) {
      const exactAngle = bearingTo(candidate.origin, candidate.end);
      const targetDistance = Number(candidate.distance || distance(candidate.origin, candidate.end));
      const blockerProfile = blockerProfileExcluding(
        candidate.origin,
        exactAngle,
        targetDistance,
        footprint,
        excludedZoneId
      );
      candidates.push({
        ...candidate,
        blockerHeight: blockerProfile.maxBlockerHeight,
        blockers: blockerProfile.blockers
      });
    }
    return {
      samples: currentData.samples || [],
      candidates,
      angleProfiles: buildAngleProfiles(candidates),
      blockers: []
    };
  }

  function shortestWeightedSector(frequency, coverage = 0.90, padding = 3) {
    const total = frequency.reduce((sum, value) => sum + value, 0);
    if (!total) {
      const angles = new Set(Array.from({ length: 360 }, (_, i) => i));
      return { start: 0, end: 359, width: 360, center: 179.5, coverage: 0, angles };
    }
    const target = total * coverage;
    let best = null;
    for (let start = 0; start < 360; start += 1) {
      let sum = 0;
      for (let width = 1; width <= 360; width += 1) {
        sum += frequency[(start + width - 1) % 360];
        if (sum >= target) {
          if (!best || width < best.width || (width === best.width && sum > best.sum)) {
            best = { start, width, sum };
          }
          break;
        }
      }
    }
    const paddedStart = (best.start - padding + 360) % 360;
    const paddedWidth = Math.min(360, best.width + padding * 2);
    const angles = new Set();
    for (let i = 0; i < paddedWidth; i += 1) angles.add((paddedStart + i) % 360);
    const end = (paddedStart + paddedWidth - 1) % 360;
    const center = (paddedStart + (paddedWidth - 1) / 2) % 360;
    return {
      start: paddedStart,
      end,
      width: paddedWidth,
      center: Number(center.toFixed(1)),
      coverage: Number((best.sum / total * 100).toFixed(1)),
      angles
    };
  }

  async function deriveReference(referenceZoneId, excludedZoneId, label) {
    const observations = [];
    const lossFrequency = Array(360).fill(0);
    let footprintCount = 0;

    for (const footprint of footprints) {
      if (normalizeZoneId(footprint.zoneName) !== referenceZoneId) continue;
      const currentData = viewAnalysisByFid.get(String(footprint.fid))?.candidateData;
      if (!currentData) continue;
      footprintCount += 1;
      const noAdjacentData = counterfactualData(footprint, currentData, excludedZoneId);
      const floors = Math.max(1, Math.round(Number(footprint.floors || 1)));

      for (let floor = 1; floor <= floors; floor += 1) {
        const observerHeight = floorEyeHeight(footprint, floor);
        const currentSet = angleSetFromCandidateData(currentData, observerHeight);
        const noAdjacentSet = angleSetFromCandidateData(noAdjacentData, observerHeight);
        const lost = new Set([...noAdjacentSet].filter(angle => !currentSet.has(angle)));
        for (const angle of lost) lossFrequency[angle] += 1;
        observations.push({
          band: bandForFloor(floor),
          currentSet,
          noAdjacentSet,
          lost
        });
      }
    }

    const sector = shortestWeightedSector(lossFrequency, 0.90, 3);
    const byBand = Object.fromEntries(bandOrder.map(band => [band, {
      band,
      referenceObservations: 0,
      counterfactualRiskAngle: 0,
      currentRiskAngle: 0,
      lostRiskAngle: 0,
      coefficient: 0
    }]));

    for (const obs of observations) {
      const row = byBand[obs.band];
      row.referenceObservations += 1;
      for (const angle of sector.angles) {
        if (obs.noAdjacentSet.has(angle)) row.counterfactualRiskAngle += 1;
        if (obs.currentSet.has(angle)) row.currentRiskAngle += 1;
        if (obs.lost.has(angle)) row.lostRiskAngle += 1;
      }
    }

    let totalCounterfactualRiskAngle = 0;
    let totalLostRiskAngle = 0;
    for (const band of bandOrder) {
      const row = byBand[band];
      row.coefficient = row.counterfactualRiskAngle > 0
        ? row.lostRiskAngle / row.counterfactualRiskAngle
        : 0;
      totalCounterfactualRiskAngle += row.counterfactualRiskAngle;
      totalLostRiskAngle += row.lostRiskAngle;
    }

    const overallCoefficient = totalCounterfactualRiskAngle > 0
      ? totalLostRiskAngle / totalCounterfactualRiskAngle
      : 0;

    console.log(`reference ${label}: sector ${sector.start}-${sector.end}, coefficient ${overallCoefficient}`);
    return {
      label,
      referenceZone: `${referenceZoneId}구역`,
      blockerZone: `${excludedZoneId}구역`,
      footprintCount,
      observationCount: observations.length,
      sector: {
        start: sector.start,
        end: sector.end,
        width: sector.width,
        center: sector.center,
        capturedLossShare: sector.coverage
      },
      sectorAngles: sector.angles,
      overallCoefficient,
      bands: bandOrder.map(band => ({
        ...byBand[band],
        coefficient: Number((byBand[band].coefficient * 100).toFixed(2))
      }))
    };
  }

  const referenceFor2 = await deriveReference('3', '2', '3구역에서 2구역 방향');
  const referenceFor5 = await deriveReference('4', '5', '4구역에서 5구역 방향');

  function coefficientFor(reference, floor) {
    const band = bandForFloor(floor);
    const row = reference.bands.find(item => item.band === band);
    if (row && row.referenceObservations > 0 && row.counterfactualRiskAngle > 0) {
      return row.coefficient / 100;
    }
    return reference.overallCoefficient;
  }

  function newZoneAccumulator(zoneId) {
    return {
      zone: `${zoneId}구역`,
      unitLines: 0,
      households: 0,
      currentAngleSum: 0,
      adjustedAngleSum: 0,
      riskAngleSum: 0,
      penaltyAngleSum: 0,
      affectedHouseholds: 0,
      currentBins: Object.fromEntries(bucketOrder.map(label => [label, 0])),
      adjustedBins: Object.fromEntries(bucketOrder.map(label => [label, 0]))
    };
  }

  const byZone = Object.fromEntries(zoneIds.map(zoneId => [zoneId, newZoneAccumulator(zoneId)]));
  const records = [];

  for (const footprint of footprints) {
    const zoneId = normalizeZoneId(footprint.zoneName);
    const zone = byZone[zoneId];
    if (!zone) continue;
    const currentData = viewAnalysisByFid.get(String(footprint.fid))?.candidateData;
    if (!currentData) continue;
    zone.unitLines += 1;

    const reference = zoneId === '2' ? referenceFor2 : zoneId === '5' ? referenceFor5 : null;
    const sectorAngles = reference ? reference.sectorAngles : new Set();
    const floors = Math.max(1, Math.round(Number(footprint.floors || 1)));

    for (let floor = 1; floor <= floors; floor += 1) {
      const observerHeight = floorEyeHeight(footprint, floor);
      const currentView = summarizeFacadeCandidates(footprint, currentData, observerHeight);
      const currentAngle = Number(currentView.totalOpen || 0);
      const currentSet = angleSetFromCandidateData(currentData, observerHeight);
      let riskAngle = 0;
      let coefficient = 0;
      let penaltyAngle = 0;

      if (reference) {
        for (const angle of sectorAngles) if (currentSet.has(angle)) riskAngle += 1;
        coefficient = coefficientFor(reference, floor);
        penaltyAngle = Math.min(currentAngle, riskAngle * coefficient);
      }

      const adjustedAngle = Math.max(0, currentAngle - penaltyAngle);
      const currentRate = currentAngle / 180 * 100;
      const adjustedRate = adjustedAngle / 180 * 100;
      const currentBucket = bucketForRate(currentRate);
      const adjustedBucket = bucketForRate(adjustedRate);

      zone.households += 1;
      zone.currentAngleSum += currentAngle;
      zone.adjustedAngleSum += adjustedAngle;
      zone.riskAngleSum += riskAngle;
      zone.penaltyAngleSum += penaltyAngle;
      if (penaltyAngle > 0.0001) zone.affectedHouseholds += 1;
      zone.currentBins[currentBucket] += 1;
      zone.adjustedBins[adjustedBucket] += 1;

      records.push({
        zone: `${zoneId}구역`,
        dong: String(footprint.dong || ''),
        unitType: String(footprint.unitType || ''),
        floor,
        floorBand: bandForFloor(floor),
        currentAngle: Number(currentAngle.toFixed(2)),
        currentRate: Number(currentRate.toFixed(2)),
        futureRiskAngle: Number(riskAngle.toFixed(2)),
        appliedCoefficient: Number((coefficient * 100).toFixed(2)),
        penaltyAngle: Number(penaltyAngle.toFixed(2)),
        adjustedAngle: Number(adjustedAngle.toFixed(2)),
        adjustedRate: Number(adjustedRate.toFixed(2)),
        currentBucket,
        adjustedBucket
      });
    }
  }

  function finalize(zone) {
    const households = zone.households || 1;
    const avgCurrentAngle = zone.currentAngleSum / households;
    const avgAdjustedAngle = zone.adjustedAngleSum / households;
    return {
      zone: zone.zone,
      unitLines: zone.unitLines,
      households: zone.households,
      avgCurrentAngle: Number(avgCurrentAngle.toFixed(2)),
      avgCurrentRate: Number((avgCurrentAngle / 180 * 100).toFixed(2)),
      avgFutureRiskAngle: Number((zone.riskAngleSum / households).toFixed(2)),
      avgPenaltyAngle: Number((zone.penaltyAngleSum / households).toFixed(2)),
      avgAdjustedAngle: Number(avgAdjustedAngle.toFixed(2)),
      avgAdjustedRate: Number((avgAdjustedAngle / 180 * 100).toFixed(2)),
      rateChangePoint: Number(((avgAdjustedAngle - avgCurrentAngle) / 180 * 100).toFixed(2)),
      reductionRate: Number((avgCurrentAngle > 0 ? (avgCurrentAngle - avgAdjustedAngle) / avgCurrentAngle * 100 : 0).toFixed(2)),
      affectedHouseholds: zone.affectedHouseholds,
      affectedShare: Number((zone.affectedHouseholds / households * 100).toFixed(2)),
      currentDistribution: bucketOrder.map(bucket => ({
        bucket,
        households: zone.currentBins[bucket],
        share: Number((zone.currentBins[bucket] / households * 100).toFixed(2))
      })),
      adjustedDistribution: bucketOrder.map(bucket => ({
        bucket,
        households: zone.adjustedBins[bucket],
        share: Number((zone.adjustedBins[bucket] / households * 100).toFixed(2))
      }))
    };
  }

  const summaries = zoneIds.map(zoneId => finalize(byZone[zoneId]));

  return {
    metadata: {
      calculationDate: '2026-07-11',
      riverFile: 'hangang_line_new.geojson',
      method: '3구역→2구역 및 4구역→5구역의 실제 차폐 감소율을 층 구간별로 산출하여, 2구역·5구역의 동일 절대방향 현재 개방각에 적용',
      formula: '장기조정각 = 현재조망각 - (미래차폐위험각 × 층구간 차폐계수)',
      sectorMethod: '실제 손실각 발생빈도의 90%를 포함하는 최소 원호 + 양끝 3도'
    },
    references: [
      { ...referenceFor2, sectorAngles: undefined },
      { ...referenceFor5, sectorAngles: undefined }
    ],
    summaries,
    records
  };
});

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

fs.writeFileSync('future_handicap_result.json', JSON.stringify(result, null, 2), 'utf8');

const summaryHeaders = [
  '구역', '유닛라인수', '세대표본수', '현재평균각도', '현재평균조망률',
  '평균미래위험각', '평균감산각', '장기조정평균각도', '장기조정평균조망률',
  '조망률증감포인트', '현재대비감소율', '영향세대수', '영향세대비율'
];
const summaryRows = [summaryHeaders];
for (const item of result.summaries) {
  summaryRows.push([
    item.zone, item.unitLines, item.households, item.avgCurrentAngle, item.avgCurrentRate,
    item.avgFutureRiskAngle, item.avgPenaltyAngle, item.avgAdjustedAngle, item.avgAdjustedRate,
    item.rateChangePoint, item.reductionRate, item.affectedHouseholds, item.affectedShare
  ]);
}
fs.writeFileSync(
  'future_handicap_summary.csv',
  '\ufeff' + summaryRows.map(row => row.map(csvCell).join(',')).join('\n'),
  'utf8'
);

const referenceRows = [[
  '참조관계', '참조구역', '차폐구역', '위험방향시작각', '위험방향끝각', '위험방향폭',
  '층구간', '표본수', '인접구역제외위험각합', '현재위험각합', '손실각합', '적용차폐계수'
]];
for (const ref of result.references) {
  for (const band of ref.bands) {
    referenceRows.push([
      ref.label, ref.referenceZone, ref.blockerZone, ref.sector.start, ref.sector.end,
      ref.sector.width, band.band, band.referenceObservations,
      band.counterfactualRiskAngle, band.currentRiskAngle, band.lostRiskAngle, band.coefficient
    ]);
  }
}
fs.writeFileSync(
  'future_handicap_reference_coefficients.csv',
  '\ufeff' + referenceRows.map(row => row.map(csvCell).join(',')).join('\n'),
  'utf8'
);

const distributionRows = [['구역', '구분', '조망률구간', '세대수', '비율']];
for (const item of result.summaries) {
  for (const row of item.currentDistribution) {
    distributionRows.push([item.zone, '현재', row.bucket, row.households, row.share]);
  }
  for (const row of item.adjustedDistribution) {
    distributionRows.push([item.zone, '장기조정', row.bucket, row.households, row.share]);
  }
}
fs.writeFileSync(
  'future_handicap_distribution.csv',
  '\ufeff' + distributionRows.map(row => row.map(csvCell).join(',')).join('\n'),
  'utf8'
);

const detailRows = [[
  '구역', '동', '평형', '층', '층구간', '현재조망각', '현재조망률', '미래차폐위험각',
  '적용차폐계수', '감산각', '장기조정각', '장기조정조망률', '현재구간', '장기조정구간'
]];
for (const row of result.records) {
  detailRows.push([
    row.zone, row.dong, row.unitType, row.floor, row.floorBand,
    row.currentAngle, row.currentRate, row.futureRiskAngle, row.appliedCoefficient,
    row.penaltyAngle, row.adjustedAngle, row.adjustedRate,
    row.currentBucket, row.adjustedBucket
  ]);
}
fs.writeFileSync(
  'future_handicap_detail.csv',
  '\ufeff' + detailRows.map(row => row.map(csvCell).join(',')).join('\n'),
  'utf8'
);

console.log(JSON.stringify({ references: result.references, summaries: result.summaries }, null, 2));
await browser.close();
