/* GRAWITA Dryrun · Cover BAYESTAR credible region — "Observational — contiguous FoVs".
 * Plans NEW FoVs as an observing sequence: each FoV is, whenever useful, geometrically contiguous to the FoV observed
 * immediately before it, with the area overlap requested by the astronomer. Contiguity is imposed while the FoVs are
 * generated; the plan is never a reordering of another plan. The module orchestrates CoverageMath and the pure helpers
 * exported by credible-region-tiling.js. It redefines no probability formula and no HEALPix routine of CoverageMath and
 * changes neither; the official P(FoV), P(new), P(cum) of the plan are computed afterwards by the usual engine.
 *
 * Footprints. A FoV is the set of points accepted by CoverageMath.inside(). insideVec() below repeats the same test on
 * unit vectors (same formulas, for speed); the tests compare it with CoverageMath.inside().
 *
 * Geometry (all on the sphere)
 *  - Directions N, NE, E, SE, S, SW, W, NW in the instrument frame of the reference FoV A, i.e. its axes rotated by its
 *    PA (E = +x axis, N = +y axis, as CoverageMath.nextCenter). Cardinal directions follow the axes. Diagonal directions
 *    pass through the corner of A (rectangles) or through the corner of the rectangle circumscribing it (ellipses,
 *    circles: the affine image of the 45-degree directions of a circle). A candidate B is the FoV moved from the centre
 *    of A along the great circle that starts in that direction (CoverageMath.offset).
 *  - Area overlap phi = Omega(A ∩ B) / Omega(A), solid angles of the true footprints, A being the reference FoV.
 *    Omega(A): Gauss-Legendre on A's own coordinates. Omega(A ∩ B): a grid on A's instrument coordinates with three
 *    levels; cells whose neighbourhood is crossed by the boundary of B (or of A) are bounded from both sides, so the
 *    result is an ENCLOSURE [lo, hi] of phi together with an estimate.
 *  - Requested overlap phi_req > 0: accepted only if phi_req <= lo and hi <= phi_req + 1 percentage point.
 *    phi_req = 0: B is moved to the distance at which the two footprints touch (vertex, edge or tangent contact). The
 *    contact is proved by a pair of boundary points closer than CONTACT_TOLERANCE_DEG, and hi <= 1 percentage point
 *    bounds any overlap. Contact at a single point is contiguity, not gap-free coverage of a region.
 *  - Contiguity is never decided from centre distances or from HEALPix cells.
 * Plan
 *  - Credible region, order-9 sample points, candidate grid, lazy greedy estimates, exact re-scoring of the shortlist,
 *    1 % negligible threshold and area completion phase: the mechanisms of Probability first, reused unchanged.
 *  - First FoV: the Probability-first choice (or, as an option, a FoV contiguous to the last accepted FoV).
 *  - Next FoVs: the most useful of the 8 FoVs contiguous to the previous one. Strict (alpha = 0) continues while one of
 *    them is useful. Balanced (alpha > 0) continues only if its gain is at least alpha x the gain of the best position
 *    found by the Probability-first search; otherwise it repositions early.
 *  - When no contiguous continuation is chosen the move is a declared REPOSITION: to a FoV contiguous to an earlier FoV
 *    of the run (a branch), if its gain is at least alpha x the best gain, otherwise to the best position of the region.
 *    A reposition that ends in a region component not visited by the previous FoV is a JUMP. No FoV is ever added only
 *    to move the telescope: every new FoV adds probability (probability phase) or uncovered area (area phase).
 * A greedy heuristic: no globally optimal plan is claimed. Angular distance is not telescope slew time.
 */
