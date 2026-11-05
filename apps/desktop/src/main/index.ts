import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
type AutoUpdater = import("electron-updater").AppUpdater;
let autoUpdater: AutoUpdater | undefined;
import { tmpdir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { YuanfangRuntime } from "@yuanfang/core";
import {
  IPC,
  type AddProjectInput,
  type ChatSendInput,
  type CreateTaskInput,
  type NavigateInput,
  type ProjectStatus,
  type RuntimeEvent,
  type RuntimeStatus,
  type UpdateConfigInput,
} from "@yuanfang/shared";

const APP_NAME = "元芳";
app.setName(APP_NAME);
let agentName = APP_NAME;
const E2E = process.env.YUANFANG_E2E === "1";
const E2E_QUIET = E2E && process.env.YUANFANG_E2E_VISIBLE !== "1";
const E2E_CAPTURE = E2E && process.env.YUANFANG_E2E_CAPTURE === "1";
if (E2E && process.env.YUANFANG_HOME === undefined) {
  process.env.YUANFANG_HOME = join(tmpdir(), "yuanfang-e2e-home");
}
// A copied/silent test app must never share the production runtime database.
const TEST_COPY =
  process.env.YUANFANG_SILENT === "1" || /[/\\]test-app[/\\]/.test(process.execPath);
if (TEST_COPY && process.env.YUANFANG_HOME === undefined) {
  process.env.YUANFANG_HOME = join(tmpdir(), "yuanfang-test-home");
}
if (E2E && process.env.YUANFANG_DEFAULT_PROJECT_PATH === undefined) {
  process.env.YUANFANG_DEFAULT_PROJECT_PATH = join(tmpdir(), "yuanfang-e2e-default");
}
let runtime: YuanfangRuntime | undefined;
let bootError: string | null = null;
let booting = true;
let mainWindow: BrowserWindow | undefined;
let quickWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let updaterUrl = "";
let updaterReady = false;
let updaterCheckStarted = false;
let updaterLoadError = "";
const requireModule = createRequire(import.meta.url);
let interactiveUpdateCheck = false;
let updatePromptOpen = false;
let quickAskHotkey = "CommandOrControl+Shift+Space";
let quickAskRegistered = false;
let markBooted: (() => void) | undefined;
const bootCompleted = new Promise<void>((resolve) => {
  markBooted = resolve;
});

function resourcePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, "resources", name)
    : join(import.meta.dirname, "../../resources", name);
}

function rendererEntry(): { url?: string; file?: string } {
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev !== undefined && dev.length > 0) {
    return { url: dev };
  }
  return { file: join(import.meta.dirname, "../renderer/index.html") };
}

function preloadPath(): string {
  return join(import.meta.dirname, "../preload/index.cjs");
}

function loadRenderer(window: BrowserWindow, query = ""): void {
  const entry = rendererEntry();
  if (entry.url !== undefined) {
    void window.loadURL(`${entry.url}${query}`);
  } else if (entry.file !== undefined) {
    void window.loadFile(entry.file, { search: query.replace(/^\?/, "") });
  }
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
    backgroundColor: "#0a0c12",
    ...(process.platform === "darwin" ? { vibrancy: "under-window" as const, visualEffectState: "active" as const } : {}),
    icon: nativeImage.createFromPath(resourcePath("icon.png")),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  loadRenderer(window);
  window.once("ready-to-show", () => {
    if (E2E) {
      if (E2E_QUIET) {
        window.setOpacity(0);
        app.dock?.hide();
      }
      window.showInactive();
      if (E2E_QUIET) window.setPosition(-4000, -4000);
      if (E2E_CAPTURE) {
        void runE2E(window);
      }
      return;
    }
    window.show();
  });
  window.on("closed", () => {
    mainWindow = undefined;
  });
  return window;
}

function createQuickWindow(): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = 720;
  const height = 210;
  const window = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.min(180, workArea.height * 0.18)),
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: true,
    ...(process.platform === "darwin" ? { vibrancy: "hud" as const, visualEffectState: "active" as const } : {}),
    backgroundColor: "#00000000",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setAlwaysOnTop(true, "floating");
  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  loadRenderer(window, "?quick=1");
  window.on("blur", () => {
    if (!window.isDestroyed()) window.hide();
  });
  window.on("closed", () => {
    quickWindow = undefined;
  });
  return window;
}

