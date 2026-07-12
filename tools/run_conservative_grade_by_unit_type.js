const fs = require('fs');
let source = fs.readFileSync('tools/calc_uniform_compare.js', 'utf8');
const custom = String.raw`
function analyzeZoneScenario(footprints, river, targetZone){
  const groups=buildGroups(footprints),gmap=new Map(groups.map(g=>[g.key,g])),records=[];
  const targets=footprints.filter(f=>f.zoneId===targetZone);let idx=0;
  for(const fp of targets){
    idx++;
    const g=gmap.get(targetZone+':'+fp.dong),profiles=candidateProfiles(fp,g,groups,river);
    for(let floor=1;floor<=fp.floors;floor++) records.push({id:fp.id,zone:targetZone,dong:fp.dong,unitType:fp.unitType||'미표기',floor,weight:fp.weight,angle:openAngle(profiles,eyeHeight(fp,floor))});
    if(idx%10===0) console.error('zone '+targetZone+': analyzed '+idx+'/'+targets.length);
  }
  return records;
}
function gradeOf(v){
  if(v>=100)return '특A급';
  if(v>=81)return 'A급';
  if(v>=61)return 'B급';
  if(v>=41)return 'C급';
  if(v>=21)return 'D급';
  return 'E급';
}
function summarizeGrades(records){
  const order=['특A급','A급','B급','C급','D급','E급'];
  const counts=Object.fromEntries(order.map(k=>[k,0]));let total=0,sum=0;
  for(const r of records){counts[gradeOf(r.angle)]+=r.weight;total+=r.weight;sum+=r.angle*r.weight;}
  const percentages=Object.fromEntries(order.map(k=>[k,total?+(counts[k]*100/total).toFixed(2):0]));
  return {count:total,averageAngle:total?+(sum/total).toFixed(2):0,counts,percentages};
}
function gradeReportMain(){
  const files={2:'apgujeong_2_units.geojson',3:'apg3_unit_polygon.geojson',4:'apgujeong_4_units.geojson',5:'apgujeong_5_units.geojson'};
  const base=Object.entries(files).flatMap(([z,f])=>prepareFeatures(z,f));
  const river=buildRiver(loadJson('hangang_line_all.geojson'));
  const report={generatedAt:new Date().toISOString(),method:{riverLine:'hangang_line_all.geojson (보수적)',sampleStepM:SAMPLE_STEP_M,angleStepDeg:ANGLE_STEP_DEG,weight:'평형 피처의 unit_type 쉼표 분리 개수 × 층수',grades:{'특A급':'100 이상','A급':'81~99','B급':'61~80','C급':'41~60','D급':'21~40','E급':'20 이하'},blockers:'2·3·4·5구역 전체 현 위치 차폐 반영'},zones:{}};
  const csv=[['구역','평형','계산단위','평균조망각','특A급','A급','B급','C급','D급','E급']];
  for(const z of ['2','3','4','5']){
    console.error('Calculating zone '+z+'...');
    const records=analyzeZoneScenario(base,river,z);
    const byType=new Map();
    for(const r of records){const key=(r.unitType||'미표기').trim()||'미표기';if(!byType.has(key))byType.set(key,[]);byType.get(key).push(r);}
    const types={};
    for(const [type,recs] of [...byType].sort((a,b)=>a[0].localeCompare(b[0],'ko',{numeric:true}))){
      const s=summarizeGrades(recs);types[type]=s;csv.push([z+'구역',type,s.count,s.averageAngle,...['특A급','A급','B급','C급','D급','E급'].map(k=>s.percentages[k])]);
    }
    report.zones[z]={overall:summarizeGrades(records),unitTypes:types};
  }
  fs.mkdirSync(OUT_DIR,{recursive:true});
  fs.writeFileSync(path.join(OUT_DIR,'conservative_grade_by_zone_unit_type.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(OUT_DIR,'conservative_grade_by_zone_unit_type.csv'),'\ufeff'+csv.map(row=>row.map(v=>{const s=String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(',')).join('\n'));
  console.log(JSON.stringify(report.zones,null,2));
}
`;
source = source.replace(/\nmain\(\);\s*$/, '\n'+custom+'\ngradeReportMain();\n');
new Function('require','process','console',source)(require,process,console);
