// 这是一个"真实 App 主进程逻辑"的最小样本：依赖虚拟 app + 作用域 ipcMain
const { app, BrowserWindow, ipcMain } = require('electron');

console.log('[fixture] app name =', app.getName());
console.log('[fixture] userData =', app.getPath('userData'));
console.log('[fixture] appPath =', app.getAppPath());

app.whenReady().then(() => {
  console.log('[fixture] ready!');
  const win = new BrowserWindow({ width: 700, height: 500, title: 'fixture' });
  win.loadURL('data:text/html,<h1>chromius fixture</h1><p>runs inside shared host</p>');
  ipcMain.handle('ping', () => 'pong from fixture');
});