function showMain(navigate?: NavigateInput): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (navigate !== undefined) {
    mainWindow.webContents.send(IPC.navigate, navigate);
  }
}

function toggleQuickAsk(): void {
  if (quickWindow === undefined || quickWindow.isDestroyed()) {
    quickWindow = createQuickWindow();
  }
  if (quickWindow.isVisible()) {
    quickWindow.hide();
    return;
  }
  if (E2E) {
    if (E2E_QUIET) quickWindow.setOpacity(0);
    quickWindow.showInactive();
    if (E2E_QUIET) quickWindow.setPosition(-4000, -4000);
    quickWindow.webContents.send(IPC.event, { type: "log", level: "info", message: "quick-ask:focus" });
    return;
  }
  quickWindow.show();
  quickWindow.focus();
  quickWindow.webContents.send(IPC.event, { type: "log", level: "info", message: "quick-ask:focus" });
}

function broadcast(event: RuntimeEvent): void {
  for (const window of [mainWindow, quickWindow]) {
    if (window !== undefined && !window.isDestroyed()) {
      window.webContents.send(IPC.event, event);
    }
  }
}

function notify(event: Extract<RuntimeEvent, { type: "notification" }>): void {
  if (!Notification.isSupported() || event.body.trim().length === 0) return;
  const notification = new Notification({
    title: event.title,
    body: event.body,
    silent: false,
    urgency: event.urgent ? "critical" : "normal",
  });
  notification.on("click", () => {
    if (event.approvalId !== undefined) {
      showMain({ view: "approvals" });
      return;
    }
    showMain(
      event.projectId === null
        ? { view: "chat", ...(event.conversationId === null ? {} : { conversationId: event.conversationId }), ...(event.messageId === undefined ? {} : { messageId: event.messageId }) }
        : { view: "project", projectId: event.projectId, ...(event.taskId === null ? {} : { taskId: event.taskId }) },
    );
  });
  notification.show();
  app.dock?.bounce(event.urgent ? "critical" : "informational");
}

