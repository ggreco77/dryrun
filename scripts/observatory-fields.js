/* GRAWITA DRY RUN — Campo Imperatore (3) and Asiago (4) J2000 pointings.
 * Seven independent 1° × 1° GEOMETRIC FoVs. These are NOT MOCs.
 * Visibility, selection and observing-plan insertion are independent actions.
 * Each Aladin polygon is created only once per viewer, then reused with
 * GraphicOverlay.show/hide/setColor/setLineWidth (no overlay churn on toggles).
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const M = window.CoverageMath;
  const groups = {
    campo: {name:'Campo Imperatore',short:'CI',color:'#f4ba63',fields:[[6.886,45.598],[8.112,45.597],[8.117,46.445]]},
    asiago: {name:'Asiago',short:'AS',color:'#63dfc7',fields:[[6.892,45.564],[6.875,46.418],[8.116,46.419],[8.123,45.556]]}
  };
  const states = new Map();
  let A = null, viewer = null, selectedId = null;
  for (const [key,group] of Object.entries(groups)) {
    group.fields = group.fields.map(([ra,dec],i) => ({
      id:key+'-'+(i+1),key,ra,dec,
      name:group.name+' '+String(i+1).padStart(2,'0'),color:group.color
    }));
    for (const field of group.fields) {
      states.set(field.id,{field,visible:false,overlay:null,footprint:null,attached:false});
    }
  }
  const allFields = [...states.values()].map(s=>s.field);
  const config = f=>({shape:'rectangle',ra:f.ra,dec:f.dec,width:1,height:1,radius:0.5,pa:0});
  const count = fields=>fields.reduce((n,f)=>n+(states.get(f.id).visible?1:0),0);
  function status(message){const el=$('statusText');if(el)el.textContent=message;}
  function visibleCount(){return count(allFields);}
  function updateControls(){
    for (const [key,group] of Object.entries(groups)) {
      const n=count(group.fields),input=$('field-'+key);
      if(input){input.checked=n===group.fields.length;input.indeterminate=n>0&&n<group.fields.length;
        input.setAttribute('aria-label',group.name+': '+n+' of '+group.fields.length+' visible; toggle all');}
      const label=$('obs-count-'+key);
      if(label)label.textContent=n+'/'+group.fields.length+' visible';
    }
    const total=$('observatory-visible-count');
    if(total)total.textContent=visibleCount()+'/7 visible';
    for(const s of states.values()) {
      const box=$('obs-check-'+s.field.id);
      if(box)box.checked=s.visible;
      const row=$('obs-row-'+s.field.id);
      if(row){row.classList.toggle('obs-visible',s.visible);
        row.classList.toggle('obs-selected',selectedId===s.field.id);
        row.setAttribute('aria-selected',String(selectedId===s.field.id));}
    }
  }
  function ensureOverlay(s){
    if(!A||!viewer)return;
    if(!s.overlay){
      const p=M.polygon(config(s.field));
      const vertices=p.ra.map((ra,i)=>[ra,p.dec[i]]);
      s.overlay=A.graphicOverlay({name:s.field.name+' · geometric 1° × 1°',color:s.field.color,lineWidth:2.5});
      s.footprint=A.polygon(vertices);
      s.overlay.addFootprints([s.footprint]);
      window.SkyFieldSelection?.registerFootprint(s.footprint,()=>selectField(s.field.id,{fromSky:true}));
    }
    if(!s.attached){viewer.addOverlay(s.overlay);s.attached=true;}
  }
  function setOverlayVisibility(s){
    if(!viewer||!A)return;
    if(s.visible){
      ensureOverlay(s);
      if(typeof s.overlay?.show==='function')s.overlay.show();
    } else if(s.overlay){
      if(typeof s.overlay.hide==='function')s.overlay.hide();
      else if(s.attached){ // fallback for older/nonconforming API, reuses the same overlay
        try{viewer.removeOverlay(s.overlay);s.attached=false;}catch(e){console.warn('Unable to hide FoV:',e);}
      }
    }
  }
  function setStyle(s){
    if(!s?.overlay)return;
    const selected=selectedId===s.field.id;
    const color=selected?'#ffe88e':s.field.color;
    const width=selected?5:2.5;
    if(typeof s.overlay.setColor==='function')s.overlay.setColor(color);
    else {s.overlay.color=color;s.overlay.reportChange?.();}
    if(typeof s.overlay.setLineWidth==='function')s.overlay.setLineWidth(width);
    else {s.overlay.lineWidth=width;s.overlay.reportChange?.();}
    const priority=selected?100:10;
    if(s.visible)window.SkyFieldSelection?.registerGeometry('obs:'+s.field.id,config(s.field),()=>selectField(s.field.id,{fromSky:true}),priority);
  }
  // Batch update: one reconciliation and one status message even when all 7 fields change.
  function setVisible(ids,visible,{silent=false}={}){
    const changed=[];
    for(const id of ids){
      const s=states.get(id);
      if(!s||s.visible===!!visible)continue;
      s.visible=!!visible;
      changed.push(s);
      if(s.visible)window.SkyFieldSelection?.registerGeometry('obs:'+id,config(s.field),()=>selectField(id,{fromSky:true}),selectedId===id?100:10);
      else window.SkyFieldSelection?.unregisterGeometry('obs:'+id);
    }
    const hiddenSelection = selectedId && !states.get(selectedId)?.visible ? states.get(selectedId) : null;
    if(hiddenSelection)selectedId=null;
    for(const s of changed)setOverlayVisibility(s);
    if(hiddenSelection)setStyle(hiddenSelection);
    updateControls();
    if(!silent)status((visible?'Showing ':'Hiding ')+changed.length+' observatory field(s) · '+visibleCount()+'/7 visible.');
    return changed.length;
  }
  function showField(id,visible){
    const s=states.get(id);if(!s)return;
    setVisible([id],visible,{silent:true});
    status(s.field.name+(s.visible?' shown':' hidden')+' · '+visibleCount()+'/7 fields visible.');
  }
  function clearSelection({announce=false}={}){
    const previous=selectedId;selectedId=null;
    if(previous)setStyle(states.get(previous));
    updateControls();
    if(announce)status('No observatory FoV selected · '+visibleCount()+'/7 visible.');
  }
  function selectField(id,options={}){
    const s=states.get(id);if(!s)return;
    // Clicking the same row / FoV twice deselects it, but never hides the field.
    if(selectedId===id && options.allowDeselect!==false){clearSelection({announce:true});return;}
    if(!s.visible)setVisible([id],true,{silent:true});
    const previous=selectedId;selectedId=id;
    if(previous!==id)setStyle(states.get(previous));
    setStyle(s);
    updateControls();
    const row=$('obs-row-'+id);
    if(options.fromSky)row?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});
    // A sky click is already in the right view; do not jump/zoom on every polygon click.
    if(viewer&&!options.fromSky){
      try{viewer.gotoRaDec(s.field.ra,s.field.dec);viewer.setFoV(3.2);}
      catch(error){console.warn('Unable to center FoV:',error);}
    }
    status(s.field.name+' selected · RA '+s.field.ra.toFixed(3)+'°, Dec '+s.field.dec.toFixed(3)+'° · 1° × 1° · '+visibleCount()+'/7 shown.');
  }
  function isolate(ids,{focusId=null}={}){
    const wanted=new Set(ids),toShow=[],toHide=[];
    for(const f of allFields)(wanted.has(f.id)?toShow:toHide).push(f.id);
    // Hide first to keep layer state and selection unambiguous on overlaps.
    setVisible(toHide,false,{silent:true});setVisible(toShow,true,{silent:true});
    if(focusId)selectField(focusId,{allowDeselect:false});
    else if(selectedId && !wanted.has(selectedId))clearSelection();
    status((focusId?states.get(focusId).field.name:'Observatory group')+' only · '+visibleCount()+'/7 visible.');
  }
  function createFieldRow(f,idx,group){
    const row=document.createElement('div');
    row.className='obs-field-row';row.dataset.obsId=f.id;row.id='obs-row-'+f.id;
    row.title='Click to select/deselect; checkbox controls visibility';
    row.tabIndex=0;row.setAttribute('role','option');row.setAttribute('aria-selected','false');
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.id='obs-check-'+f.id;
    checkbox.setAttribute('aria-label','Show '+f.name+' geometric FoV');
    checkbox.addEventListener('change',()=>showField(f.id,checkbox.checked));
    const detail=document.createElement('div');
    detail.innerHTML='<span class="obs-ident">'+group.short+' '+String(idx+1).padStart(2,'0')+'</span><span class="obs-coord">'+f.ra.toFixed(3)+'°, '+f.dec.toFixed(3)+'°</span>';
    const controls=document.createElement('div');controls.className='obs-ops';
    const button=(name,title,handler)=>{
      const btn=document.createElement('button');btn.type='button';btn.textContent=name;btn.title=title;
      btn.addEventListener('click',e=>{e.stopPropagation();handler();});controls.append(btn);
    };
    button('Locate','Select and center this field in Aladin',()=>selectField(f.id,{allowDeselect:false}));
    button('Only','Show this field and hide the other six',()=>isolate([f.id],{focusId:f.id}));
    row.append(checkbox,detail,controls);
    row.addEventListener('click',e=>{if(e.target===checkbox||e.target.closest('button'))return;selectField(f.id);});
    row.addEventListener('keydown',e=>{if(e.target===row&&(e.key==='Enter'||e.key===' ')){e.preventDefault();selectField(f.id);}});
    return row;
  }
  function buildGroup(key){
    const group=groups[key],container=$('observatory-'+key+'-list'),frag=document.createDocumentFragment();
    group.fields.forEach((f,i)=>frag.append(createFieldRow(f,i,group)));
    container.appendChild(frag);
    $('field-'+key)?.addEventListener('change',event=>{
      setVisible(group.fields.map(f=>f.id),event.target.checked,{silent:true});
      status(group.name+': '+count(group.fields)+'/'+group.fields.length+' fields visible.');
    });
    $(key+'-only')?.addEventListener('click',()=>isolate(group.fields.map(f=>f.id)));
    const plan=$(key+'-plan');
    plan?.addEventListener('click',()=>addAllToPlan(plan,group));
  }
  // "Add all to Plan": the pressed button turns orange at once (data-running, existing CSS), says so and is aria-busy until
  // the Promise of CoverageLab.addPresetPointings has settled (success, error, "Interrompi") and, when FoVs were added,
  // Aladin has run two drawing passes (the trackRun convention of scripts/button-feedback.js, which keeps its data-ack
  // confirmation). A run token keeps a late end from clearing a newer run. Both buttons follow the Coverage busy flag,
  // whoever started the work.
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
  const planRuns=new WeakMap();let planSeq=0;
  async function addAllToPlan(btn,group){
    const lab=window.CoverageLab;
    if(!lab){status('Coverage not available.');return;}
    if(lab.state.busy){lab.addPresetPointings(group.fields);return;}// refused by Coverage with its usual message
    const run=++planSeq,focused=document.activeElement===btn,count=lab.state.pointings.length;
    planRuns.set(btn,run);
    btn.setAttribute('data-running','');btn.setAttribute('aria-busy','true');btn.textContent='Adding to Coverage…';
    try{await lab.addPresetPointings(group.fields);}
    finally{
      // Nothing added (all already in the plan, refused, or stopped before the first FoV): nothing to draw, so the
      // button is restored at once and does not flash orange before the message.
      if(lab.state.pointings.length!==count){await frame();await frame();}
      if(planRuns.get(btn)===run){
        planRuns.delete(btn);btn.removeAttribute('data-running');btn.removeAttribute('aria-busy');
        btn.textContent='Add all to Plan ('+group.fields.length+')';
        // A disabled button loses the keyboard focus in some engines: give it back if nothing else took it.
        if(focused&&(!document.activeElement||document.activeElement===document.body)&&!btn.disabled)btn.focus({preventScroll:true});
      }
    }
  }
  function syncPlanButtons(busy){
    for(const key of Object.keys(groups)){const btn=$(key+'-plan');if(btn){btn.disabled=busy;btn.toggleAttribute('data-busy',busy);}}
  }
  window.addEventListener('vst-coverage-busy',event=>syncPlanButtons(!!(event.detail&&event.detail.busy)));
  if(window.CoverageLab?.state.busy)syncPlanButtons(true);
  // One outline colour per observatory group, the model of the MOC colours (scripts/app.js): the existing overlays are
  // restyled in place by setStyle (same overlays and footprints, selection highlight kept); overlays created later
  // (first show, new viewer) read field.color. Not persisted; not used by Coverage or by the exports.
  function setGroupColor(key,color){
    const group=groups[key];
    if(!group||!/^#[0-9a-f]{6}$/i.test(color))return;
    group.color=color;
    for(const f of group.fields){f.color=color;setStyle(states.get(f.id));}
    const swatch=$('field-'+key)?.closest('.layer')?.querySelector('.swatch');
    if(swatch)swatch.style.backgroundColor=color;
  }
  Object.keys(groups).forEach(buildGroup);
  for(const key of Object.keys(groups)){
    const input=$('obs-color-'+key);
    if(input){input.value=groups[key].color;input.addEventListener('input',()=>setGroupColor(key,input.value));}
    setGroupColor(key,groups[key].color);// the swatch shows the outline colour from the start
  }
  $('observatory-all')?.addEventListener('click',()=>{
    setVisible(allFields.map(f=>f.id),true,{silent:true});
    status('All seven observatory fields visible · each remains independently selectable.');
  });
  $('observatory-none')?.addEventListener('click',()=>{
    setVisible(allFields.map(f=>f.id),false,{silent:true});
    status('All observatory fields hidden · observing sequence unchanged.');
  });
  updateControls();
  function attachViewer(detail){
    if(!detail?.A||!detail?.aladin||detail.aladin===viewer)return;
    if(viewer){
      for(const s of states.values())if(s.overlay&&s.attached){
        try{viewer.removeOverlay(s.overlay);}catch(error){console.warn('Detach old field overlay:',error);}
      }
    }
    A=detail.A;viewer=detail.aladin;
    for(const s of states.values()){s.overlay=null;s.footprint=null;s.attached=false;
      if(s.visible){setOverlayVisibility(s);setStyle(s);}}
  }
  window.addEventListener('vst-aladin-ready',event=>attachViewer(event.detail));
  if(window.GRAWITALiveViewer)attachViewer(window.GRAWITALiveViewer);
  window.GRAWITAObservatoryFields={groups,states,showField,selectField,isolate,setGroupColor,
    get selectedId(){return selectedId;},get visibleCount(){return visibleCount();}
  };
})();
