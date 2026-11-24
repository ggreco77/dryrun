/* Workspace-only interaction: resizable panels, keyboard support and local-only preferences.
   No astronomy calculations, network requests, cookies, tracking or overrides to Aladin. */
(() => {
  'use strict';
  const root=document.documentElement;
  const stage=document.querySelector('.layout');
  const left=document.getElementById('resize-layers');
  const right=document.getElementById('resize-coverage');
  const expand=document.getElementById('expand-coverage');
  const reset=document.getElementById('reset-layout');
  const viewer=document.getElementById('viewer-stack');
  if(!stage||!left||!right||!viewer)return;
  const defaults={layers:270,coverage:520};
  const widths={...defaults};
  let expanded=false;
  const getMode=()=>innerWidth<=920?'stacked':innerWidth<=1280?'compact':'wide';
  const limits=()=>{
    const mode=getMode();
    const w=stage.getBoundingClientRect().width;
    const usable=w-(mode==='wide'?4:2)*7-(mode==='wide'?2:1)*9;
    const layers=mode==='wide'?widths.layers:0;
    return {layersMin:220,layersMax:Math.min(390,Math.max(220,usable-350-340)),
      coverageMin:340,coverageMax:Math.max(340,Math.min(850,usable-layers-350))};
  };
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const refresh=()=>{
    const lim=limits();
    widths.layers=clamp(widths.layers,lim.layersMin,lim.layersMax);
    widths.coverage=clamp(widths.coverage,lim.coverageMin,lim.coverageMax);
    root.style.setProperty('--layers-width',widths.layers+'px');
    root.style.setProperty('--coverage-width',widths.coverage+'px');
    left.setAttribute('aria-valuenow',String(Math.round(widths.layers)));
    right.setAttribute('aria-valuenow',String(Math.round(widths.coverage)));
    left.setAttribute('aria-valuemax',String(Math.round(lim.layersMax)));
    right.setAttribute('aria-valuemax',String(Math.round(lim.coverageMax)));
  };
  const save=()=>{try{localStorage.setItem('vst-layout-widths-v1',JSON.stringify(widths));}catch{}};
  try{
    const prior=JSON.parse(localStorage.getItem('vst-layout-widths-v1')||'null');
    if(prior && Number.isFinite(prior.layers) && Number.isFinite(prior.coverage)){
      widths.layers=prior.layers;widths.coverage=prior.coverage;
    }
  }catch{}
  let resizeFrame=0;
  const notifyViewer=()=>{
    if(resizeFrame)return;
    resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;window.dispatchEvent(new Event('resize'));});
  };
  function attach(element,kind){
    element.addEventListener('pointerdown',event=>{
      if(getMode()==='stacked'||(kind==='layers'&&getMode()!=='wide'))return;
      if(event.button!==0)return;
      const start=event.clientX,initial=widths[kind];
      element.setPointerCapture(event.pointerId);
      document.body.classList.add('layout-dragging');
      const move=e=>{widths[kind]=initial+(e.clientX-start)*(kind==='coverage'?-1:1);refresh();notifyViewer();};
      const end=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',end);element.removeEventListener('pointercancel',end);document.body.classList.remove('layout-dragging');save();};
      element.addEventListener('pointermove',move);
      element.addEventListener('pointerup',end);
      element.addEventListener('pointercancel',end);
    });
    element.addEventListener('keydown',e=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
      e.preventDefault();
      const lim=limits(),step=e.shiftKey?40:15;
      const positive=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;
      const bound=kind==='layers'?['layersMin','layersMax']:['coverageMin','coverageMax'];
      if(e.key==='Home')widths[kind]=lim[bound[0]];
      else if(e.key==='End')widths[kind]=lim[bound[1]];
      else widths[kind]+=positive*step*(kind==='coverage'?-1:1);
      refresh();notifyViewer();save();
    });
  }
  attach(left,'layers');attach(right,'coverage');
  expand.addEventListener('click',()=>{
    if(getMode()==='stacked'){
      document.getElementById('coverage-pane').scrollIntoView({behavior:'smooth',block:'start'});
      return;
    }
    expanded=!expanded;
    widths.coverage=expanded?760:defaults.coverage;
    refresh();notifyViewer();save();
    expand.textContent=expanded?'Compatta':'Allarga';
    expand.setAttribute('aria-pressed',String(expanded));
  });
  reset.addEventListener('click',()=>{
    expanded=false;Object.assign(widths,defaults);refresh();notifyViewer();save();
    viewer.style.height='';expand.textContent='Allarga';expand.setAttribute('aria-pressed','false');
  });
  window.addEventListener('resize',refresh,{passive:true});
  if(typeof ResizeObserver==='function'){
    // Aladin responds to browser resizing; relay changes when the container itself resizes.
    const observer=new ResizeObserver(()=>notifyViewer());
    observer.observe(viewer);
  }
  refresh();
})();
