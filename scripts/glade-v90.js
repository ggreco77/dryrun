/* GRAWITA DRY RUN — local FITS galaxies already preselected by the user in 3D V90.
 * This module never computes V90, downloads GLADE, or sends the FITS to a server.
 * A lightweight FITS BINTABLE parser retains every row with valid ICRS coordinates.
 * Table paging stays at 100. Optional full-map display streams sources in bounded batches.
 */
(()=>{
'use strict';
const $=id=>document.getElementById(id),M=window.CoverageMath;
const LIMIT=500000,PAGE=100,ALL_MAP_BATCH=500;
let A=null,aladin=null,posterior=null,selectedFoV=null,galaxies=[],filename='',sourceLayer=null,visible=true,page=0,selected=null,sortedByAbsoluteB=false,plotVersion=0,plotTimer=null,plottedMode='none',catalogFields=[],galaxyByRow=new Map(),measurementLookup=null,distanceTimer=null,lastDistanceControlsSignature=null;
const fmt=(v,n=3)=>Number.isFinite(v)?v.toFixed(n):'—';
const status=(msg)=>{$('glade-status').textContent=msg;};
const norm=s=>String(s??'').replace(/[^a-zA-Z0-9]/g,'').toLowerCase();
const u8text=(b,start,length)=>new TextDecoder('ascii').decode(b.subarray(start,start+length));
function header(bytes,off){
  if(off+2880>bytes.length)throw Error('Truncated FITS header');
  const h={};let offset=off,done=false;
  while(!done){if(offset+2880>bytes.length)throw Error('Truncated FITS header');
    for(let i=0;i<36;i++){
      const c=u8text(bytes,offset+80*i,80),name=c.slice(0,8).trim();
      if(name==='END'){done=true;break;}
      if(c[8]!=='=')continue;
      const raw=c.slice(10).trim();
      if(raw.startsWith("'")){
        const match=raw.match(/^'((?:[^']|'')*)'/);
        h[name]=match?match[1].replace(/''/g,"'").trim():'';
      }else{
        const q=raw.split('/')[0].trim(),numeric=Number(q.replace(/[dD]/g,'E'));
        h[name]=q==='T'?true:q==='F'?false:q&&Number.isFinite(numeric)?numeric:q;
      }
    }offset+=2880;
  }
  return {h,start:offset};
}
function tableList(buffer){
  const bytes=new Uint8Array(buffer),tables=[];let off=0;
  while(off<bytes.length){const {h,start}=header(bytes,off),na=Number(h.NAXIS||0);
    let size=0;if(h.XTENSION==='BINTABLE')size=Number(h.NAXIS1||0)*Number(h.NAXIS2||0)+Number(h.PCOUNT||0);
    else if(na>0){size=Math.abs(Number(h.BITPIX||8))/8;for(let i=1;i<=na;i++)size*=Number(h['NAXIS'+i]||0);size+=Number(h.PCOUNT||0);}
    if(!Number.isSafeInteger(size)||size<0||start+size>bytes.length)throw Error('Invalid/truncated FITS data');
    if(h.XTENSION==='BINTABLE')tables.push({h,start,bytes,view:new DataView(buffer)});
    const next=start+Math.ceil(size/2880)*2880;if(next<=off)break;off=next;
  }return tables;
}
function columns(t){
  const h=t.h,cols=[];let pos=0;
  if(!Number.isInteger(Number(h.TFIELDS||0))||Number(h.TFIELDS||0)>512)throw Error('Too many FITS columns (limit 512)');
  for(let i=1;i<=Number(h.TFIELDS||0);i++){
    const form=String(h['TFORM'+i]||'').trim().toUpperCase();
    const m=form.match(/^\s*(\d*)([LABIJKEDCMXPQ])\s*\(?\d*\)?\s*$/);
    if(!m)throw Error('Unsupported FITS TFORM: '+form);
    const cnt=Number(m[1]||1),kind=m[2];
    const bytesize=kind==='X'?Math.ceil(cnt/8):cnt*({L:1,A:1,B:1,I:2,J:4,K:8,E:4,D:8,C:8,M:16,P:8,Q:16}[kind]);
    cols.push({name:String(h['TTYPE'+i]||'').trim(),key:norm(h['TTYPE'+i]),type:kind,count:cnt,offset:pos,
      unit:String(h['TUNIT'+i]||''),scale:Number(h['TSCAL'+i]??1),zero:Number(h['TZERO'+i]??0),nullValue:h['TNULL'+i]});
    pos+=bytesize;
  }if(pos>Number(h.NAXIS1||0))throw Error('FITS column sizes exceed row length');
  return cols;
}
function pick(cols,keys){for(const key of keys){const c=cols.find(x=>x.key===norm(key));if(c)return c;}return null;}
function value(t,col,r){if(!col)return null;
  const off=t.start+r*Number(t.h.NAXIS1)+col.offset,v=t.view;
  if(col.type==='A')return u8text(t.bytes,off,col.count).replace(/\0/g,'').trim();
  if(col.count!==1)return null;
  let n;
  switch(col.type){
    case 'L':return u8text(t.bytes,off,1)==='T';
    case 'B':n=v.getUint8(off);break;
    case 'I':n=v.getInt16(off,false);break;
    case 'J':n=v.getInt32(off,false);break;
    case 'K':{const big=v.getBigInt64(off,false);if(big>BigInt(Number.MAX_SAFE_INTEGER)||big<BigInt(Number.MIN_SAFE_INTEGER))return big.toString();n=Number(big);break;}
    case 'E':n=v.getFloat32(off,false);break;
    case 'D':n=v.getFloat64(off,false);break;
    default:return null;
  }
  if(!Number.isFinite(n)||col.nullValue!==undefined&&n===Number(col.nullValue))return null;
  return n*col.scale+col.zero;
}
function parseFits(buffer){
  const tables=tableList(buffer);if(!tables.length)throw Error('No FITS BINTABLE found. Upload your GLADE+ V90 galaxy table, not a MOC or sky image.');
  for(const t of tables){const cols=columns(t);
    const raCol=pick(cols,['RA','RAJ2000','RA_ICRS','RAdeg','ra_deg','RAJ','_RAJ']),decCol=pick(cols,['Dec','DEJ2000','DE_ICRS','DECdeg','dec_deg','DEJ','_DEJ']);
    if(!raCol||!decCol)continue;
    const n=Number(t.h.NAXIS2||0);if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid FITS row count');
    if(n>LIMIT)throw Error(`This table has ${n.toLocaleString()} rows; the browser-only test limit is ${LIMIT.toLocaleString()}. Export the preselected GLADE V90 subset first.`);
    const nameCol=pick(cols,['GLADEID','GLADE_ID','Name','Object','ID','PGC','PGC1','GWGC','HyperLEDA','2MASS','AllWISE','SDSS']),
      distCol=pick(cols,['Dist','DistMpc','DistanceMpc','LuminosityDistance','dist_mpc','distance','dL','DL_Mpc','D_Mpc']),
      redshiftCol=pick(cols,['z','zhelio','redshift','z_cmb','zobs']),
      bCol=pick(cols,['Bmag','Bmag_app','Bmagcorrected','B']),
      absBCol=cols.find(c=>['BMAG','M_B','MB_abs'].includes(c.name))||null;
    const galaxiesOut=[];let rejected=0;
    for(let i=0;i<n;i++){
      let ra=Number(value(t,raCol,i)),dec=Number(value(t,decCol,i));
      if(/^(hour|h|hr|hours)$/i.test(raCol.unit.trim()))ra*=15;
      if(!Number.isFinite(ra)||!Number.isFinite(dec)||ra<0||ra>=360||dec<-90||dec>90){rejected++;continue;}
      const rawName=value(t,nameCol,i),distRaw=value(t,distCol,i),zRaw=value(t,redshiftCol,i),bRaw=value(t,bCol,i);
      const redshift=zRaw===null?null:Number(zRaw),bmag=bRaw===null?null:Number(bRaw),
        absBRaw=value(t,absBCol,i),absB=absBRaw===null?null:Number(absBRaw);
      let distance=distRaw!==null?Number(distRaw):null;
      if(Number.isFinite(distance)&&distCol&&/kpc/i.test(distCol.unit))distance/=1000;
      if(Number.isFinite(distance)&&distCol&&/gpc/i.test(distCol.unit))distance*=1000;
      if(!Number.isFinite(distance)||distance<=0)distance=null;
      galaxiesOut.push({name:rawName!==null&&String(rawName).trim()?String(rawName).trim():`GLADE row ${i+1}`,
        ra,dec,distance,redshift:Number.isFinite(redshift)&&redshift>=0?redshift:null,
        bmag:Number.isFinite(bmag)?bmag:null,absB:Number.isFinite(absB)?absB:null,row:i+1});
    }
    return {items:galaxiesOut,totalRows:n,rejected,columnNames:cols.map(c=>c.name),extName:t.h.EXTNAME||null,
      fields:cols.map(c=>({name:c.name,unit:c.unit||''})),
      getRecord:g=>cols.map(c=>value(t,c,g.row-1))};
  }
  throw Error('The FITS table has no recognized ICRS RA/Dec columns (RA, Dec or RAJ2000/DEJ2000).');
}
/* VOTable 1.1–1.5. Prefer local TABLEDATA parsing for file:// and 100-source paging.
 * If the document uses BINARY/BINARY2, the official A.catalogFromURL() VOTable
 * loader is used with a local Blob URL (useProxy=false) and the resulting
 * sources are adapted into the same paged GLADE display. No remote catalogue call.
 * Aladin Lite 3.9 decodes BINARY only: a serialization it cannot read (BINARY2)
 * yields no rows and is reported as an import error, never as an empty catalog.
 */
