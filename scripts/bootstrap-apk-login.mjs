#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CHATGPT_PACKAGE = process.env.CHATGPT_ANDROID_PACKAGE || 'com.openai.chatgpt';
const CHROME_PACKAGE = process.env.CHATGPT_ANDROID_CHROME_PACKAGE || 'com.android.chrome';
const SERIAL = process.env.ANDROID_SERIAL || '';
const CDP_PORT = Number(process.env.CHATGPT_ANDROID_CHROME_CDP_PORT || 9222);
const SESSION_B64 = process.env.CHATGPT_SESSION_COOKIES_B64 || '';
const DIAGNOSTICS_DIR = resolve(process.env.CHATGPT_ANDROID_DIAGNOSTICS_DIR || './android-apk-diagnostics');
const TRACE_PATH = resolve(process.env.CHATGPT_ANDROID_TRACE_PATH || `${DIAGNOSTICS_DIR}/trace.jsonl`);

mkdirSync(DIAGNOSTICS_DIR, { recursive: true, mode: 0o700 });
mkdirSync(dirname(TRACE_PATH), { recursive: true, mode: 0o700 });

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

function trace(stage, detail = {}) {
  const row = { at: new Date().toISOString(), stage, ...detail };
  appendFileSync(TRACE_PATH, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  process.stdout.write(`[android-apk-login] ${stage} ${JSON.stringify(detail)}\n`);
}

function run(binary, args, timeout = 30_000, encoding = 'utf8') {
  const result = spawnSync(binary, args, {
    encoding,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

function adb(args, timeout = 30_000, encoding = 'utf8') {
  const prefix = SERIAL ? ['-s', SERIAL] : [];
  return run(process.env.CHATGPT_ANDROID_ADB || 'adb', [...prefix, ...args], timeout, encoding);
}

function adbShell(args, timeout = 30_000) {
  return adb(['shell', ...args], timeout);
}

function packageInstalled(packageName) {
  const result = adbShell(['pm', 'path', packageName]);
  return result.ok && String(result.stdout || '').includes('package:');
}

function foregroundPackage() {
  const result = adbShell(['dumpsys', 'window', 'windows']);
  const text = result.ok ? String(result.stdout || '') : '';
  return text.match(/mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9._]+)\//)?.[1]
    || text.match(/mFocusedApp=.*\s([A-Za-z0-9._]+)\//)?.[1]
    || null;
}

function captureScreenshot(label) {
  const result = adb(['exec-out', 'screencap', '-p'], 20_000, null);
  if (!result.ok || !Buffer.isBuffer(result.stdout) || !result.stdout.length) return null;
  const path = resolve(DIAGNOSTICS_DIR, `${label}.png`);
  writeFileSync(path, result.stdout, { mode: 0o600 });
  trace('screenshot', { label, bytes: result.stdout.length, foregroundPackage: foregroundPackage() });
  return path;
}

function decodeXml(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function dumpNodes() {
  const remote = `/sdcard/chatgpt-bootstrap-${process.pid}.xml`;
  const dump = adbShell(['uiautomator', 'dump', remote], 20_000);
  if (!dump.ok) return [];
  const read = adb(['exec-out', 'cat', remote], 20_000);
  void adbShell(['rm', '-f', remote]);
  if (!read.ok) return [];
  const nodes = [];
  for (const match of String(read.stdout || '').matchAll(/<node\b([^>]*)\/?>(?:<\/node>)?/g)) {
    const attrs = new Map();
    for (const attr of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs.set(attr[1], decodeXml(attr[2]));
    }
    const bounds = String(attrs.get('bounds') || '').match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    nodes.push({
      text: attrs.get('text') || '',
      description: attrs.get('content-desc') || '',
      resourceId: attrs.get('resource-id') || '',
      className: attrs.get('class') || '',
      packageName: attrs.get('package') || '',
      enabled: attrs.get('enabled') !== 'false',
      editable: attrs.get('editable') === 'true' || String(attrs.get('class') || '').includes('EditText'),
      bounds: bounds ? [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])] : null,
    });
  }
  return nodes;
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function labelMatch(node, labels, contains = true) {
  const values = [normalize(node.text), normalize(node.description)].filter(Boolean);
  return labels.some(label => values.some(value => contains
    ? value.includes(normalize(label))
    : value === normalize(label)));
}

function tapNode(node) {
  if (!node?.bounds) return false;
  const [x1, y1, x2, y2] = node.bounds;
  const result = adbShell([
    'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)),
  ]);
  return result.ok;
}

async function clickKnown(labels, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const node = dumpNodes().find(item => item.enabled && item.bounds && labelMatch(item, labels));
    if (node && tapNode(node)) {
      trace('ui-click', {
        labels,
        attempt,
        packageName: node.packageName || null,
        className: node.className || null,
      });
      await sleep(700);
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function dismissChromeFirstRun() {
  if (foregroundPackage() !== CHROME_PACKAGE) return 0;
  const acceptLabels = [
    'Accept & continue', 'Accept and continue', 'Agree & continue',
    '接受并继续', '接受並繼續', '同意并继续', '同意並繼續',
  ];
  const skipLabels = [
    'Use without an account', 'Continue without an account',
    'No thanks', 'Not now', 'Skip',
    '不使用账号', '不使用帳號', '不用账号', '不用帳號',
    '暂不', '暫不', '跳过', '跳過',
  ];
  let clicks = 0;
  for (let round = 0; round < 6; round += 1) {
    if (foregroundPackage() !== CHROME_PACKAGE) break;
    const accepted = await clickKnown(acceptLabels, 1);
    if (accepted) clicks += 1;
    const skipped = await clickKnown(skipLabels, 1);
    if (skipped) clicks += 1;
    if (!accepted && !skipped) break;
    await sleep(500);
  }
  if (clicks > 0) trace('chrome-first-run-cleared', { clicks });
  return clicks;
}

function apkSurface() {
  const nodes = dumpNodes();
  const loginLabels = [
    'Log in', 'Sign in', 'Sign up', 'Log in or sign up',
    '登录', '登入', '注册', '註冊',
  ];
  const asksForLogin = nodes.some(node => labelMatch(node, loginLabels));
  const hasComposer = nodes.some(node => node.editable)
    || nodes.some(node => /message|prompt|composer|ask chatgpt|发送消息|傳送訊息/i.test(
      `${node.text} ${node.description} ${node.resourceId}`,
    ));
  return {
    foregroundPackage: foregroundPackage(),
    asksForLogin,
    hasComposer,
    nodeCount: nodes.length,
    authenticated: foregroundPackage() === CHATGPT_PACKAGE && !asksForLogin && hasComposer,
  };
}

function decodeCookies() {
  if (!SESSION_B64.trim()) throw new Error('CHATGPT_SESSION_COOKIES_B64 is empty');
  const parsed = JSON.parse(Buffer.from(SESSION_B64.trim(), 'base64').toString('utf8'));
  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const normalized = cookies.flatMap(cookie => {
    const domain = String(cookie?.domain || '');
    const lower = domain.toLowerCase().replace(/^\./, '');
    const allowed = lower === 'chatgpt.com' || lower.endsWith('.chatgpt.com')
      || lower === 'openai.com' || lower.endsWith('.openai.com');
    if (!allowed || !cookie?.name || !cookie?.value) return [];
    const item = {
      name: String(cookie.name),
      value: String(cookie.value),
      domain,
      path: String(cookie.path || '/'),
      secure: cookie.secure !== false,
      httpOnly: cookie.httpOnly === true,
    };
    if (['Strict', 'Lax', 'None'].includes(cookie.sameSite)) item.sameSite = cookie.sameSite;
    if (Number(cookie.expires) > 0) item.expires = Number(cookie.expires);
    return [item];
  });
  if (!normalized.length) throw new Error('No ChatGPT/OpenAI cookies were decoded');
  trace('credential-decoded', {
    cookieCount: normalized.length,
    domains: [...new Set(normalized.map(cookie => cookie.domain.toLowerCase().replace(/^\./, '')))].length,
  });
  return normalized;
}

async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome CDP connect timeout')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolvePromise(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome CDP connect failed')); }, { once: true });
  });
  let sequence = 0;
  const call = (method, params = {}, timeout = 20_000) => new Promise((resolvePromise, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error(`${method} timeout`));
    }, timeout);
    const onMessage = event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(`${method} failed`));
      else resolvePromise(message.result || {});
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, call };
}