async function runE2E(window: BrowserWindow): Promise<void> {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const execute = <T,>(code: string) => window.webContents.executeJavaScript(code) as Promise<T>;
  const results: Record<string, unknown> = {};
  try {
    await wait(1200);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await execute<boolean>("Boolean(window.yuanfang)");
      if (ready) break;
      await wait(250);
    }
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const label = await execute<string>("document.querySelector('.runtime-label')?.textContent ?? ''");
      if (label.includes("在线") || label.includes("失败")) break;
      await wait(250);
    }
    await wait(800);
    const directory = "/tmp/yuanfang-e2e";
    await mkdir(directory, { recursive: true });
    results.home = await execute(`({
      title: document.querySelector('.hero h1')?.textContent ?? null,
      cards: document.querySelectorAll('.project-card').length,
      chat: Boolean(document.querySelector('.chat-panel')),
      composer: Boolean(document.querySelector('.chat-composer textarea')),
      runtime: document.querySelector('.runtime-label')?.textContent ?? null,
      body: document.body.innerText.slice(0, 1600)
    })`);
    await writeFile(join(directory, "home.png"), (await window.webContents.capturePage()).toPNG());

    let projectCards = await execute<number>("document.querySelectorAll('.project-card').length");
    if (projectCards === 0) {
      const revealed = await execute<boolean>(`(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('显示归档'));
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (revealed) {
        await wait(500);
        projectCards = await execute<number>("document.querySelectorAll('.project-card').length");
      }
    }
    if (projectCards > 0) {
      await execute(`document.querySelector('.project-card')?.click()`);
      await wait(1200);
      results.project = await execute(`({
        workspace: Boolean(document.querySelector('.workspace')),
        title: document.querySelector('.workspace-title h1')?.textContent ?? null,
        stats: [...document.querySelectorAll('.stat')].map((item) => item.textContent),
        tasks: document.querySelectorAll('.task-row').length,
        tabs: [...document.querySelectorAll('.workspace-tabs .tab')].map((item) => item.textContent)
      })`);
      await writeFile(join(directory, "project.png"), (await window.webContents.capturePage()).toPNG());
      await execute(`document.querySelector('.task-row')?.click()`);
      await wait(800);
      results.task = await execute(`({
        detail: Boolean(document.querySelector('.task-detail')),
        events: Boolean(document.querySelector('.task-events')),
        review: Boolean(document.querySelector('.review-box')),
        title: document.querySelector('.task-detail h2')?.textContent ?? null
      })`);
      await writeFile(join(directory, "task.png"), (await window.webContents.capturePage()).toPNG());
      await execute(`document.querySelector('.task-detail .icon-button')?.click()`);
      await wait(300);
      await execute(`document.querySelector('.workspace-header .back')?.click()`);
      await wait(400);
    }

    const clicked = await execute<boolean>(`(() => {
      const button = [...document.querySelectorAll('.topbar button')].find((item) => item.textContent?.includes('新项目'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    results.openedNewProject = clicked;
    await wait(500);
    results.modal = await execute(`({
      modal: Boolean(document.querySelector('.modal')),
      heading: document.querySelector('.modal h2')?.textContent ?? null,
      inputs: document.querySelectorAll('.modal input, .modal textarea').length
    })`);
    await writeFile(join(directory, "new-project.png"), (await window.webContents.capturePage()).toPNG());

    await execute(`document.querySelector('.modal .icon-button')?.click()`);
    await wait(300);
    await execute(`[...document.querySelectorAll('.topbar-nav button')].find((item) => item.textContent?.includes('设置'))?.click()`);
    await wait(600);
    results.settings = await execute(`({
      modal: Boolean(document.querySelector('.modal')),
      heading: document.querySelector('.modal h2')?.textContent ?? null,
      selects: document.querySelectorAll('.modal select').length,
      tabs: document.querySelectorAll('.settings-nav-item').length,
      themes: document.querySelectorAll('.theme-option').length,
      scales: document.querySelectorAll('.scale-option').length
    })`);
    await writeFile(join(directory, "settings.png"), (await window.webContents.capturePage()).toPNG());
    await execute(`[...document.querySelectorAll('.settings-nav-item')].find((item) => item.textContent?.includes('更新'))?.click()`);
    await wait(350);
    results.settingsUpdate = await execute(`({
      version: document.querySelector('.update-card strong')?.textContent ?? null,
      button: [...document.querySelectorAll('button')].some((item) => item.textContent?.includes('检查更新')),
      source: Boolean(document.querySelector('input[value*="github.com"]'))
    })`);
    await writeFile(join(directory, "settings-update.png"), (await window.webContents.capturePage()).toPNG());
    await execute(`[...document.querySelectorAll('.settings-nav-item')].find((item) => item.textContent?.includes('身份'))?.click()`);
    await wait(350);
    results.settingsIdentity = await execute(`({
      persona: Boolean(document.querySelector('.persona-editor')),
      identity: Boolean(document.querySelector('.settings-content'))
    })`);
    await writeFile(join(directory, "settings-identity.png"), (await window.webContents.capturePage()).toPNG());

    await execute(`document.querySelector('.modal .icon-button')?.click()`);
    await wait(300);
    toggleQuickAsk();
    await wait(900);
    if (quickWindow !== undefined) {
      results.quick = await quickWindow.webContents.executeJavaScript(`({
        shell: Boolean(document.querySelector('.quick-shell')),
        input: Boolean(document.querySelector('.quick-input-row input')),
        hint: document.querySelector('.quick-hint')?.textContent ?? null
      })`);
      await writeFile(join(directory, "quick.png"), (await quickWindow.webContents.capturePage()).toPNG());
      quickWindow.hide();
    }
    console.log("E2E_RESULT " + JSON.stringify(results));
  } catch (error) {
    console.error("E2E_ERROR", error);
  } finally {
    await runtime?.close().catch(() => undefined);
    app.quit();
  }
}

function trayMenu(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: `打开${agentName}`, click: () => showMain() },
    { label: "快速提问", accelerator: quickAskHotkey, click: () => toggleQuickAsk() },
    { type: "separator" },
    {
      label: "打开工作区",
      click: () => {
        if (runtime !== undefined) void shell.openPath(runtime.paths.workspace);
      },
    },
    { label: "检查更新", click: () => checkForUpdates(true) },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
}

async function loadUpdater(): Promise<AutoUpdater | undefined> {
  if (autoUpdater !== undefined) return autoUpdater;
  try {
    // Use CommonJS resolution explicitly. A dynamic import of a CommonJS
    // dependency can fail inside a packed asar on some Electron/macOS builds.
    const module = requireModule("electron-updater") as typeof import("electron-updater");
    autoUpdater = module.autoUpdater;
    updaterLoadError = "";
    return autoUpdater;
  } catch (error) {
    updaterLoadError = error instanceof Error ? error.message : String(error);
    console.error("[元芳] electron-updater unavailable", error);
    return undefined;
  }
}

function setupUpdater(updater: AutoUpdater): void {
  if (updaterReady) return;
  updaterReady = true;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.on("update-available", (info) => {
    interactiveUpdateCheck = false;
    if (updatePromptOpen) return;
    updatePromptOpen = true;
    void dialog
      .showMessageBox({
        type: "info",
        title: "发现新版本",
        message: `元芳 ${info.version} 可用，当前版本 ${app.getVersion()}。`,
        detail: "同意后会下载并在完成后自动重启安装。",
        buttons: ["现在更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
      .then((result) => {
        if (result.response === 0) void updater.downloadUpdate();
      })
      .finally(() => {
        updatePromptOpen = false;
      });
  });
  updater.on("update-not-available", (info) => {
    if (interactiveUpdateCheck) {
      void dialog.showMessageBox({
        type: "info",
        title: "检查更新",
        message: "当前已经是最新版本。",
        detail: `当前版本 ${app.getVersion()}，服务器版本 ${info.version}。`,
      });
    }
    interactiveUpdateCheck = false;
  });
  updater.on("update-downloaded", () => {
    if (Notification.isSupported()) {
      new Notification({ title: "元芳更新已下载", body: "即将重启安装新版本。" }).show();
    }
    setTimeout(() => updater.quitAndInstall(), 1_000);
  });
  updater.on("error", (error) => {
    console.error("[元芳] update failed", error);
    if (interactiveUpdateCheck) {
      void dialog.showMessageBox({
        type: "error",
        title: "检查更新失败",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    interactiveUpdateCheck = false;
  });
}

async function configureUpdater(url: string): Promise<void> {
  updaterUrl = url.trim();
  if (!app.isPackaged || updaterUrl.length === 0) return;
  const updater = await loadUpdater();
  if (updater === undefined) return;
  setupUpdater(updater);
  try {
    updater.setFeedURL({ provider: "generic", url: updaterUrl });
  } catch (error) {
    console.error("[元芳] updater feed failed", error);
    return;
  }
  if (!updaterCheckStarted) {
    updaterCheckStarted = true;
    setTimeout(() => void checkForUpdates(false), 5_000);
  }
}

async function checkForUpdates(interactive: boolean): Promise<void> {
  interactiveUpdateCheck = interactive;
  if (!app.isPackaged) {
    if (interactive) void dialog.showMessageBox({ type: "info", title: "检查更新", message: "开发模式不支持自动更新，请使用打包后的应用。" });
    interactiveUpdateCheck = false;
    return;
  }
  if (updaterUrl.length === 0) {
    if (interactive) void dialog.showMessageBox({ type: "info", title: "检查更新", message: "还没有配置更新源。请在设置里填写 latest-mac.yml / latest.yml / latest-linux.yml 的地址。" });
    interactiveUpdateCheck = false;
    return;
  }
  await configureUpdater(updaterUrl);
  const updater = await loadUpdater();
  if (updater === undefined) {
    if (interactive) void dialog.showMessageBox({ type: "error", title: "检查更新失败", message: "更新组件未加载。" });
    interactiveUpdateCheck = false;
    return;
  }
  try {
    await updater.checkForUpdates();
  } catch (error) {
    if (interactive) {
      void dialog.showMessageBox({ type: "error", title: "检查更新失败", message: error instanceof Error ? error.message : String(error) });
    }
    interactiveUpdateCheck = false;
  }
}

function createTray(): void {
  const image =
    process.platform === "darwin"
      ? nativeImage.createFromPath(resourcePath("trayTemplate.png"))
      : nativeImage.createFromPath(resourcePath("icon.png")).resize({ width: 22, height: 22 });
  if (process.platform === "darwin") image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(agentName);
  tray.on("click", () => showMain());
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu()));
}

function appMenu(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "设置…", accelerator: "CommandOrControl+,", click: () => showMain({ view: "settings" }) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: agentName,
      submenu: [
        { label: "打开主窗口", accelerator: "CommandOrControl+0", click: () => showMain() },
        { label: "快速提问", accelerator: quickAskHotkey, click: () => toggleQuickAsk() },
        { label: "审批", click: () => showMain({ view: "approvals" }) },
        { label: "记忆", click: () => showMain({ view: "memory" }) },
        { label: "检查更新", click: () => checkForUpdates(true) },
      ],
    },
  ];
}

function applyAgentName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) return;
  agentName = trimmed;
  mainWindow?.setTitle(agentName);
  tray?.setToolTip(agentName);
  if (tray !== undefined) tray.setContextMenu(Menu.buildFromTemplate(trayMenu()));
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu()));
}

function status(): RuntimeStatus {
  if (runtime !== undefined) return runtime.status();
  return {
    ready: false,
    booting,
    error: bootError,
    warning: null,
    workspace: "",
    startedAt: Date.now(),
    activeRuns: 0,
    pendingApprovals: 0,
    runningTasks: 0,
    quickAskHotkey,
  };
}

function rebuildMenus(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu()));
  if (tray !== undefined) tray.setContextMenu(Menu.buildFromTemplate(trayMenu()));
}

