'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DisplayAvailabilityState,readWakeAvailability,isDisplayAsleep}=require('../renderer/src/stream/display-availability.ts');
const {VideoRetryPolicy,streamFallback}=require('../renderer/src/stream/recovery.ts');
const available=(changes={})=>({sessionId:'local-session',sessionGeneration:0,canWakeDisplay:true,controlGranted:true,viewOnly:false,...changes});
const asleep=(availability=available(),changes={})=>({code:'display_asleep',status:409,displayState:'off',retryable:true,availability,...changes});
const ready=()=>{const state=new DisplayAvailabilityState('local-session','screen-a');state.asleep(asleep());return state;};

test('sleep explanation requires actual typed409/off, never status or off metadata alone',()=>{
 for(const value of [null,{displayState:'off'},{code:'display_asleep',status:409},{code:'display_asleep',status:409,displayState:'dimmed'},asleep(undefined,{status:403}),asleep(undefined,{status:401}),asleep(undefined,{status:410}),asleep(undefined,{code:'host_stopping'}),asleep(undefined,{code:'unknown'})])assert.equal(isDisplayAsleep(value),false);
 assert.equal(isDisplayAsleep(asleep()),true);
});
test('missing, malformed, cross-session and nonboolean capability snapshots never enable Wake',()=>{
 for(const value of [undefined,null,[],{},available({sessionId:'other-session'}),available({sessionGeneration:-1}),available({sessionGeneration:NaN}),available({sessionGeneration:Number.MAX_SAFE_INTEGER+1}),available({canWakeDisplay:'true'}),available({controlGranted:1}),available({viewOnly:0}),{...available(),remoteId:'forbidden'}]){
  const state=new DisplayAvailabilityState('local-session','screen-a');assert.equal(readWakeAvailability(value,'local-session'),null);assert.equal(state.asleep({...asleep(),availability:value}),true);assert.equal(state.view(0).eligible,false);assert.equal(state.beginWake(0),null);
 }
});
for(const changes of [{canWakeDisplay:false},{controlGranted:false},{viewOnly:true}])test(`provider/grant/local-intent independently deny Wake: ${JSON.stringify(changes)}`,()=>{
 const state=new DisplayAvailabilityState('local-session','screen-a');state.asleep(asleep(available(changes)));assert.equal(state.view(0).asleep,true);assert.equal(state.view(0).eligible,false);assert.equal(state.beginWake(0),null);
});
test('metadata, status and304-style availability observations cannot clear asleep or begin Wake',()=>{
 const state=ready();for(let i=0;i<100;i++)assert.equal(state.observe(available(),0),true);assert.equal(state.view(100).asleep,true);assert.equal(state.view(100).pending,false);assert.equal(state.view(100).message,'');
});
test('explicit wake is single-flight and five-second limited, never an optimistic awake state',()=>{
 const state=ready();const first=state.beginWake(100);assert.ok(first);assert.equal(state.beginWake(100),null);assert.equal(state.view(100).pending,true);assert.equal(state.finishWake(first,'Wake requested.',200),true);
 assert.equal(state.view(200).asleep,true);assert.equal(state.view(200).message,'Wake requested.');assert.equal(state.beginWake(5099),null);assert.ok(state.beginWake(5100));
});
test('rate limit feedback extends the local wait without issuing a second request',()=>{
 const state=ready(),request=state.beginWake(100);assert.equal(state.finishWake(request,'Wait before requesting another display wake.',4500,true),true);assert.equal(state.view(4500).remainingMs,5000);assert.equal(state.view(4500).pending,false);assert.equal(state.beginWake(9499),null);assert.ok(state.beginWake(9500));
});
test('an explicit unsupported result cannot be overridden by cached same-generation capability metadata',()=>{
 const state=ready(),request=state.beginWake(100);state.finishWake(request,'This host does not support requesting a display wake.',200);state.unsupported();state.observe(available(),0);assert.equal(state.view(6000).eligible,false);assert.equal(state.view(6000).asleep,true);assert.equal(state.beginWake(6000),null);state.reset('local-session','screen-b');state.asleep(asleep());assert.equal(state.view(6000).eligible,false,'monitor changes cannot reset session-wide provider support');state.observe(available({sessionGeneration:1}),1);assert.equal(state.view(6000).eligible,true);
});
test('permission loss or a changed capability invalidates a pending reply at the same generation',()=>{
 for(const change of [{controlGranted:false},{canWakeDisplay:false},{viewOnly:true}]){const state=ready(),request=state.beginWake(100);state.observe(available(change),0);assert.equal(state.finishWake(request,'Wake requested.',200),false);assert.equal(state.view(200).message,'');assert.equal(state.view(200).eligible,false);}
});
test('a new generation discards a late wake response and cannot inherit the previous capability',()=>{
 const state=ready(),request=state.beginWake(100);state.observe(available({sessionGeneration:1,canWakeDisplay:false}),1);assert.equal(state.finishWake(request,'Wake requested.',200),false);assert.equal(state.view(200).eligible,false);assert.equal(state.view(200).sessionGeneration,1);
 assert.equal(state.asleep(asleep(available())),false);assert.equal(state.view(200).eligible,false);assert.equal(state.presented(available(),0),false);assert.equal(state.view(200).asleep,true);
});
test('missing newer-generation metadata disables eligibility and late responses',()=>{
 const state=ready(),request=state.beginWake(100);assert.equal(state.observe(undefined,1),false);assert.equal(state.view(200).eligible,false);assert.equal(state.view(200).sessionGeneration,1);assert.equal(state.finishWake(request,'Wake requested.',200),false);
});
test('scope change, pause and terminal retirement ignore pending outcomes',()=>{
 for(const change of [state=>state.reset('local-session','screen-b'),state=>state.reset('other-session','screen-a'),state=>state.pause(),state=>state.end()]){const state=ready(),request=state.beginWake(100);change(state);assert.equal(state.finishWake(request,'Wake requested.',200),false);assert.equal(state.view(200).eligible,false);assert.equal(state.view(200).message,'');assert.equal(state.beginWake(6000),null);}
});
test('a current authorized actual presentation clears asleep; an older generation cannot',()=>{
 const state=ready(),request=state.beginWake(100);assert.equal(state.presented(available(),0),true);assert.equal(state.view(200).asleep,false);assert.equal(state.finishWake(request,'Wake requested.',200),false);assert.equal(state.beginWake(6000),null);
 state.asleep(asleep(available({sessionGeneration:2})));assert.equal(state.presented(available({sessionGeneration:1}),1),false);assert.equal(state.view(6000).asleep,true);assert.equal(state.presented(available({sessionGeneration:2}),2),true);assert.equal(state.view(6000).asleep,false);
});
test('known asleep video failures have a15-second retry floor while generic409 stays permanent',()=>{
 const info=streamFallback(asleep());assert.equal(info.retryable,true);const policy=new VideoRetryPolicy();assert.equal(policy.failed(info),15000);assert.equal(policy.failed(info),15000);
 assert.equal(new VideoRetryPolicy().failed(streamFallback({code:'stream_unavailable',status:409,retryable:true})),null);
 for(const status of [401,403,410])assert.equal(new VideoRetryPolicy().failed(streamFallback(asleep(undefined,{status}))),null);
});
test('current authority denials outlive presentation feedback, but never cross lifecycle scopes',()=>{
 const state=ready(),request=state.beginWake(100);state.presented(available(),0);assert.equal(state.finishWake(request,'Wake requested.',200),false);assert.equal(state.currentReply(request),true);
 for(const change of [s=>s.reset('local-session','screen-b'),s=>s.reset('other-session','screen-a'),s=>s.pause(),s=>s.end(),s=>s.observe(available({sessionGeneration:1}),1)]){const current=ready(),token=current.beginWake(100);current.presented(available(),0);change(current);assert.equal(current.currentReply(token),false);}
});
