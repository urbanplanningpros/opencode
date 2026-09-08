import { available } from './engine.mjs';

export const stages = [
  {name:'Evaluate',chapter:1,mission:'Find the assumption that could break the deal.',question:'The seller sees 36 homes. What does the land actually support?',reward:'Reality check',lesson:'Separate a promising idea from the facts that can support it.',groups:[['control'],['zoning'],['access'],['utilities'],['land'],['survey'],['market']]},
  {name:'Plan',chapter:6,mission:'Turn the constraints into a different possibility.',question:'Fewer homes, a first phase, or a completely different use?',reward:'Option maker',lesson:'A constraint can change the scale, sequence, or use. Compare the alternatives before choosing.',groups:[['concept','storage']]},
  {name:'Coordinate',chapter:10,mission:'Give the next person a decision they can act on.',question:'Who needs to answer the next question: your project team or a future buyer?',reward:'Team connector',lesson:'A clear scope and a useful handoff keep specialist work tied to your decision.',groups:[['team','buyer','operator']]},
  {name:'Exit',chapter:13,mission:'Choose your next commitment—and your way out.',question:'Build, phase, pivot, partner, or walk: which route have you earned?',reward:'Exit strategist',lesson:'Success is a supported decision. A timely no-go can protect more value than a bigger plan.',groups:[]},
];

export const routeStories = {
  smaller:{icon:'20',trigger:'Utility capacity is limited',response:'Reduce the scale',service:'Master land planning',help:'Compare layouts, net capacity, access, and infrastructure against the goal for your property.',chapter:6},
  phased:{icon:'12',trigger:'The full build is too much at once',response:'Make phase one stand alone',service:'Development strategy',help:'Connect infrastructure timing, a workable first phase, and the conditions for the next commitment.',chapter:7},
  pivot:{icon:'↻',trigger:'Another use may fit better',response:'Test a new customer and use',service:'Per-project feasibility',help:'Screen a different use against zoning, access, servicing, drainage, and demand.',chapter:13},
  transfer:{icon:'⇄',trigger:'You may not be the builder',response:'Prepare a partner or transfer route',service:'Development strategy',help:'Clarify what the opportunity needs before you approach a buyer or development partner.',chapter:13},
  original:{icon:'28',trigger:'More homes need more infrastructure',response:'Make the added exposure explicit',service:'Owner representation',help:'Coordinate the specialist answers, approval sequence, and owner decisions needed to test the larger plan.',chapter:10},
  walk:{icon:'↗',trigger:'The evidence does not justify more',response:'Stop before the next commitment',service:'Per-project feasibility',help:'Identify the controlling unknowns and define the next go, pause, or no-go decision on your property.',chapter:13},
};

// Use only chapter notes already grounded in the supplied edition.
export const bookLenses = {control:13,zoning:1,access:3,utilities:3,land:3,survey:3,market:1,concept:6,negotiate:13,phase:7,storage:13,buyer:13,team:10,operator:10,extension:13};

export const assumptions = {
  control:'“There will be enough time to work it out after we sign.”',
  zoning:'“The zoning label means the project is allowed.”',
  access:'“A driveway is all the access we need.”',
  utilities:'“The line is nearby, so it can serve the whole project.”',
  land:'“Twenty-two acres means twenty-two acres we can use.”',
  survey:'“The seller’s sketch is accurate enough for design.”',
  market:'“If we can build it, people will want it.”',
  concept:'“Every separate green light adds up to a workable site.”',
  negotiate:'“The original price still makes sense after the findings.”',
  phase:'“Building fewer homes first removes most upfront cost.”',
  storage:'“Switching uses gets us around the hard questions.”',
  buyer:'“Someone will pay more once we have a few reports.”',
  team:'“Everyone has a report, so everyone is aligned.”',
  operator:'“A new use can move forward without new specialist handoffs.”',
  extension:'“The planning calendar will fit our agreement.”',
};

// Extra teaching moves guide new runs while the core history can still replay legacy endings.
// Both prerequisite lists are canonical campaign content; indirect requirements are included.
export function routePlan(campaign,state,route) {
  const ordered=[],seen=new Set();
  function visit(id){if(seen.has(id))return;seen.add(id);const a=campaign.actions.find(x=>x.id===id);if(!a)throw new Error('Unknown route prerequisite: '+id);a.needs.forEach(visit);ordered.push(a);}
  [...route.needs,...(route.guidanceNeeds??[])].forEach(visit);
  const remaining=ordered.filter(a=>!state.done.includes(a.id));
  const next=remaining.find(a=>!available(campaign,state,a))??null;
  return {ordered,remaining,next,cost:remaining.reduce((n,a)=>n+a.cost,0),days:remaining.reduce((n,a)=>n+a.days,0),ready:remaining.length===0};
}

export function stageProgress(state,index) {
  const stage=stages[index];
  if(index===3)return {done:state.ending?1:0,total:1,complete:!!state.ending};
  const done=stage.groups.filter(group=>group.some(id=>state.done.includes(id))).length;
  return {done,total:stage.groups.length,complete:done===stage.groups.length};
}

export function outbound(kind,placement,route='') {
  const url=new URL(kind==='book'?'https://urbanplanningpros.com/book':'https://urbanplanningpros.com/contact/');
  url.searchParams.set('utm_source','exit_strong');
  url.searchParams.set('utm_medium','game');
  url.searchParams.set('utm_campaign','mill_creek');
  url.searchParams.set('utm_content',placement+(route?'_'+route:''));
  return url.href;
}
