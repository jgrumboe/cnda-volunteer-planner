/**
 * Records a promo video of the planner by driving headless Chrome over the
 * DevTools Protocol and encoding the frames with ffmpeg.
 *
 * Zero dependencies: Node 24 ships a global WebSocket and fetch, which is all
 * CDP needs. Requires Chrome and ffmpeg on PATH, and the dev server running.
 *
 *   npm run dev          # in another shell
 *   npm run promo
 *
 * Volunteer names are replaced with invented ones — the real roster is personal
 * data and a promo is meant to be shared. Organizers are already public on
 * cloudnativedays.at/team, so they stay.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.PROMO_URL ?? 'http://localhost:5178';
const OUT = process.env.PROMO_OUT ?? 'promo.mp4';
const CDP_PORT = 9333;
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 1.5;
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const frameDir = join(tmpdir(), `cnda-promo-${Date.now()}`);
mkdirSync(frameDir, { recursive: true });

/* ------------------------------------------------------------------ CDP glue */

let msgId = 0;
const pending = new Map();

function send(ws, method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30_000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('Chrome did not expose a DevTools endpoint.');
}

async function firstPageTarget() {
  for (let i = 0; i < 100; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(150);
  }
  throw new Error('No page target found.');
}

/* -------------------------------------------------------------- page helpers */

let ws;

