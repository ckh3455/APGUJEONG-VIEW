const fs = require('fs');
let source = fs.readFileSync('tools/calc_uniform_compare.js', 'utf8');
const replacement = String.raw`
function createUniformLayout(zone2Groups,boundary){
  const prior=JSON.parse(fs.readFileSync('analysis_results/zone2_uniform_view_compare.json','utf8'));
  const targets=new Map((prior.layout.mapping||[]).map(m=>[String(m.dong),xy(Number(m.to[0]),Number(m.to[1]))]));
  const mix=new Map(Object.entries({
    '101':1.00,'102':1.00,'103':0.20,'104':1.00,'105':1.00,'106':0.00,'107':0.15,
    '108':0.30,'109':1.00,'110':1.00,'111':0.50,'112':0.10,'113':0.50,'114':1.00
  }));
  const moved=zone2Groups.map(g=>{
    const target=targets.get(String(g.dong))||g.center,w=Number(mix.get(String(g.dong))??0);
    const center=add(g.center,mul(sub(target,g.center),w)),d=sub(center,g.center);
    return {...g,center,hull:g.hull.map(p=>add(p,d))};
  });
  let outside=0,overlaps=0,clearDef=0,minClear=Infinity;
  for(const g of moved)for(const p of g.hull)if(!pointInPoly(p,boundary))outside++;
  for(let i=0;i<moved.length;i++)for(let j=i+1;j<moved.length;j++){
    const d=minPolyDistance(moved[i].hull,moved[j].hull);minClear=Math.min(minClear,d);
    if(d===0)overlaps++;clearDef+=Math.max(0,2-d);
  }
  const trans=new Map(),mapping=[];
  zone2Groups.forEach((g,i)=>{const d=sub(moved[i].center,g.center);trans.set(g.key,d);mapping.push({dong:g.dong,from:ll(g.center),to:ll(moved[i].center),moveM:+dist(g.center,moved[i].center).toFixed(1),uniformMix:Number(mix.get(String(g.dong))??0)});});
  return {translations:trans,mapping,diagnostics:{algorithm:'view-preserving hybrid of current and collision-safe uniform layout',outsideVertices:outside,overlapPairs:overlaps,clearanceDeficitM:+clearDef.toFixed(1),minimumBuildingClearanceM:+minClear.toFixed(1),...layoutStats(moved)}};
}
`;
source = source.replace(/function createUniformLayout\([\s\S]*?\n}\nfunction analyzeScenario/, replacement + '\nfunction analyzeScenario');
source = source.replace('2구역 동 형상·방향·층수 유지, 동 전체를 4/3 엇갈림 계열 격자 목표점으로 평행이동, 기존 위치와의 이동비용 최소화','균등분산 수혜 이동은 유지하고 106·107·112동 등 손실 동은 현재 위치 쪽으로 복귀한 조망 보전형 혼합 배치');
source = source.replace(/zone2_uniform_view_compare\.json/g,'zone2_view_preserving_compare.json');
source = source.replace(/apgujeong_2_units_uniform/g,'apgujeong_2_units_view_preserving');
source = source.replace(/uniform_staggered/g,'view_preserving_concept_v1');
new Function('require','process','console',source)(require,process,console);