(function(global){
'use strict';
const RAD=Math.PI/180,DEG=180/Math.PI;
const SAMPLE_ORDER=9;
const OVERLAP_CHOICES=[0,5,10,15,20,25,30,35,40,45,50];
const DEFAULT_OVERLAP=10;
const OVERLAP_TOLERANCE_PP=1;          // phi_req <= phi_eff <= phi_req + 1 percentage point
const CONTACT_TOLERANCE_DEG=1e-6;      // 0.0036 arcsec: proved distance below which two footprints touch
const DEFAULT_ALPHA=0.5;               // Balanced
const LONG_MOVE_DIAGONALS=3;           // display only: moves longer than 3 FoV diagonals are highlighted
const FINE_CELLS=2048;                 // overlap verification grid (fine cells along the longer side of A)
const FINER_CELLS=4096;                // used only when the bounds on FINE_CELLS are too wide for the window
const SEARCH_CELLS=256;                // overlap estimate while searching the distance
const SLICE_MS=20;
const DIRECTIONS=[['N',0,1],['NE',1,1],['E',1,0],['SE',1,-1],['S',0,-1],['SW',-1,-1],['W',-1,0],['NW',-1,1]];
const now=()=>(typeof performance!=='undefined'?performance.now():Date.now());
const yieldTurn=()=>new Promise(resolve=>setTimeout(resolve,0));
const lib=()=>{
  const M=global.CoverageMath,T=global.CredibleRegionTiling;
  if(!M||!T||!T.regionSamples)throw Error('CoverageMath and CredibleRegionTiling must be loaded first');
  return {M,T};
};

/* ---------------------------------------------------------------- footprints ---------------------------------- */
// Frame of a FoV as in CoverageMath.tangent()/inside(): centre u, east e, north n, PA rotation; half sizes a, b of
// the footprint in its instrument coordinates (deg); circles use tan(r)·DEG + 1e-10 exactly as CoverageMath.inside().
function footprint(c){
  const a=c.ra*RAD,d=c.dec*RAD,ca=Math.cos(a),sa=Math.sin(a),cd=Math.cos(d),sd=Math.sin(d),pa=c.pa*RAD;
  const F={c,kind:c.shape,ux:cd*ca,uy:cd*sa,uz:sd,ex:-sa,ey:ca,nx:-sd*ca,ny:-sd*sa,nz:cd,cp:Math.cos(pa),sp:Math.sin(pa)};
  if(c.shape==='circle'){F.a=F.b=Math.tan(c.radius*RAD)*DEG+1e-10;}
  else{F.a=c.width/2;F.b=c.height/2;}
  return F;
}
// CoverageMath.inside() on a unit vector.
function insideVec(F,px,py,pz){
  const forward=px*F.ux+py*F.uy+pz*F.uz;if(forward<=0)return false;
  const x=Math.atan2(F.ex*px+F.ey*py,forward)*DEG,y=Math.atan2(F.nx*px+F.ny*py+F.nz*pz,forward)*DEG;
  if(F.kind==='circle')return Math.hypot(x,y)<=F.a;
  const xx=x*F.cp+y*F.sp,yy=-x*F.sp+y*F.cp;
  if(F.kind==='ellipse')return (xx/F.a)**2+(yy/F.b)**2<=1;
  return Math.abs(xx)<=F.a&&Math.abs(yy)<=F.b;
}
// Continuous level of a point: <= 1 inside, > 1 outside, Infinity behind the tangent plane.
function levelVec(F,px,py,pz){
  const forward=px*F.ux+py*F.uy+pz*F.uz;if(forward<=0)return Infinity;
  const x=Math.atan2(F.ex*px+F.ey*py,forward)*DEG,y=Math.atan2(F.nx*px+F.ny*py+F.nz*pz,forward)*DEG;
  if(F.kind==='circle')return Math.hypot(x,y)/F.a;
  const xx=x*F.cp+y*F.sp,yy=-x*F.sp+y*F.cp;
  if(F.kind==='ellipse')return Math.hypot(xx/F.a,yy/F.b);
  return Math.max(Math.abs(xx)/F.a,Math.abs(yy)/F.b);
}
// Instrument coordinates (deg) of a unit vector in frame F, or null behind the tangent plane.
function instrumentOf(F,px,py,pz,out){
  const forward=px*F.ux+py*F.uy+pz*F.uz;if(forward<=0)return null;
  const x=Math.atan2(F.ex*px+F.ey*py,forward)*DEG,y=Math.atan2(F.nx*px+F.ny*py+F.nz*pz,forward)*DEG;
  out[0]=x*F.cp+y*F.sp;out[1]=-x*F.sp+y*F.cp;return out;
}
// Unit vector of the point with instrument coordinates (xx, yy) in frame F.
function pointAt(F,xx,yy,out){
  const x=(xx*F.cp-yy*F.sp)*RAD,y=(xx*F.sp+yy*F.cp)*RAD,X=Math.tan(x),Y=Math.tan(y);
  const px=F.ux+X*F.ex+Y*F.nx,py=F.uy+X*F.ey+Y*F.ny,pz=F.uz+Y*F.nz,r=Math.hypot(px,py,pz);
  out[0]=px/r;out[1]=py/r;out[2]=pz/r;return out;
}
const toRaDec=v=>({ra:((Math.atan2(v[1],v[0])*DEG)%360+360)%360,dec:Math.asin(Math.max(-1,Math.min(1,v[2])))*DEG});
const angle=(u,v)=>2*Math.asin(Math.min(1,Math.hypot(u[0]-v[0],u[1]-v[1],u[2]-v[2])/2))*DEG;
function centreDistance(a,b){
  const {M}=lib(),u=M.vec(a.ra,a.dec),v=M.vec(b.ra,b.dec);return angle(u,v);
}
// Boundary point of F at parameter t in [0, 1): rectangles run along the four edges with corners at t = 0, 1/4, 1/2,
// 3/4; ellipses and circles use the angle 2 pi t.
function boundaryXY(F,t,out){
  if(F.kind==='rectangle'){
    const s=((t%1)+1)%1*4,k=Math.min(3,Math.floor(s)),u=s-k,a=F.a,b=F.b;
    if(k===0){out[0]=a;out[1]=-b+2*b*u;}else if(k===1){out[0]=a-2*a*u;out[1]=b;}
    else if(k===2){out[0]=-a;out[1]=b-2*b*u;}else{out[0]=-a+2*a*u;out[1]=-b;}
    return out;
  }
  const th=2*Math.PI*t;out[0]=F.a*Math.cos(th);out[1]=F.b*Math.sin(th);return out;
}
const isCorner=(F,t)=>F.kind==='rectangle'&&Math.abs(t*4-Math.round(t*4))<1e-9;
// Diagonal of a FoV (deg): angular distance between opposite corners (rectangles) or the longer axis (others).
function diagonal(c){
  const F=footprint(c),p=[0,0,0],q=[0,0,0];
  if(F.kind==='rectangle'){pointAt(F,F.a,F.b,p);pointAt(F,-F.a,-F.b,q);}
  else if(F.a>=F.b){pointAt(F,F.a,0,p);pointAt(F,-F.a,0,q);}else{pointAt(F,0,F.b,p);pointAt(F,0,-F.b,q);}
  return angle(p,q);
}

/* --------------------------------------------------------------- solid angles --------------------------------- */
// Area element of the instrument coordinates: dOmega[deg²] = J dxx dyy (deg), the rotation having unit Jacobian.
function jacobian(F,xx,yy){
  const x=(xx*F.cp-yy*F.sp)*RAD,y=(xx*F.sp+yy*F.cp)*RAD,cx=Math.cos(x),cy=Math.cos(y),X=Math.tan(x),Y=Math.tan(y);
  return 1/(cx*cx*cy*cy*Math.pow(1+X*X+Y*Y,1.5));
}
const GL=(()=>{ // Gauss-Legendre nodes/weights on [-1, 1]
  const cache=new Map();
  return n=>{
    if(cache.has(n))return cache.get(n);
    const x=new Float64Array(n),w=new Float64Array(n);
    for(let i=0;i<Math.ceil(n/2);i++){
      let z=Math.cos(Math.PI*(i+0.75)/(n+0.5)),pp=0;
      for(let it=0;it<100;it++){
        let p1=1,p2=0;for(let j=1;j<=n;j++){const p3=p2;p2=p1;p1=((2*j-1)*z*p2-(j-1)*p3)/j;}
        pp=n*(z*p1-p2)/(z*z-1);const z1=z;z=z1-p1/pp;if(Math.abs(z-z1)<1e-15)break;
      }
      x[i]=-z;x[n-1-i]=z;w[i]=w[n-1-i]=2/((1-z*z)*pp*pp);
    }
    const r={x,w};cache.set(n,r);return r;
  };
})();
// Solid angle (deg²) of the footprint: Gauss-Legendre on its exact domain (rectangle, or polar coordinates).
function footprintArea(F,n=48){
  const g=GL(n);let sum=0;
  if(F.kind==='rectangle'){
    for(let i=0;i<n;i++)for(let j=0;j<n;j++)sum+=g.w[i]*g.w[j]*jacobian(F,F.a*g.x[i],F.b*g.x[j]);
    return sum*F.a*F.b;
  }
  const m=4*n;
  for(let i=0;i<n;i++){const rho=(g.x[i]+1)/2;
    for(let k=0;k<m;k++){const th=2*Math.PI*(k+0.5)/m;sum+=g.w[i]/2*rho*jacobian(F,F.a*rho*Math.cos(th),F.b*rho*Math.sin(th));}}
  return sum*F.a*F.b*2*Math.PI/m;
}

/* Overlap grid: fine cells (FINE x ...) grouped in mid cells (4 x 4 fine) and coarse cells (8 x 8 mid). Everything that
 * depends only on the shape of A (cell weights, gnomonic coordinates, cells crossed by A's own boundary) is cached. */
const MID=4,COARSE=8,BLOCK=MID*COARSE;
const gridCache=new Map();
function shapeKey(c,nf){return [c.shape,c.width,c.height,c.radius,c.pa,nf].join('|');}
function grid(F,nf){
  const key=shapeKey(F.c,nf);if(gridCache.has(key))return gridCache.get(key);
  const big=Math.max(F.a,F.b),nx=BLOCK*Math.max(1,Math.ceil(nf*F.a/big/BLOCK)),ny=BLOCK*Math.max(1,Math.ceil(nf*F.b/big/BLOCK));
  const hx=2*F.a/nx,hy=2*F.b/ny,G={nx,ny,hx,hy,mx:nx/MID,my:ny/MID,cx:nx/BLOCK,cy:ny/BLOCK,omega:footprintArea(F),perimeter:0};
  // Coarse cells: instrument and gnomonic coordinates of the centre and weight (midpoint rule). Mid and fine cells are
  // computed when visited.
  const n=G.cx*G.cy,step=BLOCK;
  G.coarse={xx:new Float64Array(n),yy:new Float64Array(n),X:new Float64Array(n),Y:new Float64Array(n),w:new Float64Array(n)};
  for(let j=0;j<G.cy;j++)for(let i=0;i<G.cx;i++){
    const k=j*G.cx+i,xx=-F.a+(i+0.5)*step*hx,yy=-F.b+(j+0.5)*step*hy,x=(xx*F.cp-yy*F.sp)*RAD,y=(xx*F.sp+yy*F.cp)*RAD;
    G.coarse.xx[k]=xx;G.coarse.yy[k]=yy;G.coarse.X[k]=Math.tan(x);G.coarse.Y[k]=Math.tan(y);G.coarse.w[k]=jacobian(F,xx,yy)*step*hx*step*hy;
  }
  // Midpoint error of the density, measured at the coarse level on the whole box against Gauss-Legendre; used as a
  // (conservative) bound of the density error of the mid and fine levels.
  let box=0;const g=GL(48);for(let i=0;i<48;i++)for(let j=0;j<48;j++)box+=g.w[i]*g.w[j]*jacobian(F,F.a*g.x[i],F.b*g.x[j]);box*=F.a*F.b;
  G.densityError=2*Math.abs(G.coarse.w.reduce((s,v)=>s+v,0)-box);
  // Cells crossed by A's own boundary (ellipses and circles only: the rectangle grid is A itself).
  G.ownMarks=null;
  if(F.kind!=='rectangle'){
    const marks=new Set(),p=[0,0];
    const n=Math.ceil(2*Math.PI*big/Math.min(hx,hy)*4);
    for(let k=0;k<n;k++){boundaryXY(F,k/n,p);markAround(G,p[0]+F.a,p[1]+F.b,marks);}
    G.ownMarks=Int32Array.from(marks);
  }
  if(gridCache.size>16)gridCache.delete(gridCache.keys().next().value);
  gridCache.set(key,G);return G;
}
function markAround(G,u,v,set){
  const i=Math.floor(u/G.hx),j=Math.floor(v/G.hy);
  for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){const a=i+di,b=j+dj;if(a>=0&&b>=0&&a<G.nx&&b<G.ny)set.add(b*G.nx+a);}
}
let stampFine=new Uint16Array(0),flagFine=new Uint8Array(0),stampMid=new Uint16Array(0),flagMid=new Uint8Array(0),
  stampCoarse=new Uint16Array(0),flagCoarse=new Uint8Array(0),generation=0;
// Fine marks: typed arrays up to 2048 x 2048 cells, a Map beyond (only the marked cells are stored).
const DENSE_LIMIT=2048*2048;let sparseFine=null;
function nextGeneration(G){
  sparseFine=G.nx*G.ny>DENSE_LIMIT?new Map():null;
  if(!sparseFine&&stampFine.length<G.nx*G.ny){stampFine=new Uint16Array(G.nx*G.ny);flagFine=new Uint8Array(G.nx*G.ny);generation=0;}
  if(stampMid.length<G.mx*G.my){stampMid=new Uint16Array(G.mx*G.my);flagMid=new Uint8Array(G.mx*G.my);generation=0;}
  if(stampCoarse.length<G.cx*G.cy){stampCoarse=new Uint16Array(G.cx*G.cy);flagCoarse=new Uint8Array(G.cx*G.cy);generation=0;}
  if(++generation>65000){stampFine.fill(0);stampMid.fill(0);stampCoarse.fill(0);generation=1;}
  return generation;
}
function stamp(G,gen,i,j,bit){
  const f=j*G.nx+i;
  if(sparseFine)sparseFine.set(f,(sparseFine.get(f)||0)|bit);
  else{if(stampFine[f]!==gen){stampFine[f]=gen;flagFine[f]=0;}flagFine[f]|=bit;}
  const m=((j/MID)|0)*G.mx+((i/MID)|0);if(stampMid[m]!==gen){stampMid[m]=gen;flagMid[m]=0;}flagMid[m]|=bit;
  const c=((j/BLOCK)|0)*G.cx+((i/BLOCK)|0);if(stampCoarse[c]!==gen){stampCoarse[c]=gen;flagCoarse[c]=0;}flagCoarse[c]|=bit;
}
// Boundary of B mapped onto A's instrument coordinates. Consecutive points are at most half a fine cell apart along
// each axis (the number of samples is doubled until this holds), so every fine cell crossed by the boundary lies in
// the 3 x 3 neighbourhood of a sample and is marked.
function markBoundary(FA,FB,G,gen){
  const p=[0,0],v=[0,0,0],q=[0,0],ax=FA.a+2*G.hx,by=FA.b+2*G.hy;
  const own=FB.kind==='rectangle'?4*(FB.a+FB.b):2*Math.PI*Math.max(FB.a,FB.b);
  let n=Math.max(64,Math.ceil(2.5*own/Math.min(G.hx,G.hy)));
  const inBox=(x,y)=>x>-ax&&x<ax&&y>-by&&y<by;
  for(let round=0;round<12;round++){
    const xs=new Float64Array(n),ys=new Float64Array(n);let ok=true;
    for(let k=0;k<n;k++){
      boundaryXY(FB,k/n,p);pointAt(FB,p[0],p[1],v);
      if(instrumentOf(FA,v[0],v[1],v[2],q)){xs[k]=q[0];ys[k]=q[1];}else{xs[k]=NaN;ys[k]=NaN;}
    }
    for(let k=0;k<n&&ok;k++){
      const l=(k+1)%n,x0=xs[k],y0=ys[k],x1=xs[l],y1=ys[l];
      const near0=inBox(x0,y0),near1=inBox(x1,y1);
      if(!near0&&!near1)continue;
      if(!(near0&&near1)&&(Number.isNaN(x0)||Number.isNaN(x1))){ok=false;break;}
      if(Math.max(Math.abs(x1-x0)/G.hx,Math.abs(y1-y0)/G.hy)>0.5)ok=false;
    }
    if(!ok){n*=2;continue;}
    for(let k=0;k<n;k++){
      if(!inBox(xs[k],ys[k]))continue;
      const i=Math.floor((xs[k]+FA.a)/G.hx),j=Math.floor((ys[k]+FA.b)/G.hy);
      for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){const a=i+di,b=j+dj;if(a>=0&&b>=0&&a<G.nx&&b<G.ny)stamp(G,gen,a,b,2);}
    }
    return n;
  }
  throw Error('Overlap: boundary sampling did not converge');
}
/* Enclosure of the area overlap phi = Omega(A ∩ B) / Omega(A). Cells not marked lie entirely on one side of both
 * boundaries and are classified by their centre; marked fine cells are counted in the estimate by their centre and
 * in [lo, hi] as unknown. Returns {est, lo, hi} as fractions. */
