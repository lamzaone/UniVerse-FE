// import { Injectable } from '@angular/core';
// import { Socket } from 'ngx-socket-io';
// import { AuthService } from './auth.service';
// import { ServersService } from './servers.service';

// @Injectable({
//   providedIn: 'root'
// })
// export class SocketService {
//   private userId: string | null = null;
//   private serverSocket: WebSocket | null = null;
//   private textRoomSocket: WebSocket | null = null;

//   constructor(
//     private socket: Socket,
//     private authService: AuthService
//   ) {
//     this.userId = this.authService.getUser().id;
//     this.setupListeners();
//   }

//   connectMain() {
//     if (this.userId) {
//       this.socket.ioSocket = new WebSocket(`ws://localhost:8000/ws/main/${this.userId}`);
//     }
//   }

//   joinServer(serverId: string) {
//     if (this.userId) {
//       this.serverSocket = new WebSocket(`ws://localhost:8000/ws/server/${serverId}/${this.userId}`);
//       this.setupServerListeners();
//     }
//   }

//   joinTextRoom(roomId: string) {
//     if (this.userId && this.serverSocket) {
//       this.textRoomSocket = new WebSocket(`ws://localhost:8000/ws/textroom/${this.serverSocket.url}/${roomId}/${this.userId}`);
//       this.setupTextRoomListeners();
//     }
//   }

//   sendMessage(message: string, privateMsg: boolean = false) {
//     if (this.textRoomSocket) {
//       this.textRoomSocket.send(JSON.stringify({ roomId: this.textRoomSocket.url, userId: this.userId, message, private: privateMsg }));
//     } else if (this.serverSocket) {
//       this.serverSocket.send(JSON.stringify({ serverId: this.serverSocket.url, userId: this.userId, message, private: privateMsg }));
//     }
//   }

//   setupListeners() {
//     this.socket.on('main_server_update', (data: any) => {
//       console.log('Main server update', data);
//     });
//   }

//   setupServerListeners() {
//     this.serverSocket?.addEventListener('message', (event) => {
//       const data = JSON.parse(event.data);
//       console.log('Server update', data);
//     });
//   }

//   setupTextRoomListeners() {
//     this.textRoomSocket?.addEventListener('message', (event) => {
//       const data = JSON.parse(event.data);
//       console.log('Text room message', data);
//     });
//   }

//   disconnect() {
//     if (this.serverSocket) this.serverSocket.close();
//     if (this.textRoomSocket) this.textRoomSocket.close();
//     this.socket.disconnect();
//   }
// }
