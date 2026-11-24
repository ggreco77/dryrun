/* GRAWITA Dryrun · Cover BAYESTAR credible region: greedy selection of NEW FoVs.
 * It orchestrates existing CoverageMath functions only. No probability formula, FoV geometry or HEALPix routine
 * is redefined here; the official P(FoV), P(new), P(cum) of the plan are computed afterwards by the usual engine.
 *  - Credible region: native BAYESTAR cells ranked by probability density (p / cell area), accumulated until the
 *    requested level is reached (the cell that reaches it is included).
 *  - Geometric coverage: HEALPix order-9 sample points of the region (native cells finer than order 9 are kept
 *    whole). A point is covered when CoverageMath.inside() accepts it for an accepted or a new FoV.
 *  - Candidates: centres of the HEALPix cells, at an order chosen from the FoV size, that contain region sample
 *    points. Every sample point lies inside the FoV centred on its own candidate cell, so full coverage is reachable.
 *  - Priority: lazy greedy on the region probability not yet covered, estimated on the order-9 points. The best
 *    `shortlist` estimates of each step are re-scored with the unchanged CoverageMath.integratePosteriorFoV on the
 *    region cells (region P(new), previous = accepted FoVs + FoVs already chosen) and the highest is chosen.
 *    When even the best estimate is negligible, the uncovered region area decides (completion phase).
 * A greedy heuristic: neither a globally optimal plan nor a strictly decreasing sequence is claimed.
 */