function overlapFraction(A,B,nf=FINE_CELLS){
  const FA=A.kind?A:footprint(A),FB=B.kind?B:footprint(B),G=grid(FA,nf),gen=nextGeneration(G);
  if(G.ownMarks)for(const f of G.ownMarks)stamp(G,gen,f%G.nx,(f/G.nx)|0,1);
  const samples=markBoundary(FA,FB,G,gen);
  const v=[0,0,0];
  const at=(X,Y)=>{const px=FA.ux+X*FA.ex+Y*FA.nx,py=FA.uy+X*FA.ey+Y*FA.ny,pz=FA.uz+Y*FA.nz,r=Math.hypot(px,py,pz);v[0]=px/r;v[1]=py/r;v[2]=pz/r;return v;};
  const inA=(xx,yy)=>FA.kind==='rectangle'||(FA.kind==='ellipse'?(xx/FA.a)**2+(yy/FA.b)**2<=1:Math.hypot(xx,yy)<=FA.a);
  const inB=(X,Y)=>{at(X,Y);return insideVec(FB,v[0],v[1],v[2]);};
  let certain=0,unknownIn=0,unknown=0;
  const C=G.coarse,hmx=MID*G.hx,hmy=MID*G.hy;
  for(let cj=0;cj<G.cy;cj++)for(let ci=0;ci<G.cx;ci++){
    const c=cj*G.cx+ci;
    if(stampCoarse[c]!==gen){if(inA(C.xx[c],C.yy[c])&&inB(C.X[c],C.Y[c]))certain+=C.w[c];continue;}
    for(let mj=cj*COARSE;mj<(cj+1)*COARSE;mj++)for(let mi=ci*COARSE;mi<(ci+1)*COARSE;mi++){
      const m=mj*G.mx+mi;
      if(stampMid[m]!==gen){
        const xx=-FA.a+(mi+0.5)*hmx,yy=-FA.b+(mj+0.5)*hmy,x=(xx*FA.cp-yy*FA.sp)*RAD,y=(xx*FA.sp+yy*FA.cp)*RAD,X=Math.tan(x),Y=Math.tan(y);
        if(inA(xx,yy)&&inB(X,Y)){const cx=Math.cos(x),cy=Math.cos(y);certain+=hmx*hmy/(cx*cx*cy*cy*Math.pow(1+X*X+Y*Y,1.5));}
        continue;
      }
      for(let j=mj*MID;j<(mj+1)*MID;j++)for(let i=mi*MID;i<(mi+1)*MID;i++){
        const xx=-FA.a+(i+0.5)*G.hx,yy=-FA.b+(j+0.5)*G.hy,x=(xx*FA.cp-yy*FA.sp)*RAD,y=(xx*FA.sp+yy*FA.cp)*RAD;
        const X=Math.tan(x),Y=Math.tan(y),cx=Math.cos(x),cy=Math.cos(y),w=G.hx*G.hy/(cx*cx*cy*cy*Math.pow(1+X*X+Y*Y,1.5));
        const f=j*G.nx+i,flags=sparseFine?sparseFine.get(f)||0:stampFine[f]===gen?flagFine[f]:0,a=inA(xx,yy),b=inB(X,Y);
        if(!flags){if(a&&b)certain+=w;continue;}
        if(a&&b)unknownIn+=w;
        // possible member: A side unknown if crossed by A's boundary, B side unknown if crossed by B's boundary
        if(((flags&1)||a)&&((flags&2)||b))unknown+=w;
      }
    }
  }
  const e=G.densityError;sparseFine=null;
  return {est:(certain+unknownIn)/G.omega,lo:Math.max(0,(certain-e)/G.omega),hi:Math.min(1,(certain+unknown+e)/G.omega),
    omegaA:G.omega,cells:G.nx*G.ny,samples};
}

