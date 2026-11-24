/* GWsky-inspired standalone Coverage LAB. Not copied from GWsky production.
 * Aladin Lite API v3 (CDS v3/latest) draws geometric FoVs via A.graphicOverlay + A.polygon.
 * ONLY the separate Create Coverage MOC action calls A.MOCFromPolygon (Aladin WASM backend).
 * Real P only with user's complete BAYESTAR map; never infer P from 50/90% MOCs.
 */
(() => {
'use strict';
const M=window.CoverageMath, $=id=>document.getElementById(id);
const DIRECTIONS=['N','NE','E','SE','S','SW','W','NW'];
const state={A:null,aladin:null,pointings:[],preview:null,posterior:null,mapFile:null,
  mocs:{...window.TEST_MOC_DATA},fineOrigin:null,draft:null,layers:[],previewLayer:null,coverageMocLayer:null,coverageMocJSON:null,samples:null,session:0,busy:false,selectedFoV:null};
// HEALPix orders (area sampling, P(inside)) are chosen before the first FoV calculation and then locked for
// the session: every later calculation uses the same orders. Only a page reload unlocks them (no storage).
let lockedOrders=null;
const ORDERS_LOCKED_NOTE='HEALPix settings locked for this session. Reload to change.';
function lockOrders(){
  if(lockedOrders)return;
  lockedOrders=Object.freeze({area:Number($('cv-order').value),prob:Number($('cv-prob-order').value)});
  orders();
}
// Orders in use. Once locked, the selects are put back to the locked values and disabled if anything changed them.
function orders(){
  if(!lockedOrders)return {area:Number($('cv-order').value),prob:Number($('cv-prob-order').value)};
  for(const [id,value] of [['cv-order',lockedOrders.area],['cv-prob-order',lockedOrders.prob]]){
    const s=$(id);if(s.value!==String(value))s.value=String(value);
    s.disabled=true;s.title=ORDERS_LOCKED_NOTE;s.setAttribute('aria-describedby','cv-orders-lock');
  }
  $('cv-orders-lock').hidden=false;
  return lockedOrders;
}
const pct=p=>p==null?'—':(p*100).toFixed(3)+' %';
const area=a=>a==null?'—':a.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' deg²';
const info=(text,type='')=>{const el=$('cv-feedback');el.textContent=text;el.dataset.type=type;};
function updateMode(){
  $('prob-mode').textContent=state.posterior?'GW POSTERIOR LOADED · FoV ESTIMATE':'GEOMETRY ONLY';
  $('prob-mode').classList.toggle('with-prob',!!state.posterior);
  $('cv-autotile').disabled=!state.posterior;
  $('cv-map-info').textContent=state.posterior?`${state.mapFile} · ${state.posterior.tableRows.toLocaleString('en-US')} cells · ${state.posterior.format}`+(Number.isFinite(state.posterior.distmean)?` · FITS DISTMEAN ${state.posterior.distmean.toFixed(3)} Mpc`:''):'Not loaded · GW 50%/90% MOCs available';
}
function getConfig(){
  const read=(id)=>Number($(id).value);
  const cfg={shape:$('cv-shape').value,ra:read('cv-ra'),dec:read('cv-dec'),width:read('cv-width'),height:read('cv-height'),radius:read('cv-radius'),pa:read('cv-pa')};
  M.configValid(cfg);
  const ox=read('cv-overlap-x'),oy=read('cv-overlap-y');
  if(ox<0||ox>=100||oy<0||oy>=100)throw Error('Overlap must be 0–99%.');
  return cfg;
}
function putCenter(center){$('cv-ra').value=center.ra.toFixed(6);$('cv-dec').value=center.dec.toFixed(6);}
function remove(layer){if(state.aladin&&layer){try{state.aladin.removeOverlay(layer);}catch(error){console.warn('Overlay removal:',error);}}}
function renderPolygon(cfg,opts){
  if(!state.A||!state.aladin)return null;
  const p=M.polygon(cfg);
  const vertices=p.ra.map((ra,i)=>[ra,p.dec[i]]);
  // Geometric overlay, NOT a MOC. MOC conversion is deliberately deferred.
  const layer=state.A.graphicOverlay({color:opts.color,lineWidth:opts.lineWidth||2,lineDash:opts.preview?[6,4]:[]});
  const footprint=state.A.polygon(vertices);
  layer.addFootprints([footprint]);
  if(opts.selectId && window.SkyFieldSelection)
    window.SkyFieldSelection.registerFootprint(footprint,()=>focusFoV(opts.selectId,{fromSky:true}));
  state.aladin.addOverlay(layer);
  return layer;
}
function invalidateCoverageMoc(){
  $('cv-moc-color').disabled=true;$('cv-moc-opacity').disabled=true;
  if(state.coverageMocLayer){remove(state.coverageMocLayer);state.coverageMocLayer=null;}
  state.coverageMocJSON=null;window.dispatchEvent(new CustomEvent('vst-coverage-moc-invalidated'));
  if($('cv-moc-export'))$('cv-moc-export').disabled=true;
  if($('cv-moc-fits'))$('cv-moc-fits').disabled=true;
  if($('cv-moc-result'))$('cv-moc-result').textContent='No MOC created (geometric FoVs).';
}

// Persistent overlays: selection updates TWO styles instead of re-drawing N polygons.
const acceptedLayers=new Map();
let visibleDraftConfig=null;
function setAcceptedStyle(id){
  const entry=acceptedLayers.get(id);if(!entry)return;
  const focused=id===state.selectedFoV;
  const color=focused?'#ffe071':'#4bebad',width=focused?5:2;
  const layer=entry.layer;
  if(typeof layer.setColor==='function')layer.setColor(color);
  else {layer.color=color;layer.reportChange?.();}
  if(typeof layer.setLineWidth==='function')layer.setLineWidth(width);
  else {layer.lineWidth=width;layer.reportChange?.();}
  window.SkyFieldSelection?.registerGeometry('plan:'+id,entry.config,()=>focusFoV(id,{fromSky:true}),focused?110:20);
}
function refreshOverlays(){
  const show=$('cv-show-accepted').checked,visible=new Set(show?state.pointings.map(p=>p.id):[]);
  for(const [id,entry] of acceptedLayers){
    if(visible.has(id))continue;
    remove(entry.layer);acceptedLayers.delete(id);
    window.SkyFieldSelection?.unregisterGeometry('plan:'+id);
  }
  if(state.A&&state.aladin){
    for(const [i,p] of state.pointings.entries()){
      if(!visible.has(p.id))continue;
      if(!acceptedLayers.has(p.id)){
        const layer=renderPolygon(p,{color:'#4bebad',lineWidth:2,selectId:p.id});
        acceptedLayers.set(p.id,{layer,config:p});
      }
      setAcceptedStyle(p.id);
    }
  }
  state.layers=state.pointings.filter(p=>visible.has(p.id)).map(p=>acceptedLayers.get(p.id)?.layer).filter(Boolean);
  // Preview FoV stays a separate temporary geometric outline, not an accepted MOC.
  const draft=state.draft||state.preview?.config||null;
  if(draft!==visibleDraftConfig){
    remove(state.previewLayer);state.previewLayer=null;visibleDraftConfig=draft;
    if(draft)state.previewLayer=renderPolygon(draft,{color:'#ffb347',lineWidth:3,preview:true});
  }
}
function setupSamples(){
  const order=orders().area;
  const sample=M.sampleMoc(state.mocs.gw90,order);
  const fifty=M.jsonToRanges(state.mocs.gw50,order);
  sample.in50=sample.points.map((p,i)=>false);
  const r90=M.jsonToRanges(state.mocs.gw90,order);
  let k=0;
  for(const [a,b] of r90)for(let pix=a;pix<b;pix++)sample.in50[k++]=M.rangeOverlap(fifty,pix,pix+1)>0;
  state.samples=sample;
}
function calc(c,accepted=state.pointings,mode='all'){
  let a50=0,a90=0,a90New=0,a90Cum=0;
  if(mode==='all'||mode==='area-only'){
    if(!state.samples)setupSamples();
    const sample=state.samples;
    for(let i=0;i<sample.points.length;i++){
      const pt=sample.points[i],inCurrent=M.inside(pt,c);
      const old=accepted.some(p=>M.inside(pt,p));
      if(inCurrent){a90++;if(sample.in50[i])a50++;if(!old)a90New++;}
      if(inCurrent||old)a90Cum++;
    }
    a90*=sample.cellArea;a50*=sample.cellArea;a90New*=sample.cellArea;a90Cum*=sample.cellArea;
  }
  let pFoV=null,pNew=null,pCum=null;
  if(state.posterior&&mode!=='area-only'&&mode!=='none'){
    ({pFoV,pNew,pCum}=M.integratePosteriorFoV(state.posterior,c,accepted,orders().prob));
  }
  return {a50,a90,a90New,a90Cum,pFoV,pNew,pCum};
}
// Keep the validated numerical integration exactly as implemented in CoverageMath.
// Processing subsets in separate event-loop turns prevents a 14th-order
// calculation from freezing the sky view before the preview outline appears.
// Small floating-point summation differences are possible at ~1e-15 level.
async function calcResponsive(c,accepted=state.pointings,mode='all',token=state.session){
  // Try local Blob Worker first. Data are sent only on posterior/MOC changes.
  lockOrders();// the first FoV calculation fixes the HEALPix orders for the session
  const {prob:order,area:areaOrder}=orders();
  const client=window.CoverageWorkerClient;
  if(client){
    const metrics=await client.compute({posterior:state.posterior,mocs:state.mocs,
      config:c,accepted,mode,probOrder:order,areaOrder,
      progress:(v,phase)=>{if(token===state.session)updateWorkProgress(v,phase);}});
    if(token!==state.session)return null;
    if(metrics)return metrics;
  }
  // Cooperative fallback: identical CoverageMath formulas, time-sliced at
  // the pixel/cell level. Works when file:// CSP forbids constructing a Worker.
  const metrics={a50:0,a90:0,a90New:0,a90Cum:0,pFoV:null,pNew:null,pCum:null};
  if(mode==='all'||mode==='area-only'){
    updateWorkProgress(0,'Local area sampling (fallback)');await nextPaint();
    if(!state.samples)setupSamples();
    const sample=state.samples;let a50=0,a90=0,a90New=0,a90Cum=0;
    for(let i=0;i<sample.points.length;i++){
      if(token!==state.session)return null;
      const pt=sample.points[i],cur=M.inside(pt,c),old=accepted.some(p=>M.inside(pt,p));
      if(cur){a90++;if(sample.in50[i])a50++;if(!old)a90New++;}
      if(cur||old)a90Cum++;
      if((i+1)%2048===0){updateWorkProgress(.35*(i+1)/sample.points.length,'GW50/GW90 area');await nextPaint();}
    }
    metrics.a50=a50*sample.cellArea;metrics.a90=a90*sample.cellArea;
    metrics.a90New=a90New*sample.cellArea;metrics.a90Cum=a90Cum*sample.cellArea;
  }
  if(state.posterior&&mode!=='area-only'&&mode!=='none'){
    let pFoV=0,pNew=0,pCum=0;
    const cells=state.posterior.cells;let batch=128;
    for(let i=0;i<cells.length;){
      if(token!==state.session)return null;
      const end=Math.min(cells.length,i+batch),start=performance.now();
      const r=M.integratePosteriorFoV({cells:cells.slice(i,end)},c,accepted,order);
      pFoV+=r.pFoV;pNew+=r.pNew;pCum+=r.pCum;
      const elapsed=performance.now()-start;
      batch=Math.max(32,Math.min(512,Math.round(batch*18/Math.max(1,elapsed))));
      i=end;updateWorkProgress((mode==='all'?.35:0)+(mode==='all'?.65:1)*i/cells.length,'BAYESTAR P(inside) (fallback)');
      if(i<cells.length)await nextPaint();
    }
    Object.assign(metrics,{pFoV,pNew,pCum});
  }
  return metrics;
}
// Separate the immediate geometric preview from slower probability integration.
function showPreviewGeometry(c){
  state.preview=null;state.draft=c;
  $('cv-accept').disabled=true;
  refreshOverlays();
  try{
    state.aladin?.gotoRaDec(c.ra,c.dec);
    const diameter=c.shape==='circle'?2*c.radius:Math.hypot(c.width,c.height);
    const fov=state.aladin?.getFoV?.();
    const visible=Number(Array.isArray(fov)?fov[0]:fov);
    if(Number.isFinite(visible)&&visible>0&&visible<diameter*1.25)
      state.aladin.setFoV(Math.min(120,Math.max(1.5,diameter*1.7)));
  }catch(error){console.warn('Preview view centering unavailable:',error);}
}
function completePreview(c,metrics){
  state.preview={config:c,metrics};state.draft=null;
  refreshOverlays();$('cv-accept').disabled=false;
}
function clearPreview(){state.preview=null;state.draft=null;}
function updateHeadline(last=null){
  $('cv-count').textContent=String(state.pointings.length);
  $('cv-area').textContent=area(last?.a90Cum??0);
  $('cv-pcum').textContent=pct(state.posterior?(last?.pCum??0):null);
  $('cv-pnew').textContent=pct(state.posterior?(last?.pNew??0):null);
}
function focusFoV(id,options={}){
  const p=state.pointings.find(item=>item.id===id);if(!p)return;
  const old=state.selectedFoV;
  state.selectedFoV=id;putCenter(p);updateDeleteSelected();
  // No overlay recreation and no table reconstruction on a selection click.
  if(old!==id){setAcceptedStyle(old);setAcceptedStyle(id);}
  for(const key of [old,id])if(key!=null){
    const row=Array.from($('cv-rows').querySelectorAll('tr[data-fov-id]')).find(el=>el.dataset.fovId===String(key));
    if(row){row.classList.toggle('cv-selected',key===id);row.setAttribute('aria-selected',String(key===id));
      if(key===id&&options.fromSky)row.scrollIntoView({behavior:'smooth',block:'nearest',inline:'nearest'});}
  }
  // A sky click is ALREADY on the desired field: do not pan or zoom again.
  if(state.aladin&&!options.fromSky){
    try{
      // Avoid a redundant GPU pan/zoom when this FoV is already in view.
      const center=state.aladin.getRaDec?.();
      const dra=Array.isArray(center)?((((Number(center[0])-p.ra)+540)%360)-180):Infinity;
      const ddec=Array.isArray(center)?Number(center[1])-p.dec:Infinity;
      if(!Number.isFinite(dra)||!Number.isFinite(ddec)||Math.hypot(dra*Math.cos(p.dec*M.RAD),ddec)>0.001)
        state.aladin.gotoRaDec(p.ra,p.dec);
      const diameter=p.shape==='circle'?2*p.radius:Math.hypot(p.width,p.height);
      const desired=Math.min(60,Math.max(1.5,diameter*2.2));
      const f=state.aladin.getFoV?.(),current=Array.isArray(f)?Number(f[0]):Number(f);
      if(!Number.isFinite(current)||Math.abs(current-desired)>desired*.03)state.aladin.setFoV(desired);
    }catch(error){info('FoV selected but Aladin could not center: '+error.message,'error');return;}
  }
  info('Selected FoV '+String(state.pointings.indexOf(p)+1).padStart(2,'0')+
       ': highlighted in Aladin at RA '+p.ra.toFixed(5)+'°, Dec '+p.dec.toFixed(5)+'°.');
  window.dispatchEvent(new CustomEvent('vst-fov-selected',{detail:{fov:p}}));
}
function updateOverlapReadout(){
  const shape=$('cv-shape').value;
  const w=shape==='circle'?Number($('cv-radius').value)*2:Number($('cv-width').value);
  const h=shape==='circle'?w:Number($('cv-height').value);
  const ox=Number($('cv-overlap-x').value),oy=Number($('cv-overlap-y').value),pa=Number($('cv-pa').value);
  const x=w*(1-ox/100),y=h*(1-oy/100);
  const el=$('cv-overlap-readout');
  if([w,h,ox,oy,pa].some(v=>!Number.isFinite(v)||v<0&&v!==pa)){
    el.textContent='Enter valid overlap and field dimensions.';return;
  }
  const actualX=100*(1-x/w),actualY=100*(1-y/h);
  el.textContent=`Axis step: X ${x.toFixed(2)}°, Y ${y.toFixed(2)}° · requested overlap ${ox}%/${oy}%`+
    ` · instrument PA ${pa.toFixed(0)}°`;
}
function renderSequence(){
  updateDeleteSelected();
  const tbody=$('cv-rows');tbody.textContent='';
  if(!state.pointings.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=8;td.textContent='No accepted FoVs.';tr.appendChild(td);tbody.appendChild(tr);updateHeadline();return;}
  for(let i=0;i<state.pointings.length;i++){
    const p=state.pointings[i],m=p.metrics||{},tr=document.createElement('tr');
    tr.classList.toggle('cv-selected',p.id===state.selectedFoV);tr.setAttribute('aria-selected',String(p.id===state.selectedFoV));
    tr.tabIndex=0;tr.dataset.fovId=p.id;tr.title='Select and center this FoV in Aladin';
    tr.addEventListener('click',()=>focusFoV(p.id));
    tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();focusFoV(p.id);}});
    const columns=[String(i+1).padStart(2,'0'),p.ra.toFixed(4)+' / '+p.dec.toFixed(4),p.shape,pct(m.pFoV),pct(m.pNew),pct(m.pCum),area(m.a90New)];
    for(const value of columns){const td=document.createElement('td');td.textContent=value;tr.appendChild(td);}
    const td=document.createElement('td');
    for(const [txt,delta] of [['↑',-1],['↓',1]]){const b=document.createElement('button');b.type='button';b.textContent=txt;b.title='Move FoV '+(delta<0?'up':'down');b.disabled=i+delta<0||i+delta>=state.pointings.length||state.busy;b.addEventListener('click',event=>{event.stopPropagation();movePointing(i,i+delta);});td.appendChild(b);}
    const inspect=document.createElement('button');inspect.type='button';inspect.textContent='Inspect';
    inspect.title='Select this FoV and open its SkyBoT / bright-star inspector';
    inspect.addEventListener('click',event=>{event.stopPropagation();focusFoV(p.id);document.getElementById('tr-fov-name')?.scrollIntoView({behavior:'smooth',block:'nearest'});});
    td.append(inspect);
    tr.appendChild(td);tbody.appendChild(tr);
  }
  updateHeadline(state.pointings[state.pointings.length-1].metrics);
}
function notifySequenceUpdated(){
  window.dispatchEvent(new CustomEvent('vst-coverage-sequence-updated',
    {detail:{pointings:state.pointings.slice(),selectedFoV:state.selectedFoV}}));
}
function commitSequenceChange({render=true}={}){
  invalidateCoverageMoc();
  if(state.selectedFoV&&!state.pointings.some(p=>p.id===state.selectedFoV))state.selectedFoV=null;
  if(render)renderSequence();
  refreshOverlays();notifySequenceUpdated();
}
async function recalcSequence(from=0,token=state.session){
  invalidateCoverageMoc();
  const accepted=state.pointings.slice(0,from);
  for(let i=from;i<state.pointings.length;i++){
    const p=state.pointings[i],metrics=await calcResponsive(p,accepted,'all',token);
    if(token!==state.session||!metrics)return;
    p.metrics=metrics;accepted.push(p);
    updateWorkProgress((i+1)/state.pointings.length,'Recalculating sequence');
  }
  if(token!==state.session)return;
  commitSequenceChange();
}
// Transactional sequence edits (delete selected, ↑/↓): the order-dependent metrics of the candidate plan
// are computed on copies with the same calcResponsive call, from index `from` on. The real plan, the MOC,
// the table, the exports and the sequence events stay untouched until everything is computed; null means
// interrupted or superseded, and nothing is applied.
async function sequenceMetrics(plan,from,token,phase='Recalculating sequence'){
  const accepted=plan.slice(0,from).map(p=>({...p})),out=[];
  for(let i=from;i<plan.length;i++){
    const p={...plan[i]},metrics=await calcResponsive(p,accepted,'all',token);
    if(token!==state.session||!metrics)return null;
    p.metrics=metrics;accepted.push(p);out.push(metrics);
    updateWorkProgress((i+1)/plan.length,phase);
  }
  return token===state.session?out:null;
}
// Publishes a fully recalculated plan in one synchronous step. Its callers (credible-region tiling, Delete selected,
// ↑/↓) are guarded() actions that end right after it without awaiting: guarded() then rebuilds the table once, with
// the buttons enabled again, before the browser can paint, so the table is not also rebuilt here.
function commitPlan(plan,from,metrics){
  for(let i=from;i<plan.length;i++)plan[i].metrics=metrics[i-from];
  state.pointings=plan;clearPreview();commitSequenceChange({render:false});
}
function hasSelectedFoV(){return state.pointings.some(p=>p.id===state.selectedFoV);}
function updateDeleteSelected(){const b=$('cv-delete-selected');if(b)b.disabled=state.busy||!hasSelectedFoV();}
function requireReady(){if(!state.A||!state.aladin){info('Aladin Lite is not available. Check the official script connection.','error');return false;}return true;}
function updateWorkProgress(value,phase){
  const v=Math.round(Math.min(1,Math.max(0,Number(value)||0))*100);
  $('cv-work-progress').value=v;
  $('cv-work-text').textContent=(phase||'Calculation')+' · '+v+'%';
  // The same real progress for the GW Tiling panel (scripts/gw-tiling-panel.js), which shows it next to its button.
  window.dispatchEvent(new CustomEvent('vst-coverage-progress',{detail:{value:v,phase:phase||'Calculation'}}));
}
function setBusy(b){
  // cv-import-map is not listed: it stays disabled in GRAWITA Dryrun (attribute in index.html).
  for(const id of ['cv-preview','cv-best','cv-accept','cv-autotile','cv-undo','cv-delete-selected','cv-clear','cv-create-moc','cv-center-compass','cv-order','cv-prob-order']){
    const el=$(id);if(!el)continue;
    const unavailable=id==='cv-autotile'&&!state.posterior||id==='cv-accept'&&!state.preview||id==='cv-delete-selected'&&!hasSelectedFoV()||
      (id==='cv-order'||id==='cv-prob-order')&&!!lockedOrders;
    el.disabled=b||unavailable;
    // Disabled only by the running calculation: keeps its usual look ([data-busy] in style/app.css); the progress bar shows the work.
    el.toggleAttribute('data-busy',b&&!unavailable);
  }
  $('cv-work-status').hidden=!b;
  $('cv-work-status').setAttribute('aria-busy',String(b));
  $('cv-cancel').disabled=!b;
  // The GW Tiling panel disables its own controls while any Coverage calculation runs.
  window.dispatchEvent(new CustomEvent('vst-coverage-busy',{detail:{busy:!!b}}));
  if(b)updateWorkProgress(0,'Preparing calculation');
}
function guarded(action){return async()=>{
  if(state.busy){info('Calculation in progress. You can cancel it.');return;}
  const token=++state.session;state.busy=true;setBusy(true);
  try{await action(token);}
  catch(error){if(token===state.session){console.error(error);info(error.message||String(error),'error');}}
  finally{if(token===state.session){state.busy=false;setBusy(false);renderSequence();}}
};}
const nextPaint=()=>new Promise(resolve=>setTimeout(resolve,0));
function cancelCalculation(){
  if(!state.busy)return;
  ++state.session;window.CoverageWorkerClient?.cancel();
  // The GW Tiling panel stops its own Worker (scripts/gw-tiling-panel.js).
  window.dispatchEvent(new CustomEvent('vst-coverage-cancelled'));
  state.busy=false;clearPreview();refreshOverlays();setBusy(false);
  renderSequence();info('Calculation interrupted; previously accepted FoVs remain available.');
}
$('cv-cancel').addEventListener('click',cancelCalculation);
const preview=guarded(async(token)=>{
  if(!requireReady())return;
  state.fineOrigin=null;const c=getConfig();showPreviewGeometry(c);
  info('FoV outlined in Aladin · computing P(inside) at HEALPix order '+orders().prob+'…');await nextPaint();
  const metrics=await calcResponsive(c,state.pointings,'all',token);if(token!==state.session)return;
  completePreview(c,metrics);
  const focus=state.posterior?`P(FoV) ${pct(metrics.pFoV)} · P(new) ${pct(metrics.pNew)} · P(cum) ${pct(metrics.pCum)}`:`GW90∩FoV ≈ ${area(metrics.a90)}; new area ≈ ${area(metrics.a90New)}. P(FoV) unavailable.`;
  info('FoV preview: '+focus);
});
const accept=guarded(async()=>{
  if(!requireReady()||!state.preview)throw Error('Preview a FoV first');
  // The preview was computed with this exact accepted sequence; reuse it.
  const p={...state.preview.config,id:Date.now()+'-'+state.pointings.length,metrics:state.preview.metrics};
  state.pointings.push(p);state.selectedFoV=p.id;clearPreview();state.fineOrigin=null;commitSequenceChange();
  window.dispatchEvent(new CustomEvent('vst-fov-selected',{detail:{fov:p}}));
  info('FoV '+String(state.pointings.length).padStart(2,'0')+' accepted. Choose a direction or Best next.');
});
function shifted(cfg,dir){const center=M.nextCenter(cfg,dir,Number($('cv-overlap-x').value),Number($('cv-overlap-y').value),0);return {...cfg,...center};}
function directionPreview(dir){return guarded(async(token)=>{
  if(!requireReady())return;
  const base=state.pointings.length?state.pointings[state.pointings.length-1]:getConfig();
  state.fineOrigin=null;const c=shifted(base,dir);putCenter(c);showPreviewGeometry(c);info(`Computing preview ${dir}…`);await nextPaint();
  const metrics=await calcResponsive(c,state.pointings,'all',token);if(token!==state.session)return;
  completePreview(c,metrics);
  info(`Direction ${dir} · ${state.posterior?'P(new) '+pct(metrics.pNew):'New GW90 area '+area(metrics.a90New)} · PREVIEW ONLY.`);
});}
const bestNext=guarded(async(token)=>{
  if(!requireReady())return;
  const base=state.pointings.length?state.pointings[state.pointings.length-1]:getConfig();
  let best=null;
  for(let i=0;i<DIRECTIONS.length;i++){
    const dir=DIRECTIONS[i],c=shifted(base,dir);
    info(`Best next: checking ${dir} (${i+1}/8)…`);await nextPaint();
    const metrics=await calcResponsive(c,state.pointings,'all',token);if(token!==state.session||!metrics)return;
    const score=state.posterior?metrics.pNew:metrics.a90New;
    if(!best||score>best.score)best={dir,config:c,metrics,score};
    if(token!==state.session)return;
  }
  if(!best)throw Error('No valid next FoV candidate.');
  state.fineOrigin=null;putCenter(best.config);showPreviewGeometry(best.config);completePreview(best.config,best.metrics);
  info(`Best next: ${best.dir} · ${state.posterior?'P(new) '+pct(best.metrics.pNew):'new GW90 area '+area(best.metrics.a90New)}. Preview only: accept manually.`);
});
const undo=guarded(async()=>{if(!state.pointings.length){info('No FoV to remove.');return;}state.pointings.pop();clearPreview();commitSequenceChange();info('Last FoV removed.');});
const clear=guarded(async()=>{if(!state.pointings.length){info('Sequence is already empty.');return;}state.pointings=[];clearPreview();commitSequenceChange();info('All FoVs cleared.');});
// Delete the FoV selected in the table. Earlier FoVs keep their values; the later ones get P(new), P(cum)
// and the new/cumulative GW90 areas recalculated. Deleting the last one needs no calculation (as Undo).
const deleteSelected=guarded(async(token)=>{
  const k=state.pointings.findIndex(p=>p.id===state.selectedFoV);
  if(k<0){info('Select an accepted FoV in the table first.');return;}
  const name='FoV '+String(k+1).padStart(2,'0');
  if(k===state.pointings.length-1){state.pointings.pop();clearPreview();commitSequenceChange();info(name+' deleted (last in the sequence).');return;}
  const plan=state.pointings.filter((p,i)=>i!==k);
  const metrics=await sequenceMetrics(plan,k,token);if(!metrics)return;
  commitPlan(plan,k,metrics);
  info(name+' deleted; P(new) and P(cum) recalculated for '+metrics.length+' following FoV'+(metrics.length>1?'s':'')+'.');
});
const movePointing=(from,to)=>guarded(async(token)=>{
  const plan=state.pointings.slice(),[item]=plan.splice(from,1);plan.splice(to,0,item);
  const metrics=await sequenceMetrics(plan,Math.min(from,to),token);if(!metrics)return;
  commitPlan(plan,Math.min(from,to),metrics);
  info('Sequence reordered; affected P(new) and P(cum) recalculated.');
})();
// GUI-COVERAGE-LABELS-01: GW90 ∩ survey as a MOC at the finer of the two orders, with the cell arithmetic of
// CoverageMath.intersectArea (jsonToRanges at a common order); its probability comes from the unchanged mocProbability.
function intersectionMoc(a,b){
  const N=Math.max(M.maxOrder(a),M.maxOrder(b)),ra=M.jsonToRanges(a,N),rb=M.jsonToRanges(b,N),pixels=[];
  for(let i=0,j=0;i<ra.length&&j<rb.length;){
    for(let p=Math.max(ra[i][0],rb[j][0]),end=Math.min(ra[i][1],rb[j][1]);p<end;p++)pixels.push(p);
    if(ra[i][1]<rb[j][1])i++;else j++;
  }
  return {[N]:pixels};
}
// An empty intersection is an exact zero; a positive value below the displayed precision is never shown as zero.
const overlapArea=a=>a===0?'0 (no overlap)':a<0.005?'< 0.01 deg²':area(a);
const surveyProb=p=>p===0?'0 %':p<0.000005?'< 0.001 %':pct(p);
function updateSurveyStats(){
  const whole=state.mocs.gw90;
  for(const [key,elem] of [['kidsN','kidsN'],['kidsS','kidsS'],['kidsW2','kidsW2'],['atlasN','atlasN'],['atlasS','atlasS']]){
    const coverage=state.mocs[key],inter=coverage&&whole?intersectionMoc(whole,coverage):null,empty=!!inter&&!Object.values(inter)[0].length;
    $("cv-"+elem+'-area').textContent=coverage?overlapArea(M.intersectArea(whole,coverage)):'Import FITS';
    $("cv-"+elem+'-prob').textContent=coverage&&state.posterior?surveyProb(M.mocProbability(state.posterior,coverage)):'—';
    $("cv-"+elem+'-prob-gw90').textContent=coverage&&state.posterior?(empty?'0 (no overlap)':surveyProb(M.mocProbability(state.posterior,inter))):'—';
  }
  if(state.posterior){let north=0,south=0;for(const cell of state.posterior.cells){if(cell.dec>=0)north+=cell.p;else south+=cell.p;}
    $('cv-hemiN-prob').textContent=pct(north);$('cv-hemiS-prob').textContent=pct(south);
  }else{$('cv-hemiN-prob').textContent='—';$('cv-hemiS-prob').textContent='—';}
}
async function readFitsFile(file){
  // Read by FITS/gzip signature, including GraceDB versioned filenames.
  // Bound both original and decompressed size before scientific FITS parsing.
  return window.GrawitaSafeFile.read(file,{
    maxInputBytes:window.GrawitaSafeFile.LIMITS.skymap,
    maxOutputBytes:window.GrawitaSafeFile.LIMITS.skymap
  });
}

