/* Standalone scientific helpers for the Coverage LAB (not GWsky production code).
 * No network, no tracking. ICRS degrees. Footprint areas are exact relative to MOC cells.
 * FoV overlap integration uses HEALPix cell-centre sampling: APPROXIMATE, explicitly labelled.
 */
(function (global) {
  'use strict';
  const RAD=Math.PI/180, DEG=180/Math.PI, SKY=4*Math.PI*(DEG*DEG);
  const containsCache = new WeakMap();
  const JRLL=[2,2,2,2,3,3,3,3,4,4,4,4], JPLL=[1,3,5,7,0,2,4,6,1,3,5,7];
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  function uniqDecode(u) {
    if (!Number.isSafeInteger(u)||u<4) throw Error('UNIQ exceeds safe integer range');
    const order=Math.floor(Math.log2(u/4)/2);
    const p=u-4*Math.pow(4,order);
    if(order<0||order>23||p<0||p>=12*Math.pow(4,order))throw Error('Invalid UNIQ: '+u);
    return {order,pixel:p};
  }
  function jsonToRanges(json,targetOrder) {
    const raw=[];
    for (const [os, pixels] of Object.entries(json||{})) {
      const order=Number(os);
      if(!Number.isInteger(order)||order<0||order>targetOrder)throw Error('Invalid MOC order: '+os);
      const scale=Math.pow(4,targetOrder-order);
      for(const pixel of pixels){const start=Number(pixel)*scale;raw.push([start,start+scale]);}
    }
    raw.sort((a,b)=>a[0]-b[0]);
    const merged=[];
    for(const [start,end] of raw){const last=merged[merged.length-1];if(last&&start<=last[1])last[1]=Math.max(last[1],end);else merged.push([start,end]);}
    return merged;
  }
  function maxOrder(json) {return Math.max(0,...Object.keys(json||{}).map(Number));}
  function areaDeg2(json) {let area=0;for(const [o,pixels] of Object.entries(json||{}))area+=pixels.length*SKY/(12*Math.pow(4,Number(o)));return area;}
  function intersectionCells(a,b) {
    let i=0,j=0,sum=0;
    while(i<a.length&&j<b.length){sum+=Math.max(0,Math.min(a[i][1],b[j][1])-Math.max(a[i][0],b[j][0]));if(a[i][1]<b[j][1])i++;else j++;}
    return sum;
  }
  function intersectArea(aJson,bJson) {const order=Math.max(maxOrder(aJson),maxOrder(bJson));const a=jsonToRanges(aJson,order),b=jsonToRanges(bJson,order);return intersectionCells(a,b)*SKY/(12*Math.pow(4,order));}
  function rangeOverlap(ranges,start,end){
    let low=0,high=ranges.length;
    while(low<high){const mid=(low+high)>>1;if(ranges[mid][1]<=start)low=mid+1;else high=mid;}
    let total=0;
    for(let i=low;i<ranges.length&&ranges[i][0]<end;i++)total+=Math.max(0,Math.min(end,ranges[i][1])-Math.max(start,ranges[i][0]));
    return total;
  }
  function containsAtOrder(ranges,pixel){return rangeOverlap(ranges,pixel,pixel+1)>0;}
  function pixelCenter(order,pixel) {
    const nside=Math.pow(2,order), face=Math.floor(pixel/(nside*nside));
    if(face<0||face>11)throw Error('HEALPix pixel out of range');
    let ipf=pixel%(nside*nside),ix=0,iy=0;
    for(let k=0;k<order;k++){ix|=(ipf&1)<<k;ipf=Math.floor(ipf/2);iy|=(ipf&1)<<k;ipf=Math.floor(ipf/2);}
    const jrt=ix+iy,jpt=ix-iy,jr=JRLL[face]*nside-jrt-1;
    let nr,z,kshift;
    if(jr<nside){nr=jr;z=1-nr*nr/(3*nside*nside);kshift=0;}
    else if(jr>3*nside){nr=4*nside-jr;z=-1+nr*nr/(3*nside*nside);kshift=0;}
    else {nr=nside;z=(2*nside-jr)*(2/(3*nside));kshift=(jr-nside)&1;}
    if(nr===0)return {ra:0,dec:jr<nside?90:-90};
    let jp=(JPLL[face]*nr+jpt+1+kshift)/2;
    if(jp>4*nside)jp-=4*nside;if(jp<1)jp+=4*nside;
    const phi=(jp-(kshift+1)*0.5)*Math.PI/(2*nr);
    return {ra:((phi*DEG)%360+360)%360,dec:Math.asin(clamp(z,-1,1))*DEG};
  }
  function vec(ra,dec){const a=ra*RAD,d=dec*RAD;return [Math.cos(d)*Math.cos(a),Math.cos(d)*Math.sin(a),Math.sin(d)];}
  function offset(center,x,y){
    const a=center.ra*RAD,d=center.dec*RAD,u=vec(center.ra,center.dec),e=[-Math.sin(a),Math.cos(a),0],n=[-Math.sin(d)*Math.cos(a),-Math.sin(d)*Math.sin(a),Math.cos(d)];
    const r=Math.hypot(x,y)*RAD;
    if(r>Math.PI/2)throw Error('FoV too wide for spherical tiling');
    if(r<1e-15)return {ra:center.ra,dec:center.dec};
    const xx=x/Math.hypot(x,y),yy=y/Math.hypot(x,y);
    const p=u.map((v,i)=>Math.cos(r)*v+Math.sin(r)*(xx*e[i]+yy*n[i]));
    return {ra:((Math.atan2(p[1],p[0])*DEG)%360+360)%360,dec:Math.asin(clamp(p[2],-1,1))*DEG};
  }
  function tangent(point,center){
    const a=center.ra*RAD,d=center.dec*RAD,p=vec(point.ra,point.dec),u=vec(center.ra,center.dec);
    const forward=p[0]*u[0]+p[1]*u[1]+p[2]*u[2];
    if(forward<=0)return null;
    const east=-Math.sin(a)*p[0]+Math.cos(a)*p[1];
    const north=-Math.sin(d)*Math.cos(a)*p[0]-Math.sin(d)*Math.sin(a)*p[1]+Math.cos(d)*p[2];
    return {x:Math.atan2(east,forward)*DEG,y:Math.atan2(north,forward)*DEG};
  }
  function configValid(c){
    if(!Number.isFinite(c.ra)||!Number.isFinite(c.dec)||c.ra<0||c.ra>=360||Math.abs(c.dec)>90)throw Error('Invalid RA/Dec (ICRS degrees)');
    if(!['circle','rectangle','ellipse'].includes(c.shape))throw Error('Unsupported FoV shape');
    for(const name of ['width','height','radius'])if(!(c[name]>0)||c[name]>40)throw Error('Dimension '+name+' must be between 0 and 40°');
    if(Math.abs(c.pa)>360)throw Error('PA out of range');
    return c;
  }
  function inside(point,c) {
    const p=tangent(point,c);
    if(!p)return false;
    if(c.shape==='circle')return Math.hypot(p.x,p.y)<=Math.tan(c.radius*RAD)*DEG+1e-10;
    const pa=c.pa*RAD,xx=p.x*Math.cos(pa)+p.y*Math.sin(pa),yy=-p.x*Math.sin(pa)+p.y*Math.cos(pa);
    if(c.shape==='ellipse')return (xx/(c.width/2))**2+(yy/(c.height/2))**2<=1;
    return Math.abs(xx)<=c.width/2&&Math.abs(yy)<=c.height/2;
  }
  function polygon(c){
    configValid(c);
    const pts=[];const count=(c.shape==='rectangle'?4:64);
    for(let i=0;i<count;i++){
      // Rectangle corners MUST be at (+/-width/2, +/-height/2), not points
      // on the ellipse inscribed within that rectangle (a previous bug).
      const corners=[[-c.width/2,-c.height/2],[c.width/2,-c.height/2],
                     [c.width/2,c.height/2],[-c.width/2,c.height/2]];
      const t=2*Math.PI*i/count;
      const ux=c.shape==='rectangle'?corners[i][0]:(c.shape==='circle'?c.radius:c.width/2)*Math.cos(t);
      const uy=c.shape==='rectangle'?corners[i][1]:(c.shape==='circle'?c.radius:c.height/2)*Math.sin(t);
      const pa=c.pa*RAD,xx=ux*Math.cos(pa)-uy*Math.sin(pa),yy=ux*Math.sin(pa)+uy*Math.cos(pa);
      pts.push(offset(c,xx,yy));
    }
    return {ra:pts.map(p=>p.ra),dec:pts.map(p=>p.dec)};
  }
  function nextCenter(c,direction,overlapX,overlapY,fine=0){
    const sx=(c.shape==='circle'?2*c.radius:c.width)*(1-overlapX/100),sy=(c.shape==='circle'?2*c.radius:c.height)*(1-overlapY/100);
    const dirs={N:[0,1],NE:[1,1],E:[1,0],SE:[1,-1],S:[0,-1],SW:[-1,-1],W:[-1,0],NW:[-1,1]};
    const [ix,iy]=dirs[direction]||[0,0];
    // Moves are along the instrument FoV axes, rotated by its PA.
    const ux=ix*(sx+fine),uy=iy*(sy+fine),pa=c.pa*RAD;
    return offset(c,ux*Math.cos(pa)-uy*Math.sin(pa),ux*Math.sin(pa)+uy*Math.cos(pa));
  }
  function sampleMoc(json,order=9){
    const ranges=jsonToRanges(json,order),total=ranges.reduce((x,r)=>x+r[1]-r[0],0);
    if(total>275000)throw Error('Too many sample cells; choose lower order');
    const points=new Array(total);let k=0;
    for(const [start,end] of ranges)for(let i=start;i<end;i++)points[k++]=pixelCenter(order,i);
    return {points,cellArea:SKY/(12*Math.pow(4,order)),order};
  }
  function readHeader(bytes,offset) {
    if(offset+2880>bytes.length)throw Error('Truncated FITS');
    const h={};let pos=offset,stop=false;
    while(!stop){if(pos+2880>bytes.length)throw Error('Header Truncated FITS');
      for(let i=0;i<36;i++){
        const start=pos+80*i,card=new TextDecoder('ascii').decode(bytes.subarray(start,start+80));
        const key=card.slice(0,8).trim();if(key==='END'){stop=true;break;}
        if(card[8]==='='){
          let raw=card.slice(10).trim();
          if(raw.startsWith("'")){const match=raw.match(/^'((?:[^']|'')*)'/);h[key]=match?match[1].replace(/''/g,"'").trim():raw;}
          else{raw=raw.split('/')[0].trim();h[key]=raw==='T'?true:raw==='F'?false:(raw&&Number.isFinite(Number(raw.replace(/D/ig,'E')))?Number(raw.replace(/D/ig,'E')):raw);}
        }
      }pos+=2880;
    }
    return {h,dataStart:pos};
  }
  // FITS input validation only (no scientific formula): every header value used as
  // a size or a count must be a non-negative integer that JavaScript represents
  // exactly. Negative, fractional, non-numeric or non-finite values are refused
  // before any offset arithmetic, so a crafted file cannot rewind the HDU cursor.
  function headerCount(h,key,max=Number.MAX_SAFE_INTEGER){
    const raw=h[key];
    if(raw===undefined||raw==='')return 0;
    if(typeof raw!=='number'||!Number.isSafeInteger(raw)||raw<0||raw>max)throw Error('Invalid FITS header value '+key+' = '+String(raw).slice(0,40));
    return raw;
  }
  function fitsTables(buffer) {
    const bytes=new Uint8Array(buffer),tables=[];let cursor=0;
    while(cursor<bytes.length){const {h,dataStart}=readHeader(bytes,cursor);
      const naxis=headerCount(h,'NAXIS',999),xtension=String(h.XTENSION||'');
      let size=0;
      if(xtension==='BINTABLE')size=headerCount(h,'NAXIS1')*headerCount(h,'NAXIS2')+headerCount(h,'PCOUNT');
      else if(naxis>0){
        const bitpix=h.BITPIX===undefined||h.BITPIX===''?8:h.BITPIX;
        if(![8,16,32,64,-32,-64].includes(bitpix))throw Error('Invalid FITS header value BITPIX = '+String(bitpix).slice(0,40));
        size=Math.abs(bitpix)/8;for(let i=1;i<=naxis;i++)size*=headerCount(h,'NAXIS'+i);size+=headerCount(h,'PCOUNT');}
      // The data unit must be a whole number of bytes that really exists in the file.
      if(!Number.isSafeInteger(size)||size<0||dataStart+size>bytes.length)throw Error('Invalid or truncated FITS data unit');
      if(xtension==='BINTABLE')tables.push({h,bytes,view:new DataView(buffer),offset:dataStart,size});
      cursor=dataStart+Math.ceil(size/2880)*2880;
      if(cursor<=dataStart && size>0)throw Error('Dimension FITS non valida');
      if(cursor>=bytes.length)break;
    }
    return tables;
  }
  function columns(table){
    let pos=0;const cols={};const h=table.h;
    const sizes={L:1,B:1,A:1,I:2,J:4,K:8,E:4,D:8};
    const fields=headerCount(h,'TFIELDS',999); // FITS standard: at most 999 table columns
    for(let i=1;i<=fields;i++){
      const name=String(h['TTYPE'+i]||'').toUpperCase().trim(), form=String(h['TFORM'+i]||'').trim().toUpperCase();
      const match=form.match(/^(\d*)([LBAIJKED])$/);if(!match)throw Error('Unsupported FITS TFORM: '+form);
      const count=Number(match[1]||1),type=match[2];cols[name]={offset:pos,type,count};pos+=count*sizes[type];
    }
    if(pos>Number(h.NAXIS1))throw Error('Dimension righe FITS non valida');
    return cols;
  }
  function columnNumber(t,col,row){
    const pos=t.offset+row*Number(t.h.NAXIS1)+col.offset, v=t.view;
    switch(col.type){case 'K':{const b=v.getBigInt64(pos,false);if(b>BigInt(Number.MAX_SAFE_INTEGER)||b<0n)throw Error('FITS UNIQ exceeds JavaScript integer precision');return Number(b);}
    case 'J':return v.getInt32(pos,false)>>>0;case 'I':return v.getInt16(pos,false);case 'B':return v.getUint8(pos);case 'D':return v.getFloat64(pos,false);case 'E':return v.getFloat32(pos,false);
    default:throw Error('Unsupported numeric column');}
  }
  function decodeMoc(buffer){
    for(const t of fitsTables(buffer)){const cols=columns(t),col=cols.UNIQ||cols.NUNIQ;
      if(!col||cols.PROBDENSITY)continue;
      const obj={};const n=Number(t.h.NAXIS2||0);
      for(let i=0;i<n;i++){const {order,pixel}=uniqDecode(columnNumber(t,col,i));(obj[order]??=[]).push(pixel);}
      return obj;
    }throw Error('This FITS does not contain a NUNIQ MOC');
  }
  function decodePosterior(buffer){
    for(const t of fitsTables(buffer)){const cols=columns(t),uc=cols.UNIQ||cols.NUNIQ,dc=cols.PROBDENSITY,pc=cols.PROB;
      if(!uc||(!dc&&!pc))continue;
      const n=Number(t.h.NAXIS2||0);let total=0;
      if(n>2500000)throw Error('Skymap too large for this browser test (>2.5 million cells)');
      const result=new Array(n); // allocated only after the row limit has been checked
      for(let i=0;i<n;i++){
        const {order,pixel}=uniqDecode(columnNumber(t,uc,i)),areaSr=4*Math.PI/(12*Math.pow(4,order));
        const density=dc?columnNumber(t,dc,i):null,p=dc?density*areaSr:columnNumber(t,pc,i);
        if(!Number.isFinite(p)||p<0)throw Error('Invalid PROBDENSITY/PROB at row '+i);
        const coord=pixelCenter(order,pixel);
        result[i]={...coord,order,pixel,p,
          distmu:cols.DISTMU?columnNumber(t,cols.DISTMU,i):null,
          distsigma:cols.DISTSIGMA?columnNumber(t,cols.DISTSIGMA,i):null,
          distnorm:cols.DISTNORM?columnNumber(t,cols.DISTNORM,i):null};total+=p;
      }
      if(!(total>0))throw Error('Posterior has no positive probability');
      for(const cell of result)cell.p/=total;
      return {cells:result,tableRows:n,originalSum:total,format:dc?'PROBDENSITY':'PROB',distmean:Number.isFinite(Number(t.h.DISTMEAN))?Number(t.h.DISTMEAN):null,diststd:Number.isFinite(Number(t.h.DISTSTD))?Number(t.h.DISTSTD):null};
    }
    throw Error('Load a full BAYESTAR FITS with NUNIQ + PROBDENSITY (or PROB); a 50/90% MOC has no probability values');
  }
  function mocProbability(map,json) {
    if(!map||!json)return null;
    let order=maxOrder(json);
    for(const cell of map.cells)if(cell.order>order)order=cell.order;
    if(order>17)throw Error('Order too high for overlap calculations in JavaScript');
    const ranges=jsonToRanges(json,order), scaleOrder=order;
    let p=0;
    for(const c of map.cells){const width=Math.pow(4,scaleOrder-c.order),start=c.pixel*width;const fraction=rangeOverlap(ranges,start,start+width)/width;p+=c.p*fraction;}
    return p;
  }


  // Convert ICRS coordinate to HEALPix NESTED pixel (standard equatorial/polar-face algorithm).
  function ang2pixNest(order,ra,dec){
    if(!Number.isInteger(order)||order<0||order>17)throw Error('Position lookup order must be 0..17');
    if(!Number.isFinite(ra)||!Number.isFinite(dec)||Math.abs(dec)>90)throw Error('Invalid RA/Dec');
    const nside=Math.pow(2,order),z=Math.sin(dec*RAD),za=Math.abs(z);
    let tt=((ra%360)+360)%360/90;
    if(tt>=4)tt=0;
    let face,ix,iy;
    if(za<=2/3){
      const jp=Math.floor(nside*(0.5+tt-0.75*z));
      const jm=Math.floor(nside*(0.5+tt+0.75*z));
      const ifp=Math.floor(jp/nside),ifm=Math.floor(jm/nside);
      if(ifp===ifm)face=(ifp&3)+4;
      else if(ifp<ifm)face=ifp&3;
      else face=(ifm&3)+8;
      ix=jm%nside;iy=nside-(jp%nside)-1;
    }else{
      const ntt=Math.min(3,Math.floor(tt)),tp=tt-ntt;
      const tmp=nside*Math.sqrt(3*(1-za));
      const jp=Math.min(nside-1,Math.floor(tp*tmp)),jm=Math.min(nside-1,Math.floor((1-tp)*tmp));
      if(z>=0){face=ntt;ix=nside-jm-1;iy=nside-jp-1;}
      else{face=ntt+8;ix=jp;iy=jm;}
    }
    let pixel=face*nside*nside;
    for(let i=0;i<order;i++)pixel+=(Math.floor(ix/Math.pow(2,i))%2+2*(Math.floor(iy/Math.pow(2,i))%2))*Math.pow(4,i);
    return pixel;
  }
  // Adaptive HEALPix NESTED integration of probability into an observing FoV.
  // Subdivides only boundary cells to targetOrder (12 by default); each child
  // inherits one quarter of its parent posterior-cell probability.  Whole
  // internal/external cells are integrated without enumerating 4^14 pixels.
  // Result is a controlled area-fraction approximation, NOT an exact spherical
  // polygon intersection and NOT a 3D Singer volume probability.
  function integratePosteriorFoV(map, fov, previous=[], targetOrder=12) {
    if(!map?.cells)throw Error('A BAYESTAR probability map is required');
    if(!Number.isInteger(targetOrder)||targetOrder<7||targetOrder>15)throw Error('Probability integration order must be 7–15');
    configValid(fov);
    previous.forEach(configValid);
    const configs=[fov,...previous];
    const geometry=configs.map(c=>({
      c,vector:vec(c.ra,c.dec),
      // Deliberately conservative spherical cap prefilter; no false negative
      // even near the maximum allowed FoV geometry (40 deg dimensions).
      cap:c.shape==='circle' ? Math.tan(c.radius*RAD)*DEG*1.5+1 :
        Math.hypot(c.width/2,c.height/2)*1.5+1
    }));
    function classify(pt,order,g){
      const v=vec(pt.ra,pt.dec),dot=clamp(v[0]*g.vector[0]+v[1]*g.vector[1]+v[2]*g.vector[2],-1,1);
      const separation=Math.acos(dot)*DEG;
      // 90 deg/nside bounds the angular radius of a HEALPix nested cell;
      // 5x radius is an intentionally conservative margin for the tangent
      // projection of a bounded FoV. Keep coarse cells undecided.
      const radius=90/Math.pow(2,order);
      if(separation>g.cap+radius)return -1;
      if(radius>3||separation+radius>75)return 0;
      const p=tangent(pt,g.c);if(!p)return -1;
      const pa=g.c.pa*RAD,x=p.x*Math.cos(pa)+p.y*Math.sin(pa),y=-p.x*Math.sin(pa)+p.y*Math.cos(pa);
      const margin=5*radius,c=g.c;
      if(c.shape==='circle'){
        const rr=Math.tan(c.radius*RAD)*DEG,d=Math.hypot(x,y);
        return d<rr-margin?1:d>rr+margin?-1:0;
      }
      const a=c.width/2,b=c.height/2;
      if(c.shape==='rectangle'){
        return Math.abs(x)<a-margin&&Math.abs(y)<b-margin?1:
          (Math.abs(x)>a+margin||Math.abs(y)>b+margin?-1:0);
      }
      if((x/(a+margin))**2+(y/(b+margin))**2>1)return -1;
      if(a>margin&&b>margin&&(x/(a-margin))**2+(y/(b-margin))**2<1)return 1;
      return 0;
    }
    let pFoV=0,pNew=0,pCum=0,nodes=0;
    function traverse(order,pixel,weight){
      nodes++;
      const pt=pixelCenter(order,pixel);
      const statuses=geometry.map(g=>classify(pt,order,g));
      let cur=statuses[0];
      let old=statuses.slice(1).some(v=>v===1)?1:statuses.slice(1).every(v=>v===-1)?-1:0;
      if(order>=targetOrder){
        if(cur===0)cur=inside(pt,fov)?1:-1;
        if(old===0)old=previous.some(c=>inside(pt,c))?1:-1;
      }
      if(cur!==0&&old!==0){
        if(cur===1){pFoV+=weight;if(old===-1)pNew+=weight;}
        if(cur===1||old===1)pCum+=weight;
        return;
      }
      for(let j=0;j<4;j++)traverse(order+1,pixel*4+j,weight/4);
    }
    for(const cell of map.cells){
      if(!(cell.p>0))continue;
      // Higher-order native map cells are already finer than the requested
      // integration order; never degrade them by subdividing their ancestors.
      traverse(cell.order,cell.pixel,cell.p);
    }
    return {pFoV,pNew,pCum,probOrder:targetOrder,nodes};
  }
  function mocContains(json,ra,dec){
    if(!json||!Object.keys(json).length)return null;
    const order=maxOrder(json);if(order>17)throw Error('MOC order above 17 is unsupported in local position checker');
    let cached=containsCache.get(json);
    if(!cached||cached.order!==order){cached={order,ranges:jsonToRanges(json,order)};containsCache.set(json,cached);}
    const pixel=ang2pixNest(order,ra,dec);
    return rangeOverlap(cached.ranges,pixel,pixel+1)>0;
  }
  function posteriorCellAt(map,ra,dec){
    if(!map?.cells?.length)return null;
    if(!map._index){
      const byOrder=new Map();let highest=0;
      for(const c of map.cells){if(c.order>17)continue;
        let arr=byOrder.get(c.order);if(!arr){arr=new Map();byOrder.set(c.order,arr);}
        arr.set(c.pixel,c);highest=Math.max(highest,c.order);
      }
      map._index={byOrder,highest};
    }
    for(let order=map._index.highest;order>=0;order--){const arr=map._index.byOrder.get(order);if(!arr)continue;
      const c=arr.get(ang2pixNest(order,ra,dec));if(c)return c;
    }
    return null;
  }
  function distanceDiagnostics(cell, distance){
    if(!cell||![cell.distmu,cell.distsigma,cell.distnorm].every(Number.isFinite)||cell.distsigma<=0||cell.distnorm<=0)return null;
    // Singer et al. conditional per-direction distance posterior:
    // p(r|n) = DISTNORM * r² * Normal(r; DISTMU, DISTSIGMA), r >= 0.
    // We integrate numerically with a finite grid for this lightweight lab; unlike
    // full GWsky 3D volume analysis, this does not determine Singer V90 membership.
    const mu=cell.distmu,sigma=cell.distsigma,norm=cell.distnorm;
    const rmax=Math.max(50,mu+9*sigma,9*sigma),n=1200,step=rmax/n;
    function pdf(r){const t=(r-mu)/sigma;return norm*r*r*Math.exp(-0.5*t*t)/(Math.sqrt(2*Math.PI)*sigma);}
    let sum=0,weighted=0;const cs=[0];
    for(let i=0;i<n;i++){const rr=(i+0.5)*step,p=pdf(rr)*step;sum+=p;weighted+=rr*p;cs.push(sum);}
    if(!(sum>0))return null;
    function quantile(q){const target=sum*q;for(let i=1;i<cs.length;i++)if(cs[i]>=target)return (i-0.5)*step;return rmax;}
    const pAt=Number.isFinite(distance)&&distance>0?pdf(distance):null;
    const cdfAt=Number.isFinite(distance)&&distance>=0?cs[Math.max(0,Math.min(n,Math.floor(distance/step)))]/sum:null;
    return {mean:weighted/sum,median:quantile(0.5),lo:quantile(0.05),hi:quantile(0.95),pAt,cdfAt,mu,sigma,norm};
  }
  global.CoverageMath={RAD,DEG,SKY,uniqDecode,jsonToRanges,maxOrder,areaDeg2,intersectArea,rangeOverlap,pixelCenter,vec,offset,tangent,inside,polygon,nextCenter,sampleMoc,decodeMoc,decodePosterior,mocProbability,configValid,ang2pixNest,mocContains,posteriorCellAt,distanceDiagnostics,integratePosteriorFoV};
})(window);
