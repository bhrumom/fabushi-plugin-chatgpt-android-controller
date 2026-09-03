import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const CHATGPT_PACKAGE = process.env.CHATGPT_ANDROID_PACKAGE || 'com.openai.chatgpt';
const DEFAULT_APPIUM_URL = process.env.CHATGPT_ANDROID_APPIUM_URL || 'http://127.0.0.1:4723';
const DEFAULT_STATE_FILE = process.env.CHATGPT_ANDROID_CONTROLLER_STATE
  || join(homedir(), '.mahayana', 'chatgpt-android-controller', 'state.json');
const DEFAULT_AUDIT_FILE = process.env.CHATGPT_ANDROID_CONTROLLER_AUDIT
  || join(dirname(DEFAULT_STATE_FILE), 'audit.log');

export type UiNode = {
  text: string;
  description: string;
  resourceId: string;
  className: string;
  packageName: string;
  clickable: boolean;
  enabled: boolean;
  editable: boolean;
  bounds: [number, number, number, number] | null;
};

type DeviceRecord = {
  id: string;
  label: string;
  serial: string;
  isDefault: boolean;
  status: string;
  createdAt: string;
  lastSeenAt?: string;
};

type QueueTask = {
  id: string;
  title: string;
  prompt: string;
  deviceId?: string;
  connector?: string;
  dependsOn: string[];
  priority: number;
  timeout: number;
  revision: number;
  directive?: string;
  status: string;
  reviewStatus?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  feedback?: string;
  lastError?: string;
  lastReply?: unknown;
};

type PersistedState = {
  version: number;
  devices: DeviceRecord[];
  watcher: {
    enabled: boolean;
    approveAll: boolean;
    intervalMs: number;
    deviceId?: string;
  };
  queuePaused: boolean;
  tasks: QueueTask[];
  audit: Array<Record<string, unknown>>;
};

const emptyState = (): PersistedState => ({
  version: 1,
  devices: [],
  watcher: { enabled: false, approveAll: true, intervalMs: 750 },
  queuePaused: false,
  tasks: [],
  audit: [],
});

function now(): string {
  return new Date().toISOString();
}

function safeJsonParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function loadState(): PersistedState {
  if (!existsSync(DEFAULT_STATE_FILE)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(DEFAULT_STATE_FILE, 'utf8')) as Partial<PersistedState>;
    return {
      ...emptyState(),
      ...parsed,
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
      watcher: { ...emptyState().watcher, ...(parsed.watcher || {}) },
    };
  } catch {
    return emptyState();
  }
}

