import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class SocketService {
  private userId: string | null = null;
  private mainSocket: WebSocket | null = null;
  private serverSocket: WebSocket | null = null;
  private textRoomSocket: WebSocket | null = null;

  constructor(private authService: AuthService) {
    this.userId = this.authService.getUser().id;
    this.connectMain();
  }

  private connectMain() {
    if (this.userId) {
      this.mainSocket = new WebSocket(`ws://localhost:8000/ws/main/${this.userId}`);
      this.mainSocket.onopen = () => console.log('Connected to main server socket');
      this.mainSocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Main server update:', data);
      };
      this.mainSocket.onclose = () => console.log('Disconnected from main server socket');
    }
  }

  joinServer(serverId: string) {
    if (this.userId) {
      this.serverSocket?.close(); // Close any previous server socket
      this.serverSocket = new WebSocket(`ws://localhost:8000/ws/server/${serverId}/${this.userId}`);
      this.serverSocket.onopen = () => console.log('Connected to server socket');
      this.serverSocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Server update:', data);
      };
      this.serverSocket.onclose = () => console.log('Disconnected from server socket');
    }
  }

  joinTextRoom(roomId: string) {
    if (this.userId && this.serverSocket) {
      const serverId = this.serverSocket.url.split('/')[4]; // Extract server ID from URL
      this.textRoomSocket?.close(); // Close any previous text room socket
      this.textRoomSocket = new WebSocket(`ws://localhost:8000/ws/textroom/${roomId}/${this.userId}`);
      this.textRoomSocket.onopen = () => console.log('Connected to text room socket');
      this.textRoomSocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Text room message:', data);
      };
      this.textRoomSocket.onclose = () => console.log('Disconnected from text room socket');
    }
  }

  sendMessage(message: string, privateMsg: boolean = false) {
    if (this.textRoomSocket) {
      const roomId = this.textRoomSocket.url.split('/')[5]; // Extract room ID from URL
      this.textRoomSocket.send(JSON.stringify({ roomId, userId: this.userId, message, private: privateMsg }));
    } else if (this.serverSocket) {
      const serverId = this.serverSocket.url.split('/')[4]; // Extract server ID from URL
      this.serverSocket.send(JSON.stringify({ serverId, userId: this.userId, message, private: privateMsg }));
    }
  }

  disconnect() {
    if (this.mainSocket) this.mainSocket.close();
    if (this.serverSocket) this.serverSocket.close();
    if (this.textRoomSocket) this.textRoomSocket.close();
  }
}