/* ------------------------------------------------------------------- contact ---------------------------------- */
const GOLDEN=(Math.sqrt(5)-1)/2;
function goldenMin(f,lo,hi,iterations=80){
  let x1=hi-GOLDEN*(hi-lo),x2=lo+GOLDEN*(hi-lo),f1=f(x1),f2=f(x2);
  for(let it=0;it<iterations&&hi-lo>1e-16;it++){
    if(f1<f2){hi=x2;x2=x1;f2=f1;x1=hi-GOLDEN*(hi-lo);f1=f(x1);}else{lo=x1;x1=x2;f1=f2;x2=lo+GOLDEN*(hi-lo);f2=f(x2);}
  }
  return f1<f2?{t:x1,value:f1}:{t:x2,value:f2};
}
// Minimum over the boundary of Gf of level_F: sampled (corners of rectangles are samples), then refined by
// golden-section search around the best sample. margin = (level - 1) · min(F.a, F.b), an approximate signed angular
// margin, > 0 when the boundary of Gf lies outside F.
function boundaryMargin(F,Gf,n=256){
  const p=[0,0],v=[0,0,0];
  const value=t=>{boundaryXY(Gf,t,p);pointAt(Gf,p[0],p[1],v);return levelVec(F,v[0],v[1],v[2]);};
  let best=Infinity,bt=0;
  for(let k=0;k<n;k++){const t=k/n,val=value(t);if(val<best){best=val;bt=t;}}
  const r=goldenMin(value,bt-1/n,bt+1/n);
  if(r.value<best){best=r.value;bt=r.t;}
  return {margin:(best-1)*Math.min(F.a,F.b),t:((bt%1)+1)%1};
}
function signedMargin(FA,FB){return Math.min(boundaryMargin(FA,FB).margin,boundaryMargin(FB,FA).margin);}
// Angular distance (deg) from the unit vector v to the boundary of F, and where it is attained (sampled, refined).
function distanceToBoundary(F,v,n=1024){
  const p=[0,0],q=[0,0,0];
  const dist=t=>{boundaryXY(F,t,p);pointAt(F,p[0],p[1],q);return Math.hypot(q[0]-v[0],q[1]-v[1],q[2]-v[2]);};
  let best=Infinity,bt=0;
  for(let k=0;k<n;k++){const d=dist(k/n);if(d<best){best=d;bt=k/n;}}
  const r=goldenMin(dist,bt-1/n,bt+1/n);if(r.value<best){best=r.value;bt=r.t;}
  return {gap:2*Math.asin(Math.min(1,best/2))*DEG,t:((bt%1)+1)%1};
}
/* Proved upper bound of the angular distance between two footprints: the distance of an actual pair of boundary
 * points. Candidates: the boundary point of each footprint that comes deepest towards the other (minimum level) and
 * its nearest point on the other boundary; the smaller distance is returned with the type of the touching points. */
function boundaryGap(FA,FB){
  const p=[0,0],v=[0,0,0];let best=null;
  for(const [F,Gf,gIsA] of [[FA,FB,false],[FB,FA,true]]){
    const m=boundaryMargin(F,Gf);boundaryXY(Gf,m.t,p);pointAt(Gf,p[0],p[1],v);
    const d=distanceToBoundary(F,v);
    if(!best||d.gap<best.gap)best=gIsA?{gap:d.gap,cornerA:isCorner(FA,m.t),cornerB:isCorner(FB,d.t)}:{gap:d.gap,cornerA:isCorner(FA,d.t),cornerB:isCorner(FB,m.t)};
  }
  return best;
}
// Geometric relation of two FoVs: 'overlap' (positive area proved), 'contact' (touching within the tolerance, no
// positive area proved) or 'separated'. Never decided from centre distances or HEALPix cells.
function relation(A,B,nf=FINE_CELLS){
  const {T}=lib(),FA=footprint(A),FB=footprint(B),d=centreDistance(A,B),reachSum=T.outerRadius(A)+T.outerRadius(B);
  if(d>reachSum)return {kind:'separated',gap:d-reachSum,overlap:null};   // lower bound of the gap
  let overlap=null;
  try{overlap=overlapFraction(FA,FB,nf);}catch(e){overlap=null;}
  if(overlap&&overlap.lo>0)return {kind:'overlap',overlap,gap:0};
  const g=boundaryGap(FA,FB);
  return {kind:g.gap<=CONTACT_TOLERANCE_DEG?'contact':'separated',overlap,gap:g.gap,cornerA:g.cornerA,cornerB:g.cornerB};
}

/* ------------------------------------------------------------------ placement --------------------------------- */
// Unit direction (east, north) of the great circle from A's centre towards direction (ix, iy) of A's frame.
function directionOf(FA,ix,iy){
  const xx=ix*FA.a,yy=iy*FA.b,x=(xx*FA.cp-yy*FA.sp)*RAD,y=(xx*FA.sp+yy*FA.cp)*RAD,X=Math.tan(x),Y=Math.tan(y),r=Math.hypot(X,Y);
  return [X/r,Y/r];
}
// Angular distance from the centre of F to its boundary along the great circle in direction (dx, dy).
function reach(F,dx,dy){
  const v=[0,0,0],at=t=>{const c=Math.cos(t*RAD),s=Math.sin(t*RAD);v[0]=c*F.ux+s*(dx*F.ex+dy*F.nx);v[1]=c*F.uy+s*(dx*F.ey+dy*F.ny);v[2]=c*F.uz+s*dy*F.nz;return levelVec(F,v[0],v[1],v[2]);};
  let lo=0,hi=1;while(at(hi)<=1&&hi<89)hi=Math.min(89,hi*2);
  for(let k=0;k<80;k++){const m=(lo+hi)/2;if(at(m)<=1)lo=m;else hi=m;}
  return lo;
}
// Area fraction of two equal discs of unit radius at distance 2u (ellipses: affine image).
const lens=u=>(2/Math.PI)*(Math.acos(u)-u*Math.sqrt(1-u*u));
function initialGuess(shape,ix,iy,phi,sc){
  if(shape==='rectangle')return ix&&iy?sc*(1-Math.sqrt(phi)):sc*(1-phi);
  let lo=0,hi=1;for(let k=0;k<60;k++){const m=(lo+hi)/2;if(lens(m)>phi)lo=m;else hi=m;}
  return sc*lo;
}
/* FoV `fov` placed contiguous to `anchor` in direction `dir` with area overlap overlapPct (percent of the anchor's
 * area). Returns {ok:true, config, distance, overlap, contact} or {ok:false, reason}. */