function saveState(state: PersistedState): void {
  mkdirSync(dirname(DEFAULT_STATE_FILE), { recursive: true });
  const temp = `${DEFAULT_STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, DEFAULT_STATE_FILE);
}

function appendAudit(state: PersistedState, event: Record<string, unknown>): void {
  const row = { at: now(), ...event };
  state.audit.push(row);
  if (state.audit.length > 200) state.audit.splice(0, state.audit.length - 200);
  mkdirSync(dirname(DEFAULT_AUDIT_FILE), { recursive: true });
  appendFileSync(DEFAULT_AUDIT_FILE, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const nodeRegex = /<node\b([^>]*)\/?>(?:<\/node>)?/g;
  for (const match of xml.matchAll(nodeRegex)) {
    const attributes = new Map<string, string>();
    for (const attr of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attributes.set(attr[1], decodeXml(attr[2]));
    }
    const rawBounds = attributes.get('bounds') || '';
    const boundMatch = rawBounds.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    nodes.push({
      text: attributes.get('text') || '',
      description: attributes.get('content-desc') || '',
      resourceId: attributes.get('resource-id') || '',
      className: attributes.get('class') || '',
      packageName: attributes.get('package') || '',
      clickable: attributes.get('clickable') === 'true',
      enabled: attributes.get('enabled') !== 'false',
      editable: attributes.get('class')?.includes('EditText') === true
        || attributes.get('editable') === 'true',
      bounds: boundMatch
        ? [Number(boundMatch[1]), Number(boundMatch[2]), Number(boundMatch[3]), Number(boundMatch[4])]
        : null,
    });
  }
  return nodes;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function labelsMatch(node: UiNode, labels: string[]): boolean {
  const text = normalize(node.text);
  const description = normalize(node.description);
  return labels.some((label) => {
    const wanted = normalize(label);
    return text === wanted || description === wanted;
  });
}

export function findSemanticNode(nodes: UiNode[], labels: string[]): UiNode | undefined {
  return nodes.find((node) => node.enabled && node.bounds && labelsMatch(node, labels));
}

function findContainsNode(nodes: UiNode[], labels: string[]): UiNode | undefined {
  return nodes.find((node) => {
    if (!node.enabled || !node.bounds) return false;
    const text = normalize(node.text);
    const description = normalize(node.description);
    return labels.some((label) => {
      const wanted = normalize(label);
      return text.includes(wanted) || description.includes(wanted);
    });
  });
}

function center(node: UiNode): [number, number] {
  if (!node.bounds) throw new Error('UI node has no bounds');
  return [
    Math.round((node.bounds[0] + node.bounds[2]) / 2),
    Math.round((node.bounds[1] + node.bounds[3]) / 2),
  ];
}

function adbBinary(): string {
  return process.env.CHATGPT_ANDROID_ADB || 'adb';
}

type CommandResult = { ok: boolean; stdout: string; stderr: string; status: number | null };

function run(binary: string, args: string[], timeout = 30_000): CommandResult {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error || ''),
    status: result.status,
  };
}

function adb(args: string[], serial?: string, timeout = 30_000): CommandResult {
  return run(adbBinary(), serial ? ['-s', serial, ...args] : args, timeout);
}

function adbShell(serial: string, args: string[], timeout = 30_000): CommandResult {
  return adb(['shell', ...args], serial, timeout);
}

export function listConnectedDevices(): Array<{ serial: string; model?: string; transport?: string }> {
  const result = adb(['devices', '-l']);
  if (!result.ok) return [];
  return result.stdout.split(/\r?\n/).slice(1).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('\tdevice')) return [];
    const [serial] = trimmed.split(/\s+/);
    const model = trimmed.match(/\bmodel:([^\s]+)/)?.[1];
    const transport = trimmed.match(/\btransport_id:([^\s]+)/)?.[1];
    return [{ serial, model, transport }];
  });
}

function ensureAdbDevice(serial: string): void {
  const connected = listConnectedDevices().some((device) => device.serial === serial);
  if (!connected) throw new Error(`Android device is not connected: ${serial}`);
}

function packageInstalled(serial: string): boolean {
  const result = adbShell(serial, ['pm', 'path', CHATGPT_PACKAGE]);
  return result.ok && result.stdout.includes('package:');
}

function launchChatGpt(serial: string): void {
  ensureAdbDevice(serial);
  if (!packageInstalled(serial)) {
    throw new Error(`ChatGPT Android package is not installed: ${CHATGPT_PACKAGE}`);
  }
  const result = adbShell(serial, ['monkey', '-p', CHATGPT_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1']);
  if (!result.ok) throw new Error(result.stderr.trim() || 'Unable to launch ChatGPT Android app');
}

function uiSourceViaAdb(serial: string): string {
  const remote = `/sdcard/mahayana-chatgpt-${process.pid}.xml`;
  const dump = adbShell(serial, ['uiautomator', 'dump', remote], 15_000);
  if (!dump.ok) throw new Error(dump.stderr.trim() || 'uiautomator dump failed');
  const cat = adb(['exec-out', 'cat', remote], serial, 15_000);
  void adbShell(serial, ['rm', '-f', remote]);
  if (!cat.ok || !cat.stdout.includes('<hierarchy')) {
    throw new Error(cat.stderr.trim() || 'Unable to read Android UI hierarchy');
  }
  return cat.stdout;
}

function tap(serial: string, node: UiNode): void {
  const [x, y] = center(node);
  const result = adbShell(serial, ['input', 'tap', String(x), String(y)]);
  if (!result.ok) throw new Error(result.stderr.trim() || 'ADB tap failed');
}

function foregroundInfo(serial: string): string {
  const result = adbShell(serial, ['dumpsys', 'window', 'windows']);
  return result.ok ? result.stdout : '';
}

function isChatGptForeground(serial: string): boolean {
  return foregroundInfo(serial).includes(CHATGPT_PACKAGE);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class AppiumClient {
  private sessions = new Map<string, string>();
  readonly baseUrl: string;

  constructor(baseUrl = DEFAULT_APPIUM_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async request(path: string, init: RequestInit = {}, timeout = 15_000): Promise<any> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeout),
    });
    const body = await response.text();
    const parsed = body ? safeJsonParse(body) : null;
    if (!response.ok) {
      const message = (parsed as any)?.value?.message || body || `Appium HTTP ${response.status}`;
      throw new Error(String(message));
    }
    return parsed;
  }

  async available(): Promise<boolean> {
    try {
      await this.request('/status', { method: 'GET' }, 2_000);
      return true;
    } catch {
      return false;
    }
  }

  async session(serial: string): Promise<string> {
    const cached = this.sessions.get(serial);
    if (cached) return cached;
    const body = await this.request('/session', {
      method: 'POST',
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            platformName: 'Android',
            'appium:automationName': 'UiAutomator2',
            'appium:udid': serial,
            'appium:appPackage': CHATGPT_PACKAGE,
            'appium:noReset': true,
            'appium:dontStopAppOnReset': true,
            'appium:newCommandTimeout': 3600,
          },
          firstMatch: [{}],
        },
      }),
    }, 60_000);
    const sessionId = String((body as any)?.value?.sessionId || (body as any)?.sessionId || '');
    if (!sessionId) throw new Error('Appium did not return a session id');
    this.sessions.set(serial, sessionId);
    return sessionId;
  }

  async source(serial: string): Promise<string> {
    const sessionId = await this.session(serial);
    const body = await this.request(`/session/${sessionId}/source`, { method: 'GET' });
    return String((body as any)?.value || '');
  }

  async findElements(serial: string, using: string, value: string): Promise<string[]> {
    const sessionId = await this.session(serial);
    const body = await this.request(`/session/${sessionId}/elements`, {
      method: 'POST',
      body: JSON.stringify({ using, value }),
    });
    const items = Array.isArray((body as any)?.value) ? (body as any).value : [];
    return items.map((item: any) => String(
      item['element-6066-11e4-a52e-4f735466cecf'] || item.ELEMENT || '',
    )).filter(Boolean);
  }

  async click(serial: string, elementId: string): Promise<void> {
    const sessionId = await this.session(serial);
    await this.request(`/session/${sessionId}/element/${elementId}/click`, {
      method: 'POST', body: '{}',
    });
  }

  async setValue(serial: string, elementId: string, value: string): Promise<void> {
    const sessionId = await this.session(serial);
    await this.request(`/session/${sessionId}/element/${elementId}/clear`, {
      method: 'POST', body: '{}',
    }).catch(() => null);
    await this.request(`/session/${sessionId}/element/${elementId}/value`, {
      method: 'POST',
      body: JSON.stringify({ text: value, value: Array.from(value) }),
    });
  }

  async close(serial?: string): Promise<void> {
    const targets = serial
      ? [[serial, this.sessions.get(serial)] as const]
      : [...this.sessions.entries()];
    for (const [deviceSerial, sessionId] of targets) {
      if (!sessionId) continue;
      await this.request(`/session/${sessionId}`, { method: 'DELETE' }).catch(() => null);
      this.sessions.delete(deviceSerial);
    }
  }
}

const APPROVAL_LABELS = [
  'Allow once', '允许一次', '允許一次',
  'Allow', '允许', '允許',
];
const SEND_LABELS = [
  'Send', 'Send message', '发送', '发送消息', '傳送', '傳送訊息',
];
const STOP_LABELS = [
  'Stop', 'Stop generating', '停止', '停止生成', '停止產生',
];
const TOOL_MENU_LABELS = [
  'Tools', '工具', 'Apps', '应用', '應用程式', 'Connectors', '连接器', '連接器',
];

function publicDevice(device: DeviceRecord): Record<string, unknown> {
  return {
    id: device.id,
    label: device.label,
    serial: device.serial,
    isDefault: device.isDefault,
    status: device.status,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || null,
  };
}

function makeDeviceId(serial: string): string {
  const compact = Buffer.from(serial).toString('hex').slice(0, 12).padEnd(12, '0');
  return `acct_${compact}`;
}

function chooseEditable(nodes: UiNode[]): UiNode | undefined {
  return nodes.find((node) => node.enabled && node.bounds && node.editable)
    || nodes.find((node) => node.enabled && node.bounds
      && /prompt|message|composer/i.test(`${node.resourceId} ${node.description}`));
}

function visibleText(nodes: UiNode[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const node of nodes) {
    const value = (node.text || node.description).replace(/\s+/g, ' ').trim();
    if (!value || seen.has(value)) continue;
    if (node.packageName && node.packageName !== CHATGPT_PACKAGE) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

export class AndroidChatGptController {
  private state: PersistedState;
  private appium = new AppiumClient();
  private watcherTimer: NodeJS.Timeout | null = null;
  private queuePromise: Promise<void> | null = null;

  constructor() {
    this.state = loadState();
    if (this.state.watcher.enabled) this.state.watcher.enabled = false;
    for (const task of this.state.tasks) {
      if (task.status === 'running') {
        task.status = 'pending';
        task.lastError = 'controller restarted while task was running';
      }
    }
    saveState(this.state);
  }

  private persist(): void {
    saveState(this.state);
  }

  private audit(event: Record<string, unknown>): void {
    appendAudit(this.state, event);
    this.persist();
  }

  private resolveDevice(requested?: string): DeviceRecord {
    const connected = listConnectedDevices();
    for (const record of this.state.devices) {
      if (connected.some((device) => device.serial === record.serial)) {
        record.status = 'connected';
        record.lastSeenAt = now();
      } else {
        record.status = 'offline';
      }
    }
    this.persist();
    let record = requested
      ? this.state.devices.find((item) => item.id === requested || item.serial === requested)
      : this.state.devices.find((item) => item.isDefault);
    if (!record && connected.length === 1) {
      record = this.registerDevice(connected[0].serial, connected[0].model || connected[0].serial);
    }
    if (!record) throw new Error('没有可用 Android 设备；先连接设备并调用 account_add');
    ensureAdbDevice(record.serial);
    return record;
  }

  private registerDevice(serial: string, label: string): DeviceRecord {
    ensureAdbDevice(serial);
    let record = this.state.devices.find((item) => item.serial === serial);
    if (!record) {
      record = {
        id: makeDeviceId(serial),
        label: label.trim().slice(0, 80) || serial,
        serial,
        isDefault: this.state.devices.length === 0,
        status: 'connected',
        createdAt: now(),
        lastSeenAt: now(),
      };
      const duplicateId = this.state.devices.some((item) => item.id === record!.id);
      if (duplicateId) record.id = `acct_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      this.state.devices.push(record);
    } else {
      record.label = label.trim().slice(0, 80) || record.label;
      record.status = 'connected';
      record.lastSeenAt = now();
    }
    this.persist();
    return record;
  }

  private async source(serial: string): Promise<{ xml: string; driver: string }> {
    if (await this.appium.available()) {
      try {
        return { xml: await this.appium.source(serial), driver: 'appium-uiautomator2' };
      } catch {
        // Fall back to adb hierarchy for read/click operations.
      }
    }
    return { xml: uiSourceViaAdb(serial), driver: 'adb-uiautomator' };
  }

  private async nodes(serial: string): Promise<{ nodes: UiNode[]; driver: string }> {
    const source = await this.source(serial);
    return { nodes: parseUiNodes(source.xml), driver: source.driver };
  }

  async accountList(): Promise<Record<string, unknown>> {
    const connected = listConnectedDevices();
    for (const device of this.state.devices) {
      device.status = connected.some((item) => item.serial === device.serial) ? 'connected' : 'offline';
      if (device.status === 'connected') device.lastSeenAt = now();
    }
    this.persist();
    return { ok: true, accounts: this.state.devices.map(publicDevice), connected };
  }

  async accountAdd(args: Record<string, any>): Promise<Record<string, unknown>> {
    const connected = listConnectedDevices();
    const serial = String(args.serial || (connected.length === 1 ? connected[0].serial : '')).trim();
    if (!serial) {
      return { ok: false, errorCode: 'device_required', message: '检测到多个或零个设备，请传 serial' };
    }
    const model = connected.find((item) => item.serial === serial)?.model || serial;
    const record = this.registerDevice(serial, String(args.label || model));
    launchChatGpt(serial);
    await delay(1200);
    this.audit({ type: 'account_add', deviceId: record.id, serial });
    return {
      ok: true,
      account: publicDevice(record),
      loginMode: 'android-app-session',
      message: '设备已注册。ChatGPT 登录状态由该 Android 设备自身安全保存；如未登录，请在手机上完成一次登录。',
    };
  }

  async accountSwitch(args: Record<string, any>): Promise<Record<string, unknown>> {
    const requested = String(args.accountId || args.deviceId || args.serial || '');
    const record = this.resolveDevice(requested);
    for (const item of this.state.devices) item.isDefault = item.id === record.id;
    this.persist();
    return { ok: true, account: publicDevice(record) };
  }

  async accountRename(args: Record<string, any>): Promise<Record<string, unknown>> {
    const record = this.resolveDevice(String(args.accountId || args.deviceId || ''));
    const label = String(args.label || '').trim();
    if (!label) return { ok: false, errorCode: 'label_required', message: 'label 不能为空' };
    record.label = label.slice(0, 80);
    this.persist();
    return { ok: true, account: publicDevice(record) };
  }

  async accountStatus(args: Record<string, any>): Promise<Record<string, unknown>> {
    const record = this.resolveDevice(String(args.accountId || args.deviceId || ''));
    const installed = packageInstalled(record.serial);
    const appiumAvailable = await this.appium.available();
    return {
      ok: true,
      account: publicDevice(record),
      chatgptInstalled: installed,
      chatgptForeground: installed && isChatGptForeground(record.serial),
      appiumAvailable,
      credentialModel: 'device-owned-session',
    };
  }

  async accountRemove(args: Record<string, any>): Promise<Record<string, unknown>> {
    if (args.confirm !== true) {
      return { ok: false, errorCode: 'confirmation_required', message: '删除设备槽位必须传 confirm=true' };
    }
    const requested = String(args.accountId || args.deviceId || '');
    const index = this.state.devices.findIndex((item) => item.id === requested || item.serial === requested);
    if (index < 0) return { ok: false, errorCode: 'not_found', message: '设备槽位不存在' };
    const [removed] = this.state.devices.splice(index, 1);
    if (removed.isDefault && this.state.devices[0]) this.state.devices[0].isDefault = true;
    this.persist();
    await this.appium.close(removed.serial);
    return { ok: true, removed: publicDevice(removed) };
  }

  unsupportedCredentialTool(tool: string): Record<string, unknown> {
    return {
      ok: false,
      errorCode: 'android_app_sandbox',
      tool,
      message: 'Android 版不导出 ChatGPT Cookie/Token。登录会话保留在 ChatGPT App 沙箱内；GitHub Actions 应通过 self-hosted runner + ADB/Appium 控制该设备。',
    };
  }

  async diagnose(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const adbVersion = adb(['version']);
    const connected = listConnectedDevices();
    let selected: Record<string, unknown> | null = null;
    try {
      const record = this.resolveDevice(String(args.deviceId || args.serial || ''));
      selected = {
        ...publicDevice(record),
        chatgptInstalled: packageInstalled(record.serial),
        chatgptForeground: isChatGptForeground(record.serial),
      };
    } catch {
      selected = null;
    }
    return {
      ok: adbVersion.ok,
      runtime: 'typescript-node-adb-appium',
      adb: { ok: adbVersion.ok, version: adbVersion.stdout.split(/\r?\n/)[0] || null },
      appium: { available: await this.appium.available(), url: DEFAULT_APPIUM_URL },
      connected,
      selected,
      packageName: CHATGPT_PACKAGE,
    };
  }

  async scanOnce(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const record = this.resolveDevice(String(args.deviceId || args.accountId || args.serial || ''));
    if (!isChatGptForeground(record.serial)) launchChatGpt(record.serial);
    await delay(350);
    const snapshot = await this.nodes(record.serial);
    const approvals = snapshot.nodes.filter((node) => labelsMatch(node, APPROVAL_LABELS));
    let clicked = 0;
    for (const node of approvals) {
      if (!node.bounds) continue;
      tap(record.serial, node);
      clicked += 1;
      await delay(180);
    }
    if (clicked > 0) this.audit({ type: 'approval', deviceId: record.id, clicked, driver: snapshot.driver });
    return { ok: true, deviceId: record.id, serial: record.serial, found: approvals.length, clicked, driver: snapshot.driver };
  }

  async startWatcher(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const record = this.resolveDevice(String(args.deviceId || args.accountId || args.serial || ''));
    const intervalMs = Math.min(5000, Math.max(400, Number(args.intervalMs || 750)));
    this.state.watcher = {
      enabled: true,
      approveAll: args.approveAll !== false,
      intervalMs,
      deviceId: record.id,
    };
    this.persist();
    if (this.watcherTimer) clearInterval(this.watcherTimer);
    this.watcherTimer = setInterval(() => {
      void this.scanOnce({ deviceId: record.id }).catch((error) => {
        this.audit({ type: 'watcher_error', deviceId: record.id, message: String(error) });
      });
    }, intervalMs);
    this.watcherTimer.unref?.();
    return { ok: true, watcher: this.state.watcher, device: publicDevice(record) };
  }

  async stopWatcher(): Promise<Record<string, unknown>> {
    if (this.watcherTimer) clearInterval(this.watcherTimer);
    this.watcherTimer = null;
    this.state.watcher.enabled = false;
    this.persist();
    return { ok: true, watcher: this.state.watcher };
  }

  async status(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      watcher: this.state.watcher,
      queuePaused: this.state.queuePaused,
      queueRunning: this.queuePromise !== null,
      tasks: this.state.tasks.reduce((counts: Record<string, number>, task) => {
        counts[task.status] = (counts[task.status] || 0) + 1;
        return counts;
      }, {}),
      devices: this.state.devices.map(publicDevice),
    };
  }

  async auditLog(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));
    return { ok: true, events: this.state.audit.slice(-limit) };
  }

  private async appiumSetPrompt(serial: string, message: string): Promise<boolean> {
    if (!await this.appium.available()) return false;
    const candidates = [
      '//android.widget.EditText',
      '//*[@editable="true"]',
      '//*[contains(@resource-id,"prompt") or contains(@resource-id,"composer")]',
    ];
    for (const xpath of candidates) {
      try {
        const elements = await this.appium.findElements(serial, 'xpath', xpath);
        if (!elements.length) continue;
        await this.appium.setValue(serial, elements[elements.length - 1], message);
        return true;
      } catch {
        // Try the next selector.
      }
    }
    return false;
  }

  private async setPrompt(serial: string, message: string): Promise<string> {
    if (await this.appiumSetPrompt(serial, message)) return 'appium-uiautomator2';
    if (!/^[\x20-\x7E\n\r\t]*$/.test(message)) {
      throw new Error('Unicode 输入需要 Appium UiAutomator2；请启动 Appium 3 并安装 uiautomator2 driver');
    }
    const snapshot = await this.nodes(serial);
    const editable = chooseEditable(snapshot.nodes);
    if (!editable) throw new Error('未找到 ChatGPT 消息输入框');
    tap(serial, editable);
    const encoded = message.replace(/ /g, '%s').replace(/([&<>|;()$`\\"'])/g, '\\$1');
    const result = adbShell(serial, ['input', 'text', encoded]);
    if (!result.ok) throw new Error(result.stderr.trim() || 'ADB text input failed');
    return 'adb-input-text';
  }

  private async clickSend(serial: string): Promise<void> {
    const snapshot = await this.nodes(serial);
    const send = findSemanticNode(snapshot.nodes, SEND_LABELS)
      || findContainsNode(snapshot.nodes, SEND_LABELS)
      || snapshot.nodes.find((node) => /send/i.test(node.resourceId) && node.bounds && node.enabled);
    if (!send) throw new Error('未找到 ChatGPT 发送按钮');
    tap(serial, send);
  }

  async addConnector(args: Record<string, any>): Promise<Record<string, unknown>> {
    const connector = String(args.connector || args.name || '').trim();
    if (!connector) return { ok: false, errorCode: 'connector_required', message: 'connector 不能为空' };
    const record = this.resolveDevice(String(args.deviceId || args.accountId || args.serial || ''));
    launchChatGpt(record.serial);
    await delay(500);
    let snapshot = await this.nodes(record.serial);
    const menu = findSemanticNode(snapshot.nodes, TOOL_MENU_LABELS)
      || findContainsNode(snapshot.nodes, TOOL_MENU_LABELS)
      || snapshot.nodes.find((node) => node.bounds && node.enabled
        && (node.text === '+' || node.description === '+'));
    if (!menu) return { ok: false, errorCode: 'tool_menu_not_found', message: '未找到 ChatGPT 工具/Apps 菜单' };
    tap(record.serial, menu);
    await delay(450);
    snapshot = await this.nodes(record.serial);
    const target = findSemanticNode(snapshot.nodes, [connector]) || findContainsNode(snapshot.nodes, [connector]);
    if (!target) {
      return { ok: false, errorCode: 'connector_not_found', message: `未在当前 ChatGPT Apps 菜单找到 ${connector}` };
    }
    tap(record.serial, target);
    this.audit({ type: 'connector_select', deviceId: record.id, connector });
    return { ok: true, deviceId: record.id, connector };
  }

  async sendMessage(args: Record<string, any>): Promise<Record<string, unknown>> {
    const message = String(args.message || '').trim();
    if (!message) return { ok: false, errorCode: 'message_required', message: 'message 不能为空' };
    const record = this.resolveDevice(String(args.deviceId || args.accountId || args.serial || ''));
    launchChatGpt(record.serial);
    await delay(650);
    if (args.connector) {
      const connectorResult = await this.addConnector({ ...args, deviceId: record.id });
      if (connectorResult.ok !== true) return connectorResult;
    }
    const driver = await this.setPrompt(record.serial, message);
    await delay(150);
    await this.clickSend(record.serial);
    this.audit({ type: 'send_message', deviceId: record.id, chars: message.length, driver });
    return { ok: true, deviceId: record.id, serial: record.serial, driver, chars: message.length };
  }

  async getReply(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const record = this.resolveDevice(String(args.deviceId || args.accountId || args.serial || ''));
    const snapshot = await this.nodes(record.serial);
    const texts = visibleText(snapshot.nodes);
    const pending = snapshot.nodes.some((node) => labelsMatch(node, APPROVAL_LABELS));
    const streaming = snapshot.nodes.some((node) => labelsMatch(node, STOP_LABELS));
    const candidates = texts.filter((value) => value.length >= 12
      && !TOOL_MENU_LABELS.some((label) => normalize(value) === normalize(label)));
    const content = candidates.at(-1) || texts.at(-1) || '';
    return {
      ok: true,
      deviceId: record.id,
      content,
      charCount: content.length,
      visibleTexts: args.includeVisibleTexts === true ? texts.slice(-80) : undefined,
      pending,
      streaming,
      done: Boolean(content) && !pending && !streaming,
      driver: snapshot.driver,
    };
  }

  async chatStatus(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const record = this.resolveDevice(String(args.deviceId || args.accountId || args.serial || ''));
    const snapshot = await this.nodes(record.serial);
    return {
      ok: true,
      deviceId: record.id,
      serial: record.serial,
      foreground: isChatGptForeground(record.serial),
      packageName: CHATGPT_PACKAGE,
      pendingApproval: snapshot.nodes.some((node) => labelsMatch(node, APPROVAL_LABELS)),
      streaming: snapshot.nodes.some((node) => labelsMatch(node, STOP_LABELS)),
      driver: snapshot.driver,
    };
  }

  async sendAndWatch(args: Record<string, any>): Promise<Record<string, unknown>> {
    const sent = await this.sendMessage(args);
    if (sent.ok !== true) return sent;
    const timeoutMs = Math.min(86_400_000, Math.max(60_000, Number(args.timeout || 21_600) * 1000));
    const pollMs = Math.min(5000, Math.max(400, Number(args.pollIntervalMs || 1000)));
    const started = Date.now();
    let last: Record<string, unknown> = { ok: true, done: false };
    while (Date.now() - started < timeoutMs) {
      await this.scanOnce(args).catch(() => null);
      last = await this.getReply(args);
      if (last.done === true) {
        return { ...last, ok: true, elapsedMs: Date.now() - started };
      }
      await delay(pollMs);
    }
    return {
      ok: false,
      errorCode: 'chat_timeout',
      message: '等待 ChatGPT Android 回复超时',
      lastReply: last,
    };
  }

  async enqueueTasks(args: Record<string, any>): Promise<Record<string, unknown>> {
    const rawTasks = Array.isArray(args.tasks) ? args.tasks.slice(0, 50) : [];
    if (!rawTasks.length) return { ok: false, errorCode: 'tasks_required', message: 'tasks 不能为空' };
    const created: QueueTask[] = [];
    for (const raw of rawTasks) {
      const id = String(raw.id || `task-${randomUUID().slice(0, 8)}`);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
        return { ok: false, errorCode: 'invalid_task_id', message: `非法任务 id: ${id}` };
      }
      if (this.state.tasks.some((task) => task.id === id)) {
        return { ok: false, errorCode: 'duplicate_task_id', message: `任务已存在: ${id}` };
      }
      const task: QueueTask = {
        id,
        title: String(raw.title || id).slice(0, 160),
        prompt: String(raw.prompt || ''),
        deviceId: raw.accountId || raw.deviceId,
        connector: raw.connector,
        dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String).slice(0, 50) : [],
        priority: Number(raw.priority || 0),
        timeout: Math.min(86_400, Math.max(60, Number(raw.timeout || 21_600))),
        revision: Math.max(1, Number(raw.revision || 1)),
        directive: raw.directive ? String(raw.directive) : undefined,
        status: 'pending',
        attempts: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      if (!task.prompt.trim()) return { ok: false, errorCode: 'prompt_required', message: `任务 ${id} prompt 不能为空` };
      this.state.tasks.push(task);
      created.push(task);
    }
    this.persist();
    if (args.start === true) void this.startQueue(args);
    return { ok: true, created: created.map((task) => ({ id: task.id, title: task.title, status: task.status })) };
  }

  private dependenciesReady(task: QueueTask): boolean {
    return task.dependsOn.every((id) => this.state.tasks.find((item) => item.id === id)?.status === 'completed');
  }

  private async runTask(task: QueueTask, waitForReview: boolean): Promise<void> {
    task.status = 'running';
    task.attempts += 1;
    task.startedAt = now();
    task.updatedAt = now();
    this.persist();
    try {
      const prompt = [task.prompt, task.directive, task.feedback ? `\n验收反馈：${task.feedback}` : '']
        .filter(Boolean).join('\n\n');
      const reply = await this.sendAndWatch({
        message: prompt,
        connector: task.connector,
        deviceId: task.deviceId,
        timeout: task.timeout,
      });
      task.lastReply = reply;
      if (reply.ok !== true) throw new Error(String(reply.message || reply.errorCode || 'task failed'));
      task.status = waitForReview ? 'waiting_review' : 'completed';
      task.reviewStatus = waitForReview ? 'pending' : 'accepted';
      if (!waitForReview) task.completedAt = now();
      task.lastError = undefined;
      this.audit({ type: 'queue_task_finished', taskId: task.id, status: task.status, attempts: task.attempts });
    } catch (error) {
      task.status = 'failed';
      task.lastError = String(error);
      this.audit({ type: 'queue_task_failed', taskId: task.id, message: task.lastError });
    } finally {
      task.updatedAt = now();
      this.persist();
    }
  }

  async startQueue(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    if (this.queuePromise) return { ok: true, alreadyRunning: true };
    this.state.queuePaused = false;
    this.persist();
    const waitForReview = args.waitForReview !== false;
    const maxConcurrent = Math.min(8, Math.max(1, Number(args.maxConcurrent || 1)));
    this.queuePromise = (async () => {
      try {
        while (!this.state.queuePaused) {
          const ready = this.state.tasks
            .filter((task) => task.status === 'pending' && this.dependenciesReady(task))
            .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
          if (!ready.length) break;
          const selected: QueueTask[] = [];
          const usedDevices = new Set<string>();
          for (const task of ready) {
            let deviceKey = task.deviceId || '__default__';
            try { deviceKey = this.resolveDevice(task.deviceId).id; } catch { /* task will fail with useful error */ }
            if (usedDevices.has(deviceKey)) continue;
            usedDevices.add(deviceKey);
            selected.push(task);
            if (selected.length >= maxConcurrent) break;
          }
          await Promise.all(selected.map((task) => this.runTask(task, waitForReview)));
        }
      } finally {
        this.queuePromise = null;
        this.persist();
      }
    })();
    void this.queuePromise;
    return { ok: true, started: true, maxConcurrent, waitForReview };
  }

  async queueStatus(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      running: this.queuePromise !== null,
      paused: this.state.queuePaused,
      tasks: this.state.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        reviewStatus: task.reviewStatus || null,
        attempts: task.attempts,
        deviceId: task.deviceId || null,
        connector: task.connector || null,
        revision: task.revision,
        lastError: task.lastError || null,
        updatedAt: task.updatedAt,
      })),
    };
  }

  async updateTask(args: Record<string, any>): Promise<Record<string, unknown>> {
    const task = this.state.tasks.find((item) => item.id === String(args.taskId || args.id || ''));
    if (!task) return { ok: false, errorCode: 'task_not_found', message: '任务不存在' };
    if (args.revision != null && Number(args.revision) < task.revision) {
      return { ok: false, errorCode: 'stale_revision', message: 'revision 不能回退' };
    }
    if (args.prompt != null) task.prompt = String(args.prompt);
    if (args.directive != null) task.directive = String(args.directive);
    if (args.connector != null) task.connector = String(args.connector);
    if (args.accountId != null || args.deviceId != null) task.deviceId = String(args.accountId || args.deviceId);
    if (args.revision != null) task.revision = Number(args.revision);
    task.updatedAt = now();
    this.persist();
    return { ok: true, task: { id: task.id, revision: task.revision, status: task.status } };
  }

  async waitForReview(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const timeoutMs = Math.min(7_200_000, Math.max(0, Number(args.timeoutSeconds || 0) * 1000));
    const started = Date.now();
    do {
      const task = this.state.tasks.find((item) => ['waiting_review', 'failed'].includes(item.status));
      if (task) return { ok: true, task };
      if (timeoutMs <= 0) break;
      await delay(500);
    } while (Date.now() - started < timeoutMs);
    return { ok: true, task: null };
  }

  async reviewTask(args: Record<string, any>): Promise<Record<string, unknown>> {
    const task = this.state.tasks.find((item) => item.id === String(args.taskId || ''));
    if (!task) return { ok: false, errorCode: 'task_not_found', message: '任务不存在' };
    if (args.accepted === true) {
      task.status = 'completed';
      task.reviewStatus = 'accepted';
      task.completedAt = now();
    } else {
      task.status = 'pending';
      task.reviewStatus = 'rejected';
      task.feedback = String(args.feedback || '请继续修正后重新提交验收');
    }
    task.updatedAt = now();
    this.persist();
    return { ok: true, task: { id: task.id, status: task.status, reviewStatus: task.reviewStatus } };
  }

  async pauseQueue(): Promise<Record<string, unknown>> {
    this.state.queuePaused = true;
    this.persist();
    return { ok: true, paused: true };
  }

  async resumeQueue(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    this.state.queuePaused = false;
    this.persist();
    return this.startQueue(args);
  }

  async retryTask(args: Record<string, any>): Promise<Record<string, unknown>> {
    const task = this.state.tasks.find((item) => item.id === String(args.taskId || ''));
    if (!task) return { ok: false, errorCode: 'task_not_found', message: '任务不存在' };
    if (args.connector != null) task.connector = String(args.connector);
    if (args.feedback != null) task.feedback = String(args.feedback);
    task.status = 'pending';
    task.lastError = undefined;
    task.updatedAt = now();
    this.persist();
    if (args.start !== false) void this.startQueue(args);
    return { ok: true, task: { id: task.id, status: task.status } };
  }

  async cancelTask(args: Record<string, any>): Promise<Record<string, unknown>> {
    const task = this.state.tasks.find((item) => item.id === String(args.taskId || ''));
    if (!task) return { ok: false, errorCode: 'task_not_found', message: '任务不存在' };
    task.status = 'cancelled';
    task.updatedAt = now();
    this.persist();
    return { ok: true, task: { id: task.id, status: task.status } };
  }

  async watchdog(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const staleSeconds = Math.max(60, Number(args.staleAfterSeconds || 21_600));
    const threshold = Date.now() - staleSeconds * 1000;
    const recovered: string[] = [];
    for (const task of this.state.tasks) {
      if (task.status !== 'running' || !task.startedAt) continue;
      if (Date.parse(task.startedAt) >= threshold) continue;
      task.status = 'pending';
      task.lastError = `watchdog recovered stale task after ${staleSeconds}s`;
      task.updatedAt = now();
      recovered.push(task.id);
    }
    this.persist();
    if (recovered.length && args.start !== false) void this.startQueue(args);
    return { ok: true, recovered };
  }

  async relaunchAndConfirm(args: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const record = this.resolveDevice(String(args.deviceId || args.accountId || args.serial || ''));
    void adbShell(record.serial, ['am', 'force-stop', CHATGPT_PACKAGE]);
    await delay(300);
    launchChatGpt(record.serial);
    await delay(900);
    return this.scanOnce({ ...args, deviceId: record.id });
  }

  async close(): Promise<void> {
    if (this.watcherTimer) clearInterval(this.watcherTimer);
    await this.appium.close();
  }
}
