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

  async getActiveWindow(): Promise<{ title: string } | null> {
    if (!this.isElectron()) return null;
    return new Promise((resolve) => {
      this.ipc.once('get-active-window-response', (event, result) => {
        resolve(result);
      });
      this.ipc.send('get-active-window');
    });
  }

  async showScreenPicker(): Promise<{id: string, name: string} | null> {
    if (!this.isElectron()) return null;

    try {
      // Get sources from main process
      const sources = await this.ipc.invoke('show-screen-picker');

      // Create a simple selection dialog
      return new Promise((resolve) => {
        const dialog = document.createElement('div');
        dialog.style.position = 'fixed';
        dialog.style.top = '0';
        dialog.style.left = '0';
        dialog.style.width = '100%';
        dialog.style.height = '100%';
        dialog.style.backgroundColor = 'rgba(0,0,0,0.8)';
        dialog.style.zIndex = '10000';
        dialog.style.display = 'flex';
        dialog.style.flexDirection = 'column';
        dialog.style.alignItems = 'center';
        dialog.style.justifyContent = 'center';

        const title = document.createElement('h2');
        title.textContent = 'Select what to share';
        title.style.color = 'white';
        dialog.appendChild(title);

        const container = document.createElement('div');
        container.style.display = 'grid';
        container.style.gridTemplateColumns = 'repeat(auto-fill, minmax(300px, 1fr))';
        container.style.gap = '20px';
        container.style.maxWidth = '90%';
        container.style.maxHeight = '80%';
        container.style.overflow = 'auto';

        sources.forEach((source: { id: string; name: string; thumbnail: string }) => {
          const sourceElement = document.createElement('div');
          sourceElement.style.cursor = 'pointer';
          sourceElement.style.display = 'flex';
          sourceElement.style.flexDirection = 'column';
          sourceElement.style.alignItems = 'center';

          const img = document.createElement('img');
          img.src = source.thumbnail;
          img.style.width = '300px';
          img.style.height = 'auto';
          img.style.border = '2px solid transparent';

          const label = document.createElement('span');
          label.textContent = source.name;
          label.style.color = 'white';
          label.style.marginTop = '10px';

          sourceElement.appendChild(img);
          sourceElement.appendChild(label);

          sourceElement.addEventListener('click', () => {
            document.body.removeChild(dialog);
            resolve({ id: source.id, name: source.name });
          });

          container.appendChild(sourceElement);
        });

        dialog.appendChild(container);

        const cancelButton = document.createElement('button');
        cancelButton.textContent = 'Cancel';
        cancelButton.style.marginTop = '20px';
        cancelButton.style.padding = '10px 20px';
        cancelButton.addEventListener('click', () => {
          document.body.removeChild(dialog);
          resolve(null);
        });

        dialog.appendChild(cancelButton);
        document.body.appendChild(dialog);
      });
    } catch (error) {
      console.error('Error showing screen picker:', error);
      return null;
    }
  }

  async getScreenSources(): Promise<{ id: string; name: string; thumbnail: string }[]> {
    if (!this.isElectron()) return [];
    try {
      const sources = await this.ipc.invoke('get-screen-sources');
      return sources;
    } catch (error) {
      console.error('Error fetching screen sources:', error);
      return [];
    }
  }
}
