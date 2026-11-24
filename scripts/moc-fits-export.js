/* Minimal IVOA SMOC NUNIQ FITS (2.0) exporter for already-created MOC JSON.
 * Pure serialization: no geometry/probability calculation takes place here.
 */
(function(global){
'use strict';
function toFits(json){
  let maxOrder=0,uniq=[];
  for(const [key,values] of Object.entries(json)){
    const order=Number(key);
    if(!Number.isInteger(order)||order<0||order>22||!Array.isArray(values))throw Error('Ordine MOC JSON non supportato in esportazione FITS: '+key);
    maxOrder=Math.max(maxOrder,order);
    for(const pixel of values){
      const n=4**order;
      if(!Number.isSafeInteger(pixel)||pixel<0||pixel>=12*n)throw Error('Invalid HEALPix index');
      uniq.push(BigInt(4**(order+1))+BigInt(pixel));
    }
  }
  if(!uniq.length)throw Error('MOC vuoto');
  uniq.sort((a,b)=>a<b?-1:a>b?1:0);
  const card=(key,val,comment='')=>{
    let rhs;
    if(typeof val==='string')rhs="'"+val.replace(/'/g,"''")+"'";
    else if(typeof val==='boolean')rhs=val?'T':'F';
    else rhs=String(val);
    return (key.padEnd(8,' ')+'= '+rhs.padStart(20,' ')+(comment?' / '+comment:'')).padEnd(80,' ').slice(0,80);
  };
  const header=(entries)=>{
    let s=entries.map(e=>card(...e)).join('')+'END'.padEnd(80,' ');
    s=s.padEnd(Math.ceil(s.length/2880)*2880,' ');
    return new TextEncoder().encode(s);
  };
  const primary=header([['SIMPLE',true],['BITPIX',8],['NAXIS',0],['EXTEND',true]]);
  const ext=header([
    ['XTENSION','BINTABLE'],['BITPIX',8],['NAXIS',2],['NAXIS1',8],['NAXIS2',uniq.length],
    ['PCOUNT',0],['GCOUNT',1],['TFIELDS',1],['TTYPE1','UNIQ'],['TFORM1','1K'],
    ['ORDERING','NUNIQ'],['COORDSYS','C'],['MOCDIM','SPACE'],['MOCORD_S',maxOrder],
    ['MOCVERS','2.0'],['MOCTYPE','IMAGE'],['EXTNAME','COVERAGE'],['MOCTOOL','VST Coverage Lab']
  ]);
  const tableBytes=uniq.length*8;
  const padded=Math.ceil(tableBytes/2880)*2880;
  const out=new Uint8Array(primary.length+ext.length+padded);
  out.set(primary,0);out.set(ext,primary.length);
  const dv=new DataView(out.buffer),start=primary.length+ext.length;
  for(let i=0;i<uniq.length;i++)dv.setBigInt64(start+i*8,uniq[i],false);
  return out;
}
global.CoverageMocFits={toFits};
})(window);
