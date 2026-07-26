#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import process from 'node:process';

import WebSocket from 'ws';

const port = Number(process.env.CDP_PORT || 9223);
const output = process.argv[2];
if (!output) throw new Error('Usage: desktop-tab-cpu-profile.mjs <output.json>');

const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
  response.json(),
);
const page = targets.find((target) => target.type === 'page' && target.url.startsWith('app://'));
if (!page) throw new Error(`No app:// page target found on CDP port ${port}`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

let commandId = 0;
const pending = new Map();
socket.on('message', (data) => {
  const message = JSON.parse(data.toString());
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { reject, resolve });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (response.exceptionDetails) throw new Error('Evaluation failed');
  return response.result.value;
};

const before = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('div')].filter((element) => {
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.y - 5) < 1 && Math.abs(rect.width - 180) < 1 && Math.abs(rect.height - 28) < 1;
  });
  const activeIndex = tabs.findIndex((element) => element.dataset.active === 'true');
  const target = tabs[(activeIndex + 1) % tabs.length];
  const rect = target.getBoundingClientRect();
  return {
    from: location.pathname + location.search,
    target: target.textContent?.trim(),
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
})()`);

await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 100 });
await send('Profiler.start');
await send('Input.dispatchMouseEvent', {
  button: 'left',
  clickCount: 1,
  type: 'mousePressed',
  x: before.x,
  y: before.y,
});
await send('Input.dispatchMouseEvent', {
  button: 'left',
  clickCount: 1,
  type: 'mouseReleased',
  x: before.x,
  y: before.y,
});
await new Promise((resolve) => setTimeout(resolve, 750));
const { profile } = await send('Profiler.stop');
const after = await evaluate(`location.pathname + location.search`);

const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
const selfTimeByNode = new Map();
for (let index = 0; index < profile.samples.length; index += 1) {
  const nodeId = profile.samples[index];
  selfTimeByNode.set(nodeId, (selfTimeByNode.get(nodeId) || 0) + profile.timeDeltas[index]);
}
const hottest = [...selfTimeByNode.entries()]
  .map(([nodeId, microseconds]) => {
    const frame = nodeById.get(nodeId)?.callFrame;
    return {
      column: frame?.columnNumber,
      functionName: frame?.functionName || '(anonymous)',
      line: frame?.lineNumber,
      milliseconds: microseconds / 1000,
      url: frame?.url,
    };
  })
  .filter((entry) => entry.milliseconds >= 0.5)
  .sort((a, b) => b.milliseconds - a.milliseconds)
  .slice(0, 80);

await writeFile(output, `${JSON.stringify({ after, before, hottest, profile }, null, 2)}\n`);
socket.close();
console.table(hottest.slice(0, 25));
