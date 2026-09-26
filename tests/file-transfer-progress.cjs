const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ui.js'), 'utf8');
const helpers = source.slice(source.indexOf('function fileTransferLabel('), source.indexOf('function createMessageElement('));

function card(direction, id, total, file = true) {
  const status = { textContent: '', className: '' };
  const fill = { style: {} };
  const bar = { setAttribute(name, value) { this[name] = value; } };
  const detail = { textContent: '' };
  const progress = {
    dataset: { total: String(total) }, hidden: true,
    querySelector(selector) {
      return { '.file-transfer-fill': fill, '.file-transfer-bar': bar,
        '.file-transfer-detail': detail }[selector];
    },
  };
  const element = {
    dataset: { senderMsgId: String(id), msgId: String(id) },
    classList: { contains(name) { return name === direction; } },
    querySelector(selector) {
      return { '.message-file': file ? {} : null,
        '.file-transfer-status': status, '.file-transfer-progress': progress }[selector];
    },
  };
  return { element, status, fill, bar, detail, progress };
}

for (const platform of ['Windows', 'Android']) {
  const sent = card('sent', 7, 1000);
  const received = card('received', 7, 1000);
  const text = card('sent', 8, 1000, false);
  const document = { getElementById() { return {
    querySelectorAll() { return [received.element, sent.element, text.element]; },
  }; } };
  const context = vm.createContext({ document, window: {}, performance: { now: () => 1000 } });
  vm.runInContext(helpers, context);
  const update = context.updateFileTransferById;

  update(7, 'uploading', 500, 1000, 1, true);
  assert.equal(sent.fill.style.width, '50%', `${platform} send uses acknowledged bytes`);
  assert.equal(sent.status.textContent, '正在发送');
  assert.match(sent.detail.textContent, /500 B \/ 1000 B.*1\.0 MB\/s/);
  assert.equal(received.progress.hidden, true, `${platform} incoming card remains independent`);
  update(7, 'uploading', 2000, 1000, 1, true);
  assert.equal(sent.fill.style.width, '100%', 'progress never exceeds confirmed total');
  update(7, 'uploading', 500, 1000, 1, true);
  update(7, 'uploading', 501, 1000, 1);
  assert.equal(sent.detail.textContent.includes('501 B'), false, 'same-percent updates are throttled');
  update(7, 'uploading', 510, 1000, 1);
  assert.equal(sent.fill.style.width, '51%', 'meaningful percent change renders immediately');

  update(7, 'downloading', 250, 1000, 0.5, true, 'received');
  assert.equal(received.fill.style.width, '25%', `${platform} receive uses written bytes`);
  assert.equal(sent.fill.style.width, '51%');
  update(7, 'saving', 1000, 1000, 0, true, 'received');
  assert.equal(received.status.textContent, '正在保存');
  update(7, 'accepted', 1000, 1000, 0, true, 'received');
  assert.equal(received.status.textContent, '已完成');
  assert.equal(received.progress.hidden, true);

  update(7, 'retrying', 0, 1000, 0, true);
  assert.equal(sent.fill.style.width, '0%', `${platform} retry resets progress`);
  assert.equal(sent.status.textContent, '重新发送');
  update(7, 'failed', 0, 1000, 0, true);
  assert.equal(sent.status.textContent, '发送失败');
  update(8, 'uploading', 500, 1000, 1, true);
  assert.equal(text.status.textContent, '', 'text messages have no progress');
}
console.log('Windows/Android send and receive progress contracts passed');