function placeContiguous(anchor,fov,dir,overlapPct){
  const {M}=lib();
  const entry=DIRECTIONS.find(d=>d[0]===dir);if(!entry)throw Error('Unknown direction '+dir);
  const [,ix,iy]=entry,FA=footprint(anchor),[dx,dy]=directionOf(FA,ix,iy),phi=overlapPct/100,tol=OVERLAP_TOLERANCE_PP/100;
  const at=s=>{const p=M.offset(anchor,s*dx,s*dy);return {...fov,ra:p.ra,dec:p.dec};};
  const fp=s=>footprint(at(s));
  // 1. Contact distance: root of the signed boundary margin, bracketed and solved by the Illinois method.
  const base=reach(FA,dx,dy)+reach(footprint({...fov,ra:anchor.ra,dec:anchor.dec}),-dx,-dy);
  if(!(base>0)||base*1.05>=90)return {ok:false,reason:'FoV too large for a contiguous placement (beyond 90°)'};
  let s0=0,g0=-Math.min(FA.a,FA.b),s1=base*1.05,g1;
  try{g1=signedMargin(FA,fp(s1));while(g1<=0&&s1<89){s0=s1;g0=g1;s1=Math.min(89.9,s1*1.25);g1=signedMargin(FA,fp(s1));}}
  catch(e){return {ok:false,reason:e.message};}
  if(!(g1>0))return {ok:false,reason:'no contact distance below 90°'};
  let side=0;
  for(let it=0;it<200&&s1-s0>1e-13*Math.max(1,s1);it++){
    const s=(s0*g1-s1*g0)/(g1-g0),m=Number.isFinite(s)&&s>s0&&s<s1?s:(s0+s1)/2,g=signedMargin(FA,fp(m));
    if(g>0){s1=m;g1=g;if(side===1)g0/=2;side=1;}else{s0=m;g0=g;if(side===-1)g1/=2;side=-1;}
  }
  const contactDistance=s1;
  if(phi===0){
    const config=at(contactDistance),FB=footprint(config),gap=boundaryGap(FA,FB),overlap=overlapFraction(FA,FB);
    const ok=gap.gap<=CONTACT_TOLERANCE_DEG&&overlap.hi<=tol;
    return ok?{ok,dir,config,distance:contactDistance,contactDistance,overlap,contact:gap}:
      {ok:false,reason:'contact not verified (gap '+gap.gap.toExponential(2)+'°, overlap ≤ '+(100*overlap.hi).toFixed(3)+' %)'};
  }
  // 2. Distance giving the centre of the accepted window, then verification on the fine grid.
  const target=phi+tol/2;
  const solve=(nf,lo,flo,hi,fhi,guess,iterations,stopAt)=>{
    let s=guess,best=null;
    for(let it=0;it<iterations;it++){
      if(!(s>lo&&s<hi))s=(lo*fhi-hi*flo)/(fhi-flo);
      if(!(s>lo&&s<hi))s=(lo+hi)/2;
      const r=overlapFraction(FA,fp(s),nf),f=r.est-target;
      if(!best||Math.abs(f)<Math.abs(best.f))best={s,f,r};
      if(Math.abs(f)<stopAt)break;
      if(f>0){lo=s;flo=f;}else{hi=s;fhi=f;}
      s=(lo*fhi-hi*flo)/(fhi-flo);
    }
    return best;
  };
  const inWindow=r=>r.lo>=phi&&r.hi<=phi+tol;
  // Verification on the fine grid; when the estimate is in the window but the bounds are too wide, on a finer one.
  const verify=s=>{let r=overlapFraction(FA,fp(s),FINE_CELLS);
    if(!inWindow(r)&&r.est>=phi&&r.est<=phi+tol&&r.hi-r.lo>tol/2)r=overlapFraction(FA,fp(s),FINER_CELLS);return r;};
  let s=solve(SEARCH_CELLS,0,1-target,contactDistance,-target,initialGuess(fov.shape,ix,iy,target,contactDistance),12,tol*0.05).s;
  let check=verify(s);
  if(!inWindow(check)){s=solve(FINE_CELLS,0,1-target,contactDistance,-target,s,8,tol*0.02).s;check=verify(s);}
  if(!inWindow(check)){
    // The overlap need not decrease monotonically with the distance (e.g. FoVs crossing a pole, whose orientation
    // follows the local north): scan the distance for the crossing of the target nearest to the first estimate.
    const n=48,scan=[];
    for(let k=1;k<n;k++){const t=contactDistance*k/n;scan.push({s:t,f:overlapFraction(FA,fp(t),SEARCH_CELLS).est-target});}
    let bracket=null;
    for(let k=0;k+1<scan.length;k++)if(scan[k].f>0&&scan[k+1].f<=0&&(!bracket||Math.abs(scan[k].s-s)<Math.abs(bracket[0].s-s)))bracket=[scan[k],scan[k+1]];
    if(bracket){
      let lo=bracket[0].s,hi=bracket[1].s;
      for(let it=0;it<30;it++){const m=(lo+hi)/2,f=overlapFraction(FA,fp(m),FINE_CELLS).est-target;if(Math.abs(f)<tol*0.02){lo=hi=m;break;}if(f>0)lo=m;else hi=m;}
      s=(lo+hi)/2;check=verify(s);
    }
  }
  if(!inWindow(check))return {ok:false,reason:'overlap not verified within ['+(100*phi)+', '+(100*(phi+tol))+'] % (enclosure '+(100*check.lo).toFixed(3)+'–'+(100*check.hi).toFixed(3)+' %)'};
  const est={s};
  return {ok:true,dir,config:at(est.s),distance:est.s,contactDistance,overlap:check,contact:null};
}

/* ------------------------------------------------------------- HEALPix components ----------------------------- */
// NESTED neighbours (port of healpix_cxx T_Healpix_Base::neighbors). Results in the order of the offsets
// (-1,0) (-1,1) (0,1) (1,1) (1,0) (1,-1) (0,-1) (-1,-1) of the face coordinates; -1 where a pixel has only 7.
const XO=[-1,-1,0,1,1,1,0,-1],YO=[0,1,1,1,0,-1,-1,-1];
const FACE=[[8,9,10,11,-1,-1,-1,-1,10,11,8,9],[5,6,7,4,8,9,10,11,9,10,11,8],[-1,-1,-1,-1,5,6,7,4,-1,-1,-1,-1],
  [4,5,6,7,11,8,9,10,11,8,9,10],[0,1,2,3,4,5,6,7,8,9,10,11],[1,2,3,0,0,1,2,3,5,6,7,4],[-1,-1,-1,-1,7,4,5,6,-1,-1,-1,-1],
  [3,0,1,2,3,0,1,2,4,5,6,7],[2,3,0,1,-1,-1,-1,-1,0,1,2,3]];
const SWAP=[[0,0,3],[0,0,6],[0,0,0],[0,0,5],[0,0,0],[5,0,0],[0,0,0],[6,0,0],[3,0,0]];
// Integer bit operations: valid up to order 13 (pixel numbers below 2^31).
function nest2xyf(order,pix){const np=1<<(2*order),face=Math.floor(pix/np);let ipf=pix-face*np,x=0,y=0;
  for(let b=0;b<order;b++){x|=(ipf&1)<<b;ipf>>>=1;y|=(ipf&1)<<b;ipf>>>=1;}return [x,y,face];}