const importPosterior=guarded(async()=>{
  const file=$('cv-map-file').files[0];if(!file)return;
  info('Reading BAYESTAR FITS '+file.name+' locally…');await nextPaint();
  const prob=M.decodePosterior(await readFitsFile(file));state.posterior=prob;state.mapFile=file.name;window.GRAWITA_CURRENT_POSTERIOR=prob;window.dispatchEvent(new CustomEvent('vst-posterior-loaded',{detail:{posterior:prob,fileName:file.name}}));
  clearPreview();state.fineOrigin=null;refreshOverlays();updateMode();info('BAYESTAR loaded: '+prob.tableRows+' cells. Probability available (FoV estimates using cell centers).');
  await recalcSequence();await nextPaint();updateSurveyStats();
});
function centerWithinRegion(cell,region){
  if(region==='all')return true;if(region==='north')return cell.dec>=0;if(region==='south')return cell.dec<0;
  const moc=state.mocs[region];if(!moc)return false;
  // exact MOC fraction of the posterior pixel; no rough coordinate limits
  let ord=Math.max(M.maxOrder(moc),cell.order);
  if(ord>17)throw Error('MOC order too high for this local checker');
  const cacheKey=region+'@'+ord;
  const ranges=regionCache[cacheKey] || (regionCache[cacheKey]=M.jsonToRanges(moc,ord));
  const width=Math.pow(4,ord-cell.order),start=cell.pixel*width;
  return M.rangeOverlap(ranges,start,start+width)>0;
}
const regionCache={};
// Cover BAYESTAR credible region (scripts/credible-region-tiling.js). The new FoVs are planned on copies, their
// official P(FoV), P(new), P(cum) are computed with the usual engine (sequenceMetrics) and the plan is published in
// one step (commitPlan): an interrupted or failed run leaves the plan, its probabilities, the MOC and the exports as
// they were. Accepted FoVs count as covered and are not changed. The Adjacent and Peaks strategies are untouched.
const CREDIBLE_LEVELS={'0.1':'10%','0.5':'50%','0.9':'90%'};
const CREDIBLE_MAX_NEW=20;
const TILING_HINTS={
  adjacent:'Adjacent: each new FoV is one overlap step N, E, S or W of the previous one, the neighbour with the highest additional probability. 1–8 FoVs.',
  peaks:'Peaks: FoVs centred on the highest-density BAYESTAR cells of the chosen region, highest additional probability first; positions may jump. 1–8 FoVs.',
  credible:'Credible region: up to 20 new FoVs, also non-contiguous, chosen for the highest additional probability inside the 10%, 50% or 90% region, then for its uncovered area, until it is covered at HEALPix order 9. Shape, size and PA as set above; overlap is not used; accepted FoVs count as covered.',
  observational:'Credible region, observational mode: up to 20 new FoVs in the 10%, 50% or 90% region, each one contiguous to the previous FoV (overlap, shared edge or touching vertex) while a contiguous FoV is useful; otherwise an explicit reposition. Strict keeps contiguity while possible; Balanced repositions early when the gain justifies it (α). The area overlap is a percentage of the geometric area of the previous FoV, not of the centre step; the X/Y overlap above is not used. Shape, size and PA as set above; accepted FoVs count as covered.'};