async function waitForAuthTarget(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        const targets = await response.json();
        lastCount = targets.length;
        const pages = targets.filter(item => item.type === 'page' && item.webSocketDebuggerUrl);
        const target = pages.find(item => /openai|chatgpt|auth/i.test(String(item.url || '')))
          || pages.at(-1);
        if (target) return target;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`No browser auth target was exposed; targetCount=${lastCount}`);
}

async function injectIntoCurrentAuthFlow(cookies) {
  const forward = adb(['forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote']);
  if (!forward.ok) throw new Error(String(forward.stderr || '').trim() || 'Unable to forward Chrome CDP');
  const target = await waitForAuthTarget();
  const url = String(target.url || '');
  trace('auth-browser-target', {
    scheme: url.split(':')[0] || null,
    hostClass: /openai\.com/i.test(url) ? 'openai.com' : /chatgpt\.com/i.test(url) ? 'chatgpt.com' : 'other',
  });
  const connection = await connectCdp(target.webSocketDebuggerUrl);
  try {
    await connection.call('Network.enable');
    const set = await connection.call('Network.setCookies', { cookies });
    if (set?.success === false) throw new Error('Chrome rejected restored cookies');
    trace('auth-cookies-restored', { cookieCount: cookies.length });
    await connection.call('Page.reload', { ignoreCache: true }, 20_000);
  } finally {
    connection.socket.close();
  }
}