(function(global){
'use strict';
const M=global.CoverageMath;
const SAMPLE_ORDER=9;               // geometric coverage resolution (sample cell 0.0131 deg²)
const MAX_SAMPLE_POINTS=1500000;    // memory guard for very extended regions
const NEGLIGIBLE_FRACTION=0.01;     // see negligibleGain()
const PREVIOUS_MARGIN_DEG=15;       // generous margin of the exact re-scoring neighbourhood filter
const SLICE_MS=20;
// Estimates re-scored with the engine at each step. Benchmark (stage SCI-TILING-IMPLEMENTATION-01, FoV 2 x 1.5 deg,
// 10/50/90 %, 18 controlled steps against the exact best of 300-772 candidates): 8 finds it in 12 of 18 steps
// (3 in 6), largest loss 0.57 % of the best FoV (3: 1.14 %), selection of 20 FoVs 12-15 s.
const DEFAULT_SHORTLIST=8;
const RAD=Math.PI/180,DEG=180/Math.PI;
const cellArea=order=>M.SKY/(12*Math.pow(4,order));
const cellRadius=order=>90/Math.pow(2,order);   // the bound CoverageMath uses for the angular radius of a cell
const yieldTurn=()=>new Promise(resolve=>setTimeout(resolve,0));
const now=()=>(typeof performance!=='undefined'?performance.now():Date.now());

function credibleRegion(posterior,level){
  if(!posterior||!Array.isArray(posterior.cells)||!posterior.cells.length)throw Error('A BAYESTAR probability map is required');
  if(!(level>0&&level<1))throw Error('Credible level must be between 0 and 1');
  const all=posterior.cells,density=new Float64Array(all.length),ranked=[];
  for(let i=0;i<all.length;i++)if(all[i].p>0){density[i]=all[i].p/cellArea(all[i].order);ranked.push(i);}
  ranked.sort((i,j)=>density[j]-density[i]||i-j);
  const member=new Uint8Array(all.length);
  let probability=0,area=0,count=0,thresholdDensity=null;
  for(const i of ranked){
    if(probability>=level)break;
    member[i]=1;probability+=all[i].p;area+=cellArea(all[i].order);count++;thresholdDensity=density[i];
  }
  // Cells keep the order of the loaded map, as in every other use of the engine.
  const cells=all.filter((c,i)=>member[i]===1);
  return {level,cells,count,probability,area,thresholdDensity};
}
// Angular radius (deg) beyond which CoverageMath.inside() accepts no point, with a margin.
function outerRadius(c){
  if(c.shape==='circle')return Math.tan(c.radius*RAD)*DEG*1.01+0.01;
  return Math.atan(Math.hypot(Math.tan(c.width/2*RAD),Math.tan(c.height/2*RAD)))*DEG*1.01+0.01;
}
// Angular radius (deg) within which CoverageMath.inside() accepts every point.
function innerRadius(c){
  if(c.shape==='circle')return c.radius;
  return Math.atan(Math.min(c.width,c.height)/2*RAD)*DEG;
}
// Candidate cell order: the cell must fit well inside the FoV (coverage guarantee) and be small enough to place it
// finely (side at most one third of the inner radius). If no order below 9 qualifies, the sample points themselves
// are the candidates.
function candidateOrder(fov){
  const inner=innerRadius(fov);
  for(let order=1;order<SAMPLE_ORDER;order++)
    if(cellRadius(order)<=0.9*inner&&Math.sqrt(cellArea(order))<=inner/3)return order;
  return SAMPLE_ORDER;
}
// The engine's own prefilter radius (coverage-math.js, integratePosteriorFoV): no part of the FoV lies beyond it.
function engineCap(c){return c.shape==='circle'?Math.tan(c.radius*RAD)*DEG*1.5+1:Math.hypot(c.width/2,c.height/2)*1.5+1;}
function separation(a,b){
  const u=M.vec(a.ra,a.dec),v=M.vec(b.ra,b.dec);
  return Math.acos(Math.max(-1,Math.min(1,u[0]*v[0]+u[1]*v[1]+u[2]*v[2])))*DEG;
}
function fovArea(c){return c.shape==='circle'?Math.PI*c.radius*c.radius:c.shape==='ellipse'?Math.PI*c.width*c.height/4:c.width*c.height;}

// Region P(new) of `fov` with the unchanged engine, restricted to the region cells: integratePosteriorFoV on the
// region cells that can reach the FoV, with the previous FoVs that can reach them. The engine adds probability to
// pFoV/pNew only for nodes whose centre is inside the FoV, so a cell farther than the FoV outer radius plus the cell
// radius adds nothing; a previous FoV farther than the engine's own prefilter radii plus a margin is classified
// outside every node near this FoV. pFoV and pNew are therefore those of the call on all region cells and all
// previous FoVs (pCum is not: it is not used here); the tests check that the values are identical.
function exactScorer(region,order){
  const cells=region.cells,n=cells.length,cx=new Float64Array(n),cy=new Float64Array(n),cz=new Float64Array(n),reach=new Float64Array(n);
  cells.forEach((c,i)=>{const v=M.vec(c.ra,c.dec);cx[i]=v[0];cy[i]=v[1];cz[i]=v[2];reach[i]=cellRadius(c.order)+0.01;});
  return (fov,previous)=>{
    const outer=outerRadius(fov),cap=engineCap(fov),v=M.vec(fov.ra,fov.dec),sub=[];
    for(let i=0;i<n;i++){
      const limit=outer+reach[i];
      if(limit>=180||cx[i]*v[0]+cy[i]*v[1]+cz[i]*v[2]>=Math.cos(limit*RAD))sub.push(cells[i]);
    }
    if(!sub.length)return 0;
    const near=previous.filter(p=>separation(p,fov)<=cap+engineCap(p)+PREVIOUS_MARGIN_DEG);
    return M.integratePosteriorFoV({cells:sub},fov,near,order).pNew;
  };
}
// Probability of the region covered by a whole plan: pCum of its last FoV, unchanged engine, region cells only.
// Fixed subsets of cells are integrated in separate turns (as in the Worker), so the sum does not depend on timing;
// null if stopped.
async function regionCoveredProbability(region,plan,order,shouldStop=()=>false){
  if(!plan.length)return 0;
  const last=plan[plan.length-1],previous=plan.slice(0,-1),cells=region.cells,BATCH=128;
  let sum=0;
  for(let i=0;i<cells.length;i+=BATCH){
    sum+=M.integratePosteriorFoV({cells:cells.slice(i,i+BATCH)},last,previous,order).pCum;
    await yieldTurn();if(shouldStop())return null;
  }
  return sum;
}

function regionSamples(cells){
  let n=0;for(const c of cells)n+=c.order>=SAMPLE_ORDER?1:Math.pow(4,SAMPLE_ORDER-c.order);
  if(n>MAX_SAMPLE_POINTS)throw Error('Credible region too extended for HEALPix order-9 sampling ('+n+' points)');
  const s={n,points:new Array(n),w:new Float64Array(n),a:new Float64Array(n),x:new Float64Array(n),y:new Float64Array(n),z:new Float64Array(n)};
  let k=0;
  const add=(pt,w,a)=>{const v=M.vec(pt.ra,pt.dec);s.points[k]=pt;s.w[k]=w;s.a[k]=a;s.x[k]=v[0];s.y[k]=v[1];s.z[k]=v[2];k++;};
  for(const c of cells){
    if(c.order>=SAMPLE_ORDER){add(M.pixelCenter(c.order,c.pixel),c.p,cellArea(c.order));continue;}
    const m=Math.pow(4,SAMPLE_ORDER-c.order),w=c.p/m,a=cellArea(SAMPLE_ORDER);
    for(let j=0;j<m;j++)add(M.pixelCenter(SAMPLE_ORDER,c.pixel*m+j),w,a);
  }
  return s;
}
// 1° x 1° RA/Dec buckets (compressed rows) for neighbourhood queries on the sample points.
function pointIndex(s){
  const BINS=360,key=new Int32Array(s.n),start=new Int32Array(181*BINS+1);
  for(let i=0;i<s.n;i++){
    const p=s.points[i],band=Math.min(180,Math.max(0,Math.floor(p.dec+90))),bin=((Math.floor(p.ra)%BINS)+BINS)%BINS;
    key[i]=band*BINS+bin;start[key[i]+1]++;
  }
  for(let k=1;k<start.length;k++)start[k]+=start[k-1];
  const fill=start.slice(0,-1),members=new Int32Array(s.n);
  for(let i=0;i<s.n;i++)members[fill[key[i]]++]=i;
  // Calls fn(i) for every sample point within R degrees of (ra, dec).
  return function forNear(ra,dec,R,fn){
    const v=M.vec(ra,dec),cosR=Math.cos(Math.min(180,R)*RAD);
    const b0=Math.max(0,Math.floor(dec-R+90)),b1=Math.min(180,Math.floor(dec+R+90)),top=Math.abs(dec)+R;
    let span=180;
    if(top<89)span=Math.asin(Math.min(1,Math.sin(Math.min(90,R)*RAD)/Math.cos(top*RAD)))*DEG+1;
    const full=span>=179;
    const scan=k=>{for(let m=start[k],e=start[k+1];m<e;m++){const i=members[m];if(s.x[i]*v[0]+s.y[i]*v[1]+s.z[i]*v[2]>=cosR)fn(i);}};
    for(let b=b0;b<=b1;b++){
      if(full){for(let bin=0;bin<BINS;bin++)scan(b*BINS+bin);continue;}
      for(let r=Math.floor(ra-span),e=Math.floor(ra+span);r<=e;r++)scan(b*BINS+((r%BINS)+BINS)%BINS);
    }
  };
}
function maxHeap(before){
  const h=[];
  return {get size(){return h.length;},
    push(i){h.push(i);let k=h.length-1;while(k>0){const p=(k-1)>>1;if(!before(h[k],h[p]))break;[h[k],h[p]]=[h[p],h[k]];k=p;}},
    pop(){const top=h[0],last=h.pop();if(h.length){h[0]=last;let k=0;for(;;){const l=2*k+1,r=l+1;let m=k;
      if(l<h.length&&before(h[l],h[m]))m=l;if(r<h.length&&before(h[r],h[m]))m=r;if(m===k)break;[h[k],h[m]]=[h[m],h[k]];k=m;}}return top;},
    drain(){return h.splice(0);}};
}

/* Plans up to maxNew NEW FoVs (same shape, size and PA as `fov`) for the credible region at `level`.
 * accepted: FoVs already in the plan, treated as covered and never changed. Returns null if shouldStop() turns true. */
async function plan({posterior,level,fov,accepted=[],maxNew,shortlist=DEFAULT_SHORTLIST,probOrder,rescore=true,shouldStop=()=>false,progress=()=>{}}){
  M.configValid({...fov,ra:0,dec:0});
  if(!Number.isInteger(maxNew)||maxNew<1)throw Error('The maximum number of new FoVs must be a positive integer');
  if(!Number.isInteger(shortlist)||shortlist<1)throw Error('Shortlist size must be a positive integer');
  accepted.forEach(M.configValid);
  const ms={},t0=now();let sliceStart=now();
  const pause=async()=>{if(now()-sliceStart<SLICE_MS)return !shouldStop();await yieldTurn();sliceStart=now();return !shouldStop();};
  progress(0,'Credible region from the BAYESTAR cells');await yieldTurn();if(shouldStop())return null;
  const region=credibleRegion(posterior,level);ms.region=now()-t0;
  progress(0.02,'Region sample points (HEALPix order 9)');if(!(await pause()))return null;
  const s=regionSamples(region.cells),forNear=pointIndex(s),N=s.n;ms.samples=now()-t0-ms.region;
  const regionArea=s.a.reduce((x,v)=>x+v,0),regionProb=s.w.reduce((x,v)=>x+v,0);
  // Accepted FoVs: their sample points are already covered.
  const covered=new Uint8Array(N);let uncovered=N,coveredArea=0,coveredProb=0;
  const mark=i=>{covered[i]=1;uncovered--;coveredArea+=s.a[i];coveredProb+=s.w[i];};
  for(const c of accepted)forNear(c.ra,c.dec,outerRadius(c),i=>{if(!covered[i]&&M.inside(s.points[i],c))mark(i);});
  const coveredByAccepted=coveredArea,coveredProbByAccepted=coveredProb;
  // Candidates and their upper bounds (all points within the outer radius).
  const C=candidateOrder(fov),R=outerRadius(fov),cand=[];
  if(C===SAMPLE_ORDER)for(let i=0;i<N;i++)cand.push(s.points[i]);
  else{const seen=new Map();for(let i=0;i<N;i++){const pix=M.ang2pixNest(C,s.points[i].ra,s.points[i].dec);if(!seen.has(pix)){seen.set(pix,cand.length);cand.push(M.pixelCenter(C,pix));}}}
  const nc=cand.length,kP=new Float64Array(nc),kA=new Float64Array(nc),stamp=new Int32Array(nc).fill(-1),covers=new Array(nc);
  progress(0.05,'Candidate positions ('+nc.toLocaleString('en-US')+')');
  for(let i=0;i<nc;i++){
    let p=0,a=0;forNear(cand[i].ra,cand[i].dec,R,j=>{if(!covered[j]){p+=s.w[j];a+=s.a[j];}});kP[i]=p;kA[i]=a;
    if((i&255)===0&&!(await pause()))return null;
  }
  ms.candidates=now()-t0-ms.region-ms.samples;
  const config=i=>({...fov,ra:cand[i].ra,dec:cand[i].dec});
  let version=0,evaluations=0;
  const evaluate=i=>{
    if(!covers[i]){const c=config(i),list=[];forNear(c.ra,c.dec,R,j=>{if(M.inside(s.points[j],c))list.push(j);});covers[i]=Int32Array.from(list);evaluations++;}
    let p=0,a=0;for(const j of covers[i])if(!covered[j]){p+=s.w[j];a+=s.a[j];}
    kP[i]=p;kA[i]=a;stamp[i]=version;
  };
  const byProbability=(i,j)=>kP[i]>kP[j]||(kP[i]===kP[j]&&i<j);
  const byArea=(i,j)=>kA[i]>kA[j]||(kA[i]===kA[j]&&(kP[i]>kP[j]||(kP[i]===kP[j]&&i<j)));
  let heap=maxHeap(byProbability);for(let i=0;i<nc;i++)heap.push(i);
  const negligible=NEGLIGIBLE_FRACTION*regionProb/regionArea*fovArea(fov);
  const score=exactScorer(region,probOrder),previous=accepted.slice(),chosen=[];
  let phase='probability',exactMs=0,exactCalls=0;
  const exact=c=>{if(!rescore)return null;const t=now(),v=score(c,previous);exactMs+=now()-t;exactCalls++;return v;};
  const tSelect=now();
  while(chosen.length<maxNew&&uncovered>0){
    progress(0.1+0.9*chosen.length/maxNew,'Selecting FoV '+(chosen.length+1)+' of at most '+maxNew+(phase==='area'?' (residual area)':''));
    let pick=null;
    if(phase==='probability'){
      const fresh=[];
      while(heap.size&&fresh.length<shortlist){
        const i=heap.pop();
        if(stamp[i]!==version){evaluate(i);heap.push(i);}else fresh.push(i);
        if(!(await pause()))return null;
      }
      if(!fresh.length||kP[fresh[0]]<negligible){
        for(const i of fresh)heap.push(i);
        const rest=heap.drain();heap=maxHeap(byArea);for(const i of rest)heap.push(i);phase='area';continue;
      }
      const scored=[];
      for(const i of fresh){scored.push({i,proxy:kP[i],exact:exact(config(i))});if(!(await pause()))return null;}
      let best=scored[0];if(rescore)for(const x of scored)if(x.exact>best.exact)best=x;
      for(const x of scored)if(x!==best)heap.push(x.i);
      pick={i:best.i,exact:best.exact,shortlist:scored.map(x=>({ra:cand[x.i].ra,dec:cand[x.i].dec,proxy:x.proxy,exact:x.exact})),proxyRank:scored.indexOf(best)+1};
    }else{
      while(heap.size){
        const i=heap.pop();
        if(stamp[i]!==version){evaluate(i);heap.push(i);if(!(await pause()))return null;continue;}
        if(kA[i]>0)pick={i,exact:null,shortlist:null,proxyRank:null};
        break;
      }
      if(!pick)break;   // no candidate covers any uncovered point
    }
    const i=pick.i,c=config(i),proxyGain=kP[i],newArea=kA[i];
    if(pick.exact==null)pick.exact=exact(c);
    let overlapPoints=0;for(const j of covers[i]){if(covered[j])overlapPoints++;else mark(j);}
    previous.push(c);version++;
    chosen.push({ra:c.ra,dec:c.dec,phase,proxyRegionNew:proxyGain,exactRegionNew:pick.exact,newArea,
      overlapArea:overlapPoints*cellArea(SAMPLE_ORDER),pointsInFoV:covers[i].length,
      coveredArea,coveredFraction:coveredArea/regionArea,proxyRank:pick.proxyRank,shortlist:pick.shortlist});
    if(!(await pause()))return null;
  }
  ms.select=now()-tSelect;ms.exact=exactMs;ms.total=now()-t0;
  const complete=uncovered===0;
  return {
    region:{level,cells:region.cells,count:region.count,probability:region.probability,area:region.area,thresholdDensity:region.thresholdDensity},
    sampleOrder:SAMPLE_ORDER,sampleCellArea:cellArea(SAMPLE_ORDER),points:N,candidateOrder:C,candidates:nc,evaluations,
    shortlist,negligibleGain:negligible,exactCalls,fovs:chosen,
    stop:complete?'complete':chosen.length>=maxNew?'limit':'no-candidates',
    coverage:{regionArea,coveredByAccepted,covered:coveredArea,residual:complete?0:regionArea-coveredArea,
      fraction:complete?1:coveredArea/regionArea,complete,uncoveredPoints:uncovered,
      sampledProbability:regionProb,sampledCoveredProbability:coveredProb,sampledCoveredProbabilityByAccepted:coveredProbByAccepted},
    ms};
}
// The pure helpers after plan() are exported unchanged for scripts/observational-contiguous-tiling.js; plan() itself
// does not use the exported object.
global.CredibleRegionTiling={plan,credibleRegion,regionCoveredProbability,exactScorer,candidateOrder,innerRadius,outerRadius,
  SAMPLE_ORDER,NEGLIGIBLE_FRACTION,DEFAULT_SHORTLIST,regionSamples,pointIndex,maxHeap,fovArea,cellArea};
})(window);
