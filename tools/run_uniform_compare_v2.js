const fs = require('fs');
let source = fs.readFileSync('tools/calc_uniform_compare.js', 'utf8');
const replacement = String.raw`
function createUniformLayout(zone2Groups,boundary){
  const moved=zone2Groups.map(g=>({...g,center:{...g.center},hull:g.hull.map(p=>({...p}))}));
  const xs=boundary.map(p=>p.x),ys=boundary.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const samples=[];
  for(let x=minX;x<=maxX;x+=18)for(let y=minY;y<=maxY;y+=18){const p={x,y};if(pointInPoly(p,boundary))samples.push(p);}
  const movedHull=(g,d)=>g.hull.map(p=>add(p,d));
  const valid=(index,d)=>{
    const nh=movedHull(moved[index],d);
    if(nh.some(p=>!pointInPoly(p,boundary)))return false;
    for(let j=0;j<moved.length;j++)if(j!==index){if(polygonsIntersect(nh,moved[j].hull)||minPolyDistance(nh,moved[j].hull)<2)return false;}
    return true;
  };
  const coverage=()=>{
    let sum=0,max=0;
    for(const p of samples){let md=Infinity;for(const g of moved)md=Math.min(md,dist(p,g.center));sum+=md;max=Math.max(max,md);}
    return {mean:sum/samples.length,max};
  };
  const score=()=>{const s=layoutStats(moved),c=coverage();return s.cv*260+c.mean*.65+c.max*1.15-s.min*1.8-s.avg*.25;};
  let currentScore=score();
  for(let iter=0;iter<260;iter++){
    const cells=Array.from({length:moved.length},()=>({x:0,y:0,n:0}));
    for(const p of samples){let bi=0,bd=Infinity;for(let i=0;i<moved.length;i++){const d=dist(p,moved[i].center);if(d<bd){bd=d;bi=i;}}cells[bi].x+=p.x;cells[bi].y+=p.y;cells[bi].n++;}
    const order=[...moved.keys()].sort((a,b)=>((iter+a)%moved.length)-((iter+b)%moved.length));
    for(const i of order){
      const g=moved[i],cell=cells[i];if(!cell.n)continue;
      const target={x:cell.x/cell.n,y:cell.y/cell.n};let force=mul(sub(target,g.center),.22);
      for(let j=0;j<moved.length;j++)if(i!==j){const q=sub(g.center,moved[j].center),d=Math.hypot(q.x,q.y);if(d>0&&d<95){const strength=(95-d)/95*4.5;force=add(force,mul(q,strength/d));}}
      const mag=Math.hypot(force.x,force.y);if(mag>7)force=mul(force,7/mag);
      let accepted=false;
      for(const scale of [1,.65,.4,.22]){const d=mul(force,scale);if(!valid(i,d))continue;const oldC=g.center,oldH=g.hull;g.center=add(g.center,d);g.hull=oldH.map(p=>add(p,d));const ns=score();if(ns<currentScore-.0001){currentScore=ns;accepted=true;break;}g.center=oldC;g.hull=oldH;}
      if(!accepted)continue;
    }
  }
  let seed=246813579;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  for(let iter=0;iter<5000;iter++){
    const i=Math.floor(rnd()*moved.length),step=10*(1-iter/5000)+.8,a=rnd()*Math.PI*2,d={x:Math.cos(a)*step,y:Math.sin(a)*step};if(!valid(i,d))continue;
    const g=moved[i],oldC=g.center,oldH=g.hull;g.center=add(g.center,d);g.hull=oldH.map(p=>add(p,d));const ns=score();if(ns<currentScore){currentScore=ns;}else{g.center=oldC;g.hull=oldH;}
  }
  let outside=0,overlaps=0,clearDef=0;for(const g of moved)for(const p of g.hull)if(!pointInPoly(p,boundary))outside++;
  for(let i=0;i<moved.length;i++)for(let j=i+1;j<moved.length;j++){const d=minPolyDistance(moved[i].hull,moved[j].hull);if(d===0)overlaps++;clearDef+=Math.max(0,2-d);}
  const trans=new Map(),mapping=[];zone2Groups.forEach((g,i)=>{const d=sub(moved[i].center,g.center);trans.set(g.key,d);mapping.push({dong:g.dong,from:ll(g.center),to:ll(moved[i].center),moveM:+dist(g.center,moved[i].center).toFixed(1)});});
  const c=coverage();return {translations:trans,mapping,diagnostics:{algorithm:'centroidal-voronoi + collision-safe local search',outsideVertices:outside,overlapPairs:overlaps,clearanceDeficitM:+clearDef.toFixed(1),coverageMeanM:+c.mean.toFixed(1),coverageMaxM:+c.max.toFixed(1),...layoutStats(moved)}};
}
`;
source = source.replace(/function createUniformLayout\([\s\S]*?\n}\nfunction analyzeScenario/, replacement + '\nfunction analyzeScenario');
source = source.replace("2구역 동 형상·방향·층수 유지, 동 전체를 4/3 엇갈림 계열 격자 목표점으로 평행이동, 기존 위치와의 이동비용 최소화", "2구역 동 형상·방향·층수 유지, 현재 위치에서 시작해 경계와 동간 비겹침을 준수하며 centroidal-Voronoi와 충돌회피 국소탐색으로 균등 분산");
new Function('require','process','console',source)(require,process,console);