async function waitForApkReturn(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  const continueLabels = [
    'Continue', 'Continue to ChatGPT', 'Open ChatGPT', 'Open',
    '继续', '繼續', '打开 ChatGPT', '開啟 ChatGPT', '打开', '開啟',
  ];
  let lastForeground = null;
  while (Date.now() < deadline) {
    lastForeground = foregroundPackage();
    if (lastForeground === CHATGPT_PACKAGE) {
      const surface = apkSurface();
      if (surface.authenticated) return surface;
    } else if (lastForeground === CHROME_PACKAGE || lastForeground === 'com.google.android.gms') {
      await clickKnown(continueLabels, 1).catch(() => false);
    }
    await sleep(1_500);
  }
  return { ...apkSurface(), lastForeground };
}

export async function bootstrapApkLogin() {
  trace('start', {
    packageName: CHATGPT_PACKAGE,
    browserPackage: CHROME_PACKAGE,
    serialConfigured: Boolean(SERIAL),
  });
  if (!packageInstalled(CHATGPT_PACKAGE)) {
    return { ok: false, errorCode: 'chatgpt_apk_missing' };
  }
  if (!packageInstalled(CHROME_PACKAGE)) {
    return { ok: false, errorCode: 'chrome_missing_for_official_login_flow' };
  }

  const launch = adbShell(['monkey', '-p', CHATGPT_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1']);
  if (!launch.ok) return { ok: false, errorCode: 'chatgpt_apk_launch_failed' };
  await sleep(2_000);

  const initial = apkSurface();
  trace('apk-initial-surface', initial);
  captureScreenshot(initial.authenticated ? 'apk-already-authenticated' : 'apk-login-required');
  if (initial.authenticated) return { ok: true, reusedExistingApkState: true, surface: initial };

  const clicked = await clickKnown([
    'Log in or sign up', 'Log in', 'Sign in',
    '登录或注册', '登入或註冊', '登录', '登入',
  ], 6);
  if (!clicked) return { ok: false, errorCode: 'apk_login_control_not_found', surface: initial };

  const browserDeadline = Date.now() + 30_000;
  while (Date.now() < browserDeadline) {
    const foreground = foregroundPackage();
    if (foreground === CHROME_PACKAGE || foreground === 'com.google.android.gms') break;
    await sleep(500);
  }
  if (foregroundPackage() === CHROME_PACKAGE) {
    await dismissChromeFirstRun();
  }
  trace('apk-login-flow-opened', { foregroundPackage: foregroundPackage() });
  captureScreenshot('apk-login-browser-opened');

  const cookies = decodeCookies();
  await injectIntoCurrentAuthFlow(cookies);
  const surface = await waitForApkReturn();
  trace('apk-login-return', surface);
  captureScreenshot(surface.authenticated ? 'apk-login-success' : 'apk-login-failed');

  return {
    ok: surface.authenticated === true,
    errorCode: surface.authenticated ? null : 'apk_login_restore_failed',
    reusedExistingApkState: false,
    surface,
  };
}

try {
  const result = await bootstrapApkLogin();
  trace('complete', { ok: result.ok === true, errorCode: result.errorCode || null });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok !== true) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  trace('fatal', { message });
  process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'apk_login_bootstrap_failed', message })}\n`);
  process.exitCode = 1;
}
