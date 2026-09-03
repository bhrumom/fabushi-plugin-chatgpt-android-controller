import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AndroidChatGptController } from '../runtime/controller.ts';

type InboxTask = {
  id: string;
  title: string;
  prompt: string;
  connector?: string;
  dependsOn?: string[];
  priority?: number;
  timeout?: number;
  revision?: number;
  directive?: string;
};

type Inbox = {
  keepAlive?: boolean;
  authoritative?: boolean;
  maxConcurrent?: number;
  reviewGate?: boolean;
  tasks?: InboxTask[];
};

const inboxPath = resolve(process.env.CHATGPT_ANDROID_ACTIONS_INBOX
  || '.agents/plugins/plugins/chatgpt-auto-confirm/tasks/actions-inbox.json');
const tracePath = process.env.CHATGPT_ANDROID_RUNNER_TRACE || '';
const durationSeconds = Math.min(20_400, Math.max(60, Number(
  process.env.CHATGPT_ANDROID_RUNNER_SECONDS || 18_600,
)));
const pollSeconds = Math.min(300, Math.max(5, Number(
  process.env.CHATGPT_ANDROID_RUNNER_POLL_SECONDS || 30,
)));

const controller = new AndroidChatGptController();

async function trace(stage: string, detail: Record<string, unknown> = {}) {
  const row = { at: new Date().toISOString(), stage, ...detail };
  process.stdout.write(`[android-runner] ${stage} ${JSON.stringify(detail)}\n`);
  if (!tracePath) return;
  const { appendFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(resolve(tracePath)), { recursive: true, mode: 0o700 });
  await appendFile(resolve(tracePath), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

async function loadInbox(): Promise<Inbox> {
  return JSON.parse(await readFile(inboxPath, 'utf8')) as Inbox;
}

async function reconcile(inbox: Inbox, accountId: string) {
  const current = await controller.queueStatus();
  const currentTasks = Array.isArray(current.tasks) ? current.tasks as Array<Record<string, any>> : [];
  const currentById = new Map(currentTasks.map(task => [String(task.id), task]));
  const desired = Array.isArray(inbox.tasks) ? inbox.tasks : [];
  const desiredIds = new Set(desired.map(task => task.id));
  let created = 0;
  let updated = 0;
  let cancelled = 0;

  for (const task of desired) {
    if (!task.id || !task.prompt) continue;
    const existing = currentById.get(task.id);
    if (!existing) {
      const result = await controller.enqueueTasks({
        tasks: [{
          ...task,
          accountId,
          dependsOn: task.dependsOn || [],
          revision: task.revision || 1,
        }],
        start: false,
      });
      if (result.ok === true) created += 1;
      else await trace('enqueue-failed', { taskId: task.id, errorCode: result.errorCode || null });
      continue;
    }
    const desiredRevision = Math.max(1, Number(task.revision || 1));
    const existingRevision = Math.max(1, Number(existing.revision || 1));
    if (desiredRevision > existingRevision) {
      const result = await controller.updateTask({
        taskId: task.id,
        prompt: task.prompt,
        directive: task.directive || '',
        connector: task.connector,
        accountId,
        revision: desiredRevision,
      });
      if (result.ok === true) updated += 1;
      else await trace('update-failed', { taskId: task.id, errorCode: result.errorCode || null });
    }
  }

  if (inbox.authoritative === true) {
    for (const existing of currentTasks) {
      const taskId = String(existing.id || '');
      if (!taskId || desiredIds.has(taskId)) continue;
      if (['completed', 'cancelled'].includes(String(existing.status || ''))) continue;
      const result = await controller.cancelTask({ taskId });
      if (result.ok === true) cancelled += 1;
    }
  }

  return { created, updated, cancelled, desired: desired.length };
}

function statusCounts(tasks: Array<Record<string, any>>) {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const status = String(task.status || 'unknown');
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

try {
  const account = await controller.accountAdd({ label: 'GitHub Actions Android emulator' });
  if (account.ok !== true) throw new Error(String(account.message || account.errorCode || 'account_add failed'));
  const accountId = String((account.account as any)?.id || '');
  if (!accountId) throw new Error('No Android account/device id was registered');

  await controller.startWatcher({ accountId, intervalMs: 750, approveAll: true });
  await trace('started', { accountId, inboxPath, durationSeconds, pollSeconds });

  const deadline = Date.now() + durationSeconds * 1000;
  while (Date.now() < deadline) {
    const inbox = await loadInbox();
    const reconciliation = await reconcile(inbox, accountId);
    await controller.startQueue({
      maxConcurrent: Math.min(8, Math.max(1, Number(inbox.maxConcurrent || 1))),
      waitForReview: inbox.reviewGate === true,
    });

    const status = await controller.queueStatus();
    const tasks = Array.isArray(status.tasks) ? status.tasks as Array<Record<string, any>> : [];
    await trace('heartbeat', {
      running: status.running === true,
      paused: status.paused === true,
      reconciliation,
      counts: statusCounts(tasks),
    });

    if (inbox.keepAlive !== true) {
      const active = tasks.some(task => ['pending', 'running', 'waiting_review'].includes(String(task.status || '')));
      if (!active) break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, pollSeconds * 1000));
  }

  const finalStatus = await controller.queueStatus();
  const finalTasks = Array.isArray(finalStatus.tasks) ? finalStatus.tasks as Array<Record<string, any>> : [];
  await trace('complete', { counts: statusCounts(finalTasks) });
  process.stdout.write(`${JSON.stringify({ ok: true, counts: statusCounts(finalTasks) })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await trace('fatal', { message });
  process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'android_action_runner_failed', message })}\n`);
  process.exitCode = 1;
} finally {
  await controller.close().catch(() => {});
}
