const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/settings-row-phone');
const probe = path.join(root, 'artifacts/phone-save-diagnosis/probe.cjs');
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const adb = (...args) => execFileSync(adbPath, ['-s','10AFAM1FN5005XG',...args], {encoding:'utf8',timeout:15000});
const evaluate = expression => JSON.parse(execFileSync(process.execPath,[probe,'eval',expression],{encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024}));
const capture = name => fs.writeFileSync(path.join(output,name+'.png'),execFileSync(adbPath,['-s','10AFAM1FN5005XG','exec-out','screencap','-p'],{maxBuffer:20*1024*1024}));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const readConfig = () => evaluate(`(async()=>({general:await apiGetSettings(),background:await window.__TAURI__.core.invoke('get_background_runtime_settings'),permission:await window.__TAURI__.core.invoke('get_notification_permission_state')}))()`);
const foreground = () => adb('shell','dumpsys','activity','activities').split('\n').filter(s=>/ResumedActivity:/.test(s)).join('\n');
const appResumed = () => /com\.lanchat\.app\/\.MainActivity/.test(foreground());
async function cancelDirectoryPicker() {
  for(let attempt=0;attempt<5;attempt++) {
    if(appResumed()) return;
    assert(/documentsui/i.test(foreground()),'Unexpected foreground while cancelling picker');
    adb('shell','input','keyevent','4');
    await sleep(600);
  }
  assert(appResumed(),'Directory picker did not close');
}
const tap = selector => {
  assert(appResumed(),'App must be foreground before tapping app controls');
  const point=evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();if(n.disabled||!n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Target is disabled or covered');return{x:Math.round((r.x+r.width/2)*devicePixelRatio),y:Math.round((r.y+r.height/2)*devicePixelRatio)};})()`);
  adb('shell','input','tap',String(point.x),String(point.y));
};
async function main() {
  fs.mkdirSync(output,{recursive:true});
  const baseline=path.join(output,'before-install.json');
  if(process.argv[2]==='baseline') {
    assert(!fs.existsSync(baseline),'Preserve original baseline');
    fs.writeFileSync(baseline,JSON.stringify(readConfig(),null,2));return;
  }
  const before=JSON.parse(fs.readFileSync(baseline,'utf8'));
  await cancelDirectoryPicker();
  assert.deepEqual(readConfig(),before);
  for(const file of ['js/ui.js','css/android-ui.css']) {
    const deployed=evaluate(`fetch('${file}').then(r=>r.text())`);
    const local=fs.readFileSync(path.join(root,'src',file),'utf8');
    const hash=text=>crypto.createHash('sha256').update(text.replace(/\r\n/g,'\n')).digest('hex');
    assert.equal(hash(deployed),hash(local),'Installed source mismatch: '+file);
  }
  if(evaluate('location.hash')==='#permissions') {
    evaluate('history.back();true');
    await sleep(300);
  }
  if(evaluate('location.hash')!=='#settings') evaluate(`document.getElementById('android-settings-btn').click();true`);
  await sleep(300);
  const layout=evaluate(`(()=>{const row=document.getElementById('android-download-location-btn'),value=document.getElementById('android-download-value'),arrow=row.querySelector('svg');return{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,align:getComputedStyle(value).textAlign,valueFits:value.scrollWidth<=value.clientWidth,arrowRight:arrow.getBoundingClientRect().right,rowRight:row.getBoundingClientRect().right,legacyHidden:getComputedStyle(document.querySelector('.desktop-download-setting')).display==='none'};})()`);
  assert.equal(layout.width,layout.scrollWidth);
  assert.equal(layout.align,'right');assert(layout.valueFits && layout.legacyHidden);
  assert(Math.abs(layout.arrowRight-layout.rowRight)<1);
  capture('download-location');
  tap('#android-download-location-btn');
  await sleep(600);
  const activity=adb('shell','dumpsys','activity','activities').split('\n').filter(s=>/ResumedActivity:/.test(s)).join('\n');
  assert(/documentsui/i.test(activity),'Expected system directory picker: '+activity);
  capture('directory-picker');
  await cancelDirectoryPicker();
  assert.deepEqual(readConfig(),before,'Cancelling directory picker must preserve path');
  assert.equal(evaluate('location.hash'),'#settings');
  evaluate(`document.getElementById('android-permissions-btn').click();true`);
  await sleep(200);
  assert.equal(evaluate(`!!document.getElementById('stop-background-service-btn')`),false);
  assert.equal(evaluate(`getComputedStyle(document.querySelector('.background-receive-actions')).display`),'none');
  capture('running-status');
  tap('#background-receive-status');
  await sleep(200);
  let dialog;
  try {
    capture('stop-confirmation');
    dialog=adb('exec-out','uiautomator','dump','/dev/tty');
    fs.writeFileSync(path.join(output,'stop-confirmation.xml'),dialog);
    assert(dialog.includes('停止后台接收并退出 LQ Chat'),'Expected stop confirmation dialog');
  } finally {
    // Never accept the destructive action on the user's phone during UI verification.
    adb('shell','input','keyevent','4');
  }
  await sleep(200);
  assert.equal(evaluate(`(async()=> (await window.__TAURI__.core.invoke('get_background_receive_state')).state)()`),'RUNNING');
  assert.equal(evaluate('location.hash'),'#permissions');
  assert.deepEqual(readConfig(),before);
  tap('#save-permissions-btn');await sleep(200);
  assert.equal(evaluate('location.hash'),'#settings');
  assert.equal(evaluate(`document.querySelector('.message-action-toast')?.textContent`),'保存成功');
  assert.deepEqual(readConfig(),before);
  evaluate(`document.getElementById('android-permissions-btn').click();document.getElementById('permissions-panel').scrollTop=0;true`);
  const report={layout,directoryPickerOpened:true,cancelPreservedPath:true,stopConfirmationShown:true,cancelKeptServiceRunning:true,savePassed:true,configurationPreserved:true};
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