const xmlChildren=(node,tag)=>Array.from(node?.children||[]).filter(n=>n.localName?.toUpperCase()===tag.toUpperCase());
const xmlDesc=(node,tag)=>Array.from(node?.getElementsByTagName('*')||[]).filter(n=>n.localName?.toUpperCase()===tag.toUpperCase());
function parseSexa(s,ra=false){
  const str=String(s??'').trim();if(!str)return NaN;
  const n=Number(str);if(Number.isFinite(n))return ra?n*15:n;
  const parts=str.replace(/[hHdDmMsS°']/g,':').split(/[:\s]+/).filter(Boolean).map(Number);
  if(parts.length<2||parts.length>3||parts.some(x=>!Number.isFinite(x)))return NaN;
  const sign=str.startsWith('-')?-1:1;
  const val=(Math.abs(parts[0])+Math.abs(parts[1])/60+(Math.abs(parts[2])||0)/3600)*sign;
  return ra?val*15:val;
}
function readVotRows(fields,rawRows){
  if(!fields.length)throw Error('VOTable has no FIELD definitions');
  if(fields.length>512)throw Error('Too many VOTable fields (limit 512)');
  const cols=fields.map((f,i)=>({name:f.name||f.id||`field${i+1}`,key:norm(f.name||f.id||''),unit:f.unit||'',ucd:(f.ucd||'').toLowerCase(),id:f.id||''}));
  let raCol=cols.findIndex(c=>c.ucd.includes('pos.eq.ra'));
  let decCol=cols.findIndex(c=>c.ucd.includes('pos.eq.dec'));
  if(raCol<0)raCol=cols.findIndex(c=>['ra','raj2000','raicrs','radeg','radeg','raj','_raj'].includes(c.key));
  if(decCol<0)decCol=cols.findIndex(c=>['dec','dej2000','deicrs','decdeg','dej','_dej'].includes(c.key));
  if(raCol<0||decCol<0)throw Error('VOTable lacks equatorial RA/Dec FIELDs (UCD pos.eq.ra/dec or RAJ2000/DEJ2000).');
  const pick=(keys)=>cols.findIndex(c=>keys.some(k=>c.key===norm(k)));
  const nameCol=pick(['GLADEID','GLADE_ID','Name','Object','ID','PGC','PGC1','GWGC','HyperLEDA','2MASS','AllWISE','SDSS']);
  const distCol=pick(['Dist','DistMpc','DistanceMpc','LuminosityDistance','dist_mpc','distance','dL','DL_Mpc','D_Mpc']);
  const zCol=pick(['z','zhelio','redshift','z_cmb','zobs']);
  const bCol=pick(['Bmag','Bmag_app','Bmagcorrected','B']);
  // BMAG is GLADE+'s ABSOLUTE B magnitude, distinct from apparent Bmag.
  // Names are intentionally case-sensitive to avoid confusing these columns.
  const absBCol=cols.findIndex(c=>['BMAG','M_B','MB_abs'].includes(c.name));
  if(rawRows.length>LIMIT)throw Error(`VOTable has ${rawRows.length} rows (limit ${LIMIT}). Use the preselected V90 sample.`);
  const galaxiesOut=[];let rejected=0;
  for(let i=0;i<rawRows.length;i++){
    const row=rawRows[i];
    const raString=String(row[raCol]??'').trim(),decString=String(row[decCol]??'').trim();
    let ra=parseSexa(raString, /(?:h|hour)/i.test(cols[raCol].unit)||raString.includes(':'));
    let dec=parseSexa(decString,false);
    if(!Number.isFinite(ra)||!Number.isFinite(dec)||ra<0||ra>=360||Math.abs(dec)>90){rejected++;continue;}
    const rawName=nameCol<0?null:row[nameCol];
    let distance=distCol<0?null:Number(row[distCol]);
    if(distance!==null&&Number.isFinite(distance)){
      if(/kpc/i.test(cols[distCol].unit))distance/=1000;
      if(/gpc/i.test(cols[distCol].unit))distance*=1000;
    }
    if(!(distance>0))distance=null;
    const z=zCol<0?NaN:Number(row[zCol]),
      b=bCol<0||String(row[bCol]??'').trim()===''?NaN:Number(row[bCol]),
      absB=absBCol<0||String(row[absBCol]??'').trim()===''?NaN:Number(row[absBCol]);
    galaxiesOut.push({name:rawName!=null&&String(rawName).trim()?String(rawName).trim():`GLADE row ${i+1}`,
      ra,dec,distance,redshift:Number.isFinite(z)&&z>=0?z:null,
      bmag:Number.isFinite(b)?b:null,absB:Number.isFinite(absB)?absB:null,row:i+1,record:row});
  }
  return {items:galaxiesOut,totalRows:rawRows.length,rejected,columnNames:cols.map(c=>c.name),extName:'VOTable',
    fields:cols.map(c=>({name:c.name,unit:c.unit||''})),getRecord:g=>g.record};
}
// Stage I-8A (security audit I-8, V-2): limits checked on the WHOLE text before the XML parser runs. A DTD can declare
// entities that the parser would expand, so a DOCTYPE or ENTITY declaration is refused wherever it appears (the former
// check read only the first 20,000 characters). The decoded text keeps the 60 MB limit of the file, and the number of
// FIELD and TR elements is bounded by the limits of the reader (512 fields, LIMIT rows) for the whole document, so an
// oversized table is refused before its DOM is built.
const VOT_MAX_CHARS=60*1024*1024,VOT_MAX_FIELDS=512;
function countTags(xml,name,stopAbove){
  const re=new RegExp('<(?:[A-Za-z_][\\w.-]*:)?'+name+'(?=[\\s/>])','gi');let n=0;
  while(n<=stopAbove&&re.exec(xml))n++;
  return n;
}
function checkVotText(xml){
  if(typeof xml!=='string')throw Error('The chosen file is not a VOTable XML document');
  if(xml.length>VOT_MAX_CHARS)throw Error('VOTable exceeds 60 MB browser-only limit. Export the V90 subset.');
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('VOTable DTD/entity declarations are not permitted');
  if(countTags(xml,'FIELD',VOT_MAX_FIELDS)>VOT_MAX_FIELDS)throw Error('Too many VOTable fields (limit 512)');
  if(countTags(xml,'TR',LIMIT)>LIMIT)throw Error(`VOTable contains more than ${LIMIT} rows`);
}
function parseVotTableData(xml){
  checkVotText(xml);
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  if(doc.doctype)throw Error('VOTable DTD/entity declarations are not permitted');   // defence in depth
  const parseErr=xmlDesc(doc,'parsererror');if(parseErr.length)throw Error('Invalid VOTable XML: '+parseErr[0].textContent.slice(0,160));
  if(doc.documentElement?.localName?.toUpperCase()!=='VOTABLE')throw Error('The chosen file is not a VOTable XML document');
  for(const t of xmlDesc(doc,'TABLE')){
    const f=xmlChildren(t,'FIELD').map(x=>({name:x.getAttribute('name'),id:x.getAttribute('ID'),unit:x.getAttribute('unit'),ucd:x.getAttribute('ucd')}));
    const td=xmlDesc(t,'TABLEDATA')[0];
    if(!td)continue;
    const rows=xmlChildren(td,'TR');
    if(rows.length>LIMIT)throw Error(`VOTable contains more than ${LIMIT} rows`);
    return readVotRows(f,rows.map(tr=>xmlChildren(tr,'TD').map(cell=>cell.textContent?.trim()??'')));
  }
  return null; // BINARY / BINARY2: delegate to Aladin native VOTable API.
}
function aladinNativeVot(blob){
  if(!A||typeof A.catalogFromURL!=='function')return Promise.reject(Error('Aladin Lite VOTable reader is not available. Try VOTable TABLEDATA or load Aladin first.'));
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(blob);let finished=false,failure=null;
    const end=(fn,value)=>{if(finished)return;finished=true;clearTimeout(timer);URL.revokeObjectURL(url);fn(value);};
    // Aladin reports once per VOTable RESOURCE, synchronously one after the other:
    // a failing or empty RESOURCE must not hide a later one that holds the table.
    const fail=error=>{if(failure||finished)return;failure=error;setTimeout(()=>end(reject,failure),0);};
    const timer=setTimeout(()=>end(reject,Error('Aladin VOTable parser timed out. The file may use an unsupported serialization.')),20000);
    try{
      // Do not add its full Catalog to Aladin; use its parsed Source array to
      // repopulate our paginated catalog via A.catalog() / A.source().
      // Aladin Lite v3 signature: catalogFromURL(url, options, success, error, useProxy).
      A.catalogFromURL(url,{name:'GLADE V90 input · local VOTable',color:'#9ce8fe'},result=>{
        try{
          // v3 hands over the parsed Catalog; the former v2 API handed over its Source array.
          const sources=Array.isArray(result)?result:(typeof result?.getSources==='function'?result.getSources():null);
          if(!Array.isArray(sources))throw Error('Aladin did not return a VOTable source array');
          if(!sources.length){fail(Error('Aladin Lite found no rows with sky coordinates in this VOTable. Its serialization (for example BINARY2) or its RA/Dec columns may be unsupported: export the table as TABLEDATA.'));return;}
          if(sources.length>LIMIT)throw Error('Catalog exceeds local V90 row limit');
          const keys=Object.keys(sources[0]?.data||{});
          const raw=sources.map(x=>keys.map(k=>x.data?.[k]??''));
          const cols=keys.map(k=>({name:k,id:k,ucd:'',unit:''}));
          // The parser also exposes RA and Dec on Source in decimal degrees.
          const raKey=cols.findIndex(c=>['ra','raj2000','raicrs','_raj'].includes(norm(c.name)));
          const deKey=cols.findIndex(c=>['dec','dej2000','deicrs','_dej'].includes(norm(c.name)));
          if(raKey<0||deKey<0){cols.push({name:'RA',id:'RA',unit:'deg'}, {name:'DEC',id:'DEC',unit:'deg'});
            sources.forEach((src,i)=>raw[i].push(src.ra,src.dec));}
          end(resolve,readVotRows(cols,raw));
        }catch(e){end(reject,e);}
      },error=>fail(Error('Aladin Lite could not read this VOTable: '+String(error?.message||error).slice(0,200))),
      false); // useProxy=false: the local Blob URL is never handed to the CDS proxy
    }catch(e){end(reject,e);}
  });
}

