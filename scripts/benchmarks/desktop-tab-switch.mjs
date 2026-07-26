#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import process from 'node:process';

import WebSocket from 'ws';

const port = Number(process.env.CDP_PORT || 9223);
const output = process.argv[2];
const iterations = Number(process.env.ITERATIONS || 12);

if (!output) {
  throw new Error('Usage: desktop-tab-switch.mjs <output.json>');
}

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
  if (!message.id) return;
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

await send('Runtime.enable');
await send('Performance.enable');
await send('HeapProfiler.collectGarbage');

const beforeMetrics = await send('Performance.getMetrics');
const evaluate = async (expression, awaitPromise = false) => {
  const response = await send('Runtime.evaluate', {
    awaitPromise,
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || 'Evaluation failed');
  }
  return response.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tabSnapshotExpression = `(() => {
  const tabs = [...document.querySelectorAll('div')].filter((element) => {
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.y - 5) < 1 && Math.abs(rect.width - 180) < 1 && Math.abs(rect.height - 28) < 1;
  });
  const activeIndex = tabs.findIndex((element) => element.dataset.active === 'true');
  return {
    activeIndex,
    path: location.pathname + location.search,
    tabs: tabs.map((element) => {
      const rect = element.getBoundingClientRect();
      return { title: element.textContent?.trim(), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }),
  };
})()`;

await evaluate(`(() => {
  window.__desktopTabBenchmark = { active: true, frameGaps: [], longTasks: [] };
  let lastFrame = performance.now();
  const frameLoop = (now) => {
    if (!window.__desktopTabBenchmark.active) return;
    const gap = now - lastFrame;
    if (gap > 20) window.__desktopTabBenchmark.frameGaps.push({ at: now, duration: gap });
    lastFrame = now;
    requestAnimationFrame(frameLoop);
  };
  requestAnimationFrame(frameLoop);
  try {
    window.__desktopTabBenchmark.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__desktopTabBenchmark.longTasks.push({ at: entry.startTime, duration: entry.duration });
      }
    });
    window.__desktopTabBenchmark.observer.observe({ buffered: true, type: 'longtask' });
  } catch {}
})()`);

const results = [];
await sleep(1000);
for (let index = 0; index < iterations; index += 1) {
  const before = await evaluate(tabSnapshotExpression);
  if (before.tabs.length < 3) throw new Error(`Expected 3 tabs, found ${before.tabs.length}`);
  const targetIndex = (before.activeIndex + 1) % before.tabs.length;
  const target = before.tabs[targetIndex];
  const offsets = await evaluate(
    `({ frameGaps: window.__desktopTabBenchmark.frameGaps.length, longTasks: window.__desktopTabBenchmark.longTasks.length })`,
  );
  const start = performance.now();

  await send('Input.dispatchMouseEvent', {
    button: 'left',
    clickCount: 1,
    type: 'mousePressed',
    x: target.x,
    y: target.y,
  });
  await send('Input.dispatchMouseEvent', {
    button: 'left',
    clickCount: 1,
    type: 'mouseReleased',
    x: target.x,
    y: target.y,
  });

  let current = before;
  while (current.activeIndex !== targetIndex && performance.now() - start < 5000) {
    await sleep(5);
    current = await evaluate(tabSnapshotExpression);
  }
  const activeAt = performance.now();
  while (current.path === before.path && performance.now() - start < 5000) {
    await sleep(5);
    current = await evaluate(tabSnapshotExpression);
  }
  const routeAt = performance.now();
  await sleep(50);
  const settledAt = performance.now();
  await sleep(250);
  const observations = await evaluate(`({
    frameGaps: window.__desktopTabBenchmark.frameGaps.slice(${offsets.frameGaps}),
    longTasks: window.__desktopTabBenchmark.longTasks.slice(${offsets.longTasks})
  })`);

  results.push({
    activeMs: activeAt - start,
    frameGaps: observations.frameGaps,
    from: before.path,
    iteration: index + 1,
    longTasks: observations.longTasks,
    routeMs: routeAt - start,
    settledMs: settledAt - start,
    target: target.title,
    to: current.path,
  });
}

const runtimeInfo = await evaluate(
  `({ finishedAt: new Date().toISOString(), userAgent: navigator.userAgent })`,
);

const afterMetrics = await send('Performance.getMetrics');
await evaluate(`(() => {
  window.__desktopTabBenchmark.active = false;
  window.__desktopTabBenchmark.observer?.disconnect();
})()`);
const metricMap = (metrics) =>
  Object.fromEntries(metrics.metrics.map(({ name, value }) => [name, value]));
const before = metricMap(beforeMetrics);
const after = metricMap(afterMetrics);
const metricNames = [
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
  'JSHeapUsedSize',
];
const metricDelta = Object.fromEntries(
  metricNames.map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)]),
);

const payload = {
  ...runtimeInfo,
  iterations,
  metricDelta,
  port,
  results,
};

await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`);
socket.close();

const values = payload.results.map((result) => result.settledMs).sort((a, b) => a - b);
const percentile = (fraction) =>
  values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
console.log(
  JSON.stringify({
    activeMedianMs: median(payload.results.map((result) => result.activeMs)),
    routeMedianMs: median(payload.results.map((result) => result.routeMs)),
    settledMedianMs: median(values),
    settledP95Ms: percentile(0.95),
    totalFrameGaps: payload.results.reduce((sum, result) => sum + result.frameGaps.length, 0),
    totalLongTasks: payload.results.reduce((sum, result) => sum + result.longTasks.length, 0),
  }),
);

function median(valuesToSort) {
  const sorted = [...valuesToSort].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
