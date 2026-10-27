'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {NativeWindowFullscreen,fullscreenRequest}=require('./fullscreen-state.cjs');
const {FullscreenStateTracker}=require('../renderer/src/stream/fullscreen-state.ts');
const url='file:///generated/index.html?viewer=1';
function fixture(id=1){
  const window=new EventEmitter();window.destroyed=false;window.native=false;window.calls=[];
  window.isDestroyed=()=>window.destroyed;window.isFullScreen=()=>window.native;
  window.isVisible=()=>!window.hidden;window.isMinimized=()=>window.minimized===true;
  window.setFullScreen=value=>window.calls.push(value);
  window.webContents={id,isDestroyed:()=>window.destroyed,mainFrame:{url}};
  const updates=[],state=new NativeWindowFullscreen(window,value=>updates.push(value)),states=new Map([[id,state]]);
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
  return {window,state,states,event,updates};
}
test('fullscreen setting waits for native observation and never changes window visibility or session state',()=>{
  const f=fixture();assert.deepEqual(fullscreenRequest(f.event,'window.fullscreen.set',{fullscreen:true},f.states,url),{fullscreen:false,revision:0});
  assert.deepEqual(f.window.calls,[true]);assert.deepEqual(f.updates,[]);
  f.window.native=true;f.window.emit('enter-full-screen');assert.deepEqual(f.updates,[{fullscreen:true,revision:1}]);
  f.window.emit('enter-full-screen');assert.equal(f.updates.length,1);
  f.window.native=false;f.window.emit('leave-full-screen');assert.deepEqual(f.updates.at(-1),{fullscreen:false,revision:2});f.state.close();
});
test('only the matching registered top-frame sender can read or change its own fullscreen state',()=>{
  const a=fixture(1),b=fixture(2);a.states.set(2,b.state);
  for(const event of [
    {sender:{...a.event.sender,id:99},senderFrame:a.event.senderFrame},
    {sender:{...a.event.sender},senderFrame:a.event.senderFrame},
    {sender:a.event.sender,senderFrame:{url}},
  ])assert.throws(()=>fullscreenRequest(event,'window.fullscreen.set',{fullscreen:true},a.states,url),/Untrusted/);
  assert.throws(()=>fullscreenRequest(a.event,'window.fullscreen.get',{},a.states,url+'wrong'),/Untrusted/);
  assert.deepEqual(fullscreenRequest(b.event,'window.fullscreen.get',{},a.states,url),{fullscreen:false,revision:0});
  assert.deepEqual(a.window.calls,[]);assert.deepEqual(b.window.calls,[]);a.state.close();b.state.close();
});
test('fullscreen request schema rejects window IDs, method names, extra fields and nonbooleans',()=>{
  const f=fixture();for(const payload of [null,[],{windowId:2,fullscreen:true},{fullscreen:'true'},{fullscreen:true,method:'show'},{}])
    assert.throws(()=>fullscreenRequest(f.event,'window.fullscreen.set',payload,f.states,url));
  assert.throws(()=>fullscreenRequest(f.event,'window.fullscreen.get',{fullscreen:true},f.states,url));
  assert.throws(()=>fullscreenRequest(f.event,'window.show',{},f.states,url));assert.deepEqual(f.window.calls,[]);f.state.close();
});
test('destroyed and closed windows cannot mutate state or publish late native events',()=>{
  const f=fixture();f.state.close();f.window.native=true;f.window.emit('enter-full-screen');assert.deepEqual(f.updates,[]);
  assert.throws(()=>fullscreenRequest(f.event,'window.fullscreen.get',{},f.states,url),/closed/);
  const gone=fixture();gone.window.destroyed=true;assert.throws(()=>fullscreenRequest(gone.event,'window.fullscreen.set',{fullscreen:true},gone.states,url),/Untrusted/);
  assert.deepEqual(gone.window.calls,[]);gone.state.close();
});
test('renderer ignores a stale fullscreen query after a newer native event and rejects revision conflicts',()=>{
  const state=new FullscreenStateTracker();assert.equal(state.accept({fullscreen:true,revision:2}),true);
  assert.equal(state.accept({fullscreen:false,revision:0}),false);assert.equal(state.accept({fullscreen:false,revision:2}),false);
  assert.deepEqual(state.snapshot(),{fullscreen:true,revision:2});assert.equal(state.accept({fullscreen:false,revision:3}),true);
  for(const value of [null,{},[],{fullscreen:1,revision:4},{fullscreen:true,revision:NaN},{fullscreen:true,revision:-1}])assert.equal(state.accept(value),false);
});
test('a query observing the native transition publishes it once before a later duplicate native event',()=>{
  const f=fixture();f.window.native=true;
  assert.deepEqual(fullscreenRequest(f.event,'window.fullscreen.get',{},f.states,url),{fullscreen:true,revision:1});
  assert.deepEqual(f.updates,[{fullscreen:true,revision:1}]);
  f.window.emit('enter-full-screen');assert.equal(f.updates.length,1);f.state.close();
});
test('hidden or minimized windows can read state but never reach the native fullscreen setter',()=>{
  for(const mode of ['hidden','minimized']){
    const f=fixture();f.window[mode]=true;
    assert.deepEqual(fullscreenRequest(f.event,'window.fullscreen.get',{},f.states,url),{fullscreen:false,revision:0});
    assert.throws(()=>fullscreenRequest(f.event,'window.fullscreen.set',{fullscreen:true},f.states,url),/Return to this window/);
    assert.deepEqual(f.window.calls,[]);f.state.close();
  }
});

test('a native teardown read failure cannot escape the event handler or fabricate a state transition',()=>{
  const f=fixture();f.window.native=true;
  const actual=f.window.isFullScreen;f.window.isFullScreen=()=>{throw Error('Generated native teardown race');};
  assert.doesNotThrow(()=>f.window.emit('enter-full-screen'));
  assert.deepEqual(f.state.current(),{fullscreen:false,revision:0});assert.deepEqual(f.updates,[]);
  assert.throws(()=>f.state.read(),/Generated native teardown race/,'explicit IPC-style reads must still report failure');
  f.window.isFullScreen=actual;f.window.emit('enter-full-screen');
  assert.deepEqual(f.updates,[{fullscreen:true,revision:1}]);f.state.close();assert.equal(f.window.listenerCount('enter-full-screen'),0);
});
