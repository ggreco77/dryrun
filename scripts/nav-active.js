/* Menu state only (presentation): marks the entry of the selected section with
 * aria-current="location" in both menus and keeps it visible inside a menu that
 * scrolls horizontally. It does not touch any scientific module or Aladin Lite.
 * The selection is the entry the user activated (click, keyboard, URL hash); in the
 * single-column layout it also follows the section being read while scrolling.
 */
(()=>{
'use strict';
const links=Array.from(document.querySelectorAll('.grawita-nav-links a[href^="#"],.mobile-jumps a[href^="#"]'));
if(!links.length)return;
const ids=Array.from(new Set(links.map(a=>a.getAttribute('href').slice(1))));
for(const a of links)a.dataset.label=a.textContent.trim(); // lets CSS reserve the width of the bold label
const singleColumn=window.matchMedia('(max-width:920px)');
let current=null,followScrollAfter=0,frame=0;
function reveal(link){
  const box=link.parentElement,b=box.getBoundingClientRect(),r=link.getBoundingClientRect();
  if(box.scrollWidth<=box.clientWidth)return;
  if(r.left<b.left)box.scrollLeft-=b.left-r.left+12;
  else if(r.right>b.right)box.scrollLeft+=r.right-b.right+12;
}
function select(id){
  if(!ids.includes(id))return;
  current=id;
  for(const a of links){
    if(a.getAttribute('href')==='#'+id){a.setAttribute('aria-current','location');reveal(a);}
    else a.removeAttribute('aria-current');
  }
}
function sectionInView(){
  // The section whose top has most recently passed below the sticky menu.
  let best=null,bestTop=-Infinity;
  for(const id of ids){
    const el=document.getElementById(id);if(!el)continue;
    const top=el.getBoundingClientRect().top;
    if(top<=120&&top>bestTop){best=id;bestTop=top;}
  }
  return best||ids[0];
}
for(const a of links)a.addEventListener('click',()=>{followScrollAfter=performance.now()+900;select(a.getAttribute('href').slice(1));});
window.addEventListener('hashchange',()=>select(location.hash.slice(1)));
window.addEventListener('scroll',()=>{
  if(!singleColumn.matches||performance.now()<followScrollAfter||frame)return;
  frame=requestAnimationFrame(()=>{frame=0;const id=sectionInView();if(id!==current)select(id);});
},{passive:true});
select(ids.includes(location.hash.slice(1))?location.hash.slice(1):ids[0]);
})();
