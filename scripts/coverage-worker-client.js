/* Local, offline-compatible Blob Worker. Aladin and the DOM remain on main thread.
 * If file:// / CSP forbids Blob workers, use the tested cooperative fallback.
 * Never transmits the BAYESTAR to a network endpoint. No analytics or tracking.
 */
(() => {
'use strict';
let worker=null,workerUrl=null,failed=false,nextId=0,lastPosterior=null,lastGw50=null,lastGw90=null;
const pending=new Map(),cache=new Map();
const failAll=(error)=>{for(const p of pending.values())p.reject(error);pending.clear();};
function terminate({permanent=false}={}){
  if(worker)worker.terminate();worker=null;
  if(workerUrl)URL.revokeObjectURL(workerUrl);workerUrl=null;
  lastPosterior=null;lastGw50=null;lastGw90=null;cache.clear();
  if(permanent)failed=true;
  failAll(new Error('Calculation cancelled or Worker unavailable'));
}
function spawn(){
  if(failed||!window.Worker||!window.GRAWITA_COVERAGE_WORKER_SOURCE)return false;
  if(worker)return true;
  let url;
  try{
    url=URL.createObjectURL(new Blob([window.GRAWITA_COVERAGE_WORKER_SOURCE],{type:'text/javascript'}));
    worker=new Worker(url);workerUrl=url;
    worker.onmessage=event=>{
      const m=event.data||{},p=pending.get(m.id);if(!p)return;
      if(m.type==='progress'){p.progress?.(m.value,m.phase);return;}
      pending.delete(m.id);
      if(m.type==='error')p.reject(new Error(m.message));
      else if(m.type==='ready'||m.type==='result')p.resolve(m.result);
    };
    worker.onerror=()=>terminate({permanent:true});
    return true;
  }catch(error){failed=true;terminate({permanent:true});return false;}
  finally{if(url&&!workerUrl)URL.revokeObjectURL(url);}
}
function call(type,payload,progress){
 return new Promise((resolve,reject)=>{
   const id=++nextId;
   pending.set(id,{resolve,reject,progress});
   try{worker.postMessage({type,id,...payload});}catch(e){pending.delete(id);reject(e);}
 });
}
let configureTask=null;
async function configure(posterior,mocs){
  if(!spawn())return false;
  if(posterior===lastPosterior&&mocs.gw50===lastGw50&&mocs.gw90===lastGw90)return true;
  if(configureTask)await configureTask;
  if(posterior===lastPosterior&&mocs.gw50===lastGw50&&mocs.gw90===lastGw90)return true;
  configureTask=call('init',{cells:posterior?.cells||null,mocs:{gw50:mocs.gw50,gw90:mocs.gw90}});
  try{
    await Promise.race([configureTask,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Worker initialization timeout')),4000))]);
    lastPosterior=posterior;lastGw50=mocs.gw50;lastGw90=mocs.gw90;cache.clear();
    return true;
  }catch(error){terminate({permanent:true});return false;}
  finally{configureTask=null;}
}
async function compute({posterior,mocs,config,accepted,mode='all',probOrder,areaOrder,progress}){
  if(!await configure(posterior,mocs))return null;
  const key=JSON.stringify([config,accepted.map(p=>[p.shape,p.ra,p.dec,p.width,p.height,p.radius,p.pa]),mode,probOrder,areaOrder]);
  if(cache.has(key)){progress?.(1,'Cached');return {...cache.get(key)};}
  // Worker errors are not silently treated as valid results. Only environmental
  // Worker failures switch to the cooperative main-thread implementation.
  try{
    const result=await call('compute',{config,accepted,mode,probOrder,areaOrder},progress);
    if(result){cache.set(key,result);if(cache.size>128)cache.delete(cache.keys().next().value);}
    return result;
  }catch(error){if(failed)return null;throw error;}
}
window.CoverageWorkerClient={compute,cancel:()=>terminate(),isAvailable:()=>!failed&&!!window.Worker,
  invalidate:()=>{lastPosterior=null;lastGw50=null;lastGw90=null;cache.clear();}};
})();