/** Register the configured accelerator. Returns false and restores the old one on conflict. */
function registerQuickAskHotkey(accelerator: string): boolean {
  const next = accelerator.trim();
  if (next.length === 0) return false;
  const previous = quickAskHotkey;
  if (quickAskRegistered && previous === next) return true;
  if (quickAskRegistered) {
    globalShortcut.unregister(previous);
    quickAskRegistered = false;
  }
  const registered = globalShortcut.register(next, () => toggleQuickAsk());
  if (!registered) {
    if (previous !== next) {
      quickAskRegistered = globalShortcut.register(previous, () => toggleQuickAsk());
    }
    return false;
  }
  quickAskHotkey = next;
  quickAskRegistered = true;
  rebuildMenus();
  return true;
}

async function boot(): Promise<void> {
  try {
    runtime = await YuanfangRuntime.open({ ensureDefaultProject: true });
    applyAgentName(runtime.configView().agentName);
    void configureUpdater(runtime.configView().updateFeedUrl);
    runtime.subscribe((event) => {
      broadcast(event);
      if (event.type === "notification") notify(event);
      if (event.type === "login_event" && event.event.type === "auth_url") {
        void shell.openExternal(event.event.url);
      }
      if (event.type === "external_url") {
        void shell.openExternal(event.url);
      }
    });
    booting = false;
    bootError = null;
    broadcast({ type: "status", status: runtime.status() });
  } catch (error) {
    booting = false;
    bootError = error instanceof Error ? error.message : String(error);
    console.error("[元芳] boot failed", error);
    broadcast({ type: "status", status: status() });
  } finally {
    markBooted?.();
    markBooted = undefined;
  }
}

