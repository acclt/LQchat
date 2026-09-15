const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/notification-access-phone');
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const adb = (...args) => execFileSync(adbPath, ['-s', '10AFAM1FN5005XG', ...args], {encoding:'utf8',timeout:15000});
const evaluate = expression => JSON.parse(execFileSync(process.execPath, [path.join(root,'artifacts/phone-save-diagnosis/probe.cjs'),'eval',expression], {encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024}));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const foreground = () => adb('shell','dumpsys','activity','activities').split('\n').filter(line=>line.includes('ResumedActivity:')).join('\n');
const config = () => evaluate(`(async()=>({general:await apiGetSettings(),background:await window.__TAURI__.core.invoke('get_background_runtime_settings'),notification:await window.__TAURI__.core.invoke('notification_settings')}))()`);
async function main() {
  fs.mkdirSync(output,{recursive:true});
  const baseline=path.join(output,'before-install.json');
  if(process.argv[2]==='baseline') {
    assert(!fs.existsSync(baseline),'Do not overwrite baseline');
    fs.writeFileSync(baseline,JSON.stringify(config(),null,2));
    return;
  }
  const before=JSON.parse(fs.readFileSync(baseline,'utf8'));
  assert.deepEqual(config(),before);
  assert(before.notification.access,'Phone must already be authorized');
  assert(foreground().includes('com.lanchat.app/.MainActivity'));
  for(const file of ['js/notification-sync.js','css/android-ui.css']) {
    const hash=text=>crypto.createHash('sha256').update(text.replace(/\r\n/g,'\n')).digest('hex');
    assert.equal(hash(evaluate(`fetch('${file}').then(r=>r.text())`)),hash(fs.readFileSync(path.join(root,'src',file),'utf8')));
  }
  if(evaluate('location.hash')==='') evaluate(`document.getElementById('android-settings-btn').click();true`);
  await sleep(400);
  if(evaluate('location.hash')==='#settings') evaluate(`document.getElementById('android-permissions-btn').click();true`);
  await sleep(400);
  assert.equal(evaluate('location.hash'),'#permissions');
  const style=()=>evaluate(`(()=>{const b=document.getElementById('android-notification-access-btn'),s=getComputedStyle(b),p=getComputedStyle(document.querySelector('.android-status-ok'));return{text:b.textContent,color:s.color,peerColor:p.color,size:s.fontSize,peerSize:p.fontSize,background:s.backgroundColor};})()`);
  assert.equal(style().text,'已授权');
  evaluate(`(()=>{const p=window.__accessQA={events:[],handlers:[],name:document.getElementById('settings-device-name-input'),push:document.querySelector('#android-notification-settings input')};p.originalName=p.name.value;p.name.value='Unsaved access QA';for(const [t,n] of [[window,'focus'],[document,'visibilitychange']]){const fn=()=>p.events.push({event:n,visibility:document.visibilityState,at:performance.now()});t.addEventListener(n,fn);p.handlers.push([t,n,fn]);}return true;})()`);
  let report;
  try {
    evaluate(`document.getElementById('android-notification-access-btn').click();true`);
    await sleep(500);
    assert(foreground().includes('com.android.settings/'));
    // Recreate a stale label only; never revoke the user's actual authorization.
    evaluate(`(()=>{const b=document.getElementById('android-notification-access-btn');b.textContent='去授权';b.classList.remove('is-authorized');return true;})()`);
    adb('shell','input','keyevent','4');
    await sleep(500);
    assert(foreground().includes('com.lanchat.app/.MainActivity'));
    const actual=style();
    assert.equal(actual.text,'已授权');
    assert.equal(actual.color,actual.peerColor);
    assert.equal(actual.size,actual.peerSize);
    assert.equal(actual.background,'rgba(0, 0, 0, 0)');
    const result=evaluate(`({events:window.__accessQA.events,draftPreserved:window.__accessQA.name===document.getElementById('settings-device-name-input')&&window.__accessQA.name.value==='Unsaved access QA',pushControlPreserved:window.__accessQA.push===document.querySelector('#android-notification-settings input')})`);
    assert(result.draftPreserved && result.pushControlPreserved);
    assert(result.events.some(e=>e.event==='visibilitychange'&&e.visibility==='visible'));
    assert.deepEqual(config(),before);
    report={style:actual,...result,configurationPreserved:true,staleLabelRecovered:true};
  } finally {
    evaluate(`(()=>{const p=window.__accessQA;if(p){p.name.value=p.originalName;for(const [t,n,fn] of p.handlers)t.removeEventListener(n,fn);delete window.__accessQA;}return true;})()`);
  }
  fs.writeFileSync(path.join(output,'authorized.png'),execFileSync(adbPath,['-s','10AFAM1FN5005XG','exec-out','screencap','-p'],{maxBuffer:20*1024*1024}));
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
