#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CHATGPT_PACKAGE = process.env.CHATGPT_ANDROID_PACKAGE || 'com.openai.chatgpt';
const SERIAL = process.env.ANDROID_SERIAL || '';
const DIAGNOSTICS_DIR = resolve(process.env.CHATGPT_ANDROID_DIAGNOSTICS_DIR || './android-apk-diagnostics');
const TRACE_PATH = resolve(process.env.CHATGPT_ANDROID_TRACE_PATH || `${DIAGNOSTICS_DIR}/trace.jsonl`);

mkdirSync(DIAGNOSTICS_DIR, { recursive: true, mode: 0o700 });
mkdirSync(dirname(TRACE_PATH), { recursive: true, mode: 0o700 });

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

function trace(stage, detail = {}) {
  const row = { at: new Date().toISOString(), stage, ...detail };
  appendFileSync(TRACE_PATH, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  process.stdout.write(`[android-apk] ${stage} ${JSON.stringify(detail)}\n`);
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

function installed() {
  const result = adbShell(['pm', 'path', CHATGPT_PACKAGE]);
  return result.ok && String(result.stdout || '').includes('package:');
}

function currentPackage() {
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
  trace('screenshot', { label, bytes: result.stdout.length });
  return path;
}

function capturePackageLogcat() {
  const pidResult = adbShell(['pidof', CHATGPT_PACKAGE]);
  const pid = pidResult.ok ? String(pidResult.stdout || '').trim().split(/\s+/)[0] : '';
  if (!/^\d+$/.test(pid)) return null;
  const logResult = adb(['logcat', '-d', '-v', 'threadtime', '--pid', pid], 20_000);
  if (!logResult.ok) return null;
  const raw = String(logResult.stdout || '');
  const path = resolve(DIAGNOSTICS_DIR, 'chatgpt-logcat.txt');
  writeFileSync(path, raw, { mode: 0o600 });
  trace('logcat-captured', { lines: raw.split(/\r?\n/).filter(Boolean).length });
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

export function parseUiSummary(xml) {
  let nodeCount = 0;
  let editableCount = 0;
  let loginControlCount = 0;
  let composerHintCount = 0;
  const loginLabels = /(log in|sign in|sign up|登录|登入|注册|註冊)/i;
  const composerHints = /(message|prompt|composer|ask chatgpt|发送消息|傳送訊息|消息)/i;

  for (const match of String(xml || '').matchAll(/<node\b([^>]*)\/?>(?:<\/node>)?/g)) {
    nodeCount += 1;
    const attrs = new Map();
    for (const attr of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs.set(attr[1], decodeXml(attr[2]));
    }
    const text = `${attrs.get('text') || ''} ${attrs.get('content-desc') || ''}`.trim();
    const className = attrs.get('class') || '';
    const resourceId = attrs.get('resource-id') || '';
    const editable = attrs.get('editable') === 'true' || className.includes('EditText');
    if (editable) editableCount += 1;
    if (loginLabels.test(text)) loginControlCount += 1;
    if (composerHints.test(`${text} ${resourceId}`)) composerHintCount += 1;
  }

  return {
    nodeCount,
    editableCount,
    loginControlCount,
    composerHintCount,
    asksForLogin: loginControlCount > 0,
    hasComposer: editableCount > 0 || composerHintCount > 0,
  };
}

function dumpUiSummary() {
  const remote = `/sdcard/chatgpt-apk-${process.pid}.xml`;
  const dump = adbShell(['uiautomator', 'dump', remote], 20_000);
  if (!dump.ok) return { ok: false, error: 'uiautomator_dump_failed' };
  const read = adb(['exec-out', 'cat', remote], 20_000);
  void adbShell(['rm', '-f', remote]);
  if (!read.ok || !String(read.stdout || '').includes('<hierarchy')) {
    return { ok: false, error: 'uiautomator_read_failed' };
  }
  return { ok: true, ...parseUiSummary(String(read.stdout || '')) };
}

export async function verifyApkSession() {
  trace('start', { packageName: CHATGPT_PACKAGE, serialConfigured: Boolean(SERIAL) });
  if (!installed()) {
    const result = {
      ok: false,
      errorCode: 'chatgpt_apk_missing',
      packageName: CHATGPT_PACKAGE,
    };
    trace('complete', result);
    return result;
  }

  const launch = adbShell([
    'monkey', '-p', CHATGPT_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1',
  ], 30_000);
  if (!launch.ok) {
    const result = { ok: false, errorCode: 'chatgpt_apk_launch_failed' };
    trace('complete', result);
    return result;
  }

  await sleep(2_500);
  const foregroundPackage = currentPackage();
  const ui = dumpUiSummary();
  const authenticated = ui.ok === true
    && ui.asksForLogin === false
    && ui.hasComposer === true
    && foregroundPackage === CHATGPT_PACKAGE;

  captureScreenshot(authenticated ? 'apk-authenticated' : 'apk-session-invalid');
  capturePackageLogcat();

  const result = {
    ok: authenticated,
    errorCode: authenticated ? null : 'apk_session_not_authenticated',
    packageName: CHATGPT_PACKAGE,
    foregroundPackage,
    ui,
  };
  trace('complete', result);
  return result;
}

try {
  const result = await verifyApkSession();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok !== true) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  trace('fatal', { message });
  process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'apk_session_probe_failed', message })}\n`);
  process.exitCode = 1;
}
