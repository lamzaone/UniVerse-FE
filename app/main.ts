import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';

let win: BrowserWindow | null = null;
const args = process.argv.slice(1),
  serve = args.some(val => val === '--serve');

function createWindow(): BrowserWindow {
  const size = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    x: 0,
    y: 0,
    width: size.width/2,
    height: size.height/2,
    minHeight: 600,
    minWidth: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      allowRunningInsecureContent: serve,
      contextIsolation: false,
    },
  });

  if (serve) {
    const debug = require('electron-debug');
    debug();

    require('electron-reloader')(module);
    win.loadURL('http://lamzaone.go.ro:4200');
  } else {
    let pathIndex = './index.html';

    if (fs.existsSync(path.join(__dirname, '../dist/index.html'))) {
      pathIndex = '../dist/index.html';
    }

    const url = new URL(path.join('file:', __dirname, pathIndex));
    win.loadURL(url.href);
  }

  win.on('closed', () => {
    win = null;
  });

  return win;
}

try {
  // ADDED THIS BECAUSE IT DESTROYS THE APP FOR SOME REASON, ON AMD GPUs WITH THE LATEST DRIVERS
  app.disableHardwareAcceleration();

  app.on('ready', () => setTimeout(createWindow, 400));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (win === null) {
      createWindow();
    }
  });
} catch (e) {
  console.error('Error during app initialization:', e);
}

ipcMain.on('google-oauth-login', async (event) => {
  const authWindow = new BrowserWindow({
    width: 500,
    height: 600,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const clientId = '167769953872-b5rnqtgjtuhvl09g45oid5r9r0lui2d6.apps.googleusercontent.com';
  const redirectUri = encodeURIComponent('http://lamzaone.go.ro:4200/auth/callback');
  const scope = encodeURIComponent('openid email profile');
  const responseType = 'token id_token';
  const googleAuthUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=${responseType}&scope=${scope}`;

  authWindow.loadURL(googleAuthUrl);

  authWindow.webContents.on('will-redirect', async (event, url) => {
    if (url.startsWith('http://lamzaone.go.ro:4200/auth/callback')) {
      const idTokenMatch = url.match(/id_token=([^&]*)/);
      const accessTokenMatch = url.match(/access_token=([^&]*)/);
      console.log('ID Token:', idTokenMatch);
      console.log('Access Token:', accessTokenMatch);
      if (idTokenMatch && accessTokenMatch) {
        const id_token = idTokenMatch[1];
        const access_token = accessTokenMatch[1];

        try {
          const response = await axios.post('http://lamzaone.go.ro:8000/api/auth/google', {
            id_token: id_token,
            access_token: access_token,
          });

          win?.webContents.send('google-oauth-success', response.data);
          console.log('Server Response:', response.data);
        } catch (error:any) {
          win?.webContents.send('google-oauth-error', error.response ? error.response.data : error.message);
        }

        authWindow.close();
      }
    }
  });

  authWindow.on('closed', () => {
    authWindow.destroy();
  });
});
