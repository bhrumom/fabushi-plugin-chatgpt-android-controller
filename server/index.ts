import readline from 'node:readline';
import { AndroidChatGptController } from '../runtime/controller.ts';

const controller = new AndroidChatGptController();

const annotations = (readOnlyHint = false, destructiveHint = false) => ({
  readOnlyHint,
  destructiveHint,
  openWorldHint: false,
});

const emptySchema = { type: 'object', additionalProperties: false, properties: {} };
const deviceFields = {
  deviceId: { type: 'string', description: '已注册 Android 设备槽位 id' },
  accountId: { type: 'string', description: '兼容旧版字段；Android 版等同 deviceId' },
  serial: { type: 'string', description: 'adb device serial' },
};

const tools = [
  {
    name: 'home',
    description: '加载 ChatGPT Android 自动化小程序首页',
    annotations: annotations(true),
    inputSchema: emptySchema,
  },
  {
    name: 'account_list',
    description: '列出已注册 Android ChatGPT 设备槽位；不读取 ChatGPT 凭据',
    annotations: annotations(true),
    inputSchema: emptySchema,
  },
  {
    name: 'account_add',
    description: '注册一台已通过 ADB 连接的 Android 设备，并打开 ChatGPT App',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        serial: { type: 'string' },
        label: { type: 'string', maxLength: 80 },
      },
    },
  },
  {
    name: 'account_login_link',
    description: '旧版兼容工具；Android 登录必须在 ChatGPT App 内完成',
    annotations: annotations(),
    inputSchema: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' } } },
  },
  {
    name: 'account_switch',
    description: '切换默认 Android 设备槽位',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { ...deviceFields },
    },
  },
  {
    name: 'account_rename',
    description: '修改 Android 设备槽位显示名称',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['label'],
      properties: { ...deviceFields, label: { type: 'string', minLength: 1, maxLength: 80 } },
    },
  },
  {
    name: 'account_status',
    description: '检查 Android 设备、ChatGPT App 和 Appium UiAutomator2 状态',
    annotations: annotations(true),
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...deviceFields } },
  },
  {
    name: 'account_sync',
    description: '旧版兼容工具；Android 沙箱下不导出 ChatGPT Cookie/Token',
    annotations: annotations(),
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...deviceFields } },
  },
  {
    name: 'account_remove',
    description: '删除本地 Android 设备槽位；不会卸载 ChatGPT 或清除手机数据',
    annotations: annotations(false, true),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['confirm'],
      properties: { ...deviceFields, confirm: { type: 'boolean' } },
    },
  },
  {
    name: 'start',
    description: '启动 Android ChatGPT 授权卡自动确认 watcher',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        ...deviceFields,
        approveAll: { type: 'boolean', default: true },
        intervalMs: { type: 'integer', minimum: 400, maximum: 5000, default: 750 },
      },
    },
  },
  { name: 'stop', description: '停止自动确认 watcher', annotations: annotations(), inputSchema: emptySchema },
  { name: 'status', description: '查看 watcher、设备和任务队列状态', annotations: annotations(true), inputSchema: emptySchema },
  {
    name: 'scan_once',
    description: '立即扫描当前 Android ChatGPT 页面并确认可识别的允许按钮',
    annotations: annotations(),
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...deviceFields } },
  },
  {
    name: 'relaunch_and_confirm',
    description: '强制停止并重新打开 Android ChatGPT，然后扫描授权卡',
    annotations: annotations(),
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...deviceFields } },
  },
  {
    name: 'audit_log',
    description: '读取本机 Android 自动化审计事件；不记录提示词正文或凭据',
    annotations: annotations(true),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    },
  },
  {
    name: 'diagnose',
    description: '只读检查 ADB、Appium、设备和 ChatGPT Android 安装状态',
    annotations: annotations(true),
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...deviceFields } },
  },
  {
    name: 'send_message',
    description: '在 Android ChatGPT 当前会话中输入并发送消息；Unicode 输入优先使用 Appium UiAutomator2',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['message'],
      properties: {
        ...deviceFields,
        message: { type: 'string', minLength: 1, maxLength: 10000 },
        connector: { type: 'string', maxLength: 256 },
      },
    },
  },
  {
    name: 'add_connector',
    description: '从 Android ChatGPT 的工具/Apps 菜单选择 connector',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['connector'],
      properties: { ...deviceFields, connector: { type: 'string', minLength: 1, maxLength: 256 } },
    },
  },
  {
    name: 'get_reply',
    description: '读取 Android ChatGPT 当前页面最新可见回复状态',
    annotations: annotations(true),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { ...deviceFields, includeVisibleTexts: { type: 'boolean', default: false } },
    },
  },
  {
    name: 'chat_status',
    description: '读取 Android ChatGPT 前台、流式回复和待确认状态',
    annotations: annotations(true),
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...deviceFields } },
  },
  {
    name: 'send_and_watch',
    description: '发送消息、自动确认工具授权，并等待 Android ChatGPT 当前回复结束',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['message'],
      properties: {
        ...deviceFields,
        message: { type: 'string', minLength: 1, maxLength: 10000 },
        connector: { type: 'string', maxLength: 256 },
        timeout: { type: 'integer', minimum: 60, maximum: 86400, default: 21600 },
        pollIntervalMs: { type: 'integer', minimum: 400, maximum: 5000, default: 1000 },
      },
    },
  },
  {
    name: 'enqueue_tasks',
    description: '写入可恢复 Android ChatGPT 任务队列；不同设备可并行',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['tasks'],
      properties: {
        start: { type: 'boolean', default: false },
        waitForReview: { type: 'boolean', default: true },
        maxConcurrent: { type: 'integer', minimum: 1, maximum: 8, default: 1 },
        tasks: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object', additionalProperties: true, required: ['title', 'prompt'],
            properties: {
              id: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' },
              accountId: { type: 'string' }, deviceId: { type: 'string' }, connector: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'string' } }, priority: { type: 'integer' },
              timeout: { type: 'integer' }, revision: { type: 'integer' }, directive: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'start_queue',
    description: '启动或继续 Android ChatGPT 任务队列',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        waitForReview: { type: 'boolean', default: true },
        maxConcurrent: { type: 'integer', minimum: 1, maximum: 8, default: 1 },
      },
    },
  },
  { name: 'queue_status', description: '读取持久化任务队列状态', annotations: annotations(true), inputSchema: emptySchema },
  {
    name: 'update_task',
    description: '更新任务 prompt、directive、connector、设备或 revision',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: true, required: ['taskId'],
      properties: {
        taskId: { type: 'string' }, prompt: { type: 'string' }, directive: { type: 'string' },
        connector: { type: 'string' }, accountId: { type: 'string' }, deviceId: { type: 'string' },
        revision: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'wait_for_review',
    description: '等待下一个待验收或失败的 Android 队列任务',
    annotations: annotations(true),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { timeoutSeconds: { type: 'integer', minimum: 0, maximum: 7200, default: 0 } },
    },
  },
  {
    name: 'review_task',
    description: '接受任务，或携带 feedback 退回重新执行',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['taskId', 'accepted'],
      properties: { taskId: { type: 'string' }, accepted: { type: 'boolean' }, feedback: { type: 'string' } },
    },
  },
  { name: 'pause_queue', description: '暂停调度新 Android 任务', annotations: annotations(), inputSchema: emptySchema },
  {
    name: 'resume_queue',
    description: '恢复任务队列',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { waitForReview: { type: 'boolean' }, maxConcurrent: { type: 'integer' } },
    },
  },
  {
    name: 'retry_task',
    description: '恢复失败/中断任务，可更新 connector 和反馈',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['taskId'],
      properties: { taskId: { type: 'string' }, connector: { type: 'string' }, feedback: { type: 'string' }, start: { type: 'boolean' } },
    },
  },
  {
    name: 'cancel_task',
    description: '取消指定任务',
    annotations: annotations(false, true),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string' } },
    },
  },
  {
    name: 'queue_watchdog',
    description: '恢复超时仍处于 running 的任务并可重新启动队列',
    annotations: annotations(),
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { staleAfterSeconds: { type: 'integer', minimum: 60 }, start: { type: 'boolean' } },
    },
  },
  {
    name: 'sync_actions_credentials',
    description: '兼容旧版工具；Android 版禁止导出 ChatGPT 凭据',
    annotations: annotations(),
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...deviceFields } },
  },
  {
    name: 'login_and_sync_actions',
    description: '兼容旧版工具；Android 版登录保留在设备，Actions 通过 ADB/Appium 操作',
    annotations: annotations(),
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...deviceFields } },
  },
  {
    name: 'start_actions_runner',
    description: '返回 Android self-hosted runner 模式说明；无需复制 ChatGPT 凭据',
    annotations: annotations(true),
    inputSchema: emptySchema,
  },
];

