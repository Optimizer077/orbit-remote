#!/usr/bin/env node
'use strict';
// Windows real-app view-only checks. Never writes screen pixels or invites.
// Requires the desktop dev dependencies and an already-built test bundle.
// Example: node scripts/perf/live-windows.cjs --app ".../Orbit Remote.exe" --source <commit> --mode recovery
const {createRequire}=require('node:module');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');

process.chdir(path.resolve(__dirname,'../..'));
const options={mode:'compare',seconds:30,controlPort:48931,remotePort:48932,proxyPort:48942,out:'artifacts/live-windows'};
for(let i=2;i<process.argv.length;i++) {
 const key=process.argv[i];
 if(key==='--require-video-recovery'){options.requireVideoRecovery=true;continue}
 if(key==='--help'){console.log('Usage: node scripts/perf/live-windows.cjs --app <packaged-exe> --source <tested-commit> [--mode compare|recovery|revocation] [--require-video-recovery] [--seconds 30] [--out <directory>] [--control-port 48931] [--remote-port 48932] [--proxy-port 48942]');process.exit(0)}
 const names={'--app':'app','--source':'source','--mode':'mode','--seconds':'seconds','--out':'out','--control-port':'controlPort','--remote-port':'remotePort','--proxy-port':'proxyPort'};
 if(!names[key]||i+1>=process.argv.length)throw Error('Unknown or incomplete option: '+key);
 options[names[key]]=process.argv[++i];
}
if(process.platform!=='win32')throw Error('This native runner currently supports Windows only');
if(!options.app||!options.source)throw Error('Specify --app and --source; the source label must match the tested bundle');
if(!['compare','recovery','revocation'].includes(options.mode))throw Error('Invalid --mode');
options.seconds=Number(options.seconds);if(!Number.isInteger(options.seconds)||options.seconds<5||options.seconds>120)throw Error('--seconds must be 5..120');
for(const name of ['controlPort','remotePort','proxyPort']){options[name]=Number(options[name]);if(!Number.isInteger(options[name])||options[name]<1024||options[name]>65535)throw Error('Invalid port')}
if(new Set([options.controlPort,options.remotePort,options.proxyPort]).size!==3)throw Error('Test ports must be distinct');
options.app=path.resolve(options.app);options.out=path.resolve(options.out);

