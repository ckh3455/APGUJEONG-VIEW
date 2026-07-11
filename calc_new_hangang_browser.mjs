import fs from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(300_000);

page.on('console', msg => {
  const text = msg.text();
  if (/error|fail|계산 완료/i.test(text)) console.log(`[browser:${msg.type()}] ${text}`);
});
page.on('pageerror', error => console.error('[pageerror]', error.message));

await page.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith('http://127.0.0.1:8000/') || url.startsWith('https://cesium.com/downloads/cesiumjs/')) {
    await route.continue();
    return;
  }
  if (url.startsWith('data:') || url.startsWith('blob:')) {
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
      Array.isArray(footprints) && footprints.length >= 200 &&
      Array.isArray(riverSegments) && riverSegments.length > 0;
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

  function floorBand(floor) {
    if (floor <= 20) return '1-20층';
    if (floor <= 40) return '21-40층';
    if (floor <= 60) return '41-60층';
    return '61층 이상';
  }

  function blockerZone(blocker) {
    return normalizeZoneId(blocker?.zoneName || blocker?.zone || '');
  }

  function openProfiles(candidateData, observerHeight, excludedZone = null) {
    const open = [];
    for (const profile of candidateData.angleProfiles || []) {
      let blockerHeight = Number(profile.blockerHeight || 0);
      if (excludedZone) {
        blockerHeight = 0;
        for (const blocker of profile.blockers || []) {
          if (blockerZone(blocker) === excludedZone) continue;
          blockerHeight = Math.max(blockerHeight, Number(blocker.height || 0));
        }
      }
      if (blockerHeight < observerHeight) open.push(profile);
    }
    return open;
  }

  function totalOpen(candidateData, observerHeight, excludedZone = null) {
    const rays = openProfiles(candidateData, observerHeight, excludedZone)
      .map(profile => ({ angle: profile.angle, order: profile.order ?? profile.angle, distance: profile.distance }))
      .sort((a, b) => a.order - b.order);
    return summarizeOpenGaps(rays).total;
  }

  function buildRiskAngleSet(sourceZone, blockerZoneId) {
    const set = new Set();
    for (const footprint of footprints) {
      if (normalizeZoneId(footprint.zoneName) !== sourceZone) continue;
      const analysis = viewAnalysisByFid.get(String(footprint.fid));
      if (!analysis?.candidateData) continue;
      for (const profile of analysis.candidateData.angleProfiles || []) {
        if ((profile.blockers || []).some(blocker => blockerZone(blocker) === blockerZoneId)) {
          const angle = Number(profile.angle);
          for (let d = -2; d <= 2; d += 1) set.add((angle + d + 360) % 360);
        }
      }
    }
    return set;
  }

  function calculateProxy(sourceZone, blockerZoneId) {
    const bands = Object.fromEntries(['1-20층', '21-40층', '41-60층', '61층 이상'].map(b => [b, {
      potentialAngle: 0, currentAngle: 0, lostAngle: 0, households: 0
    }]));
    let totalPotential = 0;
    let totalCurrent = 0;
    let households = 0;

    for (const footprint of footprints) {
      if (normalizeZoneId(footprint.zoneName) !== sourceZone) continue;
      const analysis = viewAnalysisByFid.get(String(footprint.fid));
      if (!analysis?.candidateData) continue;
      const floors = Math.max(1, Math.round(Number(footprint.floors || 1)));
      for (let floor = 1; floor <= floors; floor += 1) {
        const height = floorEyeHeight(footprint, floor);
        const current = totalOpen(analysis.candidateData, height, null);
        const potential = totalOpen(analysis.candidateData, height, blockerZoneId);
        const lost = Math.max(0, potential - current);
        const band = bands[floorBand(floor)];
        band.potentialAngle += potential;
        band.currentAngle += current;
        band.lostAngle += lost;
        band.households += 1;
        totalPotential += potential;
        totalCurrent += current;
        households += 1;
      }
    }

    const finalizeBand = band => ({
      households: band.households,
      potentialAngle: Number(band.potentialAngle.toFixed(1)),
      currentAngle: Number(band.currentAngle.toFixed(1)),
      lostAngle: Number(band.lostAngle.toFixed(1)),
      coefficient: Number((band.potentialAngle > 0 ? band.lostAngle / band.potentialAngle : 0).toFixed(4))
    });

    return {
      sourceZone: `${sourceZone}구역`,
      blockerZone: `${blockerZoneId}구역`,
      households,
      potentialAngle: Number(totalPotential.toFixed(1)),
      currentAngle: Number(totalCurrent.toFixed(1)),
      lostAngle: Number((totalPotential - totalCurrent).toFixed(1)),
      coefficient: Number((totalPotential > 0 ? (totalPotential - totalCurrent) / totalPotential : 0).toFixed(4)),
      bands: Object.fromEntries(Object.entries(bands).map(([name, band]) => [name, finalizeBand(band)]))
    };
  }

  const proxy2 = calculateProxy('3', '2');
  const proxy5 = calculateProxy('4', '5');
  const riskAngles2 = buildRiskAngleSet('3', '2');
  const riskAngles5 = buildRiskAngleSet('4', '5');

  function newZoneAccumulator(zoneId) {
    return {
      zone: `${zoneId}구역`, unitLines: 0, households: 0,
      currentAngleSum: 0, adjustedAngleSum: 0,
      currentBins: Object.fromEntries(bucketOrder.map(label => [label, 0])),
      adjustedBins: Object.fromEntries(bucketOrder.map(label => [label, 0])),
      riskOpenAngleSum: 0,
      minAdjusted: Infinity, maxAdjusted: -Infinity
    };
  }

  const byZone = Object.fromEntries(zoneIds.map(id => [id, newZoneAccumulator(id)]));
  const records = [];

  for (const footprint of footprints) {
    const zoneId = normalizeZoneId(footprint.zoneName);
    const zone = byZone[zoneId];
    if (!zone) continue;
    const analysis = viewAnalysisByFid.get(String(footprint.fid));
    if (!analysis?.candidateData) continue;

    zone.unitLines += 1;
    const floors = Math.max(1, Math.round(Number(footprint.floors || 1)));
    for (let floor = 1; floor <= floors; floor += 1) {
      const height = floorEyeHeight(footprint, floor);
      const currentView = summarizeFacadeCandidates(footprint, analysis.candidateData, height);
      const currentAngle = Number(currentView.totalOpen || 0);
      let adjustedAngle = currentAngle;
      let riskOpenAngle = 0;
      let coefficient = 0;
      let proxyBasis = '';

      if (zoneId === '2' || zoneId === '5') {
        const riskSet = zoneId === '2' ? riskAngles2 : riskAngles5;
        const proxy = zoneId === '2' ? proxy2 : proxy5;
        const open = openProfiles(analysis.candidateData, height, null);
        riskOpenAngle = open.reduce((sum, profile) => sum + (riskSet.has(Number(profile.angle)) ? 1 : 0), 0);
        coefficient = proxy.bands[floorBand(floor)]?.coefficient ?? proxy.coefficient;
        adjustedAngle = Math.max(0, currentAngle - riskOpenAngle * coefficient);
        proxyBasis = zoneId === '2' ? '3구역에서 2구역 차폐' : '4구역에서 5구역 차폐';
      }

      const currentRate = currentAngle / 180 * 100;
      const adjustedRate = adjustedAngle / 180 * 100;
      zone.households += 1;
      zone.currentAngleSum += currentAngle;
      zone.adjustedAngleSum += adjustedAngle;
      zone.riskOpenAngleSum += riskOpenAngle;
      zone.currentBins[bucketForRate(currentRate)] += 1;
      zone.adjustedBins[bucketForRate(adjustedRate)] += 1;
      zone.minAdjusted = Math.min(zone.minAdjusted, adjustedAngle);
      zone.maxAdjusted = Math.max(zone.maxAdjusted, adjustedAngle);

      records.push({
        zone: `${zoneId}구역`, dong: String(footprint.dong || ''),
        unitType: String(footprint.unitType || ''), floor,
        floorBand: floorBand(floor), currentAngle: Number(currentAngle.toFixed(2)),
        currentRate: Number(currentRate.toFixed(2)), riskOpenAngle: Number(riskOpenAngle.toFixed(2)),
        handicapCoefficient: Number(coefficient.toFixed(4)),
        adjustedAngle: Number(adjustedAngle.toFixed(2)), adjustedRate: Number(adjustedRate.toFixed(2)),
        rateDrop: Number((currentRate - adjustedRate).toFixed(2)), proxyBasis
      });
    }
  }

  function finalize(zone) {
    const avgCurrentAngle = zone.households ? zone.currentAngleSum / zone.households : 0;
    const avgAdjustedAngle = zone.households ? zone.adjustedAngleSum / zone.households : 0;
    return {
      zone: zone.zone,
      unitLines: zone.unitLines,
      households: zone.households,
      avgCurrentAngle: Number(avgCurrentAngle.toFixed(2)),
      avgCurrentRate: Number((avgCurrentAngle / 180 * 100).toFixed(2)),
      avgAdjustedAngle: Number(avgAdjustedAngle.toFixed(2)),
      avgAdjustedRate: Number((avgAdjustedAngle / 180 * 100).toFixed(2)),
      avgRateDrop: Number(((avgCurrentAngle - avgAdjustedAngle) / 180 * 100).toFixed(2)),
      avgRiskOpenAngle: Number((zone.households ? zone.riskOpenAngleSum / zone.households : 0).toFixed(2)),
      minAdjustedAngle: Number((Number.isFinite(zone.minAdjusted) ? zone.minAdjusted : 0).toFixed(2)),
      maxAdjustedAngle: Number((Number.isFinite(zone.maxAdjusted) ? zone.maxAdjusted : 0).toFixed(2)),
      currentDistribution: bucketOrder.map(label => ({
        bucket: label, households: zone.currentBins[label],
        share: Number((zone.households ? zone.currentBins[label] / zone.households * 100 : 0).toFixed(2))
      })),
      adjustedDistribution: bucketOrder.map(label => ({
        bucket: label, households: zone.adjustedBins[label],
        share: Number((zone.households ? zone.adjustedBins[label] / zone.households * 100 : 0).toFixed(2))
      }))
    };
  }

  return {
    metadata: {
      calculationDate: '2026-07-11',
      riverFile: 'hangang_line_new.geojson',
      formula: '장기 조정각 = 현재 조망각 - 미래차폐 위험각 × 층구간별 실측 차폐계수',
      riskAngleMethod: '3구역에서 2구역 건물이 관여한 방위각을 2구역 위험방향으로, 4구역에서 5구역 건물이 관여한 방위각을 5구역 위험방향으로 사용',
      angleExpansion: '관측된 위험 방위각 ±2도'
    },
    proxies: {
      zone2Future: proxy2,
      zone5Future: proxy5,
      riskAngleCount2: riskAngles2.size,
      riskAngleCount5: riskAngles5.size
    },
    summaries: zoneIds.map(id => finalize(byZone[id])),
    records
  };
});