function updateTilingMode(){
  const mode=$('cv-tile-mode').value,credible=mode==='credible',observational=credible&&$('cv-cr-mode').value==='observational';
  $('cv-region-field').hidden=credible;$('cv-tile-count-field').hidden=credible;
  $('cv-cr-level-field').hidden=!credible;$('cv-cr-max-field').hidden=!credible;$('cv-cr-mode-field').hidden=!credible;
  $('cv-obs-behavior-field').hidden=!observational;$('cv-obs-overlap-field').hidden=!observational;$('cv-obs-advanced').hidden=!observational;
  $('cv-obs-alpha').disabled=$('cv-obs-behavior').value!=='balanced';
  $('cv-tile-hint').textContent=observational?TILING_HINTS.observational:TILING_HINTS[mode]||'';
  $('cv-autotile').textContent=credible?(observational?'Generate observational tiling':'Generate credible-region tiling'):'Generate greedy tiling (uses overlap)';
}
function readCredibleMax(){
  const raw=String($('cv-cr-max').value).trim(),n=Number(raw);
  if(!/^\d+$/.test(raw)||n<1||n>CREDIBLE_MAX_NEW)throw Error('Max new FoVs must be a whole number from 1 to '+CREDIBLE_MAX_NEW+'.');
  return n;
}
let credibleSummaryPlan=null;
function showCredibleSummary(r,x){
  const box=$('cv-cr-summary'),c=r.coverage,list=document.createElement('dl');
  // The covered percentage is rounded down: 100.00 % appears only when every order-9 sample cell is covered.
  const percent=c.complete?'100.00':(Math.floor(c.fraction*1e4)/100).toFixed(2);
  const share=r.region.probability>0?' ('+(100*x.regionCovered/r.region.probability).toFixed(2)+' % of the region)':'';
  const rows=[
    ['Credible region',x.label+' · '+r.region.count.toLocaleString('en-US')+' cells of the loaded BAYESTAR · P = '+pct(r.region.probability)],
    ['New FoVs generated',r.fovs.length+' (maximum '+x.maxNew+')'+(x.existing?' · '+x.existing+' accepted FoV'+(x.existing>1?'s':'')+' counted as covered':'')],
    ['Region area',area(c.regionArea)],
    ['Covered area',area(c.covered)+' · '+percent+' %'],
    ['Residual area',area(c.residual)],
    ['P covered inside the region',pct(x.regionCovered)+share],
    ['Official P(cum), whole BAYESTAR',pct(x.officialPcum)],
    ['Geometric resolution','HEALPix order '+r.sampleOrder+' sample cells ('+r.sampleCellArea.toFixed(4)+' deg²); probabilities at HEALPix order '+x.probOrder]];
  for(const [k,v] of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v;list.append(dt,dd);}
  const note=document.createElement('p');
  if(c.complete){note.className='cv-cr-done';note.textContent='Region covered at HEALPix order '+r.sampleOrder+': every sample cell lies inside an accepted FoV.';}
  else{note.className='cv-cr-warning';note.textContent=r.stop==='limit'?
    'Limit of '+x.maxNew+' new FoV'+(x.maxNew>1?'s':'')+' reached: the '+x.label+' region is not completely covered.':
    'No further candidate position covers the residual area: the '+x.label+' region is not completely covered.';}
  const outdated=document.createElement('p');outdated.className='cv-cr-outdated';outdated.id='cv-cr-outdated';outdated.hidden=true;
  outdated.textContent='The plan changed after this tiling: the values above describe the plan as generated.';
  box.replaceChildren(list,note,outdated);box.hidden=false;
  credibleSummaryPlan=state.pointings.map(p=>p.id).join('|');
}
window.addEventListener('vst-coverage-sequence-updated',()=>{
  const note=$('cv-cr-outdated');if(!note||credibleSummaryPlan==null)return;
  note.hidden=state.pointings.map(p=>p.id).join('|')===credibleSummaryPlan;
});
async function credibleTiling(token){
  const T=window.CredibleRegionTiling;if(!T)throw Error('Credible-region tiling module is not loaded.');
  const key=$('cv-cr-level').value,label=CREDIBLE_LEVELS[key];if(!label)throw Error('Choose the 10%, 50% or 90% credible region.');
  const level=Number(key),maxNew=readCredibleMax(),cfg=getConfig();
  const fov={shape:cfg.shape,width:cfg.width,height:cfg.height,radius:cfg.radius,pa:cfg.pa};
  lockOrders();const probOrder=orders().prob;
  const existing=state.pointings.slice(),stop=()=>token!==state.session;
  info('Credible-region tiling '+label+': selecting up to '+maxNew+' new FoVs in the region from the loaded BAYESTAR…');await nextPaint();
  // shortlist: the module default (exact re-scoring of the best 8 estimates of each step).
  const result=await T.plan({posterior:state.posterior,level,fov,accepted:existing,maxNew,probOrder,
    shouldStop:stop,progress:(v,phase)=>{if(!stop())updateWorkProgress(v,phase);}});
  if(stop()||!result)return;
  const stamp=Date.now(),origin='BAYESTAR '+label+' credible-region tiling';
  const plan=existing.concat(result.fovs.map((f,k)=>({...fov,ra:f.ra,dec:f.dec,id:'cr-'+stamp+'-'+k,origin})));
  let metrics=[];
  if(result.fovs.length){
    info('Credible-region tiling '+label+': '+result.fovs.length+' FoVs selected; computing the official P(FoV), P(new), P(cum)…');
    metrics=await sequenceMetrics(plan,existing.length,token,'Official P(FoV), P(new), P(cum)');if(!metrics)return;
  }
  updateWorkProgress(0,'Probability covered inside the region');await nextPaint();
  const regionCovered=await T.regionCoveredProbability(result.region,plan,probOrder,stop);
  if(stop()||regionCovered==null)return;
  if(result.fovs.length)commitPlan(plan,existing.length,metrics);
  const last=result.fovs.length?metrics[metrics.length-1]:existing.length?existing[existing.length-1].metrics:null;
  showCredibleSummary(result,{label,maxNew,existing:existing.length,regionCovered,officialPcum:last?last.pCum:0,probOrder});
  const c=result.coverage,percent=c.complete?'100.00':(Math.floor(c.fraction*1e4)/100).toFixed(2);
  if(!result.fovs.length){info('Credible-region tiling '+label+': the accepted FoVs already cover the region at HEALPix order '+result.sampleOrder+'; no FoV added.');return;}
  info('Credible-region tiling '+label+': '+result.fovs.length+' new FoV'+(result.fovs.length>1?'s':'')+' added; region covered '+percent+' % at HEALPix order '+result.sampleOrder+
    (c.complete?'.':result.stop==='limit'?'; limit of '+maxNew+' reached before the region was covered.':'; no further candidate covers the residual area.')+
    ' Greedy heuristic: no global optimality is claimed.');
}
/* Cover BAYESTAR credible region, observational mode (scripts/observational-contiguous-tiling.js). Same transactional
 * publication as Probability first: the plan, its official metrics, the observational path and the summary are
 * published together after every calculation has ended; "Interrompi" or an error publishes nothing. */
