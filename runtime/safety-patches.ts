import { spawnSync } from 'node:child_process';
import { AndroidChatGptController } from './controller.ts';

const proto = AndroidChatGptController.prototype as any;
const originalStartWatcher = proto.startWatcher;
const originalRunTask = proto.runTask;
const originalCancelTask = proto.cancelTask;
const originalRetryTask = proto.retryTask;

const activeTaskByDevice = new WeakMap<object, Map<string, string>>();
const cancelledTasks = new WeakMap<object, Set<string>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalized(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function deviceKey(args: Record<string, any>): string {
  return String(args.deviceId || args.accountId || args.serial || '__default__');
}

function isChatGptForeground(serial: string): boolean {
  const adb = process.env.CHATGPT_ANDROID_ADB || 'adb';
  const packageName = process.env.CHATGPT_ANDROID_PACKAGE || 'com.openai.chatgpt';
  const result = spawnSync(adb, ['-s', serial, 'shell', 'dumpsys', 'activity', 'activities'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) return false;
  const output = String(result.stdout || '');
  const resumed = output.match(/^\s*mResumedActivity:.*$/m)?.[0]
    || output.match(/^\s*topResumedActivity=.*$/m)?.[0]
    || '';
  return resumed.includes(packageName);
}

proto.sendAndWatch = async function enhancedSendAndWatch(args: Record<string, any>) {
  const baseline = await this.getReply(args).catch(() => ({ content: '' }));
  const baselineContent = normalized(baseline?.content);
  const sentText = normalized(args.message);
  const sent = await this.sendMessage(args);
  if (sent.ok !== true) return sent;

  const timeoutMs = Math.min(86_400_000, Math.max(60_000, Number(args.timeout || 21_600) * 1000));
  const pollMs = Math.min(5000, Math.max(400, Number(args.pollIntervalMs || 1000)));
  const started = Date.now();
  let last: Record<string, unknown> = { ok: true, done: false };
  let sawStreaming = false;
  let sawNewReply = false;

  const active = activeTaskByDevice.get(this);
  const taskId = active?.get(deviceKey(args));
  const cancelled = cancelledTasks.get(this);

  while (Date.now() - started < timeoutMs) {
    if (taskId && cancelled?.has(taskId)) {
      return { ok: false, errorCode: 'task_cancelled', message: `任务 ${taskId} 已取消` };
    }

    await this.scanOnce(args).catch(() => null);
    last = await this.getReply(args);
    if (last.streaming === true) sawStreaming = true;

    const current = normalized(last.content);
    if (current && current !== baselineContent && current !== sentText) {
      sawNewReply = true;
    }

    // A user message can appear in the accessibility tree before ChatGPT has
    // produced any assistant output. Never treat that transient state as done.
    if (last.done === true && sawNewReply && (sawStreaming || Date.now() - started >= 800)) {
      return { ...last, ok: true, elapsedMs: Date.now() - started };
    }
    await sleep(pollMs);
  }

  return {
    ok: false,
    errorCode: 'chat_timeout',
    message: '等待 ChatGPT Android 回复超时',
    lastReply: last,
  };
};

proto.startWatcher = async function guardedStartWatcher(args: Record<string, any> = {}) {
  const result = await originalStartWatcher.call(this, args);
  if (result.ok !== true) return result;

  if (this.watcherTimer) clearInterval(this.watcherTimer);
  const intervalMs = Number(result.watcher?.intervalMs || 750);
  const id = String(result.device?.id || result.watcher?.deviceId || '');
  const serial = String(result.device?.serial || '');

  this.watcherTimer = setInterval(() => {
    // UiAutomator cannot operate a hidden third-party Android app. A background
    // watcher therefore observes only while ChatGPT is already foreground and
    // never steals focus from another phone app.
    if (!serial || !isChatGptForeground(serial)) return;
    void this.scanOnce({ deviceId: id }).catch((error: unknown) => {
      this.audit({ type: 'watcher_error', deviceId: id, message: String(error) });
    });
  }, intervalMs);
  this.watcherTimer.unref?.();
  return { ...result, foregroundOnly: true };
};

proto.runTask = async function trackedRunTask(task: any, waitForReview: boolean) {
  let active = activeTaskByDevice.get(this);
  if (!active) {
    active = new Map<string, string>();
    activeTaskByDevice.set(this, active);
  }
  const key = String(task.deviceId || '__default__');
  active.set(key, String(task.id));
  try {
    await originalRunTask.call(this, task, waitForReview);
  } finally {
    active.delete(key);
    const cancelled = cancelledTasks.get(this);
    if (cancelled?.has(String(task.id))) {
      task.status = 'cancelled';
      task.updatedAt = new Date().toISOString();
      task.lastError = undefined;
      this.persist();
    }
  }
};

proto.cancelTask = async function cancellableTask(args: Record<string, any>) {
  const taskId = String(args.taskId || '');
  const result = await originalCancelTask.call(this, args);
  if (result.ok === true && taskId) {
    let cancelled = cancelledTasks.get(this);
    if (!cancelled) {
      cancelled = new Set<string>();
      cancelledTasks.set(this, cancelled);
    }
    cancelled.add(taskId);
  }
  return result;
};

proto.retryTask = async function retryCancelledTask(args: Record<string, any>) {
  const taskId = String(args.taskId || '');
  if (taskId) cancelledTasks.get(this)?.delete(taskId);
  return originalRetryTask.call(this, args);
};