function xyf2nest(order,x,y,face){let ipf=0;for(let b=0;b<order;b++)ipf|=(((x>>>b)&1)<<(2*b))|(((y>>>b)&1)<<(2*b+1));return face*(1<<(2*order))+ipf;}
function neighbours(order,pix,out=new Array(8)){
  if(!(Number.isInteger(order)&&order>=0&&order<=13))throw Error('Neighbour order must be 0..13');
  const nside=1<<order,[ix,iy,f]=nest2xyf(order,pix);
  for(let i=0;i<8;i++){
    let x=ix+XO[i],y=iy+YO[i],nb=4;
    if(x<0){x+=nside;nb-=1;}else if(x>=nside){x-=nside;nb+=1;}
    if(y<0){y+=nside;nb-=3;}else if(y>=nside){y-=nside;nb+=3;}
    const g=FACE[nb][f];
    if(g<0){out[i]=-1;continue;}
    const bits=SWAP[nb][f>>2];
    if(bits&1)x=nside-x-1;if(bits&2)y=nside-y-1;if(bits&4){const t=x;x=y;y=t;}
    out[i]=xyf2nest(order,x,y,g);
  }
  return out;
}
// Order-9 pixel of every sample point of credible-region-tiling.js regionSamples(), in the same order.
function samplePixels(cells,n){
  const pix=new Int32Array(n);let k=0;
  for(const c of cells){
    if(c.order>=SAMPLE_ORDER){pix[k++]=Math.floor(c.pixel/Math.pow(4,c.order-SAMPLE_ORDER));continue;}
    const m=Math.pow(4,SAMPLE_ORDER-c.order);for(let j=0;j<m;j++)pix[k++]=c.pixel*m+j;
  }
  if(k!==n)throw Error('Sample pixels do not match the region samples');
  return pix;
}
// Connected components of the region at order 9: pixels holding sample points, joined through their 8 neighbours
// (sharing an edge or a vertex). Components are numbered by decreasing probability (ties: lowest pixel first).
function regionComponents(cells,s){
  const pix=samplePixels(cells,s.n),npix=12*Math.pow(4,SAMPLE_ORDER);
  // state: 0 = not in the region, -1 = in the region and not labelled yet, k > 0 = component k - 1
  const state=new Int32Array(npix);let unique=0;
  for(let i=0;i<s.n;i++)if(state[pix[i]]===0){state[pix[i]]=-1;unique++;}
  const queue=new Int32Array(unique),nb=new Array(8),groups=[];
  for(let i=0;i<s.n;i++){
    const start=pix[i];if(state[start]!==-1)continue;
    const id=groups.length;let head=0,tail=0,first=start;queue[tail++]=start;state[start]=id+1;
    while(head<tail){const p=queue[head++];if(p<first)first=p;neighbours(SAMPLE_ORDER,p,nb);
      for(let k=0;k<8;k++){const q=nb[k];if(q>=0&&state[q]===-1){state[q]=id+1;queue[tail++]=q;}}}
    groups.push({pixels:tail,prob:0,area:0,first});
  }
  for(let i=0;i<s.n;i++){const g=groups[state[pix[i]]-1];g.prob+=s.w[i];g.area+=s.a[i];}
  const order=groups.map((g,i)=>i).sort((i,j)=>groups[j].prob-groups[i].prob||groups[i].first-groups[j].first),rank=new Int32Array(groups.length);
  order.forEach((g,r)=>{rank[g]=r;});
  const comp=new Int32Array(s.n);for(let i=0;i<s.n;i++)comp[i]=rank[state[pix[i]]-1];
  return {comp,list:order.map((g,r)=>({id:r,pixels:groups[g].pixels,probability:groups[g].prob,area:groups[g].area}))};
}

/* --------------------------------------------------------------------- plan ----------------------------------- */
/* Plans up to maxNew NEW FoVs (same shape, size and PA as `fov`) for the credible region at `level` as an observing
 * sequence. behavior: 'strict' (alpha = 0) or 'balanced' (alpha in [0, 1], default 0.5). overlap: 0-50 % in steps of
 * 5. accepted: FoVs already in the plan, covered and never changed or reordered. Returns null if shouldStop() turns
 * true. */
