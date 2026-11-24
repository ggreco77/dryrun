/* Canonical union of spatial MOC JSON produced from several Aladin FoVs.
 * Geometry-preserving operation only: no skymap or P(inside) calculations.
 * IVOA MOC 2.0: no same-order duplicates, ancestor/descendant overlaps,
 * or uncollapsed groups of four HEALPix children.
 * Uses BigInt intervals at the finest input order: never expands an entire sky
 * region into individual fine pixels, and preserves large multi-order regions.
 */
(function (global) {
'use strict';
const MAX_ORDER=25;
function readMoc(moc) {
  if (typeof moc==='string')moc=JSON.parse(moc);
  if (!moc||typeof moc!=='object'||Array.isArray(moc))throw Error('Invalid spatial MOC JSON');
  const levels=[];
  for (const [key,indices] of Object.entries(moc)) {
    if (!/^(0|[1-9]\d*)$/.test(key)||!Array.isArray(indices))throw Error('Invalid MOC order: '+key);
    const order=Number(key);
    if (!Number.isInteger(order)||order<0||order>MAX_ORDER)throw Error('Unsupported MOC order: '+key);
    const maximum=12n*(1n << BigInt(2*order));
    for (const pixel of indices) {
      if (!Number.isSafeInteger(pixel)||pixel<0||BigInt(pixel)>=maximum)
        throw Error('Invalid or unsafe MOC pixel at order '+order+': '+pixel);
    }
    levels.push([order,indices]);
  }
  return levels;
}
function union(mocs) {
  if (!Array.isArray(mocs)||!mocs.length)throw Error('No FoV MOCs to combine');
  const levels=mocs.map(readMoc);
  let deepest=0,count=0;
  for (const moc of levels)for(const [order,values] of moc){
    deepest=Math.max(deepest,order);count+=values.length;
  }
  if (!count)throw Error('Empty FoV MOC union');
  // Represent input cells as [start,end) intervals of deepest-order NESTED cells.
  const ranges=[];
  for (const moc of levels)for(const [order,values] of moc){
    const scale=1n << BigInt(2*(deepest-order));
    for (const pix of values) {
      const start=BigInt(pix)*scale;
      ranges.push([start,start+scale]);
    }
  }
  ranges.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  // Merge BOTH duplicates and hierarchical overlaps, plus touching ranges.
  const merged=[];
  for (const [a,b] of ranges) {
    const last=merged[merged.length-1];
    if (last&&a<=last[1]) {
      if(b>last[1])last[1]=b;
    }else merged.push([a,b]);
  }
  // Repartition merged ranges as the largest available aligned 4^k blocks.
  // This also coalesces full sets of four children into their parent.
  const output={};
  for (const [start,end] of merged) {
    let cursor=start;
    while (cursor<end) {
      let k=0;
      while (k<deepest) {
        const next=1n << BigInt(2*(k+1));
        if(cursor%next!==0n||cursor+next>end)break;
        k++;
      }
      const step=1n << BigInt(2*k),order=deepest-k;
      const pixel=cursor/step;
      if(pixel>BigInt(Number.MAX_SAFE_INTEGER))throw Error('MOC index exceeds JSON safe-integer range');
      (output[order]??=[]).push(Number(pixel));
      cursor+=step;
    }
  }
  const canonical={};
  for (const order of Object.keys(output).sort((a,b)=>Number(a)-Number(b)))
    canonical[order]=output[order].sort((a,b)=>a-b);
  return canonical;
}
// Verify exported output without expanding pixels, useful for a strict regression test.
function isCanonical(json) {
  try {
    const levels=readMoc(json),recombined=union([json]);
    for (const [order,pixels] of levels) {
      const actual=recombined[order]||[];
      if(pixels.length!==actual.length||pixels.some((v,i)=>v!==actual[i]))return false;
    }
    return Object.keys(json).length===Object.keys(recombined).length;
  }catch(_){return false;}
}
global.CoverageMocCanonical={union,isCanonical};
})(window);
