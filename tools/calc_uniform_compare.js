const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'analysis_results');
const ORIGIN_LON = 127.03255;
const ORIGIN_LAT = 37.52545;
const M_PER_LAT = 110540;
const M_PER_LON = 111320 * Math.cos(rad(ORIGIN_LAT));
const SAMPLE_STEP_M = 8;
const ANGLE_STEP_DEG = 1;
const RAY_EPS_M = 1.5;

function rad(v){ return v * Math.PI / 180; }
function deg(v){ return v * 180 / Math.PI; }
function xy(lon,lat){ return {x:(lon-ORIGIN_LON)*M_PER_LON,y:(lat-ORIGIN_LAT)*M_PER_LAT}; }
function ll(p){ return [p.x/M_PER_LON+ORIGIN_LON,p.y/M_PER_LAT+ORIGIN_LAT]; }
function add(a,b){ return {x:a.x+b.x,y:a.y+b.y}; }
function sub(a,b){ return {x:a.x-b.x,y:a.y-b.y}; }
function mul(a,s){ return {x:a.x*s,y:a.y*s}; }
function dot(a,b){ return a.x*b.x+a.y*b.y; }
function dist(a,b){ return Math.hypot(a.x-b.x,a.y-b.y); }
function normAngle(a){ return ((a%360)+360)%360; }
function bearing(a,b){ return normAngle(deg(Math.atan2(b.x-a.x,b.y-a.y))); }
function centroid(points){ let x=0,y=0; for(const p of points){x+=p.x;y+=p.y;} return {x:x/points.length,y:y/points.length}; }
function closeRing(r){ if(!r.length)return r; const a=r[0],b=r[r.length-1]; return dist(a,b)<1e-7?r.slice(0,-1):r.slice(); }
function segments(r){ const out=[]; for(let i=0;i<r.length;i++) out.push({a:r[i],b:r[(i+1)%r.length]}); return out; }
function cross(o,a,b){ return (a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x); }
function hull(points){
  const uniq=[]; const seen=new Set();
  for(const p of points){ const k=`${p.x.toFixed(3)}:${p.y.toFixed(3)}`; if(!seen.has(k)){seen.add(k);uniq.push({...p});} }
  if(uniq.length<=3) return uniq;
  uniq.sort((a,b)=>a.x===b.x?a.y-b.y:a.x-b.x);
  const lo=[]; for(const p of uniq){ while(lo.length>=2&&cross(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p); }
  const hi=[]; for(let i=uniq.length-1;i>=0;i--){const p=uniq[i];while(hi.length>=2&&cross(hi[hi.length-2],hi[hi.length-1],p)<=0)hi.pop();hi.push(p);}
  lo.pop();hi.pop();return lo.concat(hi);
}
function pointInPoly(p,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if(((a.y>p.y)!==(b.y>p.y)) && p.x < (b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) inside=!inside;
  }
  return inside;
}
function pointSegDist(p,a,b){ const ab=sub(b,a); const d=dot(ab,ab); if(!d)return dist(p,a); const t=Math.max(0,Math.min(1,dot(sub(p,a),ab)/d)); return dist(p,add(a,mul(ab,t))); }
function polyBoundaryDistance(p,ring){ let m=Infinity; for(const s of segments(ring))m=Math.min(m,pointSegDist(p,s.a,s.b)); return m; }
function raySegDistance(o,bearingDeg,a,b){
  const th=rad(bearingDeg), d={x:Math.sin(th),y:Math.cos(th)}, v=sub(b,a), w=sub(a,o);
  const cr=d.x*v.y-d.y*v.x; if(Math.abs(cr)<1e-10)return null;
  const t=(w.x*v.y-w.y*v.x)/cr, u=(w.x*d.y-w.y*d.x)/cr;
  return t>=0&&u>=0&&u<=1?t:null;
}
function segsIntersect(a,b,c,d){
  const orient=(p,q,r)=>Math.sign(cross(p,q,r));
  const o1=orient(a,b,c),o2=orient(a,b,d),o3=orient(c,d,a),o4=orient(c,d,b);
  if(o1!==o2&&o3!==o4)return true;
  return false;
}
function polygonsIntersect(a,b){
  for(const sa of segments(a))for(const sb of segments(b))if(segsIntersect(sa.a,sa.b,sb.a,sb.b))return true;
  return pointInPoly(a[0],b)||pointInPoly(b[0],a);
}
function minPolyDistance(a,b){
  if(polygonsIntersect(a,b))return 0;
  let m=Infinity; for(const p of a)for(const s of segments(b))m=Math.min(m,pointSegDist(p,s.a,s.b));
  for(const p of b)for(const s of segments(a))m=Math.min(m,pointSegDist(p,s.a,s.b)); return m;
}
function sampleRing(ring,step=SAMPLE_STEP_M){
  const out=[];
  for(let i=0;i<ring.length;i++){
    const a=ring[i],b=ring[(i+1)%ring.length],len=dist(a,b),n=Math.max(1,Math.ceil(len/step));
    for(let k=0;k<n;k++){ const t=(k+.5)/n; out.push({point:add(a,mul(sub(b,a),t)),length:len/n}); }
  }
  return out;
}
function normalizeZone(v){ const s=String(v??''); const m=s.match(/[2345]/); return m?m[0]:s.trim(); }
function floorCount(props){ const z=normalizeZone(props.zone||props.source_zone); if(z==='2'&&String(props.dong)==='105')return 65; return Math.max(1,Math.round(Number(props.floors||1))); }
function floorHeight(props){ const raw=Number(props.floor_h); if(raw>0&&raw<20)return raw; if(raw>=1000&&raw<10000)return raw/1000; const z=normalizeZone(props.zone||props.source_zone); return (z==='2'||z==='3')?3.692:3.692; }
function totalHeight(props){
  const f=floorCount(props),fh=floorHeight(props),pil=Number(props.piloti_m||0),h=Number(props.height_m||props.height||0),body=f*fh,exp=body+pil;
  if(!(h>0))return exp; if(Math.abs(h-body)<=.25)return h+pil; if(Math.abs(h-exp)<=.25)return h; return h;
}
function unitWeight(props){ const s=String(props.unit_type||'').trim(); return Math.max(1,s.split(',').map(x=>x.trim()).filter(Boolean).length); }
function ringsFromGeometry(g){
  if(!g)return[];
  if(g.type==='Polygon')return [closeRing(g.coordinates[0].map(([x,y])=>xy(x,y)))];
  if(g.type==='MultiPolygon')return g.coordinates.map(p=>closeRing(p[0].map(([x,y])=>xy(x,y))));
  return[];
}
function loadJson(name){ return JSON.parse(fs.readFileSync(path.join(ROOT,name),'utf8')); }
function prepareFeatures(zoneId,file){
  const data=loadJson(file),out=[];
  (data.features||[]).forEach((f,idx)=>{
    for(const ring of ringsFromGeometry(f.geometry)){
      const props={...(f.properties||{})};
      out.push({ id:`${zoneId}-${props.fid??idx+1}`, zoneId, dong:String(props.dong||''), unitType:String(props.unit_type||''), floors:floorCount(props), piloti:Number(props.piloti_m||0), floorH:floorHeight(props), height:totalHeight(props), weight:unitWeight(props), props, ring, center:centroid(ring), segs:segments(ring) });
    }
  });
  return out;
}
function buildGroups(footprints){
  const map=new Map();
  for(const fp of footprints){ const key=`${fp.zoneId}:${fp.dong}`; if(!map.has(key))map.set(key,{key,zoneId:fp.zoneId,dong:fp.dong,members:[],height:0,points:[]}); const g=map.get(key); g.members.push(fp); g.height=Math.max(g.height,fp.height); g.points.push(...fp.ring); }
  for(const g of map.values()){ g.hull=hull(g.points); g.center=centroid(g.points); g.segs=segments(g.hull); g.radius=Math.max(...g.hull.map(p=>dist(p,g.center))); }
  return [...map.values()];
}
function buildRiver(data){
  const segs=[],points=[];
  for(const f of data.features||[]){ const g=f.geometry;if(!g)continue; const lines=g.type==='LineString'?[g.coordinates]:g.type==='MultiLineString'?g.coordinates:[]; for(const line of lines){ const ps=line.map(([x,y])=>xy(x,y)); points.push(...ps); for(let i=0;i<ps.length-1;i++){ const a=ps[i],b=ps[i+1]; segs.push({a,b}); const n=Math.max(1,Math.floor(dist(a,b)/25)); for(let k=1;k<n;k++)points.push(add(a,mul(sub(b,a),k/n))); } } }
  return {segs,points};
}
function nearestRay(o,a,segs,max=Infinity){ let best=Infinity; for(const s of segs){ const t=raySegDistance(o,a,s.a,s.b); if(t!==null&&t>RAY_EPS_M&&t<best&&t<max)best=t; } return best; }
function angularScan(origin,points){
  const bs=points.map(p=>bearing(origin,p)).sort((a,b)=>a-b); if(!bs.length)return[]; if(bs.length===1)return[Math.round(bs[0])];
  let gap=-1,idx=0; for(let i=0;i<bs.length;i++){ const n=bs[(i+1)%bs.length]+(i===bs.length-1?360:0),g=n-bs[i]; if(g>gap){gap=g;idx=i;} }
  const start=bs[(idx+1)%bs.length],span=360-gap,out=[]; for(let d=0;d<=span;d+=ANGLE_STEP_DEG)out.push(normAngle(Math.round(start+d))); return [...new Set(out)];
}
function pointNearHull(p,g){ return polyBoundaryDistance(p,g.hull)<=2.5; }
function rayLeavesFootprint(p,a,fp){ const th=rad(a),q={x:p.x+Math.sin(th)*.8,y:p.y+Math.cos(th)*.8}; return !pointInPoly(q,fp.ring); }
function candidateProfiles(fp,sourceGroup,groups,river){
  const byAngle=new Map();
  for(const sm of sampleRing(fp.ring)){
    if(!pointNearHull(sm.point,sourceGroup))continue;
    for(const a of angularScan(sm.point,river.points)){
      if(!rayLeavesFootprint(sm.point,a,fp))continue;
      const riverD=nearestRay(sm.point,a,river.segs); if(!Number.isFinite(riverD))continue;
      let blockerHeight=0;
      for(const g of groups){ if(g.key===sourceGroup.key)continue; const t=nearestRay(sm.point,a,g.segs,riverD); if(Number.isFinite(t))blockerHeight=Math.max(blockerHeight,g.height); }
      const cur=byAngle.get(a); if(!cur||blockerHeight<cur.blockerHeight||(blockerHeight===cur.blockerHeight&&riverD<cur.riverD))byAngle.set(a,{angle:a,blockerHeight,riverD});
    }
  }
  return [...byAngle.values()].sort((a,b)=>a.angle-b.angle);
}
function eyeHeight(fp,floor){ return Math.min(fp.piloti+Math.max(0,floor-.5)*fp.floorH,fp.height+1.5); }
function openAngle(profiles,h){ return profiles.reduce((n,p)=>n+(p.blockerHeight<h?1:0),0); }
function translateScenario(baseFootprints,translations){
  return baseFootprints.map(fp=>{
    const d=translations.get(`${fp.zoneId}:${fp.dong}`)||{x:0,y:0}; const ring=fp.ring.map(p=>add(p,d)); return {...fp,ring,center:add(fp.center,d),segs:segments(ring)};
  });
}
function selectBoundary(){
  const candidates=['apgujeong_zone_boundaries.geojson','apgujeong_osm_clipping_zones.geojson'];
  for(const file of candidates){ if(!fs.existsSync(path.join(ROOT,file)))continue; const data=loadJson(file); for(const f of data.features||[]){ const p=f.properties||{},z=normalizeZone(p.zone||p.zone_id||p.name||p.id); if(z!=='2')continue; const rs=ringsFromGeometry(f.geometry); if(rs.length){ rs.sort((a,b)=>Math.abs(polyArea(b))-Math.abs(polyArea(a))); return {ring:rs[0],file}; } } }
  throw new Error('2구역 경계 폴리곤을 찾지 못했습니다.');
}
function polyArea(r){ let s=0; for(let i=0;i<r.length;i++){const a=r[i],b=r[(i+1)%r.length];s+=a.x*b.y-b.x*a.y;} return s/2; }
function pcaAxes(points){
  const c=centroid(points); let xx=0,xyv=0,yy=0; for(const p of points){const x=p.x-c.x,y=p.y-c.y;xx+=x*x;xyv+=x*y;yy+=y*y;} const ang=.5*Math.atan2(2*xyv,xx-yy); return {c,u:{x:Math.cos(ang),y:Math.sin(ang)},v:{x:-Math.sin(ang),y:Math.cos(ang)},angle:ang};
}
function project(p,ax){ const q=sub(p,ax.c); return {u:dot(q,ax.u),v:dot(q,ax.v)}; }
function unproject(q,ax){ return add(ax.c,add(mul(ax.u,q.u),mul(ax.v,q.v))); }
function rotatedAxes(base,offDeg){ const a=base.angle+rad(offDeg); return {c:base.c,u:{x:Math.cos(a),y:Math.sin(a)},v:{x:-Math.sin(a),y:Math.cos(a)},angle:a}; }
function horizontalIntervals(polyUV,y){
  const xs=[]; for(let i=0;i<polyUV.length;i++){const a=polyUV[i],b=polyUV[(i+1)%polyUV.length]; if((a.v>y)!==(b.v>y))xs.push(a.u+(b.u-a.u)*(y-a.v)/(b.v-a.v));}
  xs.sort((a,b)=>a-b); const ints=[]; for(let i=0;i+1<xs.length;i+=2)ints.push([xs[i],xs[i+1]]); return ints.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]));
}
function hungarian(cost){
  const n=cost.length,m=cost[0].length,u=Array(n+1).fill(0),v=Array(m+1).fill(0),p=Array(m+1).fill(0),way=Array(m+1).fill(0);
  for(let i=1;i<=n;i++){p[0]=i;let j0=0,minv=Array(m+1).fill(Infinity),used=Array(m+1).fill(false);do{used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;for(let j=1;j<=m;j++)if(!used[j]){const cur=cost[i0-1][j-1]-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}}for(let j=0;j<=m;j++)if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;j0=j1;}while(p[j0]!==0);do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0);}
  const ans=Array(n).fill(-1);for(let j=1;j<=m;j++)if(p[j])ans[p[j]-1]=j-1;return ans;
}
function layoutStats(groups){
  const ds=[]; for(let i=0;i<groups.length;i++){let m=Infinity;for(let j=0;j<groups.length;j++)if(i!==j)m=Math.min(m,dist(groups[i].center,groups[j].center));ds.push(m);} const avg=ds.reduce((a,b)=>a+b,0)/ds.length; const sd=Math.sqrt(ds.reduce((s,x)=>s+(x-avg)**2,0)/ds.length); return {min:+Math.min(...ds).toFixed(1),avg:+avg.toFixed(1),cv:+(sd/avg).toFixed(3)};
}
function createUniformLayout(zone2Groups,boundary){
  const basePca=pcaAxes(boundary), patterns=[[4,3,4,3],[3,4,3,4],[3,4,4,3],[4,3,3,4],[5,4,5],[5,5,4],[4,5,5]];
  let best=null;
  for(let off=-25;off<=25;off+=5){ const ax=rotatedAxes(basePca,off),polyUV=boundary.map(p=>project(p,ax)),vs=polyUV.map(p=>p.v),minV=Math.min(...vs),maxV=Math.max(...vs);
    for(const pattern of patterns)for(const vm of [25,35,45])for(const um of [18,28,38]){
      const rows=pattern.length,slots=[]; let ok=true;
      for(let r=0;r<rows;r++){ const y=minV+vm+(maxV-minV-2*vm)*(rows===1?.5:r/(rows-1)); const ints=horizontalIntervals(polyUV,y); if(!ints.length){ok=false;break;} const [lo0,hi0]=ints[0],lo=lo0+um,hi=hi0-um,n=pattern[r]; if(hi<=lo){ok=false;break;} for(let k=0;k<n;k++){const x=n===1?(lo+hi)/2:lo+(hi-lo)*k/(n-1);slots.push(unproject({u:x,v:y},ax));} }
      if(!ok||slots.length!==zone2Groups.length)continue;
      const slotClear=slots.map(s=>polyBoundaryDistance(s,boundary)); const curUV=zone2Groups.map(g=>project(g.center,ax)),slotUV=slots.map(s=>project(s,ax)); const scaleU=Math.max(...polyUV.map(p=>p.u))-Math.min(...polyUV.map(p=>p.u)),scaleV=maxV-minV;
      const cost=zone2Groups.map((g,i)=>slots.map((s,j)=>{const du=(curUV[i].u-slotUV[j].u)/scaleU,dv=(curUV[i].v-slotUV[j].v)/scaleV,def=Math.max(0,g.radius+5-slotClear[j]);return du*du+dv*dv+def*def*500;}));
      const assign=hungarian(cost),moved=zone2Groups.map((g,i)=>({...g,center:slots[assign[i]],hull:g.hull.map(p=>add(p,sub(slots[assign[i]],g.center)))}));
      let outside=0,overlaps=0,clearDef=0; for(const g of moved)for(const p of g.hull)if(!pointInPoly(p,boundary))outside++;
      for(let i=0;i<moved.length;i++)for(let j=i+1;j<moved.length;j++){const d=minPolyDistance(moved[i].hull,moved[j].hull);if(d===0)overlaps++;clearDef+=Math.max(0,10-d);}
      const ls=layoutStats(moved),moveCost=zone2Groups.reduce((s,g,i)=>s+dist(g.center,moved[i].center),0); const score=outside*1e9+overlaps*1e8+clearDef*1e5+ls.cv*1e4+moveCost;
      const candidate={score,off,pattern,vm,um,assign,slots,moved,outside,overlaps,clearDef,layoutStats:ls}; if(!best||score<best.score)best=candidate;
    }
  }
  if(!best)throw new Error('균등배치 후보를 만들지 못했습니다.');
  const trans=new Map(),mapping=[]; zone2Groups.forEach((g,i)=>{const t=sub(best.moved[i].center,g.center);trans.set(g.key,t);mapping.push({dong:g.dong,from:ll(g.center),to:ll(best.moved[i].center),moveM:+dist(g.center,best.moved[i].center).toFixed(1)});});
  return {translations:trans,mapping,diagnostics:{pattern:best.pattern,axisOffsetDeg:best.off,rowMarginM:best.vm,sideMarginM:best.um,outsideVertices:best.outside,overlapPairs:best.overlaps,clearanceDeficitM:+best.clearDef.toFixed(1),...best.layoutStats}};
}
function analyzeScenario(footprints,river){
  const groups=buildGroups(footprints),gmap=new Map(groups.map(g=>[g.key,g])),records=[];
  const zone2=footprints.filter(f=>f.zoneId==='2'); let idx=0;
  for(const fp of zone2){ idx++; const g=gmap.get(`2:${fp.dong}`),profiles=candidateProfiles(fp,g,groups,river); for(let floor=1;floor<=fp.floors;floor++){records.push({id:fp.id,dong:fp.dong,unitType:fp.unitType,floor,weight:fp.weight,angle:openAngle(profiles,eyeHeight(fp,floor))});} if(idx%10===0)console.error(`analyzed ${idx}/${zone2.length}`); }
  return {groups,records};
}
function weightedValues(records,key='angle'){ const out=[]; for(const r of records)for(let i=0;i<r.weight;i++)out.push(r[key]); return out.sort((a,b)=>a-b); }
function percentile(a,p){ if(!a.length)return 0; const x=(a.length-1)*p,i=Math.floor(x),f=x-i; return a[i]+(a[Math.min(i+1,a.length-1)]-a[i])*f; }
function summary(records){
  const vals=weightedValues(records),n=vals.length,avg=vals.reduce((a,b)=>a+b,0)/n,sd=Math.sqrt(vals.reduce((s,x)=>s+(x-avg)**2,0)/n); const pct=x=>100*vals.filter(v=>v<=x).length/n;
  const bins={}; for(const v of vals){let k=v===0?'0':v<=10?'1-10':v<=20?'11-20':v<=30?'21-30':v<=40?'31-40':v<=50?'41-50':v<=60?'51-60':v<=90?'61-90':'91+';bins[k]=(bins[k]||0)+1;}
  return {floorHouseholdUnits:n,avg:+avg.toFixed(2),median:+percentile(vals,.5).toFixed(2),p10:+percentile(vals,.1).toFixed(2),p25:+percentile(vals,.25).toFixed(2),std:+sd.toFixed(2),min:vals[0],max:vals[n-1],zeroPct:+pct(0).toFixed(2),le10Pct:+pct(10).toFixed(2),le20Pct:+pct(20).toFixed(2),le30Pct:+pct(30).toFixed(2),ge60Pct:+(100*vals.filter(v=>v>=60).length/n).toFixed(2),bins:Object.fromEntries(Object.entries(bins).map(([k,c])=>[k,{count:c,pct:+(100*c/n).toFixed(2)}]))};
}
function groupSummary(records,groupFn){ const m=new Map();for(const r of records){const k=groupFn(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return Object.fromEntries([...m].sort((a,b)=>String(a[0]).localeCompare(String(b[0]),'ko',{numeric:true})).map(([k,v])=>[k,summary(v)])); }
function pairResults(cur,uni){
  const map=new Map(uni.map(r=>[`${r.id}|${r.floor}`,r])); const diffs=[]; for(const r of cur){const u=map.get(`${r.id}|${r.floor}`);if(!u)continue;diffs.push({...r,delta:u.angle-r.angle,uniform:u.angle});}
  const vals=weightedValues(diffs,'delta'),n=vals.length,avg=vals.reduce((a,b)=>a+b,0)/n; const count=pred=>diffs.reduce((s,r)=>s+(pred(r.delta)?r.weight:0),0);
  return {avgDelta:+avg.toFixed(2),medianDelta:+percentile(vals,.5).toFixed(2),improvedPct:+(100*count(x=>x>1)/n).toFixed(2),worsenedPct:+(100*count(x=>x<-1)/n).toFixed(2),unchangedPct:+(100*count(x=>Math.abs(x)<=1)/n).toFixed(2),records:diffs};
}
function enrichComparison(cur,uni){
  const keys=new Set([...Object.keys(cur),...Object.keys(uni)]),out={}; for(const k of [...keys].sort((a,b)=>String(a).localeCompare(String(b),'ko',{numeric:true}))){const c=cur[k],u=uni[k];out[k]={current:c,uniform:u,deltaAvg:+((u?.avg||0)-(c?.avg||0)).toFixed(2),deltaLe10Pct:+((u?.le10Pct||0)-(c?.le10Pct||0)).toFixed(2)};}return out;
}

function main(){
  const files={2:'apgujeong_2_units.geojson',3:'apg3_unit_polygon.geojson',4:'apgujeong_4_units.geojson',5:'apgujeong_5_units.geojson'};
  const base=Object.entries(files).flatMap(([z,f])=>prepareFeatures(z,f)); const river=buildRiver(loadJson('hangang_line_all.geojson')); const boundary=selectBoundary(); const currentGroups=buildGroups(base).filter(g=>g.zoneId==='2').sort((a,b)=>a.dong.localeCompare(b.dong,'ko',{numeric:true}));
  const layout=createUniformLayout(currentGroups,boundary.ring),uniformFootprints=translateScenario(base,layout.translations);
  console.error('Calculating current layout...'); const current=analyzeScenario(base,river); console.error('Calculating uniform layout...'); const uniform=analyzeScenario(uniformFootprints,river);
  const pair=pairResults(current.records,uniform.records),curSum=summary(current.records),uniSum=summary(uniform.records);
  const currentDong=groupSummary(current.records,r=>r.dong),uniformDong=groupSummary(uniform.records,r=>r.dong); const band=r=>r.floor<=10?'01-10':r.floor<=20?'11-20':r.floor<=30?'21-30':r.floor<=40?'31-40':r.floor<=50?'41-50':r.floor<=60?'51-60':'61+';
  const result={generatedAt:new Date().toISOString(),method:{riverLine:'hangang_line_all.geojson (보수적)',sampleStepM:SAMPLE_STEP_M,angleStepDeg:ANGLE_STEP_DEG,weight:'unit_type 쉼표 분리 개수 × 층수',uniformLayout:'2구역 동 형상·방향·층수 유지, 동 전체를 4/3 엇갈림 계열 격자 목표점으로 평행이동, 기존 위치와의 이동비용 최소화',boundary:boundary.file,otherZones:'3·4·5구역 현 위치를 차폐물로 유지'},layout:{dongCount:currentGroups.length,current:layoutStats(currentGroups),uniform:layout.diagnostics,mapping:layout.mapping},overall:{current:curSum,uniform:uniSum,delta:{avg:+(uniSum.avg-curSum.avg).toFixed(2),median:+(uniSum.median-curSum.median).toFixed(2),p10:+(uniSum.p10-curSum.p10).toFixed(2),zeroPct:+(uniSum.zeroPct-curSum.zeroPct).toFixed(2),le10Pct:+(uniSum.le10Pct-curSum.le10Pct).toFixed(2),le20Pct:+(uniSum.le20Pct-curSum.le20Pct).toFixed(2),le30Pct:+(uniSum.le30Pct-curSum.le30Pct).toFixed(2),ge60Pct:+(uniSum.ge60Pct-curSum.ge60Pct).toFixed(2)},paired:{avgDelta:pair.avgDelta,medianDelta:pair.medianDelta,improvedPct:pair.improvedPct,worsenedPct:pair.worsenedPct,unchangedPct:pair.unchangedPct}},byDong:enrichComparison(currentDong,uniformDong),byFloorBand:enrichComparison(groupSummary(current.records,band),groupSummary(uniform.records,band))};
  fs.mkdirSync(OUT_DIR,{recursive:true}); fs.writeFileSync(path.join(OUT_DIR,'zone2_uniform_view_compare.json'),JSON.stringify(result,null,2));
  const movedGeo={type:'FeatureCollection',name:'apgujeong_2_units_uniform',features:uniformFootprints.filter(f=>f.zoneId==='2').map(fp=>({type:'Feature',properties:{...fp.props,layout_test:'uniform_staggered'},geometry:{type:'Polygon',coordinates:[[...fp.ring.map(ll),ll(fp.ring[0])]]}}))}; fs.writeFileSync(path.join(OUT_DIR,'apgujeong_2_units_uniform.geojson'),JSON.stringify(movedGeo));
  console.log(JSON.stringify(result.overall,null,2));
}
main();
