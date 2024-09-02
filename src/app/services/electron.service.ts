import { Injectable } from '@angular/core';
import { ipcRenderer } from 'electron';

@Injectable({
  providedIn: 'root',
})
export class ElectronService {
  private ipc!: typeof ipcRenderer;

  constructor() {
    if (this.isElectron()) {
      this.ipc = window.require('electron').ipcRenderer;
    }
  }

  isElectron(): boolean {
    return !!(window && window.process && window.process.type);
  }

  send(channel: string, ...args: any[]) {
    if (this.isElectron()) {
      this.ipc.send(channel, ...args);
    }
  }

  on(channel: string, listener: (event: Electron.IpcRendererEvent, ...args: any[]) => void) {
    if (this.isElectron()) {
      this.ipc.on(channel, listener);
    }
  }
}
