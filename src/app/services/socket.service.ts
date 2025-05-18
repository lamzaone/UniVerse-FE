// socket.service.ts
import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private userId: string | null = null;
  private sockets: { [key: string]: WebSocket | null } = {};

  constructor(private authService: AuthService) {
    if (this.authService.isLoggedIn()) {
      this.userId = this.authService.getUser().id;
      this.connectToSocket('main', `ws://lamzaone.go.ro:8000/api/ws/main/${this.userId}`);
    }
  }

  private connectToSocket(key: string, url: string): void {
    if (!this.userId) return;

    if (this.sockets[key]) {
      this.sockets[key]!.close();
    }

    this.sockets[key] = new WebSocket(url);
    this.sockets[key]!.onopen = () => console.log(`Connected to ${key} socket`);
    this.sockets[key]!.onmessage = (event) => this.handleMessage(key, event);
    this.sockets[key]!.onclose = () => console.log(`Disconnected from ${key} socket`);
  }

  private handleMessage(key: string, event: MessageEvent): void {
    const data = event.data;
    // console.log(`${key.charAt(0).toUpperCase() + key.slice(1)} update:`, data);
    // Broadcast to listeners if needed
    this.notifyListeners(key, data);
  }

  private listeners: { [key: string]: ((data: any) => void)[] } = {};

  private notifyListeners(key: string, data: any) {
    if (this.listeners[key]) {
      this.listeners[key].forEach(callback => callback(data));
    }
  }



  onServerMessage(callback: (data: any) => void) {
    if (!this.listeners['server']) this.listeners['server'] = [];
    this.listeners['server'].push(callback);
  }

  onTextRoomMessage(callback: (data: any) => void) {
    if (!this.listeners['textRoom']) this.listeners['textRoom'] = [];
    this.listeners['textRoom'].push(callback);
  }

  onMainMessage(callback: (data: any) => void) {
    if (!this.listeners['main']) this.listeners['main'] = [];
    this.listeners['main'].push(callback);
  }

  onAudioRoomMessage(callback: (data: any) => void) {
    if (!this.listeners['audioRoom']) this.listeners['audioRoom'] = [];
    this.listeners['audioRoom'].push(callback);
  }

  joinServer(serverId: string): void {
    // Check if the main socket connection is opened, if not, re-open it
    if (this.sockets['main']){
      if (this.sockets['main']!.readyState > 1){
        this.sockets['main']!.close();
        this.connectToSocket('main', `ws://lamzaone.go.ro:8000/api/ws/main/${this.userId}`);
        this.connectToSocket('server', `ws://lamzaone.go.ro:8000/api/ws/server/${serverId}/${this.userId}`);
      }
      this.connectToSocket('server', `ws://lamzaone.go.ro:8000/api/ws/server/${serverId}/${this.userId}`);
    }else{
      this.connectToSocket('server', `ws://lamzaone.go.ro:8000/api/ws/server/${serverId}/${this.userId}`);
    }



  }

  joinTextRoom(roomId: string): void {
    if (this.sockets['main']){
      if (this.sockets['main']!.readyState > 2){
        this.sockets['main']!.close();
        this.connectToSocket('main', `ws://lamzaone.go.ro:8000/api/ws/main/${this.userId}`);
        this.connectToSocket('textRoom', `ws://lamzaone.go.ro:8000/api/ws/textroom/${roomId}/${this.userId}`);
      }
      this.connectToSocket('textRoom', `ws://lamzaone.go.ro:8000/api/ws/textroom/${roomId}/${this.userId}`);
    }else{
      this.connectToSocket('textRoom', `ws://lamzaone.go.ro:8000/api/ws/textroom/${roomId}/${this.userId}`);
    }

  }

  joinAudioRoom(roomId: string): WebSocket | null {
    if (this.sockets['main']){
      if (this.sockets['main']!.readyState > 2){
        this.sockets['main']!.close();
        this.connectToSocket('main', `ws://lamzaone.go.ro:8000/api/ws/main/${this.userId}`);
        this.connectToSocket('audioRoom', `ws://lamzaone.go.ro:8000/api/ws/audiovideo/${roomId}/${this.userId}`);
      }
      this.connectToSocket('audioRoom', `ws://lamzaone.go.ro:8000/api/ws/audiovideo/${roomId}/${this.userId}`);
    }else{
      this.connectToSocket('audioRoom', `ws://lamzaone.go.ro:8000/api/ws/audiovideo/${roomId}/${this.userId}`);
    }
    return this.sockets['audioRoom'];
  }

  sendMessage(message: string, privateMsg: boolean = false, context: 'server' | 'audioRoom' | 'textRoom' = 'textRoom'): void {
    const socket = this.sockets[context];
    if (socket) {
      socket.send(JSON.stringify({ userId: this.userId, message, private: privateMsg }));
    }
  }

  disconnectAll(): void {
    Object.values(this.sockets).forEach(socket => socket?.close());
  }
}