async function plan({posterior,level,fov,accepted=[],maxNew,behavior='strict',alpha,overlap=DEFAULT_OVERLAP,
  startFromLastAccepted=false,shortlist,probOrder,shouldStop=()=>false,progress=()=>{}}){
  const {M,T}=lib();
  M.configValid({...fov,ra:0,dec:0});
  if(!Number.isInteger(maxNew)||maxNew<1)throw Error('The maximum number of new FoVs must be a positive integer');
  if(!OVERLAP_CHOICES.includes(overlap))throw Error('Area overlap must be 0–50 % in steps of 5 %');
  if(behavior!=='strict'&&behavior!=='balanced')throw Error('Observational behavior must be strict or balanced');
  const a=behavior==='strict'?0:alpha==null?DEFAULT_ALPHA:alpha;
  if(!(a>=0&&a<=1))throw Error('Alpha must be between 0 and 1');
  shortlist=shortlist==null?T.DEFAULT_SHORTLIST:shortlist;
  if(!Number.isInteger(shortlist)||shortlist<1)throw Error('Shortlist size must be a positive integer');
  accepted.forEach(M.configValid);
  const ms={},t0=now();let sliceStart=now();
  const pause=async()=>{if(now()-sliceStart<SLICE_MS)return !shouldStop();await yieldTurn();sliceStart=now();return !shouldStop();};
  progress(0,'Credible region from the BAYESTAR cells');await yieldTurn();if(shouldStop())return null;
  const region=T.credibleRegion(posterior,level);
  progress(0.02,'Region sample points and components (HEALPix order 9)');if(!(await pause()))return null;
  const s=T.regionSamples(region.cells),forNear=T.pointIndex(s),N=s.n;
  if(!(await pause()))return null;
  const components=regionComponents(region.cells,s);ms.region=now()-t0;
  const regionArea=s.a.reduce((x,v)=>x+v,0),regionProb=s.w.reduce((x,v)=>x+v,0);
  const covered=new Uint8Array(N);let uncovered=N,coveredArea=0,coveredProb=0;
  const mark=i=>{covered[i]=1;uncovered--;coveredArea+=s.a[i];coveredProb+=s.w[i];};
  const R=T.outerRadius(fov);
  const coverOf=c=>{const list=[],r=T.outerRadius(c);forNear(c.ra,c.dec,r,j=>{if(M.inside(s.points[j],c))list.push(j);});return Int32Array.from(list);};
  const acceptedCover=accepted.map(coverOf);
  for(const list of acceptedCover)for(const j of list)if(!covered[j])mark(j);
  const coveredByAccepted=coveredArea,coveredProbByAccepted=coveredProb;
  // Probability-first candidates and lazy estimates (same rules as credible-region-tiling.js).
  const C=T.candidateOrder(fov),cand=[];
  if(C===SAMPLE_ORDER)for(let i=0;i<N;i++)cand.push(s.points[i]);
  else{const seen=new Map();for(let i=0;i<N;i++){const pix=M.ang2pixNest(C,s.points[i].ra,s.points[i].dec);if(!seen.has(pix)){seen.set(pix,cand.length);cand.push(M.pixelCenter(C,pix));}}}
  const nc=cand.length,kP=new Float64Array(nc),kA=new Float64Array(nc),stampV=new Int32Array(nc).fill(-1),covers=new Array(nc);
  progress(0.05,'Candidate positions ('+nc.toLocaleString('en-US')+')');
  for(let i=0;i<nc;i++){
    let p=0,ar=0;forNear(cand[i].ra,cand[i].dec,R,j=>{if(!covered[j]){p+=s.w[j];ar+=s.a[j];}});kP[i]=p;kA[i]=ar;
    if((i&255)===0&&!(await pause()))return null;
  }
  const config=i=>({...fov,ra:cand[i].ra,dec:cand[i].dec});
  let version=0,evaluations=0;
  const evaluate=i=>{
    if(!covers[i]){const c=config(i),list=[];forNear(c.ra,c.dec,R,j=>{if(M.inside(s.points[j],c))list.push(j);});covers[i]=Int32Array.from(list);evaluations++;}
    let p=0,ar=0;for(const j of covers[i])if(!covered[j]){p+=s.w[j];ar+=s.a[j];}
    kP[i]=p;kA[i]=ar;stampV[i]=version;
  };
  const byProbability=(i,j)=>kP[i]>kP[j]||(kP[i]===kP[j]&&i<j);
  const byArea=(i,j)=>kA[i]>kA[j]||(kA[i]===kA[j]&&(kP[i]>kP[j]||(kP[i]===kP[j]&&i<j)));
  let heap=T.maxHeap(byProbability);for(let i=0;i<nc;i++)heap.push(i);
  const negligible=T.NEGLIGIBLE_FRACTION*regionProb/regionArea*T.fovArea(fov);
  const score=T.exactScorer(region,probOrder),previous=accepted.slice(),chosen=[],records=[];
  let phase='probability',exactMs=0,exactCalls=0;
  const exact=c=>{const t=now(),v=score(c,previous);exactMs+=now()-t;exactCalls++;return v;};
  const gains=list=>{let p=0,ar=0;for(const j of list)if(!covered[j]){p+=s.w[j];ar+=s.a[j];}return {p,ar};};
  const STOP={};
  // Fresh best estimate of the Probability-first search, left in the heap (lazy re-evaluation as in Probability
  // first). In the probability phase the area phase starts when it is negligible, exactly as in Probability first.
  async function globalTop(){
    for(;;){
      while(heap.size){
        const i=heap.pop();
        if(stampV[i]!==version){evaluate(i);heap.push(i);if(!(await pause()))return STOP;continue;}
        heap.push(i);
        if(phase==='probability'&&kP[i]<negligible)break;
        if(phase==='area'&&!(kA[i]>0))return null;   // no candidate covers any uncovered point
        return {i,proxy:kP[i],newArea:kA[i]};
      }
      if(phase==='area')return null;
      const rest=heap.drain();heap=T.maxHeap(byArea);for(const i of rest)heap.push(i);phase='area';
    }
  }
  // Probability-first choice: the best of the shortlist re-scored with the engine (probability phase), or the
  // candidate covering the most uncovered area (area phase).
  async function globalChoice(){
    if(phase==='area'){
      const top=await globalTop();if(top===STOP||top===null)return top;
      const i=heap.pop();evaluate(i);
      return {config:config(i),list:covers[i],proxy:kP[i],newArea:kA[i],exact:null,anchor:null,dir:null,overlap:null,contact:null};
    }
    const fresh=[];
    while(heap.size&&fresh.length<shortlist){
      const i=heap.pop();
      if(stampV[i]!==version){evaluate(i);heap.push(i);}else fresh.push(i);
      if(!(await pause()))return STOP;
    }
    const scored=[];
    for(const i of fresh){scored.push({i,proxy:kP[i],exact:exact(config(i))});if(!(await pause()))return STOP;}
    let best=scored[0];for(const x of scored)if(x.exact>best.exact)best=x;
    for(const x of scored)if(x!==best)heap.push(x.i);
    return {config:config(best.i),list:covers[best.i],proxy:best.proxy,newArea:kA[best.i],exact:best.exact,anchor:null,dir:null,overlap:null,contact:null};
  }
  // Contiguous placements of each anchor, computed once (geometry does not depend on the coverage).
  const placementCache=new Map();let placements=0,failedPlacements=0,placementMs=0;const failures=[];
  const isDuplicate=c=>previous.some(p=>centreDistance(p,c)<1e-9);
  async function neighboursOf(anchorKey,anchor){
    if(placementCache.has(anchorKey))return placementCache.get(anchorKey);
    const list=[];
    for(const [dir] of DIRECTIONS){
      const t=now();let r;
      try{r=placeContiguous(anchor,fov,dir,overlap);}catch(e){r={ok:false,reason:e.message};}
      placementMs+=now()-t;placements++;
      if(r.ok)list.push({dir,config:r.config,overlap:r.overlap,contact:r.contact,distance:r.distance,list:coverOf(r.config)});
      else{failedPlacements++;failures.push({anchor:anchorKey,dir,reason:r.reason});}
      if(!(await pause()))return undefined;
    }
    placementCache.set(anchorKey,list);return list;
  }
  // Useful contiguous or branch candidates in the current phase, best estimate first: probability phase, estimated
  // region gain >= the negligible threshold of Probability first; area phase, uncovered area > 0.
  function usefulOf(items){
    const out=[];
    for(const x of items){if(isDuplicate(x.config))continue;const g=gains(x.list);x.proxy=g.p;x.newArea=g.ar;
      if(phase==='probability'?g.p>=negligible:g.ar>0)out.push(x);}
    out.sort(phase==='probability'?(x,y)=>y.proxy-x.proxy:(x,y)=>y.newArea-x.newArea||y.proxy-x.proxy);
    return out;
  }
  // Choice among useful candidates: the highest exact region gain among the best `shortlist` estimates (probability
  // phase; a gain of 0 is never chosen), the largest uncovered area (area phase).
  async function chooseAmong(list){
    if(!list.length)return null;
    if(phase==='area')return list[0];
    let best=null;
    for(const x of list.slice(0,shortlist)){x.exact=exact(x.config);if(!(await pause()))return STOP;if(x.exact>0&&(!best||x.exact>best.exact))best=x;}
    return best;
  }
  const keyOf=k=>k<0?'accepted:'+(accepted.length-1):'new:'+k;
  const anchorConfig=k=>k<0?accepted[accepted.length-1]:chosen[k];
  const fromAccepted=startFromLastAccepted&&accepted.length>0;
  /* One step. Decisions between continuing, a branch and the Probability-first position use the order-9 estimates
   * (region probability in the probability phase, uncovered area in the area phase), as the phase switch of
   * Probability first; the FoV is then chosen inside the selected category with the exact re-scoring.
   * Returns the pick, 'restart' when the probability phase has just ended (the step is repeated in the area phase,
   * so that a contiguous continuation is looked for first), 'none' when nothing covers the residual area, or STOP. */
  async function step(prevIndex){
    const est=x=>phase==='probability'?x.proxy:x.newArea,startPhase=phase;
    let all=[],contig=[];
    if(prevIndex!=null){
      const list=await neighboursOf(keyOf(prevIndex),anchorConfig(prevIndex));if(list===undefined)return STOP;
      all=list.map(x=>({...x,anchor:prevIndex}));contig=usefulOf(all);
    }
    let top;
    // Balanced needs the best estimate of the region (it may end the probability phase).
    if(contig.length&&a>0){top=await globalTop();if(top===STOP)return STOP;if(phase!==startPhase)return 'restart';}
    if(contig.length&&(a===0||!top||est(contig[0])>=a*est(top))){
      const x=await chooseAmong(contig);if(x===STOP)return STOP;if(x)return {kind:'contiguous',x};
    }
    // Reposition: a branch contiguous to an earlier FoV of the run, or the Probability-first position.
    const branches=[];
    for(let k=-1;k<chosen.length;k++){
      if(k===prevIndex||(k===-1&&!fromAccepted))continue;
      const list=await neighboursOf(keyOf(k),anchorConfig(k));if(list===undefined)return STOP;
      for(const x of list)branches.push({...x,anchor:k});
    }
    let useful=usefulOf(branches);
    if(useful.length&&a>0&&top===undefined){top=await globalTop();if(top===STOP)return STOP;if(phase!==startPhase)return 'restart';}
    if(useful.length&&(a===0||!top||est(useful[0])>=a*est(top))){
      const x=await chooseAmong(useful);if(x===STOP)return STOP;if(x)return {kind:'branch',x};
    }
    if(top===undefined){top=await globalTop();if(top===STOP)return STOP;if(phase!==startPhase)return 'restart';}
    if(top===null)return 'none';
    const g=await globalChoice();if(g===STOP)return STOP;if(g===null)return 'none';
    return {kind:'global',x:g};
  }
  const tSelect=now();
  ms.setup=tSelect-t0;
  while(chosen.length<maxNew&&uncovered>0){
    progress(0.1+0.9*chosen.length/maxNew,'Selecting FoV '+(chosen.length+1)+' of at most '+maxNew+(phase==='area'?' (residual area)':''));
    const prevIndex=chosen.length?chosen.length-1:fromAccepted?-1:null;
    const pick=await step(prevIndex);
    if(pick===STOP)return null;
    if(pick==='restart')continue;
    if(pick==='none')break;
    const x=pick.x,c={...fov,ra:x.config.ra,dec:x.config.dec};
    if(x.exact==null)x.exact=exact(c);
    let overlapPoints=0,newArea=0,newProxy=0;
    for(const j of x.list){if(covered[j])overlapPoints++;else{newArea+=s.a[j];newProxy+=s.w[j];mark(j);}}
    const prevConfig=prevIndex==null?(accepted.length?accepted[accepted.length-1]:null):anchorConfig(prevIndex);
    const comps=new Set();for(const j of x.list)comps.add(components.comp[j]);
    previous.push(c);version++;chosen.push(c);
    records.push({ra:c.ra,dec:c.dec,phase,choice:pick.kind,anchor:x.anchor,direction:x.dir||null,
      overlapWithAnchor:x.overlap?{est:x.overlap.est,lo:x.overlap.lo,hi:x.overlap.hi}:null,
      contactWithAnchor:x.contact?{gap:x.contact.gap,cornerA:x.contact.cornerA,cornerB:x.contact.cornerB}:null,
      exactRegionNew:x.exact,proxyRegionNew:newProxy,newArea,overlapArea:overlapPoints*T.cellArea(SAMPLE_ORDER),pointsInFoV:x.list.length,
      components:[...comps].sort((p,q)=>p-q),distanceFromPrevious:prevConfig?centreDistance(prevConfig,c):null,coveredArea,coveredFraction:coveredArea/regionArea});
    if(!(await pause()))return null;
  }
  ms.select=now()-tSelect;ms.exact=exactMs;ms.placement=placementMs;
  // Moves: the kind of every move is decided from the geometry relative to the PREVIOUS FoV only.
  const diag=diagonal({...fov,ra:0,dec:0}),moves=[];
  const compsOf=list=>{const set=new Set();for(const j of list)set.add(components.comp[j]);return set;};
  let prevSet=fromAccepted||accepted.length?compsOf(acceptedCover[accepted.length-1]):null;
  for(let k=0;k<records.length;k++){
    const r=records[k],from=k?chosen[k-1]:accepted.length?accepted[accepted.length-1]:null;
    let kind;
    if(r.choice==='contiguous')kind='contiguous';
    else if(!from)kind='start';
    else if(k===0&&!fromAccepted)kind='start';
    else kind=r.components.some(c=>prevSet&&prevSet.has(c))?'reposition':'jump';
    const move={index:k,kind,from:from?{ra:from.ra,dec:from.dec}:null,distance:r.distanceFromPrevious,long:r.distanceFromPrevious!=null&&r.distanceFromPrevious>LONG_MOVE_DIAGONALS*diag,
      direction:r.direction,anchor:r.anchor,overlap:r.choice==='contiguous'?r.overlapWithAnchor:null,contact:r.choice==='contiguous'?r.contactWithAnchor:null,branchOf:r.choice==='branch'?r.anchor:null};
    if(kind!=='contiguous'&&from){const rel=relation(from,chosen[k]);move.touchesPrevious=rel.kind!=='separated';move.relation=rel.kind;}
    r.move=kind;moves.push(move);prevSet=new Set(r.components);
    if(!(await pause()))return null;
  }
  ms.total=now()-t0;
  const complete=uncovered===0,visited=new Set();for(const r of records)for(const c of r.components)visited.add(c);
  const contiguousOverlaps=moves.filter(m=>m.kind==='contiguous');
  const pathLength=moves.filter(m=>m.distance!=null&&(m.index>0||fromAccepted)).reduce((t,m)=>t+m.distance,0);
  return {
    region:{level,cells:region.cells,count:region.count,probability:region.probability,area:region.area,thresholdDensity:region.thresholdDensity},
    sampleOrder:SAMPLE_ORDER,sampleCellArea:s.a.length?T.cellArea(SAMPLE_ORDER):0,points:N,candidateOrder:C,candidates:nc,evaluations,
    shortlist,negligibleGain:negligible,exactCalls,fovs:records,
    stop:complete?'complete':chosen.length>=maxNew?'limit':'no-candidates',
    coverage:{regionArea,coveredByAccepted,covered:coveredArea,residual:complete?0:regionArea-coveredArea,
      fraction:complete?1:coveredArea/regionArea,complete,uncoveredPoints:uncovered,
      sampledProbability:regionProb,sampledCoveredProbability:coveredProb,sampledCoveredProbabilityByAccepted:coveredProbByAccepted},
    observational:{behavior,alpha:a,overlapPercent:overlap,overlapTolerancePP:OVERLAP_TOLERANCE_PP,contactToleranceDeg:CONTACT_TOLERANCE_DEG,
      startFromLastAccepted:fromAccepted,moves,diagonal:diag,longMoveThreshold:LONG_MOVE_DIAGONALS*diag,pathLength,
      counts:{contiguous:moves.filter(m=>m.kind==='contiguous').length,reposition:moves.filter(m=>m.kind==='reposition').length,
        jump:moves.filter(m=>m.kind==='jump').length,start:moves.filter(m=>m.kind==='start').length,long:moves.filter(m=>m.long).length},
      overlapRange:contiguousOverlaps.length&&overlap>0?{lo:Math.min(...contiguousOverlaps.map(m=>m.overlap.lo)),hi:Math.max(...contiguousOverlaps.map(m=>m.overlap.hi)),
        estMin:Math.min(...contiguousOverlaps.map(m=>m.overlap.est)),estMax:Math.max(...contiguousOverlaps.map(m=>m.overlap.est))}:null,
      maxContactGap:overlap===0&&contiguousOverlaps.length?Math.max(...contiguousOverlaps.map(m=>m.contact.gap)):null,
      components:{count:components.list.length,list:components.list,visited:[...visited].sort((p,q)=>p-q)},
      placements:{computed:placements,failed:failedPlacements,failures:failures.slice(0,50)}},
    ms};
}
global.ObservationalTiling={plan,placeContiguous,overlapFraction,boundaryGap,relation,footprint,insideVec,footprintArea,
  regionComponents,neighbours,diagonal,DIRECTIONS:DIRECTIONS.map(d=>d[0]),OVERLAP_CHOICES,DEFAULT_OVERLAP,OVERLAP_TOLERANCE_PP,
  CONTACT_TOLERANCE_DEG,DEFAULT_ALPHA,LONG_MOVE_DIAGONALS,FINE_CELLS};
})(window);