function mcpResult(id: unknown, structuredContent: Record<string, unknown>) {
  const ok = structuredContent.ok !== false;
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{
        type: 'text',
        text: ok
          ? String(structuredContent.message || 'ChatGPT Android 自动化命令已完成。')
          : String(structuredContent.message || structuredContent.errorCode || '命令失败'),
      }],
      structuredContent,
      isError: !ok,
    },
  };
}

async function callTool(name: string, args: Record<string, any>): Promise<Record<string, unknown>> {
  switch (name) {
    case 'home':
      return {
        ok: true,
        title: 'ChatGPT Android 自动化',
        runtime: 'TypeScript/Node.js + ADB + Appium UiAutomator2',
        summary: '控制真实 Android 设备或模拟器上的 ChatGPT App，支持自动确认、消息收发、connector、可恢复队列和多设备并行。',
      };
    case 'account_list': return controller.accountList();
    case 'account_add': return controller.accountAdd(args);
    case 'account_switch': return controller.accountSwitch(args);
    case 'account_rename': return controller.accountRename(args);
    case 'account_status': return controller.accountStatus(args);
    case 'account_remove': return controller.accountRemove(args);
    case 'account_login_link':
    case 'account_sync':
    case 'sync_actions_credentials':
    case 'login_and_sync_actions':
      return controller.unsupportedCredentialTool(name);
    case 'start_actions_runner':
      return {
        ok: true,
        mode: 'self-hosted-runner-device-session',
        message: 'Android 版不复制 ChatGPT 凭据：让 GitHub self-hosted runner 保持 ADB 连接并调用本小程序即可。',
      };
    case 'start': return controller.startWatcher(args);
    case 'stop': return controller.stopWatcher();
    case 'status': return controller.status();
    case 'scan_once': return controller.scanOnce(args);
    case 'relaunch_and_confirm': return controller.relaunchAndConfirm(args);
    case 'audit_log': return controller.auditLog(args);
    case 'diagnose': return controller.diagnose(args);
    case 'send_message': return controller.sendMessage(args);
    case 'add_connector': return controller.addConnector(args);
    case 'get_reply': return controller.getReply(args);
    case 'chat_status': return controller.chatStatus(args);
    case 'send_and_watch': return controller.sendAndWatch(args);
    case 'enqueue_tasks': return controller.enqueueTasks(args);
    case 'start_queue': return controller.startQueue(args);
    case 'queue_status': return controller.queueStatus();
    case 'update_task': return controller.updateTask(args);
    case 'wait_for_review': return controller.waitForReview(args);
    case 'review_task': return controller.reviewTask(args);
    case 'pause_queue': return controller.pauseQueue();
    case 'resume_queue': return controller.resumeQueue(args);
    case 'retry_task': return controller.retryTask(args);
    case 'cancel_task': return controller.cancelTask(args);
    case 'queue_watchdog': return controller.watchdog(args);
    default:
      return { ok: false, errorCode: 'unknown_tool', message: `未知工具：${name}` };
  }
}