const OBS_BEHAVIOR={strict:'Strict contiguous',balanced:'Balanced — probability and continuity'};
const MOVE_TEXT={contiguous:'contiguous',reposition:'reposition in the same component',jump:'jump to another component',start:'start'};
state.observationalPath=null;
let pathLayers=[];
function readObservationalOverlap(){
  const O=window.ObservationalTiling,v=Number($('cv-obs-overlap').value);
  if(!O||!O.OVERLAP_CHOICES.includes(v))throw Error('Area overlap must be 0–50% in steps of 5%.');
  return v;
}
function readAlpha(){
  const raw=String($('cv-obs-alpha').value).trim(),v=Number(raw);
  if(raw===''||!Number.isFinite(v)||v<0||v>1)throw Error('α must be a number from 0 to 1.');
  return v;
}
const two=n=>String(n).padStart(2,'0');
function overlapText(o){return o?(100*o.lo).toFixed(2)+'–'+(100*o.hi).toFixed(2)+' %':'—';}
function moveLine(m,first){
  const to=two(first+m.index+1),from=m.index||first?two(first+m.index):null;
  if(m.kind==='start')return to+' · start'+(from&&m.distance!=null?' ('+m.distance.toFixed(2)+'° from FoV '+from+', not part of the path)':'');
  let text=to+' ← '+from+' · '+MOVE_TEXT[m.kind];
  if(m.kind==='contiguous')text+=' '+m.direction+(m.overlap&&m.contact==null?' · overlap '+overlapText(m.overlap):'')+(m.contact?' · contact'+(m.contact.cornerA&&m.contact.cornerB?' vertex–vertex':m.contact.cornerA||m.contact.cornerB?' at a vertex':'')+' (gap ≤ '+m.contact.gap.toExponential(1)+'°)':'');
  if(m.branchOf!=null)text+=' (contiguous '+m.direction+' to FoV '+two(first+m.branchOf+1)+')';
  if(m.distance!=null)text+=' · '+m.distance.toFixed(2)+'°';
  if(m.long)text+=' · long move';
  if(m.touchesPrevious)text+=' · touches FoV '+from+' (overlap not controlled)';
  return text;
}
function showObservationalSummary(r,x){
  const box=$('cv-cr-summary'),c=r.coverage,o=r.observational,list=document.createElement('dl');
  const percent=c.complete?'100.00':(Math.floor(c.fraction*1e4)/100).toFixed(2);
  const share=r.region.probability>0?' ('+(100*x.regionCovered/r.region.probability).toFixed(2)+' % of the region)':'';
  const k=o.counts,stops={complete:'Region covered at HEALPix order 9.',limit:'Limit of '+x.maxNew+' new FoV'+(x.maxNew>1?'s':'')+' reached.','no-candidates':'No further position covers the residual area.'};
  const rows=[
    ['Credible region',x.label+' · '+r.region.count.toLocaleString('en-US')+' cells of the loaded BAYESTAR · P = '+pct(r.region.probability)],
    ['Coverage mode','Observational — contiguous FoVs · '+OBS_BEHAVIOR[o.behavior]+(o.behavior==='balanced'?' (α = '+o.alpha+')':'')+(o.startFromLastAccepted?' · starts contiguous to the last accepted FoV':'')],
    ['Area overlap',o.overlapPercent===0?'0 % requested: FoVs in contact (edge, vertex or tangent), proved within '+o.contactToleranceDeg+'°':
      o.overlapPercent+' % of the previous FoV area requested; accepted '+o.overlapPercent+'–'+(o.overlapPercent+o.overlapTolerancePP)+' %'],
    ['New FoVs generated',r.fovs.length+' (maximum '+x.maxNew+')'+(x.existing?' · '+x.existing+' accepted FoV'+(x.existing>1?'s':'')+' counted as covered':'')],
    ['Region area',area(c.regionArea)],
    ['Covered area',area(c.covered)+' · '+percent+' %'],
    ['Residual area',area(c.residual)],
    ['P covered inside the region',pct(x.regionCovered)+share],
    ['Official P(cum), whole BAYESTAR',pct(x.officialPcum)],
    ['Moves',k.contiguous+' contiguous · '+k.reposition+' reposition'+(k.reposition===1?'':'s')+' in the same component · '+k.jump+' jump'+(k.jump===1?'':'s')+' to another component'],
    ['Effective overlap of contiguous moves',!k.contiguous?'—':o.overlapRange?(100*o.overlapRange.lo).toFixed(2)+'–'+(100*o.overlapRange.hi).toFixed(2)+' % (verified bounds)':
      'contact, largest proved gap '+(o.maxContactGap||0).toExponential(1)+'°'],
    ['Total angular distance',o.pathLength.toFixed(2)+'° · '+k.long+' move'+(k.long===1?'':'s')+' longer than 3 FoV diagonals ('+o.longMoveThreshold.toFixed(2)+'°)'],
    ['BAYESTAR components',o.components.visited.length+' of '+o.components.count+' visited (HEALPix order 9, pixels sharing an edge or a vertex)'],
    ['Stop',stops[r.stop]||r.stop],
    ['Geometric resolution','HEALPix order '+r.sampleOrder+' sample cells ('+r.sampleCellArea.toFixed(4)+' deg²); probabilities at HEALPix order '+x.probOrder]];
  for(const [key,v] of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=v;list.append(dt,dd);}
  const notes=document.createElement('p');notes.className='cv-cr-note';
  notes.textContent='Angular distance is not telescope slew time. FoVs touching only at a vertex are contiguous but do not guarantee gap-free coverage. Greedy heuristic: no global optimality is claimed.';
  const note=document.createElement('p');
  if(c.complete){note.className='cv-cr-done';note.textContent='Region covered at HEALPix order '+r.sampleOrder+': every sample cell lies inside an accepted FoV.';}
  else{note.className='cv-cr-warning';note.textContent=r.stop==='limit'?
    'Limit of '+x.maxNew+' new FoV'+(x.maxNew>1?'s':'')+' reached: the '+x.label+' region is not completely covered.':
    'No further candidate position covers the residual area: the '+x.label+' region is not completely covered.';}
  const details=document.createElement('details');details.className='cv-obs-moves';
  const summary=document.createElement('summary');summary.textContent='Moves ('+o.moves.length+')';
  const ol=document.createElement('ol');
  for(const m of o.moves){const li=document.createElement('li');li.textContent=moveLine(m,x.existing);li.dataset.kind=m.kind;ol.appendChild(li);}
  details.append(summary,ol);
  const outdated=document.createElement('p');outdated.className='cv-cr-outdated';outdated.id='cv-cr-outdated';outdated.hidden=true;
  outdated.textContent='The plan changed after this tiling: the values above describe the plan as generated; the path is no longer shown.';
  box.replaceChildren(list,note,notes,details,outdated);box.hidden=false;
  credibleSummaryPlan=state.pointings.map(p=>p.id).join('|');
}
// The path describes the plan as generated: it disappears as soon as the plan changes (ids or order).
function observationalPathCurrent(){
  const path=state.observationalPath;
  return !!path&&path.signature===state.pointings.map(p=>p.id).join('|');
}
function removePathLayers(){
  for(const layer of pathLayers){
    try{if(layer.kind==='catalog'&&typeof state.aladin?.removeCatalog==='function')state.aladin.removeCatalog(layer.layer);else state.aladin?.removeOverlay?.(layer.layer);}
    catch(error){console.warn('Path overlay removal:',error);}
  }
  pathLayers=[];
}
const PATH_STYLE={contiguous:{color:'#38bdf8',lineDash:[]},reposition:{color:'#fbbf24',lineDash:[9,6]},jump:{color:'#f472b6',lineDash:[3,5]}};
// GW Tiling planner moves drawn with the same styles: a branch moves the telescope back inside the same target
// (as a reposition), a transfer goes to another target (as a jump).
PATH_STYLE.branch=PATH_STYLE.reposition;PATH_STYLE.transfer=PATH_STYLE.jump;
function greatCircle(a,b){
  const u=M.vec(a.ra,a.dec),v=M.vec(b.ra,b.dec),d=Math.acos(Math.max(-1,Math.min(1,u[0]*v[0]+u[1]*v[1]+u[2]*v[2]))),n=Math.max(1,Math.min(90,Math.ceil(d*M.DEG)));
  const out=[];
  for(let k=0;k<=n;k++){const t=k/n,s=Math.sin(d)||1,wa=d?Math.sin((1-t)*d)/s:1-t,wb=d?Math.sin(t*d)/s:t,p=[0,1,2].map(i=>wa*u[i]+wb*v[i]);
    out.push([((Math.atan2(p[1],p[0])*M.DEG)%360+360)%360,Math.asin(Math.max(-1,Math.min(1,p[2]/Math.hypot(...p))))*M.DEG]);}
  return out;
}
// Display only: segments between consecutive FoVs of the path (style by kind of move, thicker when longer than three
// FoV diagonals), order numbers at the FoV centres and the angular distance of each move at its midpoint. It never
// changes FoVs, metrics or results.
let pathError=null;
function renderObservationalPath(){
  removePathLayers();pathError=null;
  const legend=$('cv-path-legend'),path=observationalPathCurrent()?state.observationalPath:null;
  if(!path){legend.hidden=true;legend.textContent='';if(state.observationalPath&&!observationalPathCurrent())state.observationalPath=null;return;}
  legend.hidden=false;
  legend.textContent=(path.legend||'Path: solid = contiguous · dashed = reposition in the same component · dotted = jump to another component · thicker = longer than 3 FoV diagonals')+' · total angular distance '+path.pathLength.toFixed(2)+'° (not slew time)'+($('cv-show-path').checked?'':' · hidden');
  if(!$('cv-show-path').checked||!state.A||!state.aladin)return;
  try{
    const byStyle=new Map();
    for(const m of path.moves){
      if(m.kind==='start'||!m.from)continue;
      const key=m.kind+(m.long?':long':'');if(!byStyle.has(key))byStyle.set(key,[]);
      byStyle.get(key).push(m);
    }
    for(const [key,moves] of byStyle){
      const [kind,long]=key.split(':'),style=PATH_STYLE[kind];
      const layer=state.A.graphicOverlay({name:'Observational path · '+kind,color:style.color,lineWidth:long?4:2,lineDash:style.lineDash});
      const shapes=moves.map(m=>state.A.polyline(greatCircle(m.from,m.to),{color:style.color,lineWidth:long?4:2,lineDash:style.lineDash}));
      // Aladin Lite redraws on add(): the overlay must be attached to the view first.
      state.aladin.addOverlay(layer);pathLayers.push({kind:'overlay',layer});
      if(typeof layer.add==='function')for(const shape of shapes)layer.add(shape);else layer.addFootprints(shapes);
    }
    const order=state.A.catalog({name:'Observational path · order',color:'#e2e8f0',sourceSize:7,shape:'circle',displayLabel:true,labelColumn:'label',labelColor:'#f8fafc',labelFont:'12px sans-serif'});
    order.addSources(path.moves.map(m=>state.A.source(m.to.ra,m.to.dec,{label:two(path.first+m.index+1)})));
    state.aladin.addCatalog(order);pathLayers.push({kind:'catalog',layer:order});
    const midpoints=path.moves.filter(m=>m.kind!=='start'&&m.from&&m.distance!=null).map(m=>{const u=M.vec(m.from.ra,m.from.dec),v=M.vec(m.to.ra,m.to.dec),p=[0,1,2].map(i=>u[i]+v[i]),r=Math.hypot(...p)||1;
      return state.A.source(((Math.atan2(p[1],p[0])*M.DEG)%360+360)%360,Math.asin(Math.max(-1,Math.min(1,p[2]/r)))*M.DEG,{label:m.distance.toFixed(2)+'°'});});
    if(midpoints.length){
      const distances=state.A.catalog({name:'Observational path · distances',color:'#fde68a',sourceSize:3,shape:'circle',displayLabel:true,labelColumn:'label',labelColor:'#fde68a',labelFont:'10px sans-serif'});
      distances.addSources(midpoints);state.aladin.addCatalog(distances);pathLayers.push({kind:'catalog',layer:distances});
    }
  }catch(error){
    console.warn('Observational path display:',error);removePathLayers();pathError=error.message||String(error);
    info('The observational path could not be drawn in Aladin: '+pathError+'. The plan is not affected.','error');
  }
}
function observationalExport(){
  if(!observationalPathCurrent())return null;
  const path=state.observationalPath,ids=state.pointings.map(p=>p.id);
  if(typeof path.exportPlan==='function')return path.exportPlan(ids);// GW Tiling planner (scripts/gw-tiling-panel.js)
  return {...path.metadata,totalAngularDistanceDeg:path.pathLength,
    moves:path.moves.map(m=>({to:ids[path.first+m.index],position:path.first+m.index+1,from:m.index||path.first?ids[path.first+m.index-1]:null,kind:m.kind,
      direction:m.direction,branchOf:m.branchOf==null?null:ids[path.first+m.branchOf],angularDistanceDeg:m.distance,longMove:m.long,
      areaOverlapPercentBounds:m.overlap&&!m.contact?[100*m.overlap.lo,100*m.overlap.hi]:null,areaOverlapPercentEstimate:m.overlap&&!m.contact?100*m.overlap.est:null,
      contactGapDegAtMost:m.contact?m.contact.gap:null,touchesPrevious:m.touchesPrevious??null}))};
}
window.addEventListener('vst-coverage-sequence-updated',()=>{if(state.observationalPath&&!observationalPathCurrent()){state.observationalPath=null;renderObservationalPath();}});
async function observationalTiling(token){
  const O=window.ObservationalTiling,T=window.CredibleRegionTiling;if(!O||!T)throw Error('Observational tiling module is not loaded.');
  const key=$('cv-cr-level').value,label=CREDIBLE_LEVELS[key];if(!label)throw Error('Choose the 10%, 50% or 90% credible region.');
  const level=Number(key),maxNew=readCredibleMax(),cfg=getConfig(),overlap=readObservationalOverlap();
  const behavior=$('cv-obs-behavior').value;if(!OBS_BEHAVIOR[behavior])throw Error('Choose Strict contiguous or Balanced.');
  const alpha=behavior==='balanced'?readAlpha():0,fromLast=$('cv-obs-from-last').checked;
  const fov={shape:cfg.shape,width:cfg.width,height:cfg.height,radius:cfg.radius,pa:cfg.pa};
  lockOrders();const probOrder=orders().prob;
  const existing=state.pointings.slice(),stop=()=>token!==state.session;
  info('Observational tiling '+label+' ('+OBS_BEHAVIOR[behavior]+', area overlap '+overlap+'%): selecting up to '+maxNew+' new FoVs…');await nextPaint();
  const result=await O.plan({posterior:state.posterior,level,fov,accepted:existing,maxNew,behavior,alpha,overlap,startFromLastAccepted:fromLast,probOrder,
    shouldStop:stop,progress:(v,phase)=>{if(!stop())updateWorkProgress(v,phase);}});
  if(stop()||!result)return;
  const stamp=Date.now(),origin='BAYESTAR '+label+' observational tiling';
  const plan=existing.concat(result.fovs.map((f,k)=>({...fov,ra:f.ra,dec:f.dec,id:'otile-'+stamp+'-'+k,origin})));
  let metrics=[];
  if(result.fovs.length){
    info('Observational tiling '+label+': '+result.fovs.length+' FoVs selected; computing the official P(FoV), P(new), P(cum)…');
    metrics=await sequenceMetrics(plan,existing.length,token,'Official P(FoV), P(new), P(cum)');if(!metrics)return;
  }
  updateWorkProgress(0,'Probability covered inside the region');await nextPaint();
  const regionCovered=await T.regionCoveredProbability(result.region,plan,probOrder,stop);
  if(stop()||regionCovered==null)return;
  // Publication: plan, path and summary in one synchronous step.
  if(result.fovs.length)commitPlan(plan,existing.length,metrics);
  const o=result.observational;
  state.observationalPath=result.fovs.length?{signature:plan.map(p=>p.id).join('|'),first:existing.length,pathLength:o.pathLength,
    moves:o.moves.map((m,k)=>({...m,to:{ra:result.fovs[k].ra,dec:result.fovs[k].dec}})),
    metadata:{mode:'Observational — contiguous FoVs',behavior:o.behavior,alpha:o.alpha,credibleRegion:label,areaOverlapPercent:o.overlapPercent,
      areaOverlapDefinition:'Omega(previous FoV ∩ next FoV) / Omega(previous FoV), solid angles of the CoverageMath.inside() footprints',
      overlapTolerancePercentagePoints:o.overlapTolerancePP,contactToleranceDeg:o.contactToleranceDeg,startFromLastAcceptedFoV:o.startFromLastAccepted,
      longMoveThresholdDeg:o.longMoveThreshold,stop:result.stop,componentsVisited:o.components.visited.length,components:o.components.count,
      note:'Planning metadata of the generated sequence. Angular distance is not telescope slew time. FoVs touching only at a vertex are contiguous but do not guarantee gap-free coverage.'}}:null;
  renderObservationalPath();
  const last=result.fovs.length?metrics[metrics.length-1]:existing.length?existing[existing.length-1].metrics:null;
  showObservationalSummary(result,{label,maxNew,existing:existing.length,regionCovered,officialPcum:last?last.pCum:0,probOrder});
  const c=result.coverage,percent=c.complete?'100.00':(Math.floor(c.fraction*1e4)/100).toFixed(2);
  if(!result.fovs.length){info('Observational tiling '+label+': the accepted FoVs already cover the region at HEALPix order '+result.sampleOrder+'; no FoV added.');return;}
  info('Observational tiling '+label+': '+result.fovs.length+' new FoV'+(result.fovs.length>1?'s':'')+' added ('+o.counts.contiguous+' contiguous, '+o.counts.reposition+' repositions, '+o.counts.jump+' jumps; '+o.pathLength.toFixed(2)+'° in total); region covered '+percent+' % at HEALPix order '+result.sampleOrder+'. Greedy heuristic: no global optimality is claimed.'+
    (pathError?' The path could not be drawn in Aladin ('+pathError+'); the plan is not affected.':''),pathError?'error':'');
}
const autoTiling=guarded(async(token)=>{
  if(!state.posterior)throw Error('Load BAYESTAR PROBDENSITY first');
  if(!requireReady())return;
  if($('cv-tile-mode').value==='credible'){if($('cv-cr-mode').value==='observational')await observationalTiling(token);else await credibleTiling(token);return;}
  const region=$('cv-region').value;
  if(['atlasN','atlasS','kidsN','kidsS','kidsW2','ipn','grb'].includes(region)&&!state.mocs[region])throw Error('Region MOC '+region+' not available. Import it in the left sidebar.');
  const number=Math.min(8,Math.max(1,Number($('cv-tile-count').value)||3)),cfg=getConfig();
  const strategy=$('cv-tile-mode').value;
  if(strategy==='peaks'){
    const cells=state.posterior.cells.filter(p=>p.p>0&&centerWithinRegion(p,region));
    if(!cells.length)throw Error('Selected region contains no probability cells.');
    cells.sort((a,b)=>b.p*Math.pow(4,b.order)-a.p*Math.pow(4,a.order)); // density ranking
    const candidates=[];
    const minSep=(cfg.shape==='circle'?cfg.radius:Math.min(cfg.width,cfg.height)/2)*0.55;
    for(const c of cells){
      const separated=candidates.every(q=>{const a=M.vec(c.ra,c.dec),b=M.vec(q.ra,q.dec);return Math.acos(Math.max(-1,Math.min(1,a[0]*b[0]+a[1]*b[1]+a[2]*b[2])))*M.DEG>minSep;});
      if(separated)candidates.push(c);
      if(candidates.length>=32)break;
    }
    const used=new Set();let added=0;
    for(let k=0;k<number;k++){
      let best=null;
      for(let i=0;i<candidates.length;i++){
        if(used.has(i))continue;
        const c={...cfg,ra:candidates[i].ra,dec:candidates[i].dec};
        info(`Tiling ${region}: FoV ${k+1}/${number}, candidate ${i+1}/${candidates.length}…`);
        await nextPaint();
        const metrics=await calcResponsive(c,state.pointings,'prob',token);
        if(token!==state.session||!metrics)return;
        if(!best||metrics.pNew>best.metrics.pNew)best={c,metrics,i};
      }
      if(!best||best.metrics.pNew<1e-12)break;
      used.add(best.i);
      const metrics=await calcResponsive(best.c,state.pointings,'all',token);if(token!==state.session||!metrics)return;
      state.pointings.push({...best.c,id:'auto-'+Date.now()+'-'+k,metrics});
      added++;renderSequence();refreshOverlays();notifySequenceUpdated();
    }
    invalidateCoverageMoc();
    info(`Greedy tiling completed: ${added} FoVs added in region “${$('cv-region').selectedOptions[0].text}”. Local heuristic, not a globally optimal tiling.`);
    return;
  }
  // Adjacent greedy: each new FoV advances exactly one selected overlap step
  // from the PREVIOUS accepted field. Search the four cardinal directions
  // only, so neither corner-only circle placements nor distant peaks can skip
  // intermediate observations. Users can still pick any of eight directions
  // manually; the legacy global-peak search remains available above.
  let base=state.pointings.length?state.pointings[state.pointings.length-1]:cfg;
  let added=0;
  const directions=['N','E','S','W'];
  const visited=new Set(state.pointings.map(p=>`${p.ra.toFixed(7)}:${p.dec.toFixed(7)}`));
  if(!state.pointings.length){
    const metrics=await calcResponsive(base,state.pointings,'all',token);if(token!==state.session||!metrics)return;
    state.pointings.push({...base,id:'auto-seed-'+Date.now(),metrics});
    visited.add(`${base.ra.toFixed(7)}:${base.dec.toFixed(7)}`);
    added++;renderSequence();refreshOverlays();notifySequenceUpdated();notifySequenceUpdated();
  }
  for(let k=added;k<number;k++){
    let best=null;
    for(const dir of directions){
      const c=shifted(base,dir),key=`${c.ra.toFixed(7)}:${c.dec.toFixed(7)}`;
      if(visited.has(key))continue;
      // Keep every contiguous neighbour eligible; evaluate sky probability
      // using the selected adaptive integration order, not a coarse cell-center test.
      if(region==='north'&&c.dec<0||region==='south'&&c.dec>=0)continue;
      if(!['all','north','south'].includes(region)&&!M.mocContains(state.mocs[region],c.ra,c.dec))continue;
      info(`Adjacent greedy: FoV ${k+1}/${number}, direction ${dir}…`);await nextPaint();
      const metrics=await calcResponsive(c,state.pointings,'prob',token);
      if(token!==state.session||!metrics)return;
      if(!best||metrics.pNew>best.metrics.pNew)best={dir,c,metrics,key};
    }
    if(!best||best.metrics.pNew<=1e-12)break;
    const metrics=await calcResponsive(best.c,state.pointings,'all',token);if(token!==state.session||!metrics)return;
    state.pointings.push({...best.c,id:'adj-'+Date.now()+'-'+k,metrics});
    visited.add(best.key);base=best.c;added++;renderSequence();refreshOverlays();notifySequenceUpdated();notifySequenceUpdated();
  }
  invalidateCoverageMoc();
  info(`Adjacent greedy completed: ${added} FoVs added, each new pointing one ${$('cv-overlap-x').value}%/${$('cv-overlap-y').value}% overlap step from the previous FoV (N/E/S/W). No remote peaks/skipped pointings.`);
});
function validMocJson(x){
  if(typeof x==='string')x=JSON.parse(x);
  if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Aladin returned invalid MOC JSON');
  const out={};let total=0;
  for(const [key,raw] of Object.entries(x)){
    if(!/^\d+$/.test(key)||Number(key)>25||!Array.isArray(raw))throw Error('Unsupported MOC JSON format: '+key);
    const vals=raw.map(Number);
    if(vals.some(v=>!Number.isSafeInteger(v)||v<0))throw Error('MOC pixel out of range');
    out[key]=vals;total+=vals.length;
  }
  if(!total)throw Error('Empty MOC');
  return out;
}
function unionMocJson(mocs){
  // Pixel-level Set deduplication is NOT a valid MOC union: different FoVs
  // can contain an ancestor cell and its descendants at different orders.
  // Normalize the complete nested coverage before passing it to Aladin WASM.
  const canonical=window.CoverageMocCanonical;
  if(!canonical)throw Error('Coverage MOC canonicalizer is not loaded');
  const merged=canonical.union(mocs);
  if(!canonical.isCanonical(merged))throw Error('Generated coverage MOC failed canonical validation');
  return merged;
}
function waitForPolygonMoc(p,idx){
  return new Promise((resolve,reject)=>{
    let temporary;
    try{
      temporary=state.A.MOCFromPolygon(M.polygon(p),
        {name:'Temporary FoV '+(idx+1),color:'#55aabb',fill:false,opacity:0},
        moc=>{try{const json=validMocJson(moc.serialize('json'));resolve(json);}catch(e){reject(e);}finally{setTimeout(()=>remove(moc),0);}},
        ()=>{remove(temporary);reject(Error('MOC conversion failed for FoV '+(idx+1)));});
      state.aladin.addMOC(temporary);
    }catch(error){remove(temporary);reject(error);}
  });
}
const createCoverageMoc=guarded(async(token)=>{
  if(!requireReady())return;
  if(!state.pointings.length)throw Error('Accept at least one geometric FoV before creating the MOC');
  const originals=state.pointings.slice();
  info('Creating MOC: rasterizing '+originals.length+' geometric fields with the Aladin WASM backend…');
  const parts=[];
  for(let i=0;i<originals.length;i++){
    const json=await waitForPolygonMoc(originals[i],i);
    if(token!==state.session)return;
    parts.push(json);
  }
  const merged=unionMocJson(parts);
  const mocColor=$('cv-moc-color').value, mocOpacity=Number($('cv-moc-opacity').value)/100;
  const moc=state.A.MOCFromJSON(merged,
    {name:'Coverage MOC · '+originals.length+' FoV',color:mocColor,fillColor:mocColor,fill:true,opacity:mocOpacity,perimeter:true,lineWidth:2},
    layer=>{
      // Label only. Aladin Lite 3.9 invokes this callback just BEFORE it stores the sky
      // fraction of the new MOC, so reading it here gave "NaN deg²". Read it on the next
      // task; if it is still not a number, show the area of the same MOC JSON instead.
      setTimeout(()=>{
        if(state.coverageMocLayer!==layer)return;
        const fraction=Number(layer.skyFraction?.());
        const areaDeg2=Number.isFinite(fraction)?fraction*M.SKY:M.areaDeg2(merged);
        $('cv-moc-result').textContent='MOC produced · '+originals.length+' FoV · '+areaDeg2.toFixed(3)+' deg²';
      },0);
    },
    ()=>info('Could not publish coverage MOC in Aladin','error'));
  if(state.coverageMocLayer)remove(state.coverageMocLayer);
  state.coverageMocJSON=merged;state.coverageMocLayer=moc;
  $('cv-moc-color').disabled=false;$('cv-moc-opacity').disabled=false;
  applyGeneratedMocStyle();window.dispatchEvent(new CustomEvent('vst-coverage-moc-created',{detail:{json:merged}}));
  state.aladin.addMOC(moc);
  $('cv-moc-export').disabled=false;$('cv-moc-fits').disabled=false;
  $('cv-moc-result').textContent='MOC published in Aladin · '+originals.length+' FoV · available for JSON export';
  info('MOC created from accepted fields using A.MOCFromPolygon + A.MOCFromJSON (WASM Aladin), separately from the FoV geometry.');
});
function applyGeneratedMocStyle(){
  const layer=state.coverageMocLayer;
  if(!layer)return;
  const color=$('cv-moc-color').value, opacity=Number($('cv-moc-opacity').value)/100;
  try{layer.color=color;layer.fillColor=color;layer.opacity=opacity;}
  catch(error){info('Generated MOC appearance: '+error.message,'error');}
}
for(const id of ['cv-moc-color','cv-moc-opacity']) $(id).addEventListener('input',()=>{
  $('cv-moc-opacity-value').textContent=$('cv-moc-opacity').value+'%';
  applyGeneratedMocStyle();
});
function exportCoverageMocFits(){
  if(!state.coverageMocJSON){info('Create the MOC region first','error');return;}
  try{
    const fits=window.CoverageMocFits.toFits(state.coverageMocJSON);
    download('accepted_coverage_moc.fits',fits,'application/fits');
    info('MOC exported as FITS NUNIQ.');
  }catch(error){info('FITS export: '+error.message,'error');}
}
function exportCoverageMoc(){
  if(!state.coverageMocJSON){info('Create the MOC region first','error');return;}
  download('accepted_coverage_moc.json',JSON.stringify(state.coverageMocJSON,null,2),'application/json');
  info('Coverage MOC exported in IVOA JSON (not FITS).');
}
function download(name,content,mime){const url=URL.createObjectURL(new Blob([content],{type:mime})),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function exportCSV(){const header=['position','ra_deg','dec_deg','shape','width_deg','height_deg','radius_deg','pa_deg','p_fov_estimate','p_new_estimate','p_cum_estimate','area_new_gw90_deg2_estimate'];
  const lines=[header.join(',')];state.pointings.forEach((p,i)=>{const m=p.metrics||{},fields=[i+1,p.ra,p.dec,p.shape,p.width,p.height,p.radius,p.pa,m.pFoV??'',m.pNew??'',m.pCum??'',m.a90New??''];lines.push(fields.join(','));});
  download('coverage_plan.csv',lines.join('\n')+'\n','text/csv');info('Exported coverage_plan.csv.');}
function exportJSON(){const observational=observationalExport();download('coverage_plan.json',JSON.stringify({tool:'Standalone Coverage LAB',source:'Aladin Lite v3/latest (CDS)',probabilityFile:state.mapFile||null,quantities:'FoV probability from adaptive HEALPix native-cell refinement at selected order; approximate boundary-area fractions (not 3D)',pointings:state.pointings.map(p=>({...p,polygon:M.polygon(p)})),...(observational?{observationalPlan:observational}:{})},null,2),'application/json');info('Exported coverage_plan.json.');}
window.addEventListener('vst-moc-imported',ev=>{const {key,json}=ev.detail;state.mocs[key]=json;if(key==='gw50'||key==='gw90'){state.samples=null;window.CoverageWorkerClient?.invalidate();}for(const k of Object.keys(regionCache))if(k.startsWith(key+'@'))delete regionCache[k];
  updateSurveyStats();info('Coverage: MOC '+key+' updated; area and probability recalculated.');});
window.addEventListener('vst-aladin-ready',ev=>{state.A=ev.detail.A;state.aladin=ev.detail.aladin;refreshOverlays();renderObservationalPath();info('Aladin Lite ready. Select a shape and preview a FoV.');});
$('cv-import-map').addEventListener('click',()=>{$('cv-map-file').value='';$('cv-map-file').click();});
$('cv-map-file').addEventListener('change',importPosterior);
async function loadEventPosteriorFromLocalScript(){
  const encoded=window.GRAWITA_EVENT_BAYESTAR_B64;
  if(!encoded){info('Default BAYESTAR bundle missing: import a local FITS manually.','error');return;}
  try{
    const bytes=Uint8Array.from(atob(encoded),ch=>ch.charCodeAt(0));
    const decoded=M.decodePosterior(bytes.buffer);
    state.posterior=decoded;state.mapFile=window.GRAWITA_EVENT_BAYESTAR_NAME||'bayestar.multiorder.fits,1';window.GRAWITA_CURRENT_POSTERIOR=decoded;
    window.dispatchEvent(new CustomEvent('vst-posterior-loaded',{detail:{posterior:decoded,fileName:state.mapFile}}));
    clearPreview();state.fineOrigin=null;refreshOverlays();updateMode();await recalcSequence();updateSurveyStats();
    info('Default BAYESTAR loaded: '+state.mapFile+' · '+decoded.tableRows.toLocaleString('en-US')+' cells · P(inside) order '+$('cv-prob-order').value+'.');
  }catch(error){info('Default BAYESTAR loading failed: '+error.message+'; manual FITS import remains available.','error');}
}
// Start from embedded local FITS even when the external Aladin service is down.
// Aladin initialization remains an independent later step for sky rendering.
setTimeout(loadEventPosteriorFromLocalScript,0);
$('cv-preview').addEventListener('click',preview);$('cv-accept').addEventListener('click',accept);$('cv-best').addEventListener('click',bestNext);
$('cv-undo').addEventListener('click',undo);$('cv-delete-selected').addEventListener('click',deleteSelected);$('cv-clear').addEventListener('click',clear);
$('cv-export-csv').addEventListener('click',exportCSV);$('cv-export-json').addEventListener('click',exportJSON);
$('cv-create-moc').addEventListener('click',createCoverageMoc);$('cv-moc-export').addEventListener('click',exportCoverageMoc);$('cv-moc-fits').addEventListener('click',exportCoverageMocFits);
// Read the actual viewer center, not a default position. Some Aladin releases
// return array-like WASM values while the view is becoming ready.
const waitMs=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function adoptAladinCenter(){
  if(!requireReady())return false;
  for(const delay of [0,80,160,300,500]){
    if(delay)await waitMs(delay);
    const center=window.GRAWITAReadAladinCenter?.() || null;
    if(center){
      putCenter(center);state.fineOrigin=null;
      return true;
    }
  }
  info('Aladin has not reported a valid sky center yet. Move or zoom the sky once, then press Center again. No coordinates were substituted.','error');
  return false;
}
$('cv-use-center').addEventListener('click',async()=>{
  if(await adoptAladinCenter())info('Aladin center copied. Press Preview FoV to inspect the field.');
});
$('cv-center-compass').addEventListener('click',async()=>{
  if(await adoptAladinCenter())$('cv-preview').click();
});
// Fine adjustment in arcminutes, strictly separate from telescope tiling/overlap.
const fineDirs={N:[0,1],NE:[1,1],E:[1,0],SE:[1,-1],S:[0,-1],SW:[-1,-1],W:[-1,0],NW:[-1,1]};
const runFine=(reset=false,dir='')=>guarded(async(token)=>{
  if(!requireReady())return;
  let c;
  if(reset){
    if(!state.fineOrigin){info('No fine adjustment to reset.');return;}
    c={...state.fineOrigin};state.fineOrigin=null;
  }else{
    const value=Number($('cv-fine').value);
    if(!Number.isFinite(value)||value<0.1||value>30)throw Error('Fine adjustment must be 0.1–30 arcmin.');
    const base=state.preview?.config || getConfig();
    if(!state.fineOrigin)state.fineOrigin={...base};
    const [dx,dy]=fineDirs[dir];
    const norm=Math.hypot(dx,dy),scale=value/(60*norm);
    c={...base,...M.offset(base,dx*scale,dy*scale)};
  }
  putCenter(c);showPreviewGeometry(c);info('Updating fine-position preview…');await nextPaint();
  const metrics=await calcResponsive(c,state.pointings,'all',token);if(token!==state.session)return;
  completePreview(c,metrics);
  info(reset?'Fine position reset. Preview ready.':`Fine ${dir}: ${$('cv-fine').value} arcmin; preview updated. `+(state.posterior?'P(new) '+pct(metrics.pNew):'New GW90 area '+area(metrics.a90New))+'. Accept to add this position.');
})();
for(const button of document.querySelectorAll('[data-fine-dir]'))
  button.addEventListener('click',()=>runFine(false,button.dataset.fineDir));
$('cv-fine-reset').addEventListener('click',()=>runFine(true));
$('cv-goto').addEventListener('click',()=>{if(!requireReady())return;try{const c=getConfig();state.aladin.gotoRaDec(c.ra,c.dec);state.aladin.setFoV(12);info('Aladin centered at RA '+c.ra.toFixed(4)+'°, Dec '+c.dec.toFixed(4)+'°.');}catch(e){info(e.message,'error');}});
$('cv-show-accepted').addEventListener('change',refreshOverlays);
// Before the first FoV calculation the plan is empty; once locked, any change is reverted and ignored.
$('cv-order').addEventListener('change',()=>{if(lockedOrders){orders();return;}state.samples=null;guarded(async()=>{await recalcSequence();info('Area sample order updated to '+$('cv-order').value+'.');})();});
$('cv-prob-order').addEventListener('change',()=>{if(lockedOrders){orders();return;}clearPreview();refreshOverlays();setBusy(false);guarded(async()=>{await recalcSequence();info('P(inside) integration recalculated at HEALPix order '+$('cv-prob-order').value+'.');})();});
$('cv-autotile').addEventListener('click',autoTiling);
$('cv-tile-mode').addEventListener('change',updateTilingMode);addEventListener('pageshow',updateTilingMode);
for(const id of ['cv-cr-mode','cv-obs-behavior'])$(id).addEventListener('change',updateTilingMode);
updateTilingMode();
$('cv-show-path').addEventListener('change',renderObservationalPath);
for(const id of ['cv-shape','cv-width','cv-height','cv-radius','cv-pa','cv-overlap-x','cv-overlap-y'])
  $(id).addEventListener('input',updateOverlapReadout);
for(const id of ['cv-shape','cv-ra','cv-dec','cv-width','cv-height','cv-radius','cv-pa'])
  $(id).addEventListener('input',()=>{if(state.busy)return;
    if(state.preview||state.draft){clearPreview();refreshOverlays();setBusy(false);
      info('Geometry changed: press Preview FoV to update the outline and probability.');}
  });
updateOverlapReadout();
for(const btn of document.querySelectorAll('[data-cv-dir]'))btn.addEventListener('click',directionPreview(btn.dataset.cvDir));
updateMode();updateSurveyStats();renderSequence();
function applyPresetField(field){
  state.fineOrigin=null;for(const [id,value] of [['cv-shape','rectangle'],['cv-width','1'],['cv-height','1'],['cv-pa','0'],['cv-ra',String(field.ra)],['cv-dec',String(field.dec)]])$(id).value=value;
  $('cv-shape').dispatchEvent(new Event('input',{bubbles:true}));
  putCenter(field);
  if(state.aladin){state.aladin.gotoRaDec(field.ra,field.dec);state.aladin.setFoV(3.2);}
  info('Ready to preview '+field.name+' · 1° × 1° geometric FoV.');
}
// Observatory presets (scripts/observatory-fields.js). A preset already in the sequence is not added again: a FoV is that
// preset only if it was created here (id 'obs-…'), carries the preset name as origin and has exactly the preset geometry
// (strict equality, no rounding). Manual FoVs (other ids, no origin) are never matched, and nothing is removed or reordered.
const presetConfig=f=>({shape:'rectangle',ra:f.ra,dec:f.dec,width:1,height:1,radius:0.5,pa:0});
const isPresetPointing=(p,f)=>{const c=presetConfig(f);return String(p.id).startsWith('obs-')&&p.origin===f.name&&Object.keys(c).every(k=>p[k]===c[k]);};
const addPresetPointings=(fields)=>guarded(async(token)=>{
  if(!requireReady())return;
  const missing=fields.filter(f=>!state.pointings.some(p=>isPresetPointing(p,f)));
  if(!missing.length){info('All '+fields.length+' observatory FoVs are already in the sequence. Nothing added.');return;}
  for(const f of missing){
    const cfg=presetConfig(f);
    M.configValid(cfg);
    const metrics=await calcResponsive(cfg,state.pointings,'all',token);if(token!==state.session||!metrics)return;
    state.pointings.push({...cfg,id:'obs-'+Date.now()+'-'+state.pointings.length+'-'+Math.random().toString(36).slice(2,6),origin:f.name,metrics});
  }
  clearPreview();state.fineOrigin=null;
  commitSequenceChange();
  if(state.pointings.length){state.selectedFoV=state.pointings[state.pointings.length-1].id;refreshOverlays();renderSequence();}
  info(missing.length===fields.length?'Added '+fields.length+' geometric observatory FoVs to the sequence. No MOC created.'
    :'Added '+missing.length+' of '+fields.length+' geometric observatory FoVs to the sequence; '+(fields.length-missing.length)+' already present. No MOC created.');
})();
// GW Tiling planner (scripts/gw-tiling-panel.js, SCI-TILING-REDESIGN-01 stage I-4): it runs as a guarded() action of
// this panel, so it shares the busy flag, the session token, "Interrompi", the official metrics (sequenceMetrics), the
// transactional publication (commitPlan) and the path display. Nothing here changes for the classic strategies.
const gwTiling=Object.freeze({
  run:action=>guarded(action)(),
  isCurrent:token=>token===state.session,
  isBusy:()=>state.busy,
  cancel:cancelCalculation,
  requireReady,lockOrders,orders,sequenceMetrics,commitPlan,info,
  progress:updateWorkProgress,
  setPath(path){state.observationalPath=path;renderObservationalPath();return pathError;}
});
window.CoverageLab={state,calc,calcResponsive,getConfig,recalcSequence,focusFoV,updateOverlapReadout,applyPresetField,addPresetPointings,gwTiling,
  observationalPath:()=>({current:observationalPathCurrent(),layers:pathLayers.map(l=>l.kind)})}; // read-only inspection in browser developer console
})();
