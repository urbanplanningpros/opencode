import { LIMITS } from './limits.mjs';

export function initial(campaign) {
  return {version:1,campaignVersion:campaign.version,campaign:campaign.id,history:[],cash:campaign.budget,day:0,deadline:campaign.deadline,done:[],events:[],ending:null};
}
export function available(campaign,state,action) {
  if(state.ending) return 'This run is complete.';
  if(state.history.length>=LIMITS.historyActions) return 'This run has reached its move limit.';
  if(state.done.includes(action.id)) return 'Completed';
  const missing=action.needs.filter(id=>!state.done.includes(id));
  if(missing.length) return 'First: '+missing.map(id=>campaign.actions.find(a=>a.id===id)?.short??id).join(', ');
  if(state.cash<action.cost) return 'Not enough diligence budget.';
  if(state.day+action.days>=state.deadline) return 'This move would run past your decision window.';
  return '';
}
export function routeStatus(campaign,state,route) {
  if(state.ending) return 'This run is complete.';
  const missing=route.needs.filter(id=>!state.done.includes(id));
  return missing.length?'Need: '+missing.map(id=>campaign.actions.find(a=>a.id===id)?.short??id).join(', '):'';
}
export function apply(campaign,state,id) {
  if(typeof id!=='string') throw new Error('Invalid move.');
  if(id.startsWith('exit:')) {
    const route=campaign.routes.find(r=>r.id===id.slice(5));
    if(!route) throw new Error('Unknown exit.');
    const problem=routeStatus(campaign,state,route);
    if(problem) throw new Error(problem);
    if(state.history.length>=LIMITS.historyActions) throw new Error('Move limit reached.');
    return {...state,history:[...state.history,id],ending:route.id};
  }
  const action=campaign.actions.find(a=>a.id===id);
  if(!action) throw new Error('Unknown move.');
  const problem=available(campaign,state,action);
  if(problem) throw new Error(problem);
  const day=state.day+action.days;
  return {...state,history:[...state.history,id],done:[...state.done,id],cash:state.cash-action.cost,day,deadline:state.deadline+(action.extend??0),events:campaign.events.filter(e=>day>=e.at).map(e=>e.id)};
}
export function replay(campaign,history) {
  if(!Array.isArray(history)||history.length>LIMITS.historyActions) throw new Error('Saved move list is too large.');
  return history.reduce((s,id)=>apply(campaign,s,id),initial(campaign));
}
export function encode(state) {
  const text=JSON.stringify({version:1,campaignVersion:state.campaignVersion,campaign:state.campaign,history:state.history});
  if(new TextEncoder().encode(text).length>LIMITS.saveBytes) throw new Error('Save exceeds the resource limit.');
  return text;
}
export function decode(campaign,text) {
  if(typeof text!=='string'||new TextEncoder().encode(text).length>LIMITS.saveBytes) throw new Error('Save is too large.');
  const record=JSON.parse(text);
  if(!record||record.version!==1||record.campaignVersion!==campaign.version||record.campaign!==campaign.id) throw new Error('This save belongs to a different game version.');
  return replay(campaign,record.history);
}
export function score(campaign,state) {
  const evidence=campaign.gates.filter(g=>state.done.includes(g.action)).length;
  const ready=campaign.routes.filter(r=>r.id!=='walk'&&r.needs.every(id=>state.done.includes(id))).length;
  const route=campaign.routes.find(r=>r.id===state.ending);
  return Math.min(100,evidence*9+(state.done.includes('control')?10:0)+(state.done.includes('team')?8:0)+(state.done.includes('negotiate')?5:0)+Math.min(12,ready*3)+(route?.score??0));
}
export function brief(campaign,state) {
  const route=campaign.routes.find(r=>r.id===state.ending);
  return ['EXIT STRONG — GAME DECISION RECORD','Fictional educational simulation; not a finding about any actual property.','',campaign.name,
    'Decision: '+(route?.name??'Investigation in progress'),
    'Game diligence spent: $'+(campaign.budget-state.cash).toLocaleString('en-US'),
    'Game day: '+state.day+' / '+state.deadline,
    'Decision score: '+score(campaign,state)+' / 100','',
    'EVIDENCE',...state.done.map(id=>{const a=campaign.actions.find(a=>a.id===id);return a.short+': '+a.result;}),'',
    'NEXT STEP',route?.next??'Resolve the highest-risk unknown before committing further.','',
    'The scenario stops at a next-step decision. It does not award real approvals, financing, signed sales, or construction readiness.',
    'Book: '+campaign.book.url,'Bring a real property: https://urbanplanningpros.com/contact/'].join('\n');
}