const req=createRequire(path.resolve('apps/desktop/package.json')); const {_electron}=req('@playwright/test');
const cancel=new AbortController();
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>cancel.abort());
const delay=ms=>new Promise((resolve,reject)=>{
 const finish=()=>{cancel.signal.removeEventListener('abort',abort);resolve()};
 const timer=setTimeout(finish,ms);
 const abort=()=>{clearTimeout(timer);reject(Error('Live test interrupted'))};
 cancel.signal.addEventListener('abort',abort,{once:true});if(cancel.signal.aborted)abort();
});
const report={source:options.source,path:'isolated pinned mTLS loopback, native Windows'};
const summarize=arr=>{const v=arr.filter(Number.isFinite).sort((a,b)=>a-b);return {median:v[Math.floor(v.length*.5)]??null,p95:v[Math.min(v.length-1,Math.floor(v.length*.95))]??null}};
(async()=>{
 await fs.mkdir(options.out,{recursive:true});
 const tempRoot=await fs.realpath(os.tmpdir()); const profile=await fs.mkdtemp(path.join(tempRoot,'orbit-native-live-'));
 const env={...process.env,ORBIT_LOOPBACK_TEST:'1',ORBIT_APP_DATA:profile,ORBIT_CONTROL_PORT:String(options.controlPort),ORBIT_REMOTE_PORT:String(options.remotePort)};delete env.ELECTRON_RUN_AS_NODE;
 let application,proxy;
 try {
  application=await _electron.launch({executablePath:options.app,args:['--background'],env,timeout:30000});
  const owner=await application.firstWindow(); await owner.waitForFunction(()=>!!window.orbit);
  const invoke=(action,payload)=>owner.evaluate(({action,payload})=>window.orbit.invoke(action,payload),{action,payload});
  const status=await invoke('status'); if(!status.capabilities.capture||!status.capabilities.monitors.length)throw Error('Native capture unavailable');
  report.native={arch:await application.evaluate(()=>process.arch),monitors:status.capabilities.monitors.map(m=>({width:m.width,height:m.height}))};
  if(options.mode==='recovery'){
   const {createThrottleProxy}=await import(require('node:url').pathToFileURL(path.resolve('scripts/perf/throttle-proxy.mjs')).href);
   proxy=createThrottleProxy({listenHost:'127.0.0.1',listenPort:options.proxyPort,targetHost:'127.0.0.1',targetPort:options.remotePort,handshakeRtt:false,sliceBytes:65536,log:message=>console.log('PROXY '+message)});await proxy.start();
  }
  const invite=await invoke('invite.create',{permissions:{view:true,control:false,clipboard:false,files:false,power:false}});
  let pairingInvite=invite.invite;
  if(proxy){const invitation=JSON.parse(Buffer.from(pairingInvite.slice('orbit://pair/'.length),'base64url').toString('utf8'));invitation.address='https://127.0.0.1:'+options.proxyPort;pairingInvite='orbit://pair/'+Buffer.from(JSON.stringify(invitation)).toString('base64url')}
  await invoke('pair',{invite:pairingInvite});const devices=await invoke('devices');const device=devices.devices.find(d=>d.direction==='outgoing');
  const session=await invoke('session.start',{deviceId:device.id,viewOnly:true});
  const popup=application.waitForEvent('window'); await invoke('viewer.open',{sessionId:session.sessionId,monitorId:session.monitors[0].id});const viewer=await popup;
  await viewer.waitForFunction(()=>!!window.orbit); await viewer.getByRole('switch',{name:'Video stream (beta)',exact:true}).waitFor();
  // Install instrumentation before opening video, regardless of the UI default.
  if(await viewer.getByRole('switch',{name:'Video stream (beta)',exact:true}).getAttribute('aria-checked')==='true')
   await viewer.getByRole('switch',{name:'Video stream (beta)',exact:true}).click();
  await application.evaluate(async ({BrowserWindow,screen,ipcMain})=>{
   const handler=ipcMain._invokeHandlers.get('orbit:invoke'); if(typeof handler!=='function')throw Error('Measurement hook unavailable');
   globalThis.__armImageMode='none';globalThis.__armImages=[];globalThis.__armFrameErrors=[];
   ipcMain.removeHandler('orbit:invoke');ipcMain.handle('orbit:invoke',async(event,action,payload)=>{
    if(action!=='session.frame')return handler(event,action,payload);
    const start=performance.now();const mode=globalThis.__armImageMode;
    if(mode==='jpeg')payload={...payload,format:'jpeg',quality:75};
    if(mode==='png')payload={...payload,format:'png'};
    let frame;
    try { frame=await handler(event,action,payload); }
    catch(error) { globalThis.__armFrameErrors.push({mode,status:error.status??null,code:error.code??null});throw error; }
    if(mode!=='none')globalThis.__armImages.push({ms:performance.now()-start,bytes:frame.bytes??0,mime:frame.contentType,scale:frame.scale,requestedScale:payload.scale,width:frame.width,height:frame.height,encodedWidth:frame.encodedWidth,encodedHeight:frame.encodedHeight,unchanged:frame.unchanged===true});
    return frame;
   });
   const area=screen.getPrimaryDisplay().workArea;
   const motion=new BrowserWindow({x:area.x+area.width-650,y:area.y+20,width:640,height:380,show:false,alwaysOnTop:true,skipTaskbar:true,title:'Orbit ARM64 test motion',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
   globalThis.__armMotion=motion;
   await motion.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<style>html,body{margin:0;background:#12212c;color:white;font:24px sans-serif;overflow:hidden}canvas{width:640px;height:320px}</style><div>Orbit ARM64 synthetic motion</div><canvas width="640" height="320"></canvas><script>const c=document.querySelector("canvas"),x=c.getContext("2d");let n=0;function draw(){n++;x.fillStyle="#12212c";x.fillRect(0,0,640,320);for(let i=0;i<10;i++){x.fillStyle=`hsl(${(n*3+i*29)%360} 80% 60%)`;x.fillRect((n*5+i*71)%700-60,i*31,100,25)}x.fillStyle="white";x.fillText("Frame "+n,20,160);requestAnimationFrame(draw)}draw()</script>'));
   motion.showInactive();
   for(const win of BrowserWindow.getAllWindows()) if(win!==motion&&win.webContents.getURL().includes('viewer=1'))win.setBounds({x:area.x+10,y:area.y+420,width:Math.min(1000,area.width-20),height:Math.max(500,area.height-430)});
  });
  await viewer.evaluate(()=>{
   window.__armSamples={configs:[],units:[],presented:[],dropped:0,faults:0,draws:0}; const received=new Map();
   const post=MessagePort.prototype.postMessage;
   MessagePort.prototype.postMessage=function(message,...rest){
    const samples=window.__armSamples;
    if(message?.type==='access-unit'&&message.data instanceof ArrayBuffer){received.set(message.sequence,performance.now());samples.units.push({bytes:message.data.byteLength});}
    if(message?.type==='config')samples.configs.push(message.config);
    if(message?.type==='presented')samples.presented.push({decodeMs:message.decodeMs,drawMs:message.drawMs,arrivalMs:received.has(message.sequence)?performance.now()-received.get(message.sequence):null});
    if(message?.type==='presented'||(message?.type==='consumed'&&message.dropped))received.delete(message.sequence);
    if(message?.type==='consumed'&&message.dropped)samples.dropped++;
    if(message?.type==='fault')samples.faults++;
    return post.call(this,message,...rest);
   };
   const draw=CanvasRenderingContext2D.prototype.drawImage;
   CanvasRenderingContext2D.prototype.drawImage=function(...args){window.__armSamples.draws++;return draw.apply(this,args)};
  });
  await viewer.getByLabel('Screen image quality',{exact:true}).selectOption('1');
  if(await viewer.getByRole('switch',{name:'Video stream (beta)',exact:true}).getAttribute('aria-checked')!=='true')
   await viewer.getByRole('switch',{name:'Video stream (beta)',exact:true}).click();
  if(options.mode==='compare'){
  await delay(5000);
  await viewer.evaluate(()=>{const s=window.__armSamples;s.units=[];s.presented=[];s.draws=0;s.dropped=0;s.faults=0});
  let started=Date.now(); console.log('LIVE video-only window started');await delay(options.seconds*1000);
  const elapsed=(Date.now()-started)/1000;const video=await viewer.evaluate(()=>window.__armSamples);
  const videoOn=await viewer.getByRole('switch',{name:'Video stream (beta)',exact:true}).getAttribute('aria-checked');
  report.video={seconds:elapsed,presentations:video.presented.length,drawsPerSecond:video.presented.length/elapsed,accessUnits:video.units.length,payloadBytesPerSecond:video.units.reduce((n,x)=>n+x.bytes,0)/elapsed,decodeMs:summarize(video.presented.map(x=>x.decodeMs)),arrivalToPresentationNotificationMs:summarize(video.presented.map(x=>x.arrivalMs)),config:video.configs.at(-1),dropped:video.dropped,faults:video.faults,betaStayedOn:videoOn==='true'};
  report.video.actualMode=await viewer.locator('[data-stream-mode]').getAttribute('data-stream-mode').catch(()=>null);
  if(videoOn==='true')await viewer.getByRole('switch',{name:'Video stream (beta)',exact:true}).click();
  report.images={};
  for(const mode of ['png','jpeg']){
   await viewer.getByLabel('Screen image quality',{exact:true}).selectOption('1');
   await application.evaluate((_,mode)=>{globalThis.__armImageMode=mode;globalThis.__armImages=[]},mode);await delay(2000);
   await application.evaluate(()=>{globalThis.__armImages=[]});await viewer.evaluate(()=>{window.__armSamples.draws=0});started=Date.now();console.log('LIVE '+mode+'-only window started');await delay(options.seconds*1000);
   const images=await application.evaluate(()=>globalThis.__armImages);const draws=await viewer.evaluate(()=>window.__armSamples.draws);const seconds=(Date.now()-started)/1000;
   report.images[mode]={seconds,draws,drawsPerSecond:draws/seconds,responses:images.length,requestMs:summarize(images.map(x=>x.ms)),bytesPerSecond:images.reduce((n,x)=>n+x.bytes,0)/seconds,mimes:[...new Set(images.map(x=>x.mime))],lastGeometry:images.length?{width:images.at(-1).width,height:images.at(-1).height,scale:images.at(-1).scale,requestedScale:images.at(-1).requestedScale,encodedWidth:images.at(-1).encodedWidth,encodedHeight:images.at(-1).encodedHeight}:null};
  }
  await application.evaluate(()=>{globalThis.__armImageMode='none'});

  }else if(options.mode==='recovery'){
  await delay(5000);
  await viewer.evaluate(()=>{const s=window.__armSamples;s.units=[];s.presented=[];s.draws=0;s.dropped=0;s.faults=0});
  console.log('RECOVERY baseline video 10s');await delay(10000);
  const baseline=await viewer.evaluate(()=>({video:window.__armSamples.presented.length,image:window.__armSamples.draws}));
  if(baseline.video===0)throw Error('No video baseline before interruption');
  await application.evaluate(()=>{globalThis.__armImageMode='recovery';globalThis.__armImages=[]});
  console.log('RECOVERY scoped TCP reset for 10s');const blipStarted=Date.now();await proxy.drop(10000);await delay(11000);
  await viewer.evaluate(()=>{window.__armSamples.presented=[];window.__armSamples.draws=0});await application.evaluate(()=>{globalThis.__armImages=[]});
  const resumeStart=Date.now();console.log('RECOVERY automatic-resume observation 25s');await delay(25000);
  const samples=await viewer.evaluate(()=>window.__armSamples);const images=await application.evaluate(()=>globalThis.__armImages);const current=await invoke('status');
  report.recovery={baselineVideoFrames:baseline.video,interruptionSeconds:10,scope:'only this test pinned-mTLS TCP proxy; opaque TLS passthrough',observationSeconds:(Date.now()-resumeStart)/1000,
    videoPresentations:samples.presented.length,imageDraws:samples.draws,imageResponses:images.length,videoStillEnabled:(await viewer.getByRole('switch',{name:'Video stream (beta)',exact:true}).getAttribute('aria-checked'))==='true',
    sameLocalSession:current.sessions.some(s=>s.direction==='outgoing'&&s.id===session.sessionId),automaticUpdatesResumed:samples.presented.length+samples.draws>0,
    totalSinceInterruptionSeconds:(Date.now()-blipStarted)/1000,proxyDrops:proxy.stats.drops};
  console.log(JSON.stringify(report.recovery));
  report.recovery.actualMode=await viewer.locator('[data-stream-mode]').getAttribute('data-stream-mode').catch(()=>null);

  }else{
  await delay(5000);await viewer.evaluate(()=>{window.__armSamples.presented=[]});
  console.log('REVOCATION video baseline 10s');await delay(10000);
  const beforeFrames=await viewer.evaluate(()=>window.__armSamples.presented.length);assert.ok(beforeFrames>0,'Video not live before revocation');
  const incoming=devices.devices.find(d=>d.direction==='incoming');assert.ok(incoming,'No isolated incoming peer');
  console.log('REVOCATION revoke isolated peer; observe terminal16s');await invoke('device.revoke',{deviceId:incoming.id});await delay(16000);
  let staleFrameDenied=false;try{await invoke('session.frame',{sessionId:session.sessionId,monitorId:session.monitors[0].id,includeImage:false})}catch{staleFrameDenied=true}
  report.revocation={beforeVideoFrames:beforeFrames,peerRevoked:true,terminalObservedAfterSeconds:16,staleFrameDenied};

  }
  if(options.mode!=='revocation'){await invoke('host.disconnect-all');await delay(16000)}
  const after=await invoke('devices');const hostStatus=await invoke('status');
  report.terminal={endedVisible:await viewer.getByRole('heading',{name:'Connection ended',exact:true}).isVisible().catch(()=>false),outgoingSessions:hostStatus.sessions.filter(s=>s.direction==='outgoing').length,hostSessions:hostStatus.sessions?.length??null};
  report.frameErrors=await application.evaluate(()=>globalThis.__armFrameErrors);
  console.log(JSON.stringify(report,null,2));await fs.writeFile(path.join(options.out,'evidence.json'),JSON.stringify(report,null,2));
  if(options.mode==='compare'){assert.ok(report.video.presentations>0,'No actual video presentations');assert.ok(report.video.betaStayedOn,'Video fell back');assert.ok(report.images.png.draws>0,'No PNG canvas draws');assert.ok(report.images.jpeg.draws>0,'No JPEG canvas draws');}
  if(options.mode==='recovery'){assert.ok(report.recovery.automaticUpdatesResumed,'Updates did not recover automatically');assert.ok(report.recovery.sameLocalSession,'Original session was lost')}
  if(options.mode==='recovery'&&options.requireVideoRecovery){assert.ok(report.recovery.videoPresentations>0,'Video did not recover automatically');assert.equal(report.recovery.actualMode,'video','Viewer did not return to actual video mode')}
  if(options.mode==='revocation')assert.ok(report.revocation.staleFrameDenied,'Revoked frame request allowed');
  assert.ok(report.terminal.endedVisible,'Ended UI missing');assert.equal(report.terminal.hostSessions,0,'Sessions remain after ending');
 } finally {
  try { if(application)await application.close(); }
  finally {
   try { if(proxy)await proxy.close(); }
   finally {
    const resolved=await fs.realpath(profile);if(path.dirname(resolved)!==tempRoot||!path.basename(resolved).startsWith('orbit-native-live-'))throw Error('Unexpected profile path');await fs.rm(resolved,{recursive:true,force:true});
   }
  }
  console.log('Live test app/motion closed and isolated profile removed');
 }
})().catch(e=>{console.error(e.message);process.exitCode=1});
