/* GRAWITA dry-run — local transient coordinates, MOC membership, 3D distance,
 * field-scoped SkyBoT query. Uses Aladin Lite APIs only (source popups reuse
 * Aladin's own popup object, filled with escaped text), no tracking.
 * MOC membership is 2D; conditional and marginalized distances use full FITS.
 */
(()=>{
'use strict';
const $=id=>document.getElementById(id),M=window.CoverageMath;
let A=null,aladin=null,posterior=window.GRAWITA_CURRENT_POSTERIOR||null,sourceLayer=null,objects=[],chosen=null,coverageMoc=null,selectedFov=null;
const mocs={...window.TEST_MOC_DATA};
const botCache=new Map();let botLayer=null,botActive=null,botRequest=0,botBusy=false,starRequest=0,starLayer=null;
const fmt=(n,d=3)=>Number.isFinite(n)?Number(n).toFixed(d):'—';
const status=s=>{$('tr-info').textContent=s;};
// Aladin Lite's built-in onClick:'showPopup' concatenates every source value into
// popup.innerHTML without escaping. Transient IDs are pasted/imported text and
// SkyBoT names come from a remote service, so both catalogs render their popup
// here from HTML-escaped text only. The source data themselves stay unmodified
// (native canvas labels, tables and exports keep the original characters).
const HTML_ESCAPES={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const escapeHtml=value=>String(value).replace(/[&<>"']/g,ch=>HTML_ESCAPES[ch]);
function popupMarkup(data){
  // Same structure, class and row order as Aladin's own source popup.
  let rows='';
  for(const key in data)rows+='<tr><td>'+escapeHtml(key)+'</td><td>'+escapeHtml(data[key])+'</td></tr>';
  return '<div class="aladin-marker-measurement"><table>'+rows+'</table></div>';
}
function showSourcePopup(source){
  if(!aladin||!source)return;
  const title='<br><br>',markup=popupMarkup(source.data||{});
  try{
    const popup=aladin.popup;
    if(popup&&['setTitle','setText','setSource','show'].every(name=>typeof popup[name]==='function')){
      // Identical call sequence to Aladin's built-in 'showPopup' action.
      popup.setTitle(title);popup.setText(markup);popup.setSource(source);popup.show();
    }else if(typeof aladin.showPopup==='function'){
      aladin.showPopup(source.ra,source.dec,title,markup); // documented public fallback
    }else console.warn('Aladin popup API unavailable: source details not shown.');
  }catch(error){console.warn('Source popup:',error);}
}
const nameFor=f=>f?.origin || (f?.id?`FoV ${String((window.CoverageLab?.state.pointings||[]).findIndex(x=>x.id===f.id)+1).padStart(2,'0')}`:'No accepted FoV selected');
const geometryKey=f=>f?JSON.stringify([f.id,f.ra,f.dec,f.shape,f.width,f.height,f.radius,f.pa]):'';
const timeKey=()=>String($('tr-epoch').value||'')+'Z|'+String($('tr-observer').value||'500').trim();
const botKey=f=>geometryKey(f)+'|'+timeKey();
const localBotData=()=>botCache.get(botKey(selectedFov));
function splitCSV(line,delimiter){
  const out=[];let t='',quoted=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){t+='"';i++;}else quoted=!quoted;}
    else if(c===delimiter&&!quoted){out.push(t.trim());t='';}else t+=c;
  }out.push(t.trim());return out;
}
function parseDelimited(txt){
  const lines=String(txt).replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'));
  if(!lines.length)throw Error('No coordinates supplied. Paste ID, RA, Dec (decimal degrees).');
  const delimiter=lines[0].includes('\t')?'\t':lines[0].includes(';')?';':lines[0].includes(',')?',':null;
  const split=line=>delimiter?splitCSV(line,delimiter):line.trim().split(/\s+/);
  const head=split(lines[0]).map(x=>x.toLowerCase().replace(/[^a-z0-9]/g,''));
  const col=names=>head.findIndex(x=>names.includes(x));
  let ir=col(['ra','radeg','raj2000','raicrs','raj']),id=col(['dec','decdeg','dej2000','deicrs','dej']);
  const header=ir>=0&&id>=0,first=header?1:0;
  const iname=col(['id','name','object','transient','designation','sn']),iz=col(['z','redshift']);
  const ird=col(['distancempc','distmpc','distance','dlmpc','luminositydistancempc']);
  if(!header){ir=1;id=2;}
  const out=[];let skipped=0;
  for(let i=first;i<lines.length&&out.length<10000;i++){
    const fields=split(lines[i]);if(fields.length<3){skipped++;continue;}
    const ra=Number(fields[ir]),dec=Number(fields[id]);
    if(!Number.isFinite(ra)||!Number.isFinite(dec)||ra<0||ra>=360||dec<-90||dec>90){skipped++;continue;}
    const n=header?iname>=0&&fields[iname]?fields[iname]:`Object ${i-first+1}`:fields[0];
    const rawDistance=ird>=0?fields[ird]:!header&&fields.length>=4?fields[3]:'',rawZ=iz>=0?fields[iz]:'';
    const dist=rawDistance!==''&&rawDistance!=null?Number(rawDistance):null;
    const z=rawZ!==''&&rawZ!=null?Number(rawZ):null;
    out.push({name:String(n||`Object ${i-first+1}`),ra,dec,distance:Number.isFinite(dist)&&dist>0?dist:null,redshift:Number.isFinite(z)&&z>=0?z:null});
  }
  if(!out.length)throw Error('No valid RA/Dec pairs found (decimal degrees required).');
  return {items:out,skipped};
}
function selectedMoc(){const key=$('tr-moc').value;return {key,json:key==='coverage'?coverageMoc:mocs[key]||null};}
function inMoc(o){const {json}=selectedMoc();return json?M.mocContains(json,o.ra,o.dec):null;}
function safeRemove(layer){if(!layer||!aladin)return;try{if(typeof aladin.removeCatalog==='function')aladin.removeCatalog(layer);else aladin.removeOverlay?.(layer);}catch(_){try{aladin.removeOverlay?.(layer);}catch(e){console.warn('Catalog cleanup:',e);}}}
function ensureCatalog(){
  if(!A||!aladin)return;
  safeRemove(sourceLayer);
  // Aladin Lite v3 native source labels use the ID pasted by the user.
  // No external name-resolution service or guessed designation is involved.
  sourceLayer=A.catalog({name:'Local transients',color:'#f8e190',sourceSize:9,
    displayLabel:true,labelColumn:'Name',labelColor:'#f8e190',labelFont:'11px sans-serif',
    onClick:showSourcePopup});
  sourceLayer.addSources(objects.slice(0,2500).map((o,i)=>A.source(o.ra,o.dec,{Name:o.name,ID:i,RA:o.ra,Dec:o.dec,Distance_Mpc:o.distance??'unknown'})));
  aladin.addCatalog(sourceLayer);
}
function setObjects(items,source){objects=items;chosen=null;ensureCatalog();refresh();status(`${items.length} transient positions loaded from ${source}. Select an object for 2D membership and 3D distance.`);}
function refresh(){
  const tbody=$('tr-rows'),frag=document.createDocumentFragment();let count=0;
  for(const [i,o] of objects.entries()){
    const inside=inMoc(o);if(inside)count++;
    const tr=document.createElement('tr');tr.dataset.objectId=String(i);if(chosen===i)tr.className='selected';tr.tabIndex=0;
    for(const v of [o.name,fmt(o.ra,4),fmt(o.dec,4),o.distance==null?'—':fmt(o.distance,1)+' Mpc',inside==null?'MOC unavailable':inside?'INSIDE':'OUTSIDE']){
      const td=document.createElement('td');td.textContent=v;tr.append(td);
    }
    tr.addEventListener('click',()=>selectObject(i));tr.addEventListener('keydown',e=>{if(e.key==='Enter'){selectObject(i);}});frag.append(tr);
  }
  if(!objects.length){const row=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='Paste ID, RA, Dec (degrees), or import a local CSV.';row.append(td);frag.append(row);}
  tbody.replaceChildren(frag);
  $('tr-count').textContent=objects.length+' objects';
  $('tr-in').textContent=selectedMoc().json?`${count} inside · ${objects.length-count} outside`:'MOC not loaded';
  $('tr-export').disabled=!objects.length;
  if(chosen!==null&&objects[chosen])details(chosen);
}
function scalarPDF(cell,r){
  const mu=cell?.distmu,sigma=cell?.distsigma,norm=cell?.distnorm;
  if(!Number.isFinite(mu)||!Number.isFinite(sigma)||sigma<=0||!Number.isFinite(norm)||norm<=0||r<0)return 0;
  const z=(r-mu)/sigma;
  return norm*r*r*Math.exp(-.5*z*z)/(Math.sqrt(2*Math.PI)*sigma);
}
const validDistance=c=>Number.isFinite(c?.distmu)&&Number.isFinite(c?.distsigma)&&c.distsigma>0&&Number.isFinite(c?.distnorm)&&c.distnorm>0;
function distanceCurves(obj){
  if(!posterior?.cells?.length)return null;
  const here=M.posteriorCellAt(posterior,obj.ra,obj.dec);if(!validDistance(here))return null;
  let sample=posterior._distanceSampleCache;
  if(!sample){
    const valid=posterior.cells.filter(c=>c.p>0&&validDistance(c));if(!valid.length)return null;
    const totalP=valid.reduce((sum,c)=>sum+c.p,0);
    // Cache expensive stratified sampling for repeated transient clicks. Memory
    // stays bounded to 4,000 cells even when the FITS has millions of rows.
    const limit=4000;let weighted=[];
    if(valid.length<=limit)weighted=valid.map(c=>[c,c.p/totalP]);
    else{
      const target=totalP/limit;let k=0,cum=valid[0].p;
      for(let i=0;i<limit;i++){
        const mark=(i+.5)*target;
        while(mark>cum&&k<valid.length-1){k++;cum+=valid[k].p;}
        weighted.push([valid[k],1/limit]);
      }
    }
    const extent=weighted.map(([c,w])=>[Math.max(0,c.distmu+6*c.distsigma),w]).sort((a,b)=>a[0]-b[0]);
    let weight=0,marginalMax=0;
    for(const [limitValue,w] of extent){weight+=w;if(weight>=.998){marginalMax=limitValue;break;}}
    sample={weighted,total:valid.length,marginalMax};
    posterior._distanceSampleCache=sample;
  }
  const {weighted}=sample;
  let rmax=sample.marginalMax;
  rmax=Math.max(50,here.distmu+7*here.distsigma,rmax,obj.distance||0);
  rmax=Math.min(rmax,12000);
  const n=200,xs=Array.from({length:n+1},(_,i)=>rmax*i/n);
  const marginal=new Float64Array(n+1),conditional=new Float64Array(n+1);
  for(let i=0;i<=n;i++){
    const r=xs[i];conditional[i]=scalarPDF(here,r);
    let sum=0;for(const [c,w] of weighted)sum+=w*scalarPDF(c,r);
    marginal[i]=sum;
  }
  const normalize=y=>{let sum=0;for(let i=1;i<y.length;i++)sum+=(y[i]+y[i-1])*.5*(xs[i]-xs[i-1]);if(sum>0)for(let i=0;i<y.length;i++)y[i]/=sum;};
  normalize(marginal);normalize(conditional);
  return {xs,conditional,marginal,approx:sample.total>weighted.length,sampled:weighted.length,total:sample.total};
}
function plotDistance(parent,obj){
  const curves=distanceCurves(obj);if(!curves){const p=document.createElement('p');p.textContent='A 3D BAYESTAR FITS with valid DISTMU, DISTSIGMA and DISTNORM is needed for both distance curves.';parent.append(p);return;}
  const {xs,conditional,marginal}=curves,svgNS='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(svgNS,'svg');svg.setAttribute('viewBox','0 0 520 232');svg.setAttribute('role','img');svg.setAttribute('aria-label','GW luminosity distance distributions, interactive zoom and horizontal pan');
  svg.classList.add('tr-distance-plot');svg.style.touchAction='none';
  const W=520,H=232,L=49,R=12,T=14,B=35,fullMax=xs.at(-1),plotWidth=W-L-R;
  const mean=values=>{let total=0,moment=0;for(let i=1;i<xs.length;i++){const dx=xs[i]-xs[i-1],a=values[i-1],b=values[i];total+=(a+b)*dx/2;moment+=(xs[i-1]*a+xs[i]*b)*dx/2;}return total>0?moment/total:null;};
  const globalMean=mean(marginal),losMean=mean(conditional),catalogDist=Number.isFinite(obj.distance)&&obj.distance>=0?obj.distance:null;
  let lo=0,hi=fullMax;
  const toolbar=document.createElement('div');toolbar.className='tr-distance-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','Distance graph navigation');
  const viewport=document.createElement('span');viewport.className='tr-distance-viewport';viewport.setAttribute('aria-live','polite');
  function clamp(left,width){const w=Math.min(fullMax,Math.max(fullMax/200,width));return [Math.max(0,Math.min(fullMax-w,left)),w];}
  function setView(left,width){const [l,w]=clamp(left,width);lo=l;hi=l+w;render();}
  const center=(value)=>{if(Number.isFinite(value))setView(value-(hi-lo)/2,hi-lo);};
  const zoom=(factor,at=(lo+hi)/2)=>{const width=(hi-lo)*factor;setView(at-(at-lo)*factor,width);};
  const pan=direction=>setView(lo+direction*(hi-lo)*.2,hi-lo);
  function btn(label,action,title){const b=document.createElement('button');b.type='button';b.textContent=label;b.title=title||label;b.addEventListener('click',action);toolbar.append(b);return b;}
  btn('Fit',()=>setView(0,fullMax),'Show the complete plotted distance interval');
  btn('−',()=>zoom(1.5),'Zoom out');btn('+',()=>zoom(1/1.5),'Zoom in');
  btn('←',()=>pan(-1),'Pan toward shorter distances');btn('→',()=>pan(1),'Pan toward greater distances');
  btn('Global',()=>center(globalMean),'Center at sky-marginalized mean distance');
  btn('LOS',()=>center(losMean),'Center at mean distance along this line of sight');
  const catalogButton=btn('Object',()=>center(catalogDist),'Center at supplied catalog distance');catalogButton.disabled=catalogDist===null;
  toolbar.append(viewport);
  const add=(tag,attrs,text)=>{const el=document.createElementNS(svgNS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));if(text!=null)el.textContent=text;svg.append(el);return el;};
  const interp=(values,r)=>{const t=r/fullMax*(xs.length-1),i=Math.max(0,Math.min(values.length-2,Math.floor(t)));return values[i]+(values[i+1]-values[i])*(t-i);};
  function render(){
    svg.replaceChildren();viewport.textContent=`${lo.toFixed(1)}–${hi.toFixed(1)} Mpc`;
    const x=r=>L+(r-lo)/(hi-lo)*plotWidth;
    const visible=[0,1,2,3,4,5,6,7,8,9,10].flatMap(j=>{const r=lo+(hi-lo)*j/10;return [interp(marginal,r),interp(conditional,r)];});
    const ymax=1.1*Math.max(.000001,...visible);
    const y=v=>H-B-v/ymax*(H-T-B);
    for(let j=0;j<=4;j++){const yy=T+(H-T-B)*j/4;add('line',{x1:L,y1:yy,x2:W-R,y2:yy,stroke:'#32465e','stroke-width':.8});}
    add('line',{x1:L,y1:H-B,x2:W-R,y2:H-B,stroke:'#95b2c7'});
    for(let j=0;j<=4;j++){const value=lo+(hi-lo)*j/4;add('text',{x:x(value),y:H-12,fill:'#b7cbdb','font-size':10,'text-anchor':'middle'},value.toFixed(hi-lo<40?1:0));}
    add('text',{x:W/2,y:H-1,fill:'#d6e6f5','font-size':11,'text-anchor':'middle'},'Luminosity distance (Mpc)');
    add('text',{x:5,y:13,fill:'#b9cedd','font-size':10},'PDF (Mpc⁻¹)');
    const series=(values,color)=>{
      const steps=200,coords=Array.from({length:steps+1},(_,i)=>{const r=lo+(hi-lo)*i/steps;return (i?'L':'M')+x(r).toFixed(2)+' '+y(interp(values,r)).toFixed(2);});
      add('path',{d:coords.join(' '),fill:'none',stroke:color,'stroke-width':2.3,'stroke-linejoin':'round'});
    };
    series(marginal,'#57decc');series(conditional,'#ffc178');
    if(catalogDist!==null&&catalogDist>=lo&&catalogDist<=hi){
      add('line',{x1:x(catalogDist),y1:T,x2:x(catalogDist),y2:H-B,stroke:'#fff','stroke-dasharray':'4 3'});
      add('circle',{cx:x(catalogDist),cy:y(interp(conditional,catalogDist)),r:4,fill:'#ffc178',stroke:'#fff','stroke-width':1.2});
    }
    // Fully transparent pointer capture target, drawn after the curves.
    add('rect',{x:L,y:T,width:plotWidth,height:H-T-B,fill:'transparent','data-distance-hit':'true'});
  }
  let drag=null;
  svg.addEventListener('pointerdown',e=>{if(!e.target.hasAttribute('data-distance-hit'))return;drag={clientX:e.clientX,left:lo,width:hi-lo};svg.setPointerCapture(e.pointerId);});
  svg.addEventListener('pointermove',e=>{if(!drag)return;const rect=svg.getBoundingClientRect(),scale=W/rect.width;setView(drag.left-(e.clientX-drag.clientX)*scale/plotWidth*drag.width,drag.width);});
  const finish=()=>{drag=null;};svg.addEventListener('pointerup',finish);svg.addEventListener('pointercancel',finish);svg.addEventListener('lostpointercapture',finish);
  svg.addEventListener('wheel',e=>{if(!e.target.hasAttribute('data-distance-hit'))return;e.preventDefault();const rect=svg.getBoundingClientRect(),pos=(e.clientX-rect.left)/rect.width*W,at=lo+Math.max(0,Math.min(1,(pos-L)/plotWidth))*(hi-lo);zoom(e.deltaY<0?1/1.2:1.2,at);},{passive:false});
  render();
  // The legend uses the exact stroke/marker colors of the graph. Keep the
  // scientific arrays unchanged; this is presentation only.
  const legend=document.createElement('div');legend.className='tr-plot-legend';legend.setAttribute('aria-label','Distance plot legend');
  const addLegendItem=(label,color,kind)=>{
    const entry=document.createElement('span');entry.className='tr-legend-item';entry.style.color=color;
    const swatch=document.createElementNS(svgNS,'svg');swatch.setAttribute('viewBox','0 0 34 16');swatch.setAttribute('aria-hidden','true');
    swatch.classList.add('tr-legend-swatch');
    const line=document.createElementNS(svgNS,'line');
    for(const [key,value] of Object.entries({x1:2,y1:8,x2:32,y2:8,stroke:kind==='distance'?'#fff':color,'stroke-width':2.5}))line.setAttribute(key,String(value));
    if(kind==='distance')line.setAttribute('stroke-dasharray','4 3');
    swatch.append(line);
    if(kind==='distance'){
      const marker=document.createElementNS(svgNS,'circle');
      for(const [key,value] of Object.entries({cx:17,cy:8,r:4,fill:'#ffc178',stroke:'#fff','stroke-width':1}))marker.setAttribute(key,String(value));
      swatch.append(marker);
    }
    const caption=document.createElement('span');caption.textContent=label;
    entry.append(swatch,caption);legend.append(entry);
  };
  addLegendItem('All-sky marginal','#57decc','sky');
  addLegendItem('At transient position','#ffc178','los');
  if(catalogDist!==null)addLegendItem('Catalog distance · intersection','#fff','distance');
  parent.append(toolbar,svg,legend);
}
function details(index){
  const obj=objects[index],inside=inMoc(obj),cell=posterior?M.posteriorCellAt(posterior,obj.ra,obj.dec):null;
  const dist=M.distanceDiagnostics(cell,obj.distance),parent=$('tr-detail');parent.replaceChildren();
  const h=document.createElement('h4');h.textContent=obj.name;parent.append(h);
  const para=(a,b)=>{const p=document.createElement('p');const str=document.createElement('strong');str.textContent=a+' ';p.append(str,document.createTextNode(b));parent.append(p);};
  para('ICRS (degrees):',`RA ${fmt(obj.ra,6)}°, Dec ${fmt(obj.dec,6)}°`);
  para('MOC:',`${inside==null?'Unavailable':inside?'INSIDE':'OUTSIDE'} · ${$('tr-moc').selectedOptions[0].text}`);
  para('Catalog distance:',obj.distance==null?'Not supplied':fmt(obj.distance,2)+' Mpc');
  if(Number.isFinite(posterior?.distmean))para('FITS all-sky DISTMEAN:',fmt(posterior.distmean,3)+' Mpc'+(Number.isFinite(posterior.diststd)?` · DISTSTD ${fmt(posterior.diststd,3)} Mpc`:''));
  if(dist)para('GW direction:',`mean ${fmt(dist.mean,1)} Mpc; median ${fmt(dist.median,1)} Mpc; 90% interval ${fmt(dist.lo,1)}–${fmt(dist.hi,1)} Mpc`);
  plotDistance(parent,obj);
}
function selectObject(i){chosen=i;refresh();const o=objects[i];if(aladin&&o){try{aladin.gotoRaDec(o.ra,o.dec);aladin.setFoV(1.5);}catch(e){console.warn('Aladin navigation:',e);}}}
function exportResults(){
 const rows=['id,ra_deg,dec_deg,distance_mpc,moc,inside_moc,gw_los_mean_mpc'];
 for(const o of objects){const cell=posterior?M.posteriorCellAt(posterior,o.ra,o.dec):null,dist=M.distanceDiagnostics(cell,o.distance),membership=inMoc(o);
   // Spreadsheet formula injection: keep the source value unchanged in the app,
   // but force hazardous CSV cells to text on export.
   const quote=x=>{const original=String(x??'');
     const safe=/^[\s\u0000-\u001f]*[=+\-@]/.test(original)?"'"+original:original;
     return '"'+safe.replaceAll('"','""')+'"';};
   rows.push([quote(o.name),o.ra,o.dec,o.distance??'',selectedMoc().key,membership==null?'':membership,dist?.mean??''].join(','));}
 const url=URL.createObjectURL(new Blob([rows.join('\n')+'\n'],{type:'text/csv'})),a=document.createElement('a');a.href=url;a.download='transient_moc_membership.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function currentFov(){return selectedFov&&window.CoverageLab?.state.pointings.some(p=>p.id===selectedFov.id)?selectedFov:null;}
function queryRadius(f){return f.shape==='circle'?f.radius:Math.hypot(f.width,f.height)*.5*1.01;}
function hideSkybotLayer(){if(botLayer){safeRemove(botLayer);botLayer=null;}botActive=null;}
function updateSkyBotPanel(){
 const f=currentFov(),key=f?botKey(f):null,cached=key?botCache.get(key):null;
 $('tr-fov-name').textContent=f?`${nameFor(f)} · RA ${fmt(f.ra,5)}°, Dec ${fmt(f.dec,5)}° · ${f.shape}`:'Select an accepted FoV in the observation sequence';
 $('tr-skybot').disabled=!f||!A||!aladin||botBusy;
 $('tr-bright').disabled=!f||!A||!aladin;
 $('tr-bot-clear').disabled=!cached;
 const body=$('tr-bot-rows');body.replaceChildren();
 if(!f){$('tr-bot-status').textContent='SkyBoT is scoped to one accepted FoV. Select a sequence row first.';hideSkybotLayer();return;}
 if(!cached){$('tr-bot-status').textContent='No SkyBoT query for this FoV and observing epoch. Press Query.';hideSkybotLayer();return;}
 $('tr-bot-status').textContent=`${cached.objects.length} moving objects in ${nameFor(f)} · UTC ${cached.epoch} · observer ${cached.observer}.`;
 for(const [i,o] of cached.objects.entries()){
   const row=document.createElement('tr');row.tabIndex=0;
   for(const v of [o.name,fmt(o.ra,5),fmt(o.dec,5),o.mag==null?'—':fmt(o.mag,1)]){const td=document.createElement('td');td.textContent=v;row.append(td);}
   row.addEventListener('click',()=>{try{aladin?.gotoRaDec(o.ra,o.dec);aladin?.setFoV(Math.max(1,queryRadius(f)*2));}catch(_){}});body.append(row);
 }
 if(botActive!==key){hideSkybotLayer();if(cached.objects.length&&A&&aladin){
   const layer=A.catalog({name:`SkyBoT · ${nameFor(f)}`,color:'#fd76ce',sourceSize:8,onClick:showSourcePopup});
   layer.addSources(cached.objects.map(o=>A.source(o.ra,o.dec,{Name:o.name,VMag:o.mag??'—',FoV:nameFor(f),UTC:cached.epoch})));
   aladin.addCatalog(layer);botLayer=layer;botActive=key;
 }}
}
function querySkybot(){
 const f=currentFov();if(!A||!aladin||!f){status('Select an accepted FoV before querying SkyBoT.');return;}
 if(typeof A.catalogFromURL!=='function'&&typeof A.catalogFromSkyBot!=='function'){status('This Aladin release has no supported SkyBoT catalog interface.');return;}
 const value=$('tr-epoch').value,observer=String($('tr-observer').value||'500').trim();
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)){status('Enter a UTC date/time for this FoV.');return;}
 if(!/^[A-Za-z0-9]{1,8}$/.test(observer)){status('Use a valid observatory/MPC code (for example 500 = geocenter).');return;}
 const epoch=value+':00',radius=queryRadius(f),key=botKey(f),request=++botRequest;
 botBusy=true;updateSkyBotPanel();$('tr-bot-status').textContent=`SkyBoT query for ${nameFor(f)}: cone radius ${fmt(radius,3)}°, UTC ${epoch}, observer ${observer}.`;
 const complete=cat=>{
   botBusy=false;if(request!==botRequest)return;
   const sources=cat?.getSources?.()||[];
   const found=sources.map((s,i)=>{const d=s.data||{},ra=Number(s.ra),dec=Number(s.dec);
     const mag=Number(d['Vmag']??d['VMag']??d['VMag (mag)']??d['VMag (mag)']);
     return {ra,dec,name:String(d.Name??d.name??d['Name']??d['Object']??`SSO ${i+1}`),mag:Number.isFinite(mag)?mag:null};
   }).filter(s=>Number.isFinite(s.ra)&&Number.isFinite(s.dec)&&M.inside(s,f));
   botCache.set(key,{objects:found,epoch,observer});
   if(botCache.size>40)botCache.delete(botCache.keys().next().value);
   updateSkyBotPanel();status(`SkyBoT: ${found.length} moving objects inside ${nameFor(f)} at ${epoch} UTC. Query cone ${fmt(radius,3)}°; geometry filtered locally.`);
 };
 const fail=e=>{botBusy=false;if(request!==botRequest)return;updateSkyBotPanel();status('SkyBoT FoV query failed: '+String(e?.message||e));};
 try{
   const options={name:`SkyBoT query · ${nameFor(f)}`,color:'#fd76ce',sourceSize:7,limit:5000};
   if(typeof A.catalogFromURL==='function'){
     // Official SkyBoT HTTPS SCS endpoint; bypass the obsolete HTTP hostname
     // hard-coded by older Aladin builds. Aladin still parses the VOTable.
     const query=new URLSearchParams({TIME:epoch,RA:String(f.ra),DEC:String(f.dec),
       SR:String(radius),RESPONSEFORMAT:'votable',MAXREC:'5000',VERB:'2','-observer':observer});
     const url='https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?'+query.toString();
     A.catalogFromURL(url,options,complete,fail,false);
   }else{
     // Supported by some earlier Aladin v3 builds; use its native helper.
     A.catalogFromSkyBot(f.ra,f.dec,radius,epoch,{'-observer':observer},options,complete,fail);
   }
   // Success/error callbacks alone determine the request result.
 }catch(e){fail(e);}
}
function queryBrightStars(){
 const f=currentFov();if(!A||!aladin||!f){status('Select an accepted FoV for Bright Stars.');return;}
 const request=++starRequest,radius=queryRadius(f),key=geometryKey(f);
 status('Querying V/50 bright stars for '+nameFor(f)+'…');
 try{A.catalogFromVizieR('V/50',`${f.ra} ${f.dec}`,radius,
   {name:'Bright stars · '+nameFor(f),color:'#d0b6ff',sourceSize:6,limit:1000},catalog=>{
     if(request!==starRequest||geometryKey(currentFov())!==key)return;
     const sources=(catalog.getSources?.()||[]).filter(s=>M.inside({ra:Number(s.ra),dec:Number(s.dec)},f));
     safeRemove(starLayer);starLayer=A.catalog({name:'Bright stars · '+nameFor(f),color:'#d0b6ff',sourceSize:6});starLayer.addSources(sources);aladin.addCatalog(starLayer);
     status(`${sources.length} bright stars in ${nameFor(f)} (V/50).`);
   },e=>{if(request===starRequest)status('Bright-star query error: '+String(e));});}
 catch(e){status('Bright-star query error: '+e.message);}
}
$('tr-quick-analyze').addEventListener('click',()=>{
  const name=$('tr-quick-id').value.trim()||`Transient ${objects.length+1}`;
  const ra=Number($('tr-quick-ra').value),dec=Number($('tr-quick-dec').value);
  const dRaw=$('tr-quick-distance').value.trim(),distance=dRaw===''?null:Number(dRaw);
  if(!Number.isFinite(ra)||ra<0||ra>=360||!Number.isFinite(dec)||dec<-90||dec>90||
    (distance!==null&&(!Number.isFinite(distance)||distance<=0))){
    status('Enter valid RA [0, 360), Dec [-90, 90] and a positive distance in Mpc.');return;
  }
  const index=objects.length;
  setObjects([...objects,{name,ra,dec,distance,redshift:null}],'single-transient input');
  selectObject(index);
});
$('tr-import').addEventListener('click',()=>{$('tr-file').value='';$('tr-file').click();});
$('tr-file').addEventListener('change',async()=>{const f=$('tr-file').files[0];if(!f)return;try{if(f.size>window.GrawitaSafeFile.LIMITS.transient)throw Error('Transient coordinate file exceeds 8 MiB');const data=parseDelimited(await f.text());setObjects(data.items,f.name);if(data.skipped)status(`${data.items.length} imported; ${data.skipped} invalid rows skipped.`);}catch(e){status('Import error: '+e.message);}});
$('tr-paste-run').addEventListener('click',()=>{try{const data=parseDelimited($('tr-paste').value);setObjects(data.items,'pasted coordinates');if(data.skipped)status(`${data.items.length} positions accepted; ${data.skipped} invalid rows skipped.`);}catch(e){status('Coordinates: '+e.message);}});
$('tr-moc').addEventListener('change',refresh);
$('tr-export').addEventListener('click',exportResults);
$('tr-skybot').addEventListener('click',querySkybot);
$('tr-bright').addEventListener('click',queryBrightStars);
$('tr-bot-clear').addEventListener('click',()=>{const f=currentFov();if(f){botCache.delete(botKey(f));updateSkyBotPanel();}});
for(const id of ['tr-epoch','tr-observer'])$(id).addEventListener('change',()=>{botRequest++;botBusy=false;updateSkyBotPanel();});
window.addEventListener('vst-aladin-ready',event=>{A=event.detail.A;aladin=event.detail.aladin;ensureCatalog();updateSkyBotPanel();});
window.addEventListener('vst-fov-selected',event=>{selectedFov=event.detail.fov||null;botRequest++;botBusy=false;updateSkyBotPanel();});
window.addEventListener('vst-coverage-sequence-updated',event=>{
 const f=event.detail.pointings.find(p=>p.id===event.detail.selectedFoV)||null;
 const changed=geometryKey(f)!==geometryKey(selectedFov);
 selectedFov=f;if(changed){botRequest++;botBusy=false;starRequest++;safeRemove(starLayer);starLayer=null;}
 updateSkyBotPanel();
});
window.addEventListener('vst-posterior-loaded',event=>{posterior=event.detail.posterior;if(chosen!==null)details(chosen);});
window.addEventListener('vst-moc-imported',event=>{mocs[event.detail.key]=event.detail.json;refresh();});
window.addEventListener('vst-coverage-moc-created',event=>{coverageMoc=event.detail.json;refresh();});
window.addEventListener('vst-coverage-moc-invalidated',()=>{coverageMoc=null;refresh();});
if(window.GRAWITALiveViewer){A=window.GRAWITALiveViewer.A;aladin=window.GRAWITALiveViewer.aladin;ensureCatalog();}
refresh();updateSkyBotPanel();
window.GrawitaTransientTest={parseCSV:txt=>parseDelimited(txt).items,parseDelimited,setObjects,selectedMoc,selectObject,refresh,querySkybot,botCache,geometryKey,distanceCurves,escapeHtml,popupMarkup,showSourcePopup};
})();
