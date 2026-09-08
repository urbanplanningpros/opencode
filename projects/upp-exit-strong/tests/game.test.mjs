import test from 'node:test';
import assert from 'node:assert/strict';
import { campaign } from '../dist/game/content/mill-creek.mjs';
import { initial, apply, available, routeStatus, replay, encode, decode, score, brief } from '../dist/game/engine.mjs';
import { LIMITS } from '../dist/game/limits.mjs';

const base=['control','zoning','access','utilities','land','survey','market','concept'];
const paths={smaller:[...base,'team'],phased:[...base,'phase','team'],pivot:['control','zoning','access','utilities','land','survey','market','storage'],transfer:[...base,'buyer'],original:[...base,'negotiate','team'],walk:['utilities','land']};
for(const [route,moves] of Object.entries(paths))test('complete supported ending: '+route,()=>{const s=replay(campaign,[...moves,'exit:'+route]);assert.equal(s.ending,route);assert.ok(s.cash>=0);assert.ok(s.day<s.deadline);assert.equal(decode(campaign,encode(s)).ending,route);assert.match(brief(campaign,s),/Fictional educational simulation/);});
test('unearned exits cannot be selected',()=>{assert.throws(()=>apply(campaign,initial(campaign),'exit:smaller'),/Need:/);});
test('spending a move twice and acting after ending both fail',()=>{const s=apply(campaign,initial(campaign),'utilities');assert.throws(()=>apply(campaign,s,'utilities'),/Completed/);assert.throws(()=>apply(campaign,apply(campaign,s,'exit:walk'),'access'),/complete/);});
test('prerequisite, budget and time constraints fail closed',()=>{const s=initial(campaign);assert.match(available(campaign,s,campaign.actions.find(a=>a.id==='survey')),/Site control/);assert.match(available(campaign,{...s,cash:100},campaign.actions[0]),/budget/);assert.match(available(campaign,{...s,day:44},campaign.actions[0]),/window/);});
test('extension adds finite time and cannot be repeated',()=>{let s=replay(campaign,['control','extension']);assert.equal(s.deadline,60);assert.equal(s.day,2);assert.throws(()=>apply(campaign,s,'extension'),/Completed/);});
test('all moves can be completed without impossible budgets',()=>{const s=replay(campaign,['control','extension','zoning','access','utilities','land','survey','market','concept','negotiate','phase','storage','buyer','team','operator']);assert.equal(s.done.length,campaign.actions.length);assert.ok(s.cash>=0);assert.ok(s.day<s.deadline);for(const r of campaign.routes)assert.equal(routeStatus(campaign,s,r),'');});
test('saved state rebuilds facts from canonical history',()=>{const encoded=JSON.stringify({version:1,campaignVersion:campaign.version,campaign:campaign.id,history:['utilities'],cash:99999999,done:['team']});const s=decode(campaign,encoded);assert.equal(s.cash,campaign.budget-3100);assert.deepEqual(s.done,['utilities']);assert.ok(encode(s).length<1024);});
test('corrupt, oversized, unknown and overlong histories are rejected',()=>{for(const raw of ['{','null',JSON.stringify({version:5,campaign:campaign.id,history:[]}),JSON.stringify({version:1,campaign:campaign.id,history:['fake']}),'x'.repeat(LIMITS.saveBytes+1)])assert.throws(()=>decode(campaign,raw));assert.throws(()=>replay(campaign,Array(LIMITS.historyActions+1).fill('control')));});
test('events appear once after their trigger',()=>{const s=replay(campaign,['control','zoning','access','utilities','land']);assert.deepEqual(s.events,['rain']);assert.deepEqual(apply(campaign,s,'survey').events,['rain']);});
test('a supported no-go can score well without a purchase',()=>{const s=replay(campaign,[...base,'negotiate','team','exit:walk']);assert.ok(score(campaign,s)>=80);assert.ok(!('purchase' in s));});
test('replaying the final decision preserves evidence and resources',()=>{const original=replay(campaign,[...base,'team','exit:smaller']);const before=replay(campaign,original.history.slice(0,-1));const second=apply(campaign,before,'exit:walk');assert.equal(second.cash,original.cash);assert.equal(second.day,original.day);assert.deepEqual(second.done,original.done);});
test('save from a different campaign revision is rejected',()=>{assert.throws(()=>decode({...campaign,version:2},encode(initial(campaign))),/different game version/);});

const { routePlan, stageProgress, bookLenses } = await import('../dist/game/journey.mjs');
test('route guidance opens every exit through real affordable prerequisites',()=>{
  for(const route of campaign.routes){
    let state=initial(campaign),moves=0;
    while(!routePlan(campaign,state,route).ready){
      const plan=routePlan(campaign,state,route);
      assert.ok(plan.next,'A legal next move must exist for '+route.id);
      assert.equal(available(campaign,state,plan.next),'');
      state=apply(campaign,state,plan.next.id);
      assert.ok(++moves<=campaign.actions.length);
    }
    assert.equal(routeStatus(campaign,state,route),'');
    assert.equal(apply(campaign,state,'exit:'+route.id).ending,route.id);
  }
});
test('exit map includes indirect evidence and respects time and budget blockers',()=>{
  const route=campaign.routes.find(r=>r.id==='phased'),state=initial(campaign);
  const before=routePlan(campaign,state,route),after=routePlan(campaign,apply(campaign,state,'utilities'),route);
  assert.ok(before.ordered.some(a=>a.id==='survey'));
  assert.equal(after.remaining.length,before.remaining.length-1);
  assert.equal(after.cost,before.cost-3100);
  assert.equal(routePlan(campaign,{...state,cash:0},route).next,null);
  assert.equal(routePlan(campaign,{...state,day:44},route).next,null);
  assert.equal(new Set(before.ordered.map(a=>a.id)).size,before.ordered.length);
});
test('stage milestones survive save replay and every move points to a verified chapter note',()=>{
  const state=replay(campaign,[...base,'team','exit:smaller']);
  const restored=decode(campaign,encode(state));
  for(let i=0;i<4;i++){assert.equal(stageProgress(state,i).complete,true);assert.deepEqual(stageProgress(restored,i),stageProgress(state,i));}
  assert.equal(stageProgress(initial(campaign),3).complete,false);
  for(const action of campaign.actions)assert.ok(campaign.book.chapters.some(c=>c.n===bookLenses[action.id]));
});

test('chosen ambition survives a save and unknown ambitions are rejected',()=>{
  const state={...replay(campaign,['control','utilities']),ambition:'pivot'};
  assert.equal(decode(campaign,encode(state)).ambition,'pivot');
  assert.throws(()=>decode(campaign,encode({...state,ambition:'invented'})),/Unknown saved ambition/);
  assert.equal(decode(campaign,encode(replay(campaign,['control']))).ambition,'smaller');
});
test('new pivot guidance teaches coordination while earlier endings remain replayable',()=>{
  const route=campaign.routes.find(r=>r.id==='pivot'),old=replay(campaign,paths.pivot);
  assert.equal(routePlan(campaign,old,route).ready,false);
  assert.equal(routePlan(campaign,old,route).next.id,'operator');
  const next=apply(campaign,old,'operator');
  assert.equal(stageProgress(next,2).complete,true);
  assert.equal(routePlan(campaign,next,route).ready,true);
  assert.equal(decode(campaign,encode(apply(campaign,old,'exit:pivot'))).ending,'pivot');
});
