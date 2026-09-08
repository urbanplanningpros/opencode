import { initial, available, routeStatus, apply, replay, encode, decode, score, brief } from './engine.mjs';
import { SAVE_KEY } from './limits.mjs';

const { campaign } = await import('./content/mill-creek.mjs');
const $ = selector => document.querySelector(selector);
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => '$'+value.toLocaleString('en-US');
const phases = [ ['EVALUATE','Find the expensive assumption.'], ['PLAN','Give the land a workable plan.'], ['COORDINATE','Put the right people on the next question.'], ['EXIT STRONG','Choose the decision you can defend.'] ];
let state=initial(campaign),phase=0,selected='control',sound=false,saved=false,zoom=1,pan={x:0,y:0},drag=null;
let audio=null,toastTimer=null;
try { const raw=localStorage.getItem(SAVE_KEY); if(raw){state=decode(campaign,raw);saved=state.history.length>0;} } catch { $('#save-notice').hidden=false;$('#save-notice').textContent='Your previous save could not be loaded. You can start a fresh campaign; no purchase access is affected.'; }
$('#resume').hidden=!saved;
function beep(){if(!sound)return;try{audio??=new (window.AudioContext||window.webkitAudioContext)();const o=audio.createOscillator(),g=audio.createGain();o.connect(g);g.connect(audio.destination);o.frequency.setValueAtTime(440,audio.currentTime);o.frequency.exponentialRampToValueAtTime(660,audio.currentTime+.08);g.gain.setValueAtTime(.03,audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.12);o.start();o.stop(audio.currentTime+.12);}catch{sound=false;}}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4000);}
function save(){try{localStorage.setItem(SAVE_KEY,encode(state));$('#save-state').textContent='Saved on this device';saved=true;}catch{$('#save-state').textContent='Playing without a saved copy';toast('Device storage is unavailable. Keep this tab open or download your decision record.');}}
function openModal(html){$('#modal-body').innerHTML=html;$('#modal').showModal();}
function closeModal(){$('#modal').close();}
function start(fresh=false){if(fresh){state=initial(campaign);phase=0;selected='control';save();}$('#launch').hidden=true;$('#game').hidden=false;render();$('#game h1').setAttribute('tabindex','-1');$('#game h1').focus({preventScroll:true});if(state.ending)showEnding();}
function showIntro(){openModal(`<p class="overline">YOUR OPPORTUNITY</p><h2 id="modal-title">Welcome to Mill Creek.</h2><p>${escape(campaign.intro)}</p><div class="brief-grid"><div><small>INVESTIGATION BUDGET</small><strong>${money(campaign.budget)}</strong></div><div><small>DECISION WINDOW</small><strong>${campaign.deadline} days</strong></div></div><p>Investigate the map. Spend in the right order. Compare the routes your evidence supports. The strongest ending may be a smaller project—or a timely exit.</p><p class="fine">All scenario facts, costs, deadlines, and outcomes are fictional. Your in-game budget is not real money.</p><button class="button bright" data-command="begin">Make my first move <span>→</span></button>`);}
function select(id){selected=id;const action=campaign.actions.find(a=>a.id===id);if(action)phase=action.phase;render();beep();if(window.matchMedia('(max-width: 760px)').matches)$('#decision-content').scrollIntoView({behavior:'smooth',block:'center'});}
function setPhase(n){phase=n;selected=n===3?'smaller':campaign.actions.find(a=>a.phase===n&&!state.done.includes(a.id))?.id??campaign.actions.find(a=>a.phase===n)?.id;render();}
function render(){
  $('#cash').textContent=money(state.cash);$('#time').innerHTML=`${state.deadline-state.day} <em>days left</em>`;
  const count=campaign.gates.filter(g=>state.done.includes(g.action)).length;
  $('#evidence').innerHTML=`${count} <em>/ 6 gates</em>`;
  document.querySelectorAll('[data-phase]').forEach(b=>{b.setAttribute('aria-pressed',Number(b.dataset.phase)===phase?'true':'false');});
  $('#deck-kicker').textContent=`0${phase+1} / ${phases[phase][0]}`;$('#deck-title').textContent=phases[phase][1];
  $('#deck-count').textContent=phase===3?'Every exit needs a reason':`${state.done.length} investigations & moves completed`;
  $('#gates').innerHTML=campaign.gates.map((g,i)=>`<button data-select="${g.action}" class="gate ${state.done.includes(g.action)?'complete':''}" title="${escape(g.name)}"><span>${state.done.includes(g.action)?'✓':'0'+(i+1)}</span><strong>${g.name}</strong><small>${state.done.includes(g.action)?'Screened':'Unknown'}</small></button>`).join('');
  $('#map-markers').innerHTML=campaign.actions.filter(a=>a.phase===0||a.id===selected).map(a=>`<button class="map-marker ${state.done.includes(a.id)?'complete':''} ${a.id===selected?'active':''}" data-select="${a.id}" style="left:${a.marker[0]}%;top:${a.marker[1]}%" aria-label="${escape(a.name)}${state.done.includes(a.id)?', completed':''}"><span>${state.done.includes(a.id)?'✓':a.id==='control'?'⚑':a.id==='land'?'≈':a.id==='survey'?'⌖':a.id==='market'?'↗':'?'}</span><b>${escape(a.short)}</b></button>`).join('');
  $('#creek-zone').classList.toggle('revealed',state.done.includes('land'));$('#road-zone').classList.toggle('revealed',state.done.includes('access'));
  renderConcept();renderMoves();renderDecision();
}
function renderConcept(){
  const route=campaign.routes.find(r=>r.id===selected||r.id===state.ending);
  if(!state.done.includes('concept')&&!state.done.includes('storage')){$('#concept-overlay').innerHTML='';return;}
  const type=route?.footprint??(state.done.includes('storage')&&!state.done.includes('concept')?'storage':'homes');
  if(type==='outline'){$('#concept-overlay').innerHTML='';return;}
  const rows=type==='phase'?2:type==='dense'?4:3,cols=type==='storage'?4:5;
  const cells=[];for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){const x=342+col*60-row*18,y=254+row*49+col*8;cells.push(`<polygon class="concept-lot" style="animation-delay:${(row*cols+col)*22}ms" points="${x},${y} ${x+48},${y+7} ${x+31},${y+42} ${x-17},${y+35}"/>`);}
  $('#concept-overlay').innerHTML=`<g class="${type==='storage'?'storage-plan':''}">${cells.join('')}</g><text x="560" y="455" class="plan-label" text-anchor="middle">${type==='phase'?'FIRST-PHASE STUDY':type==='storage'?'ALTERNATIVE-USE STUDY':'CONCEPT STUDY'}</text>`;
}
function renderMoves(){
  if(phase===3){$('#moves').innerHTML=campaign.routes.map(r=>{const reason=routeStatus(campaign,state,r);return `<button class="move route-move ${selected===r.id?'selected':''}" data-route="${r.id}"><span class="move-kind">${escape(r.kind)}</span><strong>${escape(r.short)}</strong><span class="move-bottom"><span>${reason?'Evidence needed':'Route available'}</span><b>${reason?'◇':'↗'}</b></span></button>`;}).join('');return;}
  $('#moves').innerHTML=campaign.actions.filter(a=>a.phase===phase).map(a=>{const done=state.done.includes(a.id),reason=available(campaign,state,a);return `<button class="move ${done?'done':''} ${selected===a.id?'selected':''}" data-select="${a.id}"><span class="move-kind">${done?'✓ COMPLETED':a.category.toUpperCase()}</span><strong>${escape(a.short)}</strong><span class="move-bottom"><span>${money(a.cost)} · ${a.days} ${a.days===1?'day':'days'}</span><b>${done?'✓':reason?'◇':'↗'}</b></span></button>`;}).join('');
}
function renderDecision(){
  if(phase===3){const r=campaign.routes.find(r=>r.id===selected)??campaign.routes[0],reason=routeStatus(campaign,state,r);$('#panel-kicker').textContent='YOUR EXIT STRATEGY';$('#decision-content').innerHTML=`<span class="decision-index">0${campaign.routes.indexOf(r)+1} / ${escape(r.kind.toUpperCase())}</span><h2>${escape(r.name)}</h2><p>${escape(r.summary)}</p><div class="tradeoff"><small>THE TRADEOFF</small><p>${escape(r.tradeoff)}</p></div><div class="risk-row"><span>Route exposure</span><strong>${escape(r.risk)}</strong></div>${reason?`<p class="requirement">${escape(reason)}</p>`:''}<button class="button bright decision-button" data-exit="${r.id}" ${reason?'disabled':''}>Choose this ending <span>→</span></button><p class="fine">This ending records a next-step decision. Further approvals, financing, and transaction work remain outside the simulation.</p>`;return;}
  const a=campaign.actions.find(a=>a.id===selected)??campaign.actions[0],done=state.done.includes(a.id),reason=available(campaign,state,a);
  $('#panel-kicker').textContent=done?'EVIDENCE IN YOUR JOURNAL':'YOUR NEXT MOVE';
  $('#decision-content').innerHTML=`<span class="decision-index">${escape(a.category.toUpperCase())} / CHAPTER ${a.chapter}</span><h2>${escape(a.name)}</h2><p>${escape(done?a.result:a.description)}</p>${done?`<div class="lesson"><small>THE TAKEAWAY</small><p>${escape(a.lesson)}</p></div>`:`<div class="move-cost"><div><small>BUDGET</small><strong>${money(a.cost)}</strong></div><div><small>TIME</small><strong>${a.days} ${a.days===1?'day':'days'}</strong></div></div>`}${reason&&!done?`<p class="requirement">${escape(reason)}</p>`:''}${done?`<button class="button dark decision-button" data-command="next">Find the next move <span>→</span></button>`:`<button class="button bright decision-button" data-move="${a.id}" ${reason?'disabled':''}>${a.category==='Pivot'?'Explore this pivot':a.category==='Negotiate'?'Make this move':'Start this move'} <span>→</span></button>`}<button class="book-note" data-chapter="${a.chapter}"><span>▤</span> From the field manual <b>Chapter ${a.chapter} ↗</b></button>`;
}
function move(id){
  const before=state;try{state=apply(campaign,state,id);}catch(error){toast(error.message);return;}
  save();render();beep();const action=campaign.actions.find(a=>a.id===id);const events=campaign.events.filter(e=>state.events.includes(e.id)&&!before.events.includes(e.id));
  const unlocked=campaign.routes.filter(r=>r.id!=='walk'&&r.needs.every(x=>state.done.includes(x))&&!r.needs.every(x=>before.done.includes(x)));
  openModal(`<p class="overline">MOVE COMPLETE · DAY ${state.day}</p><h2 id="modal-title">${escape(action.evidence)}</h2><p>${escape(action.result)}</p><div class="lesson"><small>WHAT THIS CHANGES</small><p>${escape(action.lesson)}</p></div>${events.map(e=>`<div class="event"><span>NEW DEVELOPMENT</span><h3>${escape(e.title)}</h3><p>${escape(e.text)}</p></div>`).join('')}${unlocked.length?`<div class="unlocked">↗ ${unlocked.length} ${unlocked.length===1?'route is':'routes are'} now available: ${unlocked.map(r=>escape(r.short)).join(', ')}.</div>`:''}<div class="modal-actions"><button class="button bright" data-command="continue">Continue playing <span>→</span></button><button class="text-button" data-command="exits">Compare exits</button></div><p class="fine">${money(action.cost)} spent · ${action.days} ${action.days===1?'day':'days'} elapsed · Fictional simulation</p>`);
}
function chooseExit(id){try{state=apply(campaign,state,'exit:'+id);}catch(error){toast(error.message);return;}save();render();beep();showEnding();}
function showEnding(){const r=campaign.routes.find(r=>r.id===state.ending),points=score(campaign,state),label=points>=85?'STRATEGIC DEVELOPER':points>=65?'OPTIONS PROTECTED':points>=40?'EVIDENCE BUILDER':'EARLY DECISION';openModal(`<p class="overline">CAMPAIGN COMPLETE / ${escape(r.kind.toUpperCase())}</p><h2 id="modal-title">${escape(r.name)}</h2><div class="ending-score"><strong>${points}<small>/100</small></strong><div><span>${label}</span><p>Decision quality score</p></div></div><p>${escape(r.lesson)}</p><div class="brief-grid"><div><small>GAME BUDGET REMAINING</small><strong>${money(state.cash)}</strong></div><div><small>TIME PROTECTED</small><strong>${state.deadline-state.day} days</strong></div></div><div class="lesson"><small>YOUR NEXT STEP ON THIS ROUTE</small><p>${escape(r.next)}</p></div><p class="fine">Your score rewards evidence and supported choices. It does not predict real profit, approvals, or investment performance.</p><div class="modal-actions"><button class="button bright" data-command="replay">Try another route <span>↻</span></button><button class="button outline" data-command="export">Save decision record</button></div><div class="ending-offer"><span>TAKE THE NEXT STEP</span><h3>You played a property.<br>Now think about yours.</h3><p>Explore the complete field manual or bring UPP the real decision you need to make.</p><div><a href="${campaign.book.url}" target="_blank" rel="noopener">Get the book · $47 ↗</a><a href="https://urbanplanningpros.com/contact/" target="_blank" rel="noopener">Discuss my property ↗</a></div></div>`);}
function showGuide(chapter){const entry=campaign.book.chapters.find(c=>c.n===chapter);openModal(`<p class="overline">THE FIELD MANUAL</p><h2 id="modal-title">${entry?escape(entry.title):'Better moves start with better questions.'}</h2>${entry?`<p>${escape(entry.body)}</p>`:'<p>Your campaign follows the four-part framework in Jeremy Wenger’s book. These short game notes connect the decisions to the reading.</p>'}<div class="chapter-list">${campaign.book.chapters.map(c=>`<button data-chapter="${c.n}"><span>CH ${String(c.n).padStart(2,'0')}</span><strong>${escape(c.title)}</strong><b>↗</b></button>`).join('')}</div><a class="button bright" href="${campaign.book.url}" target="_blank" rel="noopener">Get the complete book · $47 <span>↗</span></a><p class="fine">Game notes paraphrase selected ideas. The full book is delivered through the existing UPP book checkout.</p>`);}
function showCampaigns(){openModal(`<p class="overline">CHOOSE YOUR NEXT OPPORTUNITY</p><h2 id="modal-title">Every property tells a different story.</h2><div class="campaign-card available-campaign"><span>CAMPAIGN 01 / FREE</span><h3>Mill Creek</h3><p>A subdivision idea, an expensive utility assumption, and six ways to make your next decision.</p><button class="button bright" data-command="campaign">${saved?'Continue Mill Creek':'Play Mill Creek'} <span>→</span></button></div><div class="coming-campaigns"><article><span>IN DEVELOPMENT</span><h3>The Hospitality Pivot</h3><p>Seasonality, guest experience, wastewater, and a venue that needs a different path.</p></article><article><span>IN DEVELOPMENT</span><h3>The Contractor Yard</h3><p>Access, drainage, customers, and phased infrastructure for outdoor storage.</p></article></div><p class="fine">Additional campaigns and paid game access are not on sale yet. The $47 book purchase currently provides the book; it does not promise unreleased campaigns.</p>`);}
function showLog(){openModal(`<p class="overline">YOUR DECISION JOURNAL</p><h2 id="modal-title">Evidence, move by move.</h2>${state.done.length?`<ol class="journal">${state.done.map(id=>{const a=campaign.actions.find(a=>a.id===id);return `<li><span>${escape(a.short)} · ${money(a.cost)}</span><p>${escape(a.result)}</p></li>`;}).join('')}</ol>`:'<p>Your journal starts with your first investigation. Pick a marker on the map to choose a move.</p>'}<button class="button bright" data-command="export">Download decision record <span>↓</span></button>`);}
function exportRecord(){const url=URL.createObjectURL(new Blob([brief(campaign,state)],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='mill-creek-decision-record.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Your game decision record has been downloaded.');}
function resetPrompt(){openModal('<p class="overline">NEW CAMPAIGN RUN</p><h2 id="modal-title">A fresh look at the same land.</h2><p>This replaces the single save on this device. Download your current decision record first if you want to keep it.</p><div class="modal-actions"><button class="button bright" data-command="reset">Start a fresh run <span>↻</span></button><button class="button outline" data-command="export">Download current record</button></div>');}
function nextMove(){const a=campaign.actions.find(a=>!available(campaign,state,a));if(a){selected=a.id;phase=a.phase;}else{phase=3;selected='walk';}render();}
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.select){select(b.dataset.select);return;}
  if(b.dataset.route){selected=b.dataset.route;render();return;}
  if(b.dataset.phase!==undefined){setPhase(Number(b.dataset.phase));return;}
  if(b.dataset.move){move(b.dataset.move);return;}
  if(b.dataset.exit){chooseExit(b.dataset.exit);return;}
  if(b.dataset.chapter){closeModal();showGuide(Number(b.dataset.chapter));return;}
  if(b.dataset.panel){b.dataset.panel==='campaigns'?showCampaigns():showGuide();return;}
  switch(b.dataset.command){
    case 'begin':closeModal();start(true);break;
    case 'continue':closeModal();nextMove();break;
    case 'next':nextMove();break;
    case 'exits':closeModal();setPhase(3);break;
    case 'export':exportRecord();break;
    case 'replay':closeModal();state=replay(campaign,state.history.slice(0,-1));save();setPhase(3);toast('Rewound to your final decision. Try another supported route.');break;
    case 'reset':closeModal();start(true);break;
    case 'campaign':closeModal();saved?start():showIntro();break;
  }
});
$('#start').addEventListener('click',()=>saved?resetPrompt():showIntro());$('#resume').addEventListener('click',()=>start());
$('#close-modal').addEventListener('click',closeModal);$('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))closeModal();});
$('#show-log').addEventListener('click',showLog);$('#restart').addEventListener('click',resetPrompt);$('#export').addEventListener('click',exportRecord);
$('#sound').addEventListener('click',()=>{sound=!sound;$('#sound').setAttribute('aria-pressed',String(sound));$('#sound').setAttribute('aria-label',sound?'Turn game sounds off':'Turn game sounds on');beep();});
$('#layers').addEventListener('click',()=>{const on=$('#layers').getAttribute('aria-pressed')!=='true';$('#layers').setAttribute('aria-pressed',String(on));$('#map-world').classList.toggle('no-layers',!on);});
function camera(){pan.x=Math.max(-150*(zoom-1),Math.min(150*(zoom-1),pan.x));pan.y=Math.max(-120*(zoom-1),Math.min(120*(zoom-1),pan.y));$('#map-world').style.transform=`translate(${pan.x}px,${pan.y}px) scale(${zoom})`;}
$('#zoom-in').addEventListener('click',()=>{zoom=Math.min(1.7,zoom+.15);camera();});$('#zoom-out').addEventListener('click',()=>{zoom=Math.max(1,zoom-.15);camera();});$('#zoom-reset').addEventListener('click',()=>{zoom=1;pan={x:0,y:0};camera();});
$('#map-window').addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;drag={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};$('#map-window').setPointerCapture(e.pointerId);});
$('#map-window').addEventListener('pointermove',e=>{if(!drag)return;pan={x:drag.px+e.clientX-drag.x,y:drag.py+e.clientY-drag.y};camera();});
$('#map-window').addEventListener('pointerup',()=>drag=null);$('#map-window').addEventListener('pointercancel',()=>drag=null);
render();
