// Verifies the isolated Android acceptance package without touching the installed release app.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/receive-settings-fix');
const serial = process.env.LQCHAT_ADB_SERIAL || 'emulator-5554';
const packageName = 'com.lanchat.app.acceptance';
const port = '19226';
const notificationPort = '18888';
const adbPath = path.join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = text => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const pid = adb('shell', 'pidof', packageName).trim();
  assert.match(pid, /^\d+$/);
  const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
  if (sdk >= 33) {
    try { adb('shell', 'pm', 'grant', packageName, 'android.permission.POST_NOTIFICATIONS'); } catch (_) {}
  }
  adb('forward', `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);
  adb('forward', `tcp:${notificationPort}`, 'tcp:8888');
  let ws;
  try {
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      try {
        page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
          .find(item => item.title === 'LQ Chat' && item.url.startsWith('http://tauri.localhost/'));
      } catch (_) {}
      if (!page) await sleep(100);
    }
    assert(page, 'Acceptance WebView did not become available');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => {
      const message = JSON.parse(event.data), entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error || message.result?.exceptionDetails) entry.reject(message.error || message.result.exceptionDetails);
      else entry.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async expression =>
      (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    const wait = async expression => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      throw Error(`Timed out: ${expression}`);
    };
    const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const sendNotification = notification => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${notificationPort}/ws`);
      const timeout = setTimeout(() => { socket.close(); reject(Error('Notification reply timed out')); }, 10000);
      socket.onopen = () => socket.send(JSON.stringify(notification));
      socket.onerror = () => { clearTimeout(timeout); reject(Error('Notification socket failed')); };
      socket.onmessage = event => {
        const result = JSON.parse(event.data);
        if (result.msg_type !== 'notification_result' || result.event_id !== notification.event_id) return;
        clearTimeout(timeout);
        socket.close();
        resolve(result);
      };
    });
    const capture = name => fs.writeFileSync(
      path.join(output, `${name}.png`),
      execFileSync(adbPath, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 20 * 1024 * 1024 }),
    );

    await wait(`document.body.classList.contains('android-app') && !!window.NotificationUI`);
    await wait(`window.__TAURI__.core.invoke('get_background_receive_state').then(status=>status.state==='RUNNING')`);
    for (const file of ['css/android-ui.css', 'js/notification-sync.js']) {
      const deployed = await evaluate(`fetch(${JSON.stringify(file)}).then(response => response.text())`);
      assert.equal(hash(deployed), hash(fs.readFileSync(path.join(root, 'src', file), 'utf8')), `${file} is stale`);
    }
    const layout = await evaluate(`(() => {
      const inspect=card=>{const count=card.querySelector('.android-count-label').getBoundingClientRect(),refresh=card.querySelector('.android-icon-btn').getBoundingClientRect();return Math.abs((count.top+count.height/2)-(refresh.top+refresh.height/2))<1;};
      return{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,chat:inspect(document.querySelector('.android-chat-card')),receive:inspect(document.querySelector('.android-receive-card'))};
    })()`);
    assert.equal(layout.scrollWidth, layout.width);
    assert(layout.chat && layout.receive);
    capture('mumu-home-toolbar');

    const before = await evaluate(`window.__TAURI__.core.invoke('notification_settings').then(result=>result.settings.receive_enabled)`);
    await evaluate(`NotificationUI.open('qa-source','notification_receive')`);
    await wait(`location.hash==='#notifications' && !document.querySelector('.ns-detail').hidden`);
    await click('.ns-detail-header > button:last-child');
    await wait(`location.hash==='#receive-settings' && document.getElementById('android-receive-settings-panel').style.display==='block'`);
    assert.equal(await evaluate(`document.getElementById('settings-panel').style.display`), 'none');
    assert.equal(await evaluate(`document.querySelector('#android-receive-settings-panel input').checked`), before);
    capture('mumu-receive-settings');

    await click('#android-receive-settings-panel input');
    await wait(`document.querySelector('#android-receive-settings-panel .ns-save-status').textContent==='已保存'`);
    assert.equal(await evaluate(`window.__TAURI__.core.invoke('notification_settings').then(result=>result.settings.receive_enabled)`), !before);
    await click('#android-receive-settings-back-btn');
    await wait(`location.hash==='#notifications' && document.getElementById('android-receive-settings-panel').style.display==='none'`);
    await click('.ns-detail-header > button:last-child');
    await wait(`location.hash==='#receive-settings'`);
    assert.equal(await evaluate(`document.querySelector('#android-receive-settings-panel input').checked`), !before);
    if (before) {
      await click('#android-receive-settings-panel input');
      await wait(`window.__TAURI__.core.invoke('notification_settings').then(result=>result.settings.receive_enabled===true)`);
    }

    const localId = await evaluate(`apiGetMyId()`);
    const eventId = `mumu-receive-${Date.now()}`;
    const reply = await sendNotification({
      msg_type: 'notification', event_id: eventId, source_device_id: 'qa-source', target_device_id: localId,
      package: 'com.lanchat.qa', app_name: 'LQ Chat 验收', title: '信息接收测试',
      text: '这是一条本地验收通知。', notification_key: eventId, post_time: Date.now(),
    });
    let receivedRecord = null;
    if (reply.status === 'success') {
      await wait(`window.__TAURI__.core.invoke('notification_records').then(result=>(Array.isArray(result)?result:result.records||[]).some(item=>item.notification.event_id===${JSON.stringify(eventId)}&&item.status!=='receiving'))`);
      receivedRecord = await evaluate(`window.__TAURI__.core.invoke('notification_records').then(result=>(Array.isArray(result)?result:result.records||[]).find(item=>item.notification.event_id===${JSON.stringify(eventId)}))`);
    }
    if (!before) {
      await click('#android-receive-settings-panel input');
      await wait(`window.__TAURI__.core.invoke('notification_settings').then(result=>result.settings.receive_enabled===false)`);
    }
    const coreStatus = await evaluate(`window.__TAURI__.core.invoke('get_background_receive_state')`);
    assert.equal(reply.status, 'success', `Receiver rejected notification while core was ${coreStatus.state}: ${receivedRecord?.failure_reason || 'no record'}`);
    assert.equal(receivedRecord.status, 'success');

    const result = { passed: true, layout, receiveSettingRestored: true, notificationReply: reply.status, receivedRecord: receivedRecord.status };
    fs.writeFileSync(path.join(output, 'mumu-results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    ws?.close();
    try { adb('forward', '--remove', `tcp:${port}`); } catch (_) {}
    try { adb('forward', '--remove', `tcp:${notificationPort}`); } catch (_) {}
    try { adb('shell', 'am', 'force-stop', packageName); } catch (_) {}
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