function handle<T>(channel: string, fn: (input: T) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (_event, input: T) => {
    try {
      await bootCompleted;
      return await fn(input);
    } catch (error) {
      console.error(`[元芳] ipc ${channel} failed`, error);
      throw error;
    }
  });
}

function requireRuntime(): YuanfangRuntime {
  if (runtime === undefined) throw new Error(bootError ?? "元芳正在启动，请稍候");
  return runtime;
}

function registerIpc(): void {
  ipcMain.handle(IPC.getStatus, () => status());
  handle<void>(IPC.getProjects, () => requireRuntime().listProjects());
  handle<string>(IPC.getProject, (projectId) => requireRuntime().projectDetailAsync(projectId));
  handle<AddProjectInput>(IPC.createProject, async (input) => {
    const rt = requireRuntime();
    const project = await rt.createProject(input);
    return rt.projectRecordView(project.id);
  });
  handle<{ name: string; path?: string }>(IPC.draftProjectBrief, (input) =>
    requireRuntime().draftProjectBrief(input),
  );
  handle<string | undefined>(IPC.chooseFolder, async (defaultPath) => {
    const options: Electron.OpenDialogOptions = {
      title: "选择项目文件夹",
      buttonLabel: "选择",
      properties: ["openDirectory", "createDirectory"],
      ...(defaultPath === undefined || defaultPath.length === 0 ? {} : { defaultPath }),
    };
    const result =
      mainWindow === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(mainWindow, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle<{ projectId: string; status: ProjectStatus }>(IPC.updateProject, (input) => {
    const current = requireRuntime().getProjectRecord(input.projectId);
    if (current === undefined) return undefined;
    requireRuntime().setProjectStatus(input.projectId, input.status);
    return requireRuntime().projectRecordView(input.projectId);
  });
  handle<{ projectId: string; status: ProjectStatus }>(IPC.archiveProject, (input) => {
    requireRuntime().setProjectStatus(input.projectId, input.status);
    return requireRuntime().projectRecordView(input.projectId);
  });
  handle<CreateTaskInput>(IPC.createTask, (input) => requireRuntime().createTask(input));
  handle<string>(IPC.dispatchTask, (taskId) => requireRuntime().dispatchTask(taskId));
  handle<string>(IPC.cancelTask, (taskId) => requireRuntime().cancelTask(taskId));
  handle<{ taskId: string; note?: string }>(IPC.acceptTask, (input) => requireRuntime().acceptTask(input.taskId, input.note));
  handle<{ taskId: string; note: string }>(IPC.rejectTask, (input) => requireRuntime().rejectTask(input.taskId, input.note));
  handle<string>(IPC.retryTask, (taskId) => requireRuntime().retryTask(taskId));
  handle<string>(IPC.abortConversation, (conversationId) => requireRuntime().abortConversation(conversationId));
  handle<string>(IPC.getTasks, (projectId) => requireRuntime().listTasks(projectId));
  handle<string>(IPC.getTaskEvents, (taskId) => requireRuntime().listTaskEvents(taskId));
  handle<string>(IPC.indexProject, (projectId) => requireRuntime().indexProject(projectId));
  handle<string>(IPC.deleteProject, (projectId) => requireRuntime().deleteProject(projectId));
  handle<ChatSendInput>(IPC.sendChat, (input) =>
    input.projectId === undefined || input.projectId === null
      ? requireRuntime().sendSystemMessage(input.text)
      : requireRuntime().sendProjectMessage(input.projectId, input.text),
  );
  handle<string>(IPC.getConversation, (conversationId) => requireRuntime().getConversationFeed(conversationId));
  handle<void>(IPC.getSystemConversation, () => {
    const rt = requireRuntime();
    const conversationId = rt.systemConversationFeed();
    return { conversationId, feed: rt.getConversationFeed(conversationId) };
  });
  handle<{ status?: "pending" | "approved" | "denied" }>(IPC.getApprovals, (input) =>
    requireRuntime().getApprovals(input?.status),
  );
  handle<void>(IPC.getNotifications, () => requireRuntime().getNotifications());
  handle<void>(IPC.markNotificationsRead, () => requireRuntime().markNotificationsRead());
  handle<{ id: string; decision: "approved" | "denied"; note: string | null }>(IPC.resolveApproval, (input) =>
    requireRuntime().resolveApproval(input.id, input.decision, input.note),
  );
  handle<{ projectId?: string | null }>(IPC.getMemories, (input) =>
    requireRuntime().getMemories(input?.projectId ?? null),
  );
  handle<Parameters<YuanfangRuntime["addMemory"]>[0]>(IPC.addMemory, (input) => requireRuntime().addMemory(input));
  handle<{ id: string; change: Parameters<YuanfangRuntime["updateMemory"]>[1] }>(IPC.updateMemory, (input) =>
    requireRuntime().updateMemory(input.id, input.change),
  );
  handle<string>(IPC.deleteMemory, (id) => requireRuntime().deleteMemory(id));
  handle<Parameters<YuanfangRuntime["saveSkill"]>[0]>(IPC.saveSkill, (input) => requireRuntime().saveSkill(input));
  handle<{ name: string; projectId?: string | null }>(IPC.readSkill, (input) =>
    requireRuntime().readSkill(input.name, input.projectId ?? null),
  );
  handle<{ query: string; projectId?: string | null }>(IPC.search, (input) =>
    requireRuntime().search(input.query, input.projectId ?? null),
  );
  handle<void>(IPC.getConfig, () => requireRuntime().configViewWithPersona());
  handle<void>(IPC.getProviders, () => requireRuntime().providers());
  handle<{ providerId: string; refresh?: boolean }>(IPC.getProviderModels, (input) =>
    requireRuntime().providerModels(input.providerId, input.refresh === true),
  );
  handle<{ providerId: string; key: string; env?: Record<string, string> }>(IPC.saveProviderKey, (input) =>
    requireRuntime().saveProviderKey(input.providerId, input.key, input.env),
  );
  handle<import("@yuanfang/shared").CustomProviderInput>(IPC.saveCustomProvider, (input) =>
    requireRuntime().saveCustomProvider(input),
  );
  handle<string>(IPC.removeProviderKey, (providerId) => requireRuntime().removeProviderKey(providerId));
  handle<void>(IPC.importPiCredentials, () => requireRuntime().importPiCredentials());
  handle<void>(IPC.getRoles, () => requireRuntime().listRoles());
  handle<{ name: string; description: string; instructions: string; model: { provider: string; modelId: string } | null }>(
    IPC.saveRole,
    (input) => requireRuntime().saveRole(input),
  );
  handle<string>(IPC.beginProviderLogin, (providerId) => requireRuntime().beginProviderLogin(providerId));
  handle<{ loginId: string; promptId: string; value: string }>(IPC.respondLoginPrompt, (input) =>
    requireRuntime().respondLoginPrompt(input.loginId, input.promptId, input.value),
  );
  handle<string>(IPC.cancelProviderLogin, (loginId) => requireRuntime().cancelProviderLogin(loginId));
  handle<UpdateConfigInput>(IPC.updateConfig, async (input) => {
    const rt = requireRuntime();
    const previousHotkey = rt.configView().quickAskHotkey;
    const updated = await rt.updateConfig(input);
    if (!E2E && input.quickAskHotkey !== undefined && updated.quickAskHotkey !== previousHotkey) {
      if (!registerQuickAskHotkey(updated.quickAskHotkey)) {
        await rt.updateConfig({ quickAskHotkey: previousHotkey });
        throw new Error("这个快捷键无法注册，可能已被系统或其他应用占用，请换一个组合。");
      }
    }
    applyAgentName(updated.agentName);
    void configureUpdater(updated.updateFeedUrl);
    return updated;
  });
  ipcMain.handle(IPC.setZoom, (event, factor: unknown) => {
    if (event.sender.isDestroyed()) return;
    const scale = typeof factor === "number" && Number.isFinite(factor) ? Math.min(1.4, Math.max(0.8, factor)) : 1;
    event.sender.setZoomFactor(scale);
  });
  handle<{ projectId?: string | null }>(IPC.getSkills, async (input) => {
    const rt = requireRuntime();
    const projectId = input?.projectId ?? null;
    const project = projectId === null ? undefined : rt.getProjectRecord(projectId);
    return rt.skills.list(projectId, project?.path ?? null);
  });
  handle<void>(IPC.getPlugins, () => requireRuntime().plugins.list());
  handle<void>(IPC.getMcpServers, () => requireRuntime().mcp.list());
  handle<string>(IPC.removeMcpServer, (name) => requireRuntime().mcp.remove(name));
  handle<void>(IPC.reloadPlugins, () => requireRuntime().reloadPlugins());
  handle<string>(IPC.removePlugin, (name) => requireRuntime().removePlugin(name));
  handle<{ name: string; scope: "global" | "project"; projectId?: string | null }>(IPC.deleteSkill, (input) =>
    requireRuntime().removeSkill(input.name, input.scope, input.projectId ?? null),
  );
  handle<void>(IPC.getAppInfo, () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    updateFeedUrl: updaterUrl || requireRuntime().configView().updateFeedUrl,
  }));
  handle<void>(IPC.getLocks, () => requireRuntime().getLocks());
  handle<string>(IPC.openWorkspace, async (path) => {
    await shell.openPath(path.length > 0 ? path : requireRuntime().paths.workspace);
  });
  handle<{ text: string }>(IPC.quickAsk, async (input) => {
    const result = await requireRuntime().sendSystemMessage(input.text);
    if (quickWindow !== undefined && !quickWindow.isDestroyed()) quickWindow.hide();
    return result;
  });
  ipcMain.on(IPC.hideQuickAsk, () => {
    if (quickWindow !== undefined && !quickWindow.isDestroyed()) quickWindow.hide();
  });
  ipcMain.on(IPC.openMain, () => showMain());
  ipcMain.handle(IPC.checkForUpdates, () => checkForUpdates(true));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMain());
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu()));

    registerIpc();
    mainWindow = createMainWindow();
    if (!E2E) createTray();
    await boot();
    if (!E2E && runtime !== undefined) {
      if (!registerQuickAskHotkey(runtime.configView().quickAskHotkey)) {
        console.warn("[元芳] shortcut registration failed");
      }
    } else if (runtime !== undefined) {
      quickAskHotkey = runtime.configView().quickAskHotkey;
    }
  });

  app.on("activate", () => showMain());
  app.on("window-all-closed", () => {
    // The tray keeps the app alive on macOS; quitting is explicit.
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void (async () => {
      globalShortcut.unregisterAll();
      await runtime?.close().catch(() => undefined);
      app.quit();
    })();
  });
}
