// Verify action manager DOM in the settings window via CDP.
const http = require('http');
const WebSocket = require('ws');

const body = JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: {
    expression: JSON.stringify({
      actionCount: document.getElementById('action-list')?.children?.length ?? -1,
      emptyHidden: document.getElementById('action-list-empty')?.style?.display ?? 'not-set',
      rootText: document.getElementById('actions-root')?.textContent ?? '',
      scanBtn: document.getElementById('scan-actions')?.textContent?.slice(0, 20) ?? '',
    }),
    returnByValue: true,
  },
});

const req = http.get('http://localhost:9222/json', (res) => {
  let data = '';
  res.on('data', (c) => (data += c));
  res.on('end', () => {
    const targets = JSON.parse(data);
    const settings = targets.find((t) => t.url.includes('settings'));
    if (!settings) {
      console.log('NO_SETTINGS_TARGET');
      process.exit(1);
    }
    const ws = new WebSocket(settings.webSocketDebuggerUrl);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.executionContextCreated') {
        ws.send(body);
      }
      if (msg.id === 1 && msg.result?.result?.value) {
        console.log(msg.result.result.value);
        ws.close();
        process.exit(0);
      }
    });
  });
});

req.on('error', (e) => {
  console.log(`HTTP_ERROR: ${e.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.log('TIMEOUT');
  process.exit(1);
}, 6000);