async function decompressIfGzip(file){
  return window.GrawitaSafeFile.read(file,{
    maxInputBytes:window.GrawitaSafeFile.LIMITS.galaxy,
    maxOutputBytes:window.GrawitaSafeFile.LIMITS.galaxy
  });
}

function distanceEnabled(){return $('glade-show-all').checked&&$('glade-distance-enable').checked;}
function distanceRange(){
  const minInput=$('glade-distance-min'),maxInput=$('glade-distance-max');
  const minText=minInput.value.trim(),maxText=maxInput.value.trim();
  const min=minText===''?0:Number(minText),max=maxText===''?Infinity:Number(maxText);
  const valid=minInput.validity.valid&&maxInput.validity.valid&&
    Number.isFinite(min)&&min>=0&&(max===Infinity||Number.isFinite(max))&&max>=min;
  return {min,max,valid};
}
function inDistance(g,range){
  return !range||(Number.isFinite(g.distance)&&g.distance>=range.min&&g.distance<=range.max);
}
function fovOnlyActive(){
  // Preserve v16 behavior: unrestricted 'Show ALL' ignores the FoV entirely.
  // The new distance option explicitly enables opt-in FoV filtering without paging.
  return $('glade-only-fov').checked&&(!$('glade-show-all').checked||distanceEnabled());
}
function filtered(range=distanceEnabled()?distanceRange():null){
  const search=$('glade-search').value.trim().toLowerCase(),onlyFoV=fovOnlyActive();
  return galaxies.filter(g=>inDistance(g,range)&&(!search||g.name.toLowerCase().includes(search))&&
    (!onlyFoV||(selectedFoV&&M.inside(g,selectedFoV))));
}
function fullMapItems(range=distanceEnabled()?distanceRange():null){
  // Full sky ignores the *text search*, not the explicit distance/FoV selections.
  // Every matching galaxy becomes a marker regardless of the 100-row table page.
  if(!range&&!fovOnlyActive())return galaxies;
  return galaxies.filter(g=>inDistance(g,range)&&(!fovOnlyActive()||(selectedFoV&&M.inside(g,selectedFoV))));
}
function distanceSummary(range){
  const info=$('glade-distance-feedback');
  if(!distanceEnabled()){
    info.dataset.error='false';info.textContent='Distance selection off: Show ALL plots the entire loaded catalog.';return true;
  }
  const d=range||distanceRange();
  for(const el of [$('glade-distance-min'),$('glade-distance-max')])el.setAttribute('aria-invalid',String(!d.valid));
  if(!d.valid){
    info.dataset.error='true';info.textContent='Invalid range: use non-negative distances and ensure From ≤ To. Previous display preserved.';
    return false;
  }
  const n=galaxies.filter(g=>inDistance(g,d)).length;
  info.dataset.error='false';
  info.textContent=`${n.toLocaleString('en-US')} / ${galaxies.length.toLocaleString('en-US')} galaxies in ${Number.isFinite(d.min)?d.min:0}–${Number.isFinite(d.max)?d.max:'∞'} Mpc (inclusive).`+
    (fovOnlyActive()?' Selected FoV is also applied.':' FoV filter off; all directions included.');
  return true;
}
function removePlot(){
  // Invalidates pending batches before removing the old Aladin layer. This also
  // handles unchecked 'Show all', changed filters and imported replacement data.
  plotVersion++;
  if(plotTimer!==null){clearTimeout(plotTimer);plotTimer=null;}
  const oldLayer=sourceLayer;sourceLayer=null;plottedMode='none';
  if(oldLayer&&aladin){try{aladin.removeOverlay(oldLayer);}catch(e){try{aladin.removeCatalog(oldLayer);}catch(_){console.warn('Could not remove GLADE layer',e);}}}
}
function plot(items,{keepAll=false}={}){
  const all=$('glade-show-all').checked;
  if(keepAll&&all&&visible&&sourceLayer&&plottedMode==='all')return;
  removePlot();
  const progress=$('glade-plot-progress');
  if(!visible){progress.textContent='Galaxies hidden in Aladin.';return;}
  if(!A||!aladin){progress.textContent='Awaiting Aladin viewer…';return;}
  if(!items.length){progress.textContent='No galaxies to display.';return;}
  // Aladin Lite's documented onClick(Source) callback. Keep marker metadata
  // lightweight even when 23,935 sources are displayed simultaneously;
  // retrieve the original 43-column row only upon clicking one galaxy.
  const cat=A.catalog({name:'GLADE+ galaxies · V90',color:'#9ce8fe',sourceSize:5,
    onClick:source=>{
      const index=Number(source?.data?.__grawitaRow);
      const g=galaxyByRow.get(index);
      if(g)selectGalaxy(g,{center:false});
    }});
  const toSource=g=>A.source(g.ra,g.dec,{Name:g.name,RA:g.ra,Dec:g.dec,Distance_Mpc:g.distance??'unknown',B_mag:g.bmag??'unknown',Absolute_B_mag:g.absB??'unknown',__grawitaRow:g.row});
  aladin.addCatalog(cat);sourceLayer=cat;
  if(!all){
    // Original fast 100-at-a-time mode; no change to the table's page size.
    cat.addSources(items.map(toSource));plottedMode='page';
    progress.textContent=`${items.length.toLocaleString('en-US')} galaxies displayed (current page).`;
    return;
  }
  plottedMode='all';
  const version=plotVersion,total=items.length;let cursor=0;
  progress.textContent=`Adding ALL ${total.toLocaleString('en-US')} galaxies to Aladin: 0 / ${total.toLocaleString('en-US')}…`;
  function nextBatch(){
    plotTimer=null;
    if(version!==plotVersion||sourceLayer!==cat||!visible||!$('glade-show-all').checked)return;
    try{
      const end=Math.min(total,cursor+ALL_MAP_BATCH),sources=[];
      for(let i=cursor;i<end;i++)sources.push(toSource(items[i]));
      cat.addSources(sources);cursor=end;
      const loaded=typeof cat.getSources==='function'?cat.getSources().length:cursor;
      if(cursor===total&&loaded!==total){
        progress.textContent=`Aladin count mismatch: ${loaded.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} loaded.`;
        console.error('Full galaxy catalog count mismatch',{loaded,total});
      }else{
        const qualifier=distanceEnabled()?(fovOnlyActive()?' in distance range and selected FoV':' in distance range'):'';
        progress.textContent=cursor===total
          ?`All ${total.toLocaleString('en-US')} galaxies${qualifier} loaded in Aladin. Table: 100 per page. Use “All sky” to frame the whole catalog.`
          :`Adding ALL galaxies${qualifier} to Aladin: ${cursor.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}…`;
      }
      if(cursor<total)plotTimer=setTimeout(nextBatch,16);
    }catch(error){
      // Keep the working partial catalog and give user a reversible escape hatch.
      progress.textContent=`Aladin stopped plotting after ${cursor.toLocaleString('en-US')} sources: ${error.message}. Untick “Show all” to restore 100-per-page display.`;
      console.error('GLADE full-map plot error',error);
    }
  }
  nextBatch();
}
function detail(g){const p=$('glade-detail');p.textContent='';
  const lines=[`GLADE+ · ${g.name}`,`ICRS: RA ${fmt(g.ra,6)}°, Dec ${fmt(g.dec,6)}°`,
    `Catalog distance: ${g.distance===null?'not supplied':fmt(g.distance,2)+' Mpc'}`];
  if(g.redshift!==null)lines.push('Redshift: '+fmt(g.redshift,5));
  if(g.bmag!==null)lines.push('Apparent B magnitude: '+fmt(g.bmag,3));
  if(g.absB!==null&&g.absB!==undefined)lines.push('Absolute B magnitude (BMAG): '+fmt(g.absB,3));
  if(Number.isFinite(g.searchedProbVol))lines.push('3D cumulative credibility: '+fmt(g.searchedProbVol*100,4)+'% (not an individual host probability)');
  if(posterior){const cell=M.posteriorCellAt(posterior,g.ra,g.dec),d=M.distanceDiagnostics(cell,g.distance);
    if(d)lines.push(`GW direction distance: mean ≈ ${fmt(d.mean,1)} Mpc; 90% equal-tailed interval ${fmt(d.lo,1)}–${fmt(d.hi,1)} Mpc`);
    else lines.push('GW distance: unavailable at this sky position / missing 3D columns');
  }
  lines.push('V90 membership: supplied by your prefiltered FITS, not independently recomputed here.');
  p.textContent=lines.join('\n');
}
function closeMeasurements(){
  $('glade-measurements').hidden=true;
  $('glade-measurements-values').textContent='';
}
function showMeasurements(g){
  const dock=$('glade-measurements'),head=$('glade-measurements-title');
  const labels=$('glade-measurements-labels'),values=$('glade-measurements-values');
  labels.textContent='';values.textContent='';
  let raw=null;
  try{raw=measurementLookup?.(g)||null;}catch(e){console.warn('GLADE measurement lookup failed',e);}
  let fields=catalogFields;
  if(!Array.isArray(raw)||raw.length!==fields.length){
    // Never mislabel a field as an original VOTable column when unavailable.
    fields=[{name:'Name'},{name:'RAJ2000',unit:'deg'},{name:'DEJ2000',unit:'deg'},
      {name:'dL',unit:'Mpc'},{name:'BMAG',unit:'mag'}];
    raw=[g.name,g.ra,g.dec,g.distance,g.absB];
  }
  for(let i=0;i<fields.length;i++){
    const f=fields[i],h=document.createElement('th'),v=document.createElement('td');
    h.scope='col';h.textContent=f.name;
    if(f.unit)h.title=`${f.name} (${f.unit})`;
    const val=raw[i];v.textContent=val===null||val===undefined||String(val).trim()===''?'—':String(val);
    if(f.unit)v.title=f.unit;
    labels.appendChild(h);values.appendChild(v);
  }
  head.textContent=`${g.name} · ${fields.length} catalog columns · source row ${g.row.toLocaleString('en-US')}`;
  dock.hidden=false;
  $('glade-measurements-scroll').scrollLeft=0;
}
function selectGalaxy(g,{center=true}={}){selected=g.row;detail(g);showMeasurements(g);
  // Clicking a marker must NOT move the sky or change its FoV.
  // Clicking a sidebar row preserves the original center-on-source action.
  if(center&&aladin){try{aladin.gotoRaDec(g.ra,g.dec);aladin.setFoV(1.5);}catch(e){status('Galaxy selected, Aladin centering failed: '+e.message);}}
  for(const row of $('glade-rows').querySelectorAll('tr[data-row]'))row.classList.toggle('selected',Number(row.dataset.row)===g.row);
}
function refresh({keepAll=false}={}){
  const range=distanceEnabled()?distanceRange():null;
  if(!distanceSummary(range))return; // never silently replace a valid subset with an invalid range
  const rows=filtered(range);const maxPage=Math.max(0,Math.ceil(rows.length/PAGE)-1);page=Math.min(page,maxPage);
  const shown=rows.slice(page*PAGE,(page+1)*PAGE),tbody=$('glade-rows');tbody.textContent='';
  $('glade-count').textContent=`${galaxies.length.toLocaleString('en-US')} galaxies in catalog`;
  $('glade-order').textContent=sortedByAbsoluteB?'Absolute B magnitude (BMAG) · brightest first':'Original catalog order';
  $('glade-page-count').textContent=`${rows.length.toLocaleString('en-US')} matching`;
  $('glade-page').textContent=rows.length?`Page ${page+1} of ${maxPage+1}`:'Page —';
  $('glade-prev').disabled=page===0||!rows.length;$('glade-next').disabled=page>=maxPage||!rows.length;
  $('glade-hide').disabled=!galaxies.length;
  $('glade-hide').textContent=visible?'Hide galaxies':'Show galaxies';
  if(!shown.length){const tr=tbody.insertRow(),td=tr.insertCell();td.colSpan=5;td.textContent=galaxies.length?'No galaxies match these filters.':'Import a local GLADE V90 FITS or VOTable.';}
  for(const g of shown){const tr=tbody.insertRow();tr.dataset.row=String(g.row);tr.tabIndex=0;tr.title='Center this galaxy in Aladin';
    if(g.row===selected)tr.classList.add('selected');
    for(const str of [g.name,fmt(g.ra,3),fmt(g.dec,3),g.distance===null?'—':fmt(g.distance,1),g.absB==null?'—':fmt(g.absB,2)])tr.insertCell().textContent=str;
    tr.addEventListener('click',()=>selectGalaxy(g));tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectGalaxy(g);}});
  }
  // Full map ignores text search and pagination, but respects the optional
  // user-selected distance interval and, if explicitly requested, selected FoV.
  plot($('glade-show-all').checked?fullMapItems(range):shown,{keepAll});
}
function installCatalogResult(res, name, options={}){
  galaxies=res.items;filename=name;selected=null;page=0;visible=true;sortedByAbsoluteB=options.sortedByAbsoluteB===true;
  // A replacement catalog may have very different distance bounds: reset the
  // opt-in interval, never apply an old catalog's limits silently.
  $('glade-distance-enable').checked=false;
  let minDistance=Infinity,maxDistance=-Infinity;
  for(const g of galaxies){if(Number.isFinite(g.distance)&&g.distance>0){
    if(g.distance<minDistance)minDistance=g.distance;
    if(g.distance>maxDistance)maxDistance=g.distance;
  }}
  $('glade-distance-min').value=Number.isFinite(minDistance)?String(Math.floor(minDistance)):'0';
  $('glade-distance-max').value=Number.isFinite(maxDistance)?String(Math.ceil(maxDistance)):'';
  syncShowAllControls();
  catalogFields=res.fields||[];
  measurementLookup=typeof res.getRecord==='function'?res.getRecord:null;
  galaxyByRow=new Map(galaxies.map(g=>[g.row,g]));
  closeMeasurements();
  $('glade-search').disabled=false;refresh();
  status(`${filename}: ${res.items.length.toLocaleString()} galaxies loaded; ${res.rejected} invalid coordinate rows excluded. ${sortedByAbsoluteB?'Sorted by absolute B magnitude (BMAG), brightest first; missing values last. ':''}Table: 100 galaxies per page; full-map display is optional.`);
  if(res.items.length)detail(res.items[0]);
}
async function importVotFile(){
  const file=$('glade-vot-file').files[0];if(!file)return;
  $('glade-vot-import').disabled=true;status('Reading local VOTable '+file.name+'…');
  try{
    if(file.size>60*1024*1024)throw Error('VOTable exceeds 60 MB browser-only limit. Export the V90 subset.');
    const raw=await decompressIfGzip(file);
    const blob=new Blob([raw],{type:'application/x-votable+xml'});
    const text=await blob.text();
    let res=parseVotTableData(text);
    if(!res)res=await aladinNativeVot(blob);
    installCatalogResult(res,file.name);
  }catch(e){status('VOTable import error: '+e.message);console.error('GLADE VOTable error',e);}
  finally{$('glade-vot-import').disabled=false;}
}
$('glade-measurements-close').addEventListener('click',closeMeasurements);
$('glade-search').addEventListener('input',()=>{page=0;refresh({keepAll:true});});
$('glade-only-fov').addEventListener('change',()=>{
  page=0;
  // In full distance-filter mode, the opt-in FoV changes the actual marker set.
  refresh({keepAll:!distanceEnabled()});
});
$('glade-hide').addEventListener('click',()=>{visible=!visible;refresh();});
function syncShowAllControls({clearFoV=false}={}){
  const all=$('glade-show-all').checked,range=$('glade-distance-enable').checked,only=$('glade-only-fov');
  $('glade-distance-box').hidden=!all;
  for(const id of ['glade-distance-min','glade-distance-max'])$(id).disabled=!(all&&range);
  // Without an explicitly enabled distance range, preserve v16's invariant:
  // Show ALL is unrestricted and disables the older FoV-only table filter.
  only.disabled=all&&!range;
  if(clearFoV||only.disabled)only.checked=false;
  only.title=all?(range?'Optional: show every galaxy in the distance range AND the selected FoV (no 100-marker limit).':'Disabled until a distance range is enabled. Show ALL plots every galaxy.'):
    'Filter the 100-per-page table and Aladin map by the selected FoV.';
}
function updateDistance(){
  if(distanceTimer!==null){clearTimeout(distanceTimer);distanceTimer=null;}
  if(!distanceSummary())return;
  // input+change fire together when a user moves focus: do not rebuild a
  // thousands-source Aladin catalog twice for the same exact interval.
  const signature=['glade-show-all','glade-distance-enable','glade-distance-min','glade-distance-max'].map(id=>{
    const el=$(id);return el.type==='checkbox'?String(el.checked):el.value.trim();
  }).join('|');
  if(signature===lastDistanceControlsSignature)return;
  lastDistanceControlsSignature=signature;
  page=0;refresh();
}
$('glade-distance-enable').addEventListener('change',()=>{
  syncShowAllControls({clearFoV:!$('glade-distance-enable').checked});updateDistance();
});
for(const id of ['glade-distance-min','glade-distance-max']){
  $(id).addEventListener('input',()=>{
    if(distanceTimer!==null)clearTimeout(distanceTimer);
    // A large catalog is redrawn only after typing stops.
    distanceTimer=setTimeout(()=>{distanceTimer=null;updateDistance();},280);
  });
  $(id).addEventListener('change',updateDistance);
}
$('glade-show-all').addEventListener('change',()=>{
  if(distanceTimer!==null){clearTimeout(distanceTimer);distanceTimer=null;}
  // Returning to 100-per-page mode restores the exact v17 behavior.
  if(!$('glade-show-all').checked)$('glade-distance-enable').checked=false;
  syncShowAllControls({clearFoV:true});
  if($('glade-show-all').checked)visible=true;
  page=0;refresh();
});
$('glade-prev').addEventListener('click',()=>{page--;refresh({keepAll:true});});
$('glade-next').addEventListener('click',()=>{page++;refresh({keepAll:true});});
window.addEventListener('vst-aladin-ready',ev=>{A=ev.detail.A;aladin=ev.detail.aladin;refresh();});
window.addEventListener('vst-fov-selected',ev=>{selectedFoV=ev.detail.fov;page=0;if(fovOnlyActive())refresh();});
window.addEventListener('vst-coverage-sequence-updated',ev=>{
  selectedFoV=ev.detail.pointings.find(p=>p.id===ev.detail.selectedFoV)||null;
  if(fovOnlyActive()){page=0;refresh();}
});
window.addEventListener('vst-posterior-loaded',ev=>{posterior=ev.detail.posterior;});
// Aladin may have initialized before this standalone module's listener was installed.
if(window.GRAWITALiveViewer?.A && window.GRAWITALiveViewer?.aladin){A=window.GRAWITALiveViewer.A;aladin=window.GRAWITALiveViewer.aladin;refresh();}
// This is a self-contained script dataset rather than fetch('data/…') so that
// double-clicking index.html remains compatible with file:// security rules.
// The full, unchanged user VOTable is bundled separately in data/ for provenance.
function installBundledDefault(){
  const d=window.GRAWITAGladeDefaultData;
  if(!d)return;
  try{
    if(d.version!==1||!Array.isArray(d.rows)||d.rows.length!==d.totalRows-d.rejected)throw Error('Invalid bundled catalog metadata');
    const items=d.rows.map(([name,ra,dec,distance,redshift,bmag,absB,searchedProbVol,searchedProb2d,row])=>({
      name,ra,dec,distance,redshift,bmag,absB,searchedProbVol,searchedProb2d,row
    }));
    // The generated data is pre-sorted; guard against accidental regeneration
    // without the requested stable ordering, including missing values last.
    for(let i=1;i<items.length;i++){
      const a=items[i-1].absB,b=items[i].absB;
      if((a==null&&b!=null)||(a!=null&&b!=null&&a>b))throw Error('Bundled BMAG ordering is invalid');
    }
    const raw=window.GRAWITAGladeMeasurements;
    // Guard against displaying unrelated rows if the original VOTable changes.
    const valid=raw?.version===1 && raw.sourceSha256===d.sourceSha256 &&
      raw.totalRows===d.totalRows && raw.fieldCount===raw.fields?.length &&
      raw.rows?.length===d.totalRows && raw.rows.every(r=>Array.isArray(r)&&r.length===raw.fieldCount);
    if(!valid)console.warn('Full GLADE measurements unavailable or source checksum mismatch');
    installCatalogResult({items,totalRows:d.totalRows,rejected:d.rejected,
      fields:valid?raw.fields:[],
      getRecord:valid?(g=>raw.rows[g.row-1]):null},d.source,{sortedByAbsoluteB:true});
  }catch(e){status('Bundled V90 load error: '+e.message);console.error('Bundled GLADE V90 catalog error',e);}
}
syncShowAllControls();
installBundledDefault();
window.GrawitaGladeTest={parseFits,parseVotTableData,readVotRows,filtered,refresh,importVotFile,
  getState:()=>({galaxies,filename,visible,page,selected,sortedByAbsoluteB,plottedMode,plotVersion,measurementColumns:catalogFields.length,measurementsOpen:!$('glade-measurements').hidden,plottedCount:sourceLayer&&typeof sourceLayer.getSources==='function'?sourceLayer.getSources().length:null,distanceEnabled:distanceEnabled(),distanceRange:distanceRange(),fovOnlyActive:fovOnlyActive()}),
  selectGalaxyRow:row=>{const g=galaxyByRow.get(Number(row));if(g)selectGalaxy(g,{center:false});}};
})();
