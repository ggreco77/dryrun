/* Button feedback (presentation only). After a user's own click on a GRAWITA button, and only once its
 * action has finished without an error, that same button shows a short confirmation (data-ack, ~550 ms);
 * no other control changes. It only reads existing UI state: the Coverage busy flag, the Coverage and
 * status messages, uncaught errors and, for commands that may end without doing anything, whether the
 * plan, the preview or the transient table really changed. It never calls, delays, repeats or blocks an
 * action. Not used for Aladin Lite, disabled buttons, the persistent Expand toggle (aria-pressed), file
 * pickers and the SkyBoT / bright-star queries, whose own status lines report the outcome later.
 * FoV commands (compass, fine adjustment, Center, Best next, Preview) instead stay orange while they run.
 */
(()=>{
'use strict';
const SCOPE='#layer-pane button,#sky-pane button,#coverage-pane button';
// GW Tiling (scripts/gw-tiling-panel.js): "Generate coverage" sets and restores its own orange running state for the whole
// calculation, which may last longer than the limits below; its "Cancel" is a cancel command like #cv-cancel.
const NOT='.viewer-stack *,.subtle-button,[aria-pressed],#tr-skybot,#tr-bright,#tr-import,#cv-import-map,#cv-cancel,#gw-generate,#gw-cancel';
const ACK_MS=550,MAX_WAIT_MS=60000;
const lab=()=>window.CoverageLab&&window.CoverageLab.state;
const count=()=>lab()?lab().pointings.length:null;
// May end with "nothing to do" (empty plan, Coverage missing): confirmed only on a real change.
const CHANGE={'cv-undo':count,'cv-delete-selected':count,'cv-clear':count,'campo-plan':count,'asiago-plan':count};
// Report invalid input only as text: confirmed only if the transient table was redrawn.
const ROWS={'tr-quick-analyze':'tr-rows','tr-paste-run':'tr-rows'};
// Waits for Aladin before acting: its outcome is the next Coverage message.
const WAIT_MESSAGE=new Set(['cv-use-center']);
// FoV commands: the pressed button stays orange (data-running) from its accepted start until the calculation
// has ended and Aladin Lite has run a drawing pass after it. Aladin has no public "rendered" event: its view
// loop draws pending overlay changes on the next animation frame, so two frames after the end are an
// operational guarantee that the new outline has been drawn, not a confirmation of the WebGL frame itself.
const FOV='[data-cv-dir],[data-fine-dir],#cv-fine-reset,#cv-center-compass,#cv-best,#cv-preview';
const MAX_RUN_MS=300000;
const runs=new WeakMap();let runSeq=0;
async function trackRun(btn){
  const run=++runSeq,start=performance.now(),message=document.getElementById('cv-feedback');
  let messageChanged=false;
  const watch=new MutationObserver(()=>{messageChanged=true;});
  if(message)watch.observe(message,{attributes:true,childList:true,characterData:true,subtree:true});
  runs.set(btn,run);btn.setAttribute('data-running','');
  await frame();// the click handler has run: the guarded calculation is busy, or already over
  // Center first reads Aladin's view centre; its outcome, or the preview it starts, is the next message.
  while(btn.id==='cv-center-compass'&&!messageChanged&&!(lab()&&lab().busy)&&performance.now()-start<3000)await frame();
  while(lab()&&lab().busy&&performance.now()-start<MAX_RUN_MS)await frame();
  await frame();await frame();
  watch.disconnect();
  if(runs.get(btn)===run){runs.delete(btn);btn.removeAttribute('data-running');}// a later run keeps its own state
}
let uncaught=0,lastCancel=-Infinity;
addEventListener('error',()=>{uncaught++;});
addEventListener('unhandledrejection',()=>{uncaught++;});
// A calculation interrupted with "Interrompi" is not a success.
document.addEventListener('click',e=>{if(e.isTrusted&&e.target instanceof Element&&e.target.closest('#cv-cancel,#gw-cancel'))lastCancel=performance.now();},true);
const timers=new WeakMap();
function ack(btn){
  clearTimeout(timers.get(btn));btn.setAttribute('data-ack','');
  timers.set(btn,setTimeout(()=>btn.removeAttribute('data-ack'),ACK_MS));
}
const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>resolve()));
async function settled(waitMessage,changed){
  const start=performance.now();
  await frame();await frame();
  while(waitMessage&&!changed.has('message')&&performance.now()-start<3000)await frame();
  while(lab()&&lab().busy&&performance.now()-start<MAX_WAIT_MS)await frame();
}
// Capture phase: the state is read before the button's own handler runs.
document.addEventListener('click',async e=>{
  const btn=e.isTrusted&&e.target instanceof Element?e.target.closest(SCOPE):null;
  if(!btn||btn.disabled||btn.matches(NOT))return;
  const busyBefore=!!(lab()&&lab().busy),errorsBefore=uncaught,snap=CHANGE[btn.id],before=snap?snap():null,clickedAt=performance.now();
  if(btn.matches(FOV)){if(!busyBefore)trackRun(btn);return;}// refused while busy: no feedback
  const message=document.getElementById('cv-feedback'),status=document.getElementById('status');
  const rows=ROWS[btn.id]?document.getElementById(ROWS[btn.id]):null;
  const changed=new Set();
  const watch=new MutationObserver(records=>{
    for(const r of records){
      if(message&&message.contains(r.target))changed.add('message');
      else if(status&&status.contains(r.target))changed.add('status');
      else if(rows&&rows.contains(r.target))changed.add('rows');
    }
  });
  for(const el of [message,status,rows])if(el)watch.observe(el,{attributes:true,childList:true,characterData:true,subtree:true});
  await settled(WAIT_MESSAGE.has(btn.id),changed);
  watch.disconnect();
  const failed=busyBefore||uncaught>errorsBefore||lastCancel>=clickedAt
    ||changed.has('message')&&message.dataset.type==='error'
    ||changed.has('status')&&/\b(error|warn)\b/.test(status.className)
    ||WAIT_MESSAGE.has(btn.id)&&!changed.has('message')
    ||!!snap&&snap()===before
    ||!!rows&&!changed.has('rows');
  if(!failed&&btn.isConnected&&!btn.disabled)ack(btn);
},true);
})();
