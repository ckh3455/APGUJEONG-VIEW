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

// 계산에 불필요한 지도 타일·통계·3D 건물 요청은 차단하고 Cesium 정적 파일과 로컬 데이터만 허용한다.
await page.route('**/*', async route => {
  const url = route.request().url();
  if (
    url.startsWith('http://127.0.0.1:8000/') ||
    url.startsWith('https://cesium.com/downloads/cesiumjs/')
  ) {
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

  const byZone = {};
  const records = [];
  const zoneIds = ['2', '3', '4', '5'];
  for (const zoneId of zoneIds) {
    byZone[zoneId] = {
      zone: `${zoneId}구역`,
      unitLines: 0,
      households: 0,
      angleSum: 0,
      minAngle: Infinity,
      maxAngle: -Infinity,
      bins: Object.fromEntries(bucketOrder.map(label => [label, 0]))
    };
  }

  for (const footprint of footprints) {
    const zoneId = normalizeZoneId(footprint.zoneName);
    const zone = byZone[zoneId];
    if (!zone) continue;
    const analysis = viewAnalysisByFid.get(String(footprint.fid));
    if (!analysis || !analysis.candidateData) continue;

    zone.unitLines += 1;
    const floors = Math.max(1, Math.round(Number(footprint.floors || 1)));
    for (let floor = 1; floor <= floors; floor += 1) {
      const view = summarizeFacadeCandidates(
        footprint,
        analysis.candidateData,
        floorEyeHeight(footprint, floor)
      );
      const angle = Number(view.totalOpen || 0);
      const rate = angle / 180 * 100;
      const bucket = bucketForRate(rate);

      zone.households += 1;
      zone.angleSum += angle;
      zone.minAngle = Math.min(zone.minAngle, angle);
      zone.maxAngle = Math.max(zone.maxAngle, angle);
      zone.bins[bucket] += 1;
      records.push({
        zone: `${zoneId}구역`,
        dong: String(footprint.dong || ''),
        unitType: String(footprint.unitType || ''),
        floor,
        angle: Number(angle.toFixed(1)),
        viewRate: Number(rate.toFixed(2)),
        bucket
      });
    }
  }

  function finalize(zone) {
    const avgAngle = zone.households ? zone.angleSum / zone.households : 0;
    const distribution = bucketOrder.map(label => ({
      bucket: label,
      households: zone.bins[label],
      share: zone.households ? zone.bins[label] / zone.households * 100 : 0
    }));
    return {
      zone: zone.zone,
      unitLines: zone.unitLines,
      households: zone.households,
      avgAngle: Number(avgAngle.toFixed(2)),
      avgViewRate: Number((avgAngle / 180 * 100).toFixed(2)),
      minAngle: Number((Number.isFinite(zone.minAngle) ? zone.minAngle : 0).toFixed(1)),
      maxAngle: Number((Number.isFinite(zone.maxAngle) ? zone.maxAngle : 0).toFixed(1)),
      distribution: distribution.map(row => ({
        ...row,
        share: Number(row.share.toFixed(2))
      }))
    };
  }

  const summaries = zoneIds.map(zoneId => finalize(byZone[zoneId]));
  const overallRaw = {
    zone: '전체', unitLines: 0, households: 0, angleSum: 0,
    minAngle: Infinity, maxAngle: -Infinity,
    bins: Object.fromEntries(bucketOrder.map(label => [label, 0]))
  };
  for (const zone of Object.values(byZone)) {
    overallRaw.unitLines += zone.unitLines;
    overallRaw.households += zone.households;
    overallRaw.angleSum += zone.angleSum;
    overallRaw.minAngle = Math.min(overallRaw.minAngle, zone.minAngle);
    overallRaw.maxAngle = Math.max(overallRaw.maxAngle, zone.maxAngle);
    for (const label of bucketOrder) overallRaw.bins[label] += zone.bins[label];
  }

  return {
    metadata: {
      calculationDate: '2026-07-11',
      appVersion: 'v42',
      riverFile: 'hangang_line_new.geojson',
      rateFormula: '조망률 = 조망각 / 180도 × 100',
      note: '각 유닛 폴리곤의 1층부터 최고층까지를 세대 표본으로 계산'
    },
    summaries: [...summaries, finalize(overallRaw)],
    records
  };
});

fs.writeFileSync('view_rate_new_hangang.json', JSON.stringify(result, null, 2), 'utf8');

const summaryRows = [
  ['구역', '유닛라인수', '세대표본수', '평균조망각도', '평균조망률', '최소각도', '최대각도',
    '10% 이하', '10-20%', '21-30%', '31-40%', '41-50%', '51-60%',
    '61-70%', '71-80%', '81-90%', '91-100%', '100% 이상']
];
for (const item of result.summaries) {
  const shares = Object.fromEntries(item.distribution.map(row => [row.bucket, row.share]));
  summaryRows.push([
    item.zone, item.unitLines, item.households, item.avgAngle, item.avgViewRate,
    item.minAngle, item.maxAngle,
    ...summaryRows[0].slice(7).map(label => shares[label] ?? 0)
  ]);
}
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
fs.writeFileSync(
  'view_rate_new_hangang_summary.csv',
  '\ufeff' + summaryRows.map(row => row.map(csvCell).join(',')).join('\n'),
  'utf8'
);

const detailRows = [['구역', '동', '평형', '층', '조망각도', '조망률', '구간']];
for (const row of result.records) {
  detailRows.push([row.zone, row.dong, row.unitType, row.floor, row.angle, row.viewRate, row.bucket]);
}
fs.writeFileSync(
  'view_rate_new_hangang_detail.csv',
  '\ufeff' + detailRows.map(row => row.map(csvCell).join(',')).join('\n'),
  'utf8'
);

console.log(JSON.stringify(result.summaries, null, 2));
await browser.close();