fs.writeFileSync('future_handicap_view_results.json', JSON.stringify(result, null, 2), 'utf8');

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const summaryRows = [['구역','유닛라인수','세대표본수','현재평균각도','현재평균조망률','장기조정평균각도','장기조정평균조망률','평균하락폭(%p)','평균미래차폐위험각']];
for (const item of result.summaries) {
  summaryRows.push([item.zone,item.unitLines,item.households,item.avgCurrentAngle,item.avgCurrentRate,item.avgAdjustedAngle,item.avgAdjustedRate,item.avgRateDrop,item.avgRiskOpenAngle]);
}
fs.writeFileSync('future_handicap_summary.csv','\ufeff'+summaryRows.map(r=>r.map(csvCell).join(',')).join('\n'),'utf8');

const proxyRows = [['적용대상','참고관계','층구간','표본수','잠재조망각합','현재조망각합','차폐각합','차폐계수']];
for (const [target, proxy, basis] of [['2구역',result.proxies.zone2Future,'3구역→2구역'],['5구역',result.proxies.zone5Future,'4구역→5구역']]) {
  for (const [band, row] of Object.entries(proxy.bands)) {
    proxyRows.push([target,basis,band,row.households,row.potentialAngle,row.currentAngle,row.lostAngle,row.coefficient]);
  }
  proxyRows.push([target,basis,'전체',proxy.households,proxy.potentialAngle,proxy.currentAngle,proxy.lostAngle,proxy.coefficient]);
}
fs.writeFileSync('future_handicap_coefficients.csv','\ufeff'+proxyRows.map(r=>r.map(csvCell).join(',')).join('\n'),'utf8');

const detailRows = [['구역','동','평형','층','층구간','현재각도','현재조망률','미래차폐위험각','핸디캡계수','장기조정각도','장기조정조망률','하락폭(%p)','계수근거']];
for (const r of result.records) detailRows.push([r.zone,r.dong,r.unitType,r.floor,r.floorBand,r.currentAngle,r.currentRate,r.riskOpenAngle,r.handicapCoefficient,r.adjustedAngle,r.adjustedRate,r.rateDrop,r.proxyBasis]);
fs.writeFileSync('future_handicap_detail.csv','\ufeff'+detailRows.map(r=>r.map(csvCell).join(',')).join('\n'),'utf8');

console.log(JSON.stringify({ proxies: result.proxies, summaries: result.summaries }, null, 2));
await browser.close();
