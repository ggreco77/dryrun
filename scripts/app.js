/*
 * VST x GW test page. Genuine CDS Aladin Lite v3/latest (official CDN endpoint).
 * No custom sky renderer / no fake footprints / no modifications to Aladin.
 * Bundled MOC data uses the documented A.MOCFromJSON() to work under file://.
 * Imported local FITS MOCs are decoded locally and supplied to A.MOCFromJSON.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const A_VERSION = 'v3/latest';
  const A_SCRIPT_URL = 'https://aladin.cds.unistra.fr/AladinLite/api/v3/latest/aladin.js';
  const bundled = window.TEST_MOC_DATA || {};
  const definitions = {
    gw90:   {name:'GW 90%',       color:'#f4ba63', checked:true,  opacity:0.42},
    gw50:   {name:'GW 50%',       color:'#fb7e74', checked:true,  opacity:0.69},
    gw10:   {name:'GW 10%',       color:'#ed78d9', checked:true, opacity:0.76},
    // SURVEY-LOBES-IMPLEMENTATION-01: the three user-supplied KiDS regions replace the aggregated KiDS MOC.
    kidsN:  {name:'KiDS-N',       color:'#5de2bc',checked:true, opacity:0.52},
    kidsS:  {name:'KiDS-S',       color:'#5de2bc',checked:true, opacity:0.52},
    kidsW2: {name:'KiDS-W2',      color:'#5de2bc',checked:true, opacity:0.52},
    atlasN: {name:'VST ATLAS-N',color:'#4d9cf1',checked:true,opacity:0.63},
    atlasS: {name:'VST ATLAS-S',color:'#dfabf7',checked:true,opacity:0.63},
    extra:  {name:'Additional footprint',color:'#67b7fb',checked:false,opacity:0.60},
    ipn: {name:'IPN SIMULATED — arbitrary 5° ring',color:'#ffe179',checked:true,opacity:0.47},
    grb: {name:'Simulated Short GRB',color:'#8cc2ff',checked:true,opacity:0.47}
  };
  let A = null;
  let aladin = null;
  const mocLayers = {};
  const importedUrls = {};
  let importTarget = null;
  let booting = false;

  function status(message,level='ok') {
    $('statusText').textContent = message;
    $('status').className = 'status' + (level === 'ok' ? '' : ' ' + level);
  }
  function countActive() {
    const n = Object.keys(definitions).filter(key => $('toggle-'+key).checked).length;
    $('activeCount').textContent = n + ' selected' + '';
  }
  function mocOptions(key) {
    const d=definitions[key];
    return { name:d.name, color:d.color, fillColor:d.color,
             fill:true, perimeter:true, edge:false, opacity:d.opacity, lineWidth:2 };
  }
  function updateVisibility(key) {
    const layer=mocLayers[key];
    if (layer) {
      try { if ($('toggle-'+key).checked) layer.show(); else layer.hide(); }
      catch(error){ status('Layer error '+definitions[key].name+': '+error.message, 'error'); }
    }
    countActive();
  }

  // Each MOC is independently styled through documented writable Aladin MOC
  // properties. No MOC geometry is modified, no layer needs re-creating.
  function styleMoc(key) {
    const d=definitions[key],layer=mocLayers[key];
    if (!layer)return;
    try {
      layer.color=d.color;
      layer.fillColor=d.color;
      layer.opacity=d.opacity;
    } catch(error) {
      status('MOC appearance '+d.name+': '+error.message,'error');
    }
  }
  function setupMocAppearance() {
    for(const [key,d] of Object.entries(definitions)) {
      const color=$('moc-color-'+key),opacity=$('moc-opacity-'+key),value=$('moc-opacity-value-'+key);
      if(!color||!opacity||!value)throw new Error('Missing MOC appearance controls: '+key);
      color.value=d.color;
      opacity.value=String(Math.round(d.opacity*100));
      value.textContent=Math.round(d.opacity*100)+'%';
      color.addEventListener('input',()=> {
        d.color=color.value;
        const swatch=$('toggle-'+key).closest('.layer')?.querySelector('.swatch');
        if(swatch)swatch.style.backgroundColor=d.color;
        styleMoc(key);
      });
      opacity.addEventListener('input',()=> {
        d.opacity=Number(opacity.value)/100;
        value.textContent=opacity.value+'%';
        styleMoc(key);
      });
    }
  }
  setupMocAppearance();

  // GUI-CLEANUP-09 addendum: the area of each GW credible-region MOC, measured on the MOC itself (CoverageMath.areaDeg2,
  // shown with the formatting of the Coverage panel); never a fixed number. Refreshed if a GW MOC is replaced.
  function showGwArea(key,json) {
    const el=$(key+'hint'),M=window.CoverageMath;
    if(!el||!M)return;
    const a=json&&Object.values(json).some(p=>p&&p.length)?M.areaDeg2(json):null;
    el.textContent=a==null?'—':a.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' deg²';
  }
  ['gw90','gw50','gw10'].forEach(key=>showGwArea(key,bundled[key]));
  window.addEventListener('vst-moc-imported',ev=>{const k=ev.detail&&ev.detail.key;if(k==='gw90'||k==='gw50'||k==='gw10')showGwArea(k,ev.detail.json);});

  function addBundledMOCs() {
    ['kidsN','kidsS','kidsW2','gw90','gw50','atlasN','atlasS','gw10','ipn','grb'].forEach(key => {
      // Official API: A.MOCFromJSON -> aladin.addMOC
      const layer = A.MOCFromJSON(
        bundled[key], mocOptions(key),
        () => { styleMoc(key); updateVisibility(key); },
        err => status('Unable to read MOC '+definitions[key].name+': '+String(err),'error')
      );
      mocLayers[key] = layer;
      aladin.addMOC(layer);
      updateVisibility(key);
    });
  }
  function aladinApiReady(candidate){
    return candidate && typeof candidate.aladin === 'function' &&
      typeof candidate.MOCFromJSON === 'function' &&
      typeof candidate.MOCFromURL === 'function';
  }
  function timeout(promise, millis, message) {
    return Promise.race([
      promise,
      new Promise((_,reject) => setTimeout(() => reject(new Error(message)), millis))
    ]);
  }
  function loadClassic(url) {
    return new Promise((resolve,reject) => {
      const script=document.createElement('script');
      script.src=url;
      script.async=true;
      script.onload=resolve;
      script.onerror=() => reject(new Error('Unavailable: '+url));
      document.head.appendChild(script);
    });
  }
  async function loadApi() {
    // Official v3/latest CDN endpoint: initial script and retry use the same URL.
    if (aladinApiReady(window.A)) return window.A;
    if (window.__aladinStaticLoaded) {
      throw new Error('CDS Aladin script loaded, but window.A does not expose required v3 APIs.');
    }
    if (window.__aladinStaticError) {
      throw new Error('Network error loading official CDS Aladin: '+A_SCRIPT_URL);
    }
    try {
      await timeout(loadClassic(A_SCRIPT_URL),20000,'Network timeout loading Aladin Lite v3/latest');
      if (!aladinApiReady(window.A)) {
        throw new Error('Script loaded, but v3 API incomplete (A.aladin / MOCFromJSON / MOCFromURL).');
      }
      return window.A;
    } catch (error) {
      throw new Error('Unable to load official CDS Aladin Lite: '+error.message);
    }
  }
  async function start() {
    if(booting || aladin) return;
    booting=true;
    $('aladin-fail').hidden=true;
    status('Loading Aladin Lite '+A_VERSION+'…');
    try {
      A=await loadApi();
      // Official v3 readiness promise (initializes Rust/WASM + WebGL renderer).
      await timeout(Promise.resolve(A.init),18000,'Aladin WASM initialization timed out');
      aladin=A.aladin('#aladin-lite-div',{
        log:false, // no Aladin Lite usage logger: it would send the page URL (a local path under file://) to CDS
        survey:'P/DSS2/color',
        target:'0 +0', fov:360, projection:'AIT',
        cooFrame:'equatorial',
        showLayersControl:true,
        showCooGridControl:true,
        showFullscreenControl:true,
        showSimbadPointerControl:false
      });
      addBundledMOCs();
      window.GRAWITALiveViewer={A,aladin};
      window.dispatchEvent(new CustomEvent('vst-aladin-ready',{detail:{A,aladin}}));
      $('engineLabel').textContent='API '+A_VERSION+' · ready';
      status('');   // GUI-CLEANUP-08: no technical start-up line; the GW Superevent summary describes the event
    } catch(error) {
      console.error('Aladin error:',error);
      $('engineLabel').textContent='API '+A_VERSION+' · unavailable';
      $('aladin-fail').hidden=false;
      status('Unable to start Aladin Lite: '+error.message,'error');
    } finally { booting=false; }
  }
  function requireAladin() {
    if(aladin && A)return true;
    status('Aladin Lite not ready. Check the network and retry.','warn');
    return false;
  }
  function flyToAllSky() {
    if(!requireAladin())return;
    aladin.setProjection('AIT');
    aladin.gotoRaDec(0,0);
    aladin.setFoV(360);
    status('All-sky Hammer-Aitoff view.');
  }
  // Read Aladin's real view center. Do not guess or silently insert 0/0.
  function readViewerCenter(){
    if(!aladin || typeof aladin.getRaDec!=='function')return null;
    try{
      const raw=aladin.getRaDec();
      const ra=Number(raw?.length>=2?raw[0]:raw?.ra);
      const dec=Number(raw?.length>=2?raw[1]:raw?.dec);
      if(!Number.isFinite(ra)||!Number.isFinite(dec)||dec < -90||dec > 90)return null;
      return {ra:((ra%360)+360)%360,dec};
    }catch(error){console.debug('Aladin center not ready:',error);return null;}
  }
  window.GRAWITAReadAladinCenter=readViewerCenter;
  let selectedPosterior=window.GRAWITA_CURRENT_POSTERIOR||null;
  window.addEventListener('vst-posterior-loaded',ev=>{selectedPosterior=ev.detail?.posterior||null;});
  function focusGWPoint(){
    // When full PROBDENSITY is present, find the pixel with the greatest
    // sky probability DENSITY, not merely the greatest integrated cell P.
    if(selectedPosterior?.cells?.length){
      const best=selectedPosterior.cells.reduce((a,b)=>
        b.p*Math.pow(4,b.order)>a.p*Math.pow(4,a.order)?b:a);
      return {...best,provenance:'BAYESTAR maximum probability density'};
    }
    // Without the full posterior, choose an actual cell inside the bundled
    // GW 50% MOC. Its spherical centroid itself might be outside the region.
    const s=window.CoverageMath.sampleMoc(bundled.gw50,7);
    if(!s.points.length)throw new Error('Bundled GW 50% MOC is empty');
    let x=0,y=0,z=0;
    for(const p of s.points){const v=window.CoverageMath.vec(p.ra,p.dec);x+=v[0];y+=v[1];z+=v[2];}
    const norm=Math.hypot(x,y,z)||1;let best=s.points[0],score=-Infinity;
    for(const p of s.points){const v=window.CoverageMath.vec(p.ra,p.dec);
      const dot=(v[0]*x+v[1]*y+v[2]*z)/norm;
      if(dot>score){best=p;score=dot;}
    }
    return {...best,provenance:'a cell inside the bundled GW 50% MOC (not a probability maximum)'};
  }
  function flyToGW(){
    if(!requireAladin())return;
    try{
      const target=focusGWPoint();
      aladin.setProjection('SIN');
      aladin.gotoRaDec(target.ra,target.dec);aladin.setFoV(selectedPosterior?30:45);
      status('GW centered on '+target.provenance+' · RA '+target.ra.toFixed(3)+'°, Dec '+target.dec.toFixed(3)+'°.');
    }catch(error){status('Center GW failed: '+error.message,'error');}
  }
  async function importMocFits(file,key) {
    if(!requireAladin())return;
    try {
      const json=window.CoverageMath.decodeMoc(await window.GrawitaSafeFile.read(file,{maxInputBytes:window.GrawitaSafeFile.LIMITS.moc,maxOutputBytes:window.GrawitaSafeFile.LIMITS.moc}));
      const old=mocLayers[key];
      // A user replacement is not the bundled simulated IPN / labelled Fermi sample.
      // Avoid retaining the default provenance label for an unrelated imported FITS.
      const importedName=key==='ipn'?'IPN — imported MOC':
        key==='grb'?'GRB — imported MOC':null;
      const options=mocOptions(key);
      if(importedName)options.name=importedName;
      const layer=A.MOCFromJSON(json,options,() => {
        if(importedName){
          definitions[key].name=importedName;
          const title=$('toggle-'+key).closest('.layer')?.querySelector('.layer-copy b');
          if(title)title.textContent=importedName;
        }
        $('toggle-'+key).disabled=false;
        $('toggle-'+key).checked=true;
        $('toggle-'+key).closest('.layer').classList.remove('muted');
        $(key+'hint').textContent=file.name;
        styleMoc(key);
        updateVisibility(key);
        window.dispatchEvent(new CustomEvent('vst-moc-imported',{detail:{key,json,fileName:file.name}}));
        status('MOC FITS '+file.name+' imported locally through Aladin API.');
      },error=>status('MOC error '+file.name+': '+String(error),'error'));
      if(old)aladin.removeOverlay(old);
      mocLayers[key]=layer;
      aladin.addMOC(layer);
    } catch(error){status('FITS import '+file.name+': '+error.message,'error');}
  }
  // The seven user-provided observatory coordinates are pointing CENTERS,
  // implemented in scripts/observatory-fields.js as separate 1° × 1° fields.
  // No inferred polygons and no conversion to MOC at this stage.
  Object.keys(definitions).forEach(key => {
    $('toggle-'+key).addEventListener('change',()=>updateVisibility(key));
  });
  document.querySelectorAll('[data-upload]').forEach(button => button.addEventListener('click',()=>{
    importTarget=button.dataset.upload;
    $('fits-file').value=''; $('fits-file').click();
  }));
  $('fits-file').addEventListener('change',ev => {
    if(ev.target.files[0] && importTarget) importMocFits(ev.target.files[0],importTarget);
  });
  $('btn-fullsky').addEventListener('click',flyToAllSky);
  $('btn-gw').addEventListener('click',flyToGW);
  $('retry-aladin').addEventListener('click',()=>{ window.__aladinStaticError=false; start(); });
  $('hips-select').addEventListener('change',event => {
    if(!requireAladin())return;
    try {
      aladin.setBaseImageLayer(event.target.value);
      status('HiPS selected: '+event.target.options[event.target.selectedIndex].text+'.');
    } catch(error){status('HiPS unavailable: '+error.message,'warn');}
  });
  countActive();
  start();
})();