async function handleRpc(rpc: any): Promise<any | null> {
  if (rpc.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: rpc.id,
      result: {
        protocolVersion: rpc.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: '@mahayana/chatgpt-android-controller', version: '0.1.0' },
      },
    };
  }
  if (rpc.method === 'notifications/initialized' || rpc.method === 'notifications/cancelled') return null;
  if (rpc.method === 'tools/list') {
    return { jsonrpc: '2.0', id: rpc.id, result: { tools } };
  }
  if (rpc.method === 'tools/call') {
    const name = String(rpc.params?.name || '');
    const args = rpc.params?.arguments && typeof rpc.params.arguments === 'object'
      ? rpc.params.arguments
      : {};
    try {
      return mcpResult(rpc.id, await callTool(name, args));
    } catch (error) {
      return mcpResult(rpc.id, {
        ok: false,
        errorCode: 'runtime_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (rpc.method === 'ping') return { jsonrpc: '2.0', id: rpc.id, result: {} };
  if (rpc.id === undefined) return null;
  return {
    jsonrpc: '2.0', id: rpc.id,
    error: { code: -32601, message: `Method not found: ${String(rpc.method)}` },
  };
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  let rpc: any;
  try {
    rpc = JSON.parse(line);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0', id: null,
      error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
    })}\n`);
    continue;
  }
  const response = await handleRpc(rpc);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}

await controller.close();
