const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const dgram = require('node:dgram');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const output = path.join(root,'artifacts/boot-phone-5.0.3-retest');
const lan = process.argv[2] === 'lan';
const host = lan ? process.argv[3] : '127.0.0.1:19224';
assert(!lan || /^192\.168\.5\.\d+:8888$/.test(host),'Expected verified local network');
const adbPath = path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
const adb = (...args)=>execFileSync(adbPath,['-s','10AFAM1FN5005XG',...args],{encoding:'utf8',timeout:15000,maxBuffer:12*1024*1024});
const read = async route => {
  const response = await fetch('http://'+host+route,{signal:AbortSignal.timeout(4000)});
  assert(response.ok);
  return response.json();
};
async function main() {
  const baseline=JSON.parse(fs.readFileSync(path.join(root,'artifacts/boot-phone-5.0.3/before.json'),'utf8').replace(/^\uFEFF/,''));
  const bootId=adb('shell','cat','/proc/sys/kernel/random/boot_id').trim();
  assert.notEqual(bootId,fs.readFileSync(path.join(output,'boot-id-before.txt'),'utf8').replace(/^\uFEFF/,'').trim());
  const activities=adb('shell','dumpsys','activity','activities');
  assert(!activities.includes('com.lanchat.app/.MainActivity'),'Activity must not be opened for boot test');
  const services=adb('shell','dumpsys','activity','services');
  const service=services.split(/(?=\s+\* ServiceRecord\{)/).find(block=>block.includes('com.lanchat.app/.LanChatForegroundService'));
  assert(service?.includes('isForeground=true') && service.includes('BOOT_COMPLETED'));
  fs.writeFileSync(path.join(output,'boot-service.txt'),service);
  assert.equal((await read('/api/get_my_id')).id,baseline.id);
  const peerId=lan ? JSON.parse(fs.readFileSync(path.join(output,'message-result.json'),'utf8')).testPeerId : randomUUID();
  let discovery;
  if(lan) {
    const udp=dgram.createSocket({type:'udp4',reuseAddr:true});
    try {
      discovery=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('No phone discovery announcement')),12000);
        udp.on('error',error=>{clearTimeout(timer);reject(error);});
        udp.on('message',(bytes,remote)=>{
          const fields=bytes.toString().split('|');
          if(fields[0]==='LANChat' && fields[2]===baseline.id && remote.address===host.split(':')[0]) {
            clearTimeout(timer);resolve({phoneAnnouncementReceived:true,source:remote.address,name:fields[3]});
          }
        });
        udp.bind(8888,'0.0.0.0',()=>udp.addMembership('224.0.0.167','192.168.5.5'));
      });
      await new Promise((resolve,reject)=>udp.send(Buffer.from(`LANChat|ONLINE|${peerId}|LQ Boot Test|8888|1024|0|0|`),8888,host.split(':')[0],error=>error?reject(error):resolve()));
      await new Promise(resolve=>setTimeout(resolve,350));
      assert(JSON.stringify(await read('/api/get_peers')).includes(peerId),'Phone did not discover test peer');
      discovery.phoneDiscoveredTestPeer=true;
    } finally {udp.close();}
  }
  const message={msg_type:'text',from_id:peerId,from_name:'LQ Boot Test',content:lan?'LQ Chat Wi-Fi boot verification: background message received without opening the app.':'LQ Chat boot verification: background message received without opening the app.',timestamp:Math.floor(Date.now()/1000)};
  const socket=new WebSocket('ws://'+host+'/ws');
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('WebSocket timeout')),5000);socket.onopen=()=>{clearTimeout(timer);resolve();};socket.onerror=()=>{clearTimeout(timer);reject(Error('WebSocket failed'));};});
  let history;
  try {
    socket.send(JSON.stringify(message));
    for(let i=0;i<15;i++) {
      await new Promise(resolve=>setTimeout(resolve,200));
      history=await read('/api/chat_history/'+peerId);
      if(JSON.stringify(history).includes(message.content)) break;
    }
    assert(JSON.stringify(history).includes(message.content),'Background message was not persisted');
  } finally {socket.close();}
  assert(!adb('shell','dumpsys','activity','activities').includes('com.lanchat.app/.MainActivity'));
  const result={bootId,bootServiceStarted:true,mainActivityOpened:false,identityPreserved:true,backgroundMessageReceived:true,transport:lan?'Direct Wi-Fi LAN':'USB-forwarded WebSocket, not LAN',discovery,testPeerId:peerId,history};
  fs.writeFileSync(path.join(output,lan?'lan-result.json':'message-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
main().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
