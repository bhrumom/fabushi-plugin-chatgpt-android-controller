import { AndroidChatGptController } from '../runtime/controller.ts';

const marker = process.env.CHATGPT_ANDROID_SMOKE_MARKER || 'MAHAYANA_ANDROID_SMOKE_OK';
const timeout = Math.min(600, Math.max(60, Number(process.env.CHATGPT_ANDROID_SMOKE_TIMEOUT || 240)));
const controller = new AndroidChatGptController();

function emit(stage: string, detail: Record<string, unknown> = {}) {
  process.stdout.write(`[android-smoke] ${stage} ${JSON.stringify(detail)}\n`);
}

try {
  const account = await controller.accountAdd({ label: 'GitHub Actions Android emulator' });
  if (account.ok !== true) throw new Error(String(account.message || account.errorCode || 'account_add failed'));
  const accountId = String((account.account as any)?.id || '');
  emit('device-ready', { accountId: accountId || null });

  const status = await controller.accountStatus({ accountId });
  if (status.ok !== true || status.chatgptInstalled !== true) {
    throw new Error('ChatGPT APK is not available after device registration');
  }
  emit('apk-status', {
    chatgptInstalled: status.chatgptInstalled,
    chatgptForeground: status.chatgptForeground,
    appiumAvailable: status.appiumAvailable,
  });

  const result = await controller.sendAndWatch({
    accountId,
    message: `这是 GitHub Actions 安卓 APK 自动化验收。只回复这一行，不要添加其他文字：${marker}`,
    timeout,
    pollIntervalMs: 1000,
  });
  const content = String(result.content || '');
  const passed = result.ok === true && content.includes(marker);
  emit('reply', {
    ok: result.ok === true,
    done: result.done === true,
    charCount: Number(result.charCount || content.length),
    markerObserved: passed,
    elapsedMs: result.elapsedMs || null,
  });
  if (!passed) {
    throw new Error(String(result.message || result.errorCode || 'Smoke reply marker was not observed'));
  }
  process.stdout.write(`${JSON.stringify({ ok: true, markerObserved: true })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emit('failed', { message });
  process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'apk_smoke_failed', message })}\n`);
  process.exitCode = 1;
} finally {
  await controller.close().catch(() => {});
}
