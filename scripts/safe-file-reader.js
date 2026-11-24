/* Bounded local binary reader for FITS, MOC and VOTable; never sends inputs over the network. */
(()=>{'use strict';
const MiB=1024*1024;
const LIMITS=Object.freeze({skymap:96*MiB, moc:24*MiB, galaxy:60*MiB, transient:8*MiB});
async function read(file,{maxInputBytes=LIMITS.galaxy,maxOutputBytes=maxInputBytes}={}){
  if(!file||typeof file.arrayBuffer!=='function')throw Error('Invalid local file');
  if(Number.isFinite(file.size)&&file.size>maxInputBytes)throw Error('Input file exceeds the '+Math.round(maxInputBytes/MiB)+' MiB limit');
  const raw=await file.arrayBuffer();
  if(raw.byteLength>maxInputBytes)throw Error('Input file exceeds the '+Math.round(maxInputBytes/MiB)+' MiB limit');
  const b=new Uint8Array(raw);
  if(b.length<2||b[0]!==0x1f||b[1]!==0x8b){
    if(raw.byteLength>maxOutputBytes)throw Error('Uncompressed file exceeds '+Math.round(maxOutputBytes/MiB)+' MiB');
    return raw;
  }
  if(typeof DecompressionStream!=='function')throw Error('This browser cannot unpack gzip: decompress the file before importing.');
  const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader=stream.getReader(),parts=[];
  let total=0,done=false;
  try{
    while(true){
      const next=await reader.read();
      if(next.done){done=true;break;}
      total+=next.value.byteLength;
      if(total>maxOutputBytes)throw Error('Decompressed file exceeds '+Math.round(maxOutputBytes/MiB)+' MiB. Import aborted safely.');
      parts.push(next.value);
    }
  }finally{if(!done){try{await reader.cancel();}catch(_){}}reader.releaseLock();}
  const out=new Uint8Array(total);let off=0;
  for(const chunk of parts){out.set(chunk,off);off+=chunk.byteLength;}
  return out.buffer;
}
window.GrawitaSafeFile=Object.freeze({read,LIMITS});
})();
