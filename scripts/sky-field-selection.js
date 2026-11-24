/* Bidirectional selection for real Aladin Lite footprint and sky-click APIs.
 * Handles all geometric FoVs; never treats a drawing as an astronomical MOC.
 * Registered footprints live in a WeakMap so deleted overlays are not retained.
 */
(() => {
  'use strict';
  const footprintActions=new WeakMap();
  const geometries=new Map();
  let lastDirectClick=0;
  let viewer=null;
  const M=window.CoverageMath;
  function registerFootprint(footprint,action){
    if(footprint && typeof footprint==='object')footprintActions.set(footprint,action);
  }
  function registerGeometry(id,config,action,priority=0){geometries.set(id,{config,action,priority});}
  function unregisterGeometry(id){geometries.delete(id);}
  function dropPrefix(prefix){for(const key of geometries.keys())if(key.startsWith(prefix))geometries.delete(key);}
  function pickAt(ra,dec){
    if(!Number.isFinite(ra)||!Number.isFinite(dec))return false;
    const possible=[];
    for(const [key,entry] of geometries){
      if(!M.inside({ra,dec},entry.config))continue;
      // For overlapping FoVs prefer the closest projected field centre,
      // then the most recently overlaid footprint by priority.
      const c=entry.config,dy=(dec-c.dec),dx=((((ra-c.ra)+540)%360)-180)*Math.cos(dec*Math.PI/180);
      possible.push({...entry,key,distance:Math.hypot(dx,dy)});
    }
    possible.sort((a,b)=>a.distance-b.distance || b.priority-a.priority);
    if(possible.length){possible[0].action();return true;}
    return false;
  }
  window.SkyFieldSelection={registerFootprint,registerGeometry,unregisterGeometry,dropPrefix,pickAt};
  window.addEventListener('vst-aladin-ready',({detail})=>{
    viewer=detail.aladin;
    if(typeof viewer.on!=='function')return;
    viewer.on('footprintClicked',fp=>{
      const action=fp&&footprintActions.get(fp);
      if(action){lastDirectClick=Date.now();action();}
    });
    // The fallback supports API versions where footprintClicked is not raised
    // for outline-only polygons. A normal sky click elsewhere does nothing.
    viewer.on('click',position=>{
      if(Date.now()-lastDirectClick<200)return;
      const ra=Number(position?.ra),dec=Number(position?.dec);
      pickAt(ra,dec);
    });
  });
})();