async function evaluate(expression, awaitPromise = false) {
  const res = await send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      `Page error: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
    );
  }
  return res.result?.value;
}

const frames = [];

async function capture() {
  const { data } = await send(ws, 'Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  const file = join(frameDir, `f${String(frames.length).padStart(5, '0')}.jpg`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: Date.now() });
}

/** Capture continuously for `seconds`, so CSS transitions land as real motion. */
async function hold(seconds) {
  const until = Date.now() + seconds * 1000;
  do {
    await capture();
  } while (Date.now() < until);
}

/* ------------------------------------------------------------------- storyboard */

const DEMO_VOLUNTEERS = [
  'Lena Hofer',
  'Tobias Wolf',
  'Nina Kraus',
  'Jonas Berger',
  'Mara Sailer',
  'Elias Frank',
  'Sofia Reiter',
  'David Lang',
  'Clara Moser',
  'Noah Steiner',
];

/** Overlay for captions, injected so it matches the app's visual language. */
const INSTALL_OVERLAY = `(() => {
  if (document.getElementById('promo-overlay')) return 'exists';
  const css = document.createElement('style');
  css.textContent = \`
    #promo-overlay {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 9999;
      padding: 26px 34px 30px;
      background: linear-gradient(to top, rgba(8,10,15,.94) 0%, rgba(8,10,15,.78) 55%, rgba(8,10,15,0) 100%);
      pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #promo-overlay .pw { display: flex; gap: 14px; align-items: flex-start; }
    #promo-overlay .bar { width: 3px; border-radius: 2px; background: #4f8cff; align-self: stretch; }
    #promo-overlay h1 { margin: 0; font-size: 27px; font-weight: 650; color: #f2f5fa; letter-spacing: -.015em; }
    #promo-overlay p  { margin: 5px 0 0; font-size: 16px; color: #a7b0c2; font-weight: 450; }
    #promo-overlay.in .pw { animation: promoIn .5s cubic-bezier(.16,1,.3,1) both; }
    @keyframes promoIn { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: none; } }
    #promo-overlay.hidden { opacity: 0; }
  \`;
  document.head.appendChild(css);
  const el = document.createElement('div');
  el.id = 'promo-overlay';
  el.innerHTML = '<div class="pw"><div class="bar"></div><div><h1></h1><p></p></div></div>';
  document.body.appendChild(el);
  window.__caption = (title, sub) => {
    const o = document.getElementById('promo-overlay');
    if (title === null) { o.classList.add('hidden'); return; }
    o.classList.remove('hidden');
    o.querySelector('h1').textContent = title;
    o.querySelector('p').textContent = sub || '';
    o.classList.remove('in'); void o.offsetWidth; o.classList.add('in');
  };
  return 'installed';
})()`;

/** Deterministic demo state: app seed, with volunteers renamed. */
const SEED_DEMO = `(() => {
  localStorage.removeItem('cnda-planner:v1');
  return 'cleared';
})()`;

const RENAME_VOLUNTEERS = `(() => {
  const k = 'cnda-planner:v1';
  const s = JSON.parse(localStorage.getItem(k));
  const demo = ${JSON.stringify(DEMO_VOLUNTEERS)};
  let i = 0;
  s.people = s.people.map(p => p.isOrganizer ? p : { ...p, name: demo[i++] ?? p.name, notes: undefined });
  s.assignments = [];
  localStorage.setItem(k, JSON.stringify(s));
  return s.people.filter(p => !p.isOrganizer).map(p => p.name).join(', ');
})()`;

const click = (text, scope = 'body') =>
  `(() => { const b=[...document.querySelectorAll('${scope} button')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(
    text,
  )})); if(!b) throw new Error('button not found: '+${JSON.stringify(text)}); b.click(); return 'ok'; })()`;

/** A synthetic registration CSV: shows the PII columns being dropped, with no real data. */
const SYNTHETIC_CSV = [
  'Timestamp,Email address,Name,Address,Date of birth,Phone number,Can we add you to a WhatsApp group with all the volunteers to communicate during the conference days?,I can help on the following days,I would like to help for more than one shift (one shift is approx. 4-5 hours),Additional comments',
  '2026-08-01 10:12:03,demo1@example.org,Rosa Feldner,"Demoweg 1, 8010 Graz",1994-03-11,+43 000 0000001,Yes,"Tuesday, 29th September, Wednesday, 30th September",Yes,',
  '2026-08-02 18:44:51,demo2@example.org,Emil Bauer,"Demoweg 2, 8020 Graz",1988-07-24,+43 000 0000002,Yes,"Monday 28th September (Afternoon, venue setup), Tuesday, 29th September",Yes,happy to do setup',
  '2026-08-03 09:05:17,demo3@example.org,Alma Winter,"Demoweg 3, 8010 Graz",1999-12-02,+43 000 0000003,No,"Wednesday, 30th September",No,',
].join('\n');

const STAGE_CSV = `(async () => {
  const csv = ${JSON.stringify(SYNTHETIC_CSV)};
  const file = new File([csv], 'Volunteer Registration (Responses).csv', { type: 'text/csv' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.querySelector('.dropzone input[type=file]');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  return 'staged';
})()`;

async function caption(title, sub) {
  await evaluate(`window.__caption(${JSON.stringify(title)}, ${JSON.stringify(sub ?? '')})`);
}

async function scene(title, sub, seconds, action) {
  if (action) await action();
  await caption(title, sub);
  await hold(seconds);
}

/* ------------------------------------------------------------------------ main */

let chrome;
try {
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${join(frameDir, 'profile')}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--force-color-profile=srgb',
      APP_URL,
    ],
    { stdio: 'ignore' },
  );

  await waitForCdp();
  const target = await firstPageTarget();

  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
  });

  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });

  // Clean demo state, then reload so React picks it up.
  await send(ws, 'Page.navigate', { url: APP_URL });
  await sleep(1800);
  await evaluate(SEED_DEMO);
  await send(ws, 'Page.reload', { ignoreCache: false });
  await sleep(1800);
  const names = await evaluate(RENAME_VOLUNTEERS);
  console.log('demo volunteers:', names);
  await send(ws, 'Page.reload', { ignoreCache: false });
  await sleep(2000);
  await evaluate(INSTALL_OVERLAY);

  console.log('recording…');

  await scene(
    'CND Austria — Volunteer Planner',
    'Shift planning for a three-day conference',
    3.2,
  );

  await scene('Every task, every day, at a glance', '30 tasks · 63 open slots · 18 people', 3.0);

  await scene(
    'Manage who is available',
    'Days, shift limits and preferences — read straight from the registration form',
    4.0,
    async () => {
      await evaluate(click('People', '.tabs'));
      await sleep(500);
    },
  );

  await scene('Rules you control', 'One shift per day · all-hands tasks exempt · volunteers first', 4.0, async () => {
    await evaluate(click('Board', '.tabs'));
    await sleep(300);
    await evaluate(click('Rules', '.topbar'));
  });

  await scene('One click fills every open slot', 'Best of 400 randomised runs', 3.6, async () => {
    await evaluate(click('Close', '.modal'));
    await sleep(400);
    await evaluate(click('Assign open tasks', '.topbar'));
    await sleep(500);
  });

  await scene('Nothing is applied until you say so', 'Uncheck anything you disagree with', 3.2, () =>
    evaluate(
      `(() => { const c=[...document.querySelectorAll('.prop-row input[type=checkbox]')]; c[3].click(); c[7].click(); return 'unchecked'; })()`,
    ),
  );

  await scene('It tells you what it could not do', 'Monday setup is short — nobody registered for it', 3.4, () =>
    evaluate(
      `(() => { const b=document.querySelector('.modal .body'); b.scrollTop = b.scrollHeight; return 'scrolled'; })()`,
    ),
  );

  await scene('Accepted', 'Tuesday and Wednesday fully staffed', 3.4, async () => {
    await evaluate(
      `(() => { const b=document.querySelector('.modal .body'); b.scrollTop = 0; return 'top'; })()`,
    );
    await sleep(300);
    await evaluate(click('Accept', '.modal footer'));
    await sleep(600);
  });

  await scene('Balanced by design', 'Shift count first, hours as the tie-break', 4.0, async () => {
    await evaluate(click('Warnings & Balance', '.tabs'));
    await sleep(500);
    await evaluate(`(() => { document.querySelector('.content').scrollTop = 300; return 'ok'; })()`);
  });

  await scene('Who works when, per person', 'Derived from the plan — never stale', 3.6, () =>
    evaluate(`(() => { document.querySelector('.content').scrollTop = 1500; return 'ok'; })()`),
  );

  await scene('Override anything', 'Rule-breaking assignments are offered, with the reason', 3.8, async () => {
    await evaluate(`(() => { document.querySelector('.content').scrollTop = 0; return 'ok'; })()`);
    await evaluate(click('Board', '.tabs'));
    await sleep(500);
    await evaluate(
      `(() => { const card=[...document.querySelectorAll('.task-card')].find(c=>c.textContent.includes('Room 4 Help morning')); [...card.querySelectorAll('button')].find(b=>b.textContent.includes('assign someone')).click(); return 'ok'; })()`,
    );
    await sleep(500);
  });

  await scene('It warns — it never blocks', 'You stay in charge; the plan flags the consequence', 3.8, async () => {
    await evaluate(
      `(() => { const c=[...document.querySelectorAll('.candidate')].find(x=>!x.disabled && x.textContent.includes('—')); c.click(); return 'ok'; })()`,
    );
    await sleep(600);
  });

  await scene('Every breach spelled out', 'Over-committed people, unfilled slots, double bookings', 3.8, async () => {
    await evaluate(click('Warnings & Balance', '.tabs'));
    await sleep(500);
  });

  await scene('Import straight from Google Sheets', '.xlsx and .csv, parsed in the browser', 3.8, async () => {
    await evaluate(click('Board', '.tabs'));
    await sleep(300);
    await evaluate(click('Import', '.topbar'));
    await sleep(500);
    await evaluate(STAGE_CSV, true);
  });

  await scene(
    'Personal data never gets stored',
    'Address, date of birth and phone are dropped at the file boundary',
    4.2,
    () => evaluate(`(() => { const b=document.querySelector('.modal .body'); b.scrollTop = 260; return 'ok'; })()`),
  );

  await scene('No server. No accounts.', 'Everything stays in your browser — CSV and JSON export when you need it', 4.0, async () => {
    await evaluate(click('Close', '.modal'));
    await sleep(500);
  });

  // Clean full-screen end card rather than a caption over the board.
  await evaluate(`(() => {
    window.__caption(null);
    const el = document.createElement('div');
    el.id = 'promo-end';
    el.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#0f1117;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;animation:promoFade .6s ease both';
    el.innerHTML =
      '<div style="font-size:40px;font-weight:650;color:#f2f5fa;letter-spacing:-.02em">Volunteer Planner</div>' +
      '<div style="font-size:19px;color:#a7b0c2">Cloud Native Days Austria · 28–30 September 2026</div>' +
      '<div style="margin-top:18px;font-family:ui-monospace,Menlo,monospace;font-size:15px;color:#4f8cff;background:#171a23;border:1px solid #2a2f3d;border-radius:7px;padding:9px 16px">npm run dev</div>' +
      '<div style="margin-top:10px;font-size:13px;color:#6b7385">No server · no accounts · your data stays in your browser</div>';
    const s = document.createElement('style');
    s.textContent = '@keyframes promoFade{from{opacity:0}to{opacity:1}}';
    document.head.appendChild(s);
    document.body.appendChild(el);
    return 'end card';
  })()`);
  await hold(3.6);

  console.log(`captured ${frames.length} frames`);

  /* --------------------------------------------------------------- encode */

  const list = frames
    .map((f, i) => {
      const next = frames[i + 1];
      const dur = next ? Math.max(0.04, (next.t - f.t) / 1000) : 0.5;
      return `file '${f.file}'\nduration ${dur.toFixed(3)}`;
    })
    .join('\n');
  const listFile = join(frameDir, 'frames.txt');
  writeFileSync(listFile, `${list}\nfile '${frames[frames.length - 1].file}'\n`);

  const outW = Math.round((WIDTH * SCALE) / 2) * 2;
  const outH = Math.round((HEIGHT * SCALE) / 2) * 2;

  const ff = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-vf', `fps=30,scale=${outW}:${outH}:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '20',
      '-movflags', '+faststart',
      OUT,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );
  if (ff.status !== 0) {
    console.error(ff.stderr?.split('\n').slice(-25).join('\n'));
    throw new Error('ffmpeg failed');
  }
  console.log(`wrote ${OUT} (${outW}x${outH})`);
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  chrome?.kill();
  await sleep(500);
  rmSync(frameDir, { recursive: true, force: true });
}
