import { CommonModule } from '@angular/common';
import { Component, effect, signal } from '@angular/core';
import { ServersService } from '../services/servers.service';
import { UsersService } from '../services/users.service';
import { SocketService } from '../services/socket.service';

@Component({
  selector: 'app-connections',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './connections.component.html',
  styleUrls: ['./connections.component.scss'] // Fixed from styleUrl to styleUrls
})
export class ConnectionsComponent {
  userList = signal([] as any[]);
  currentServer = signal<any>(null);
  onlineUsers= signal([] as any[]);

  constructor(
    private userService: UsersService,
    private serverService: ServersService,
    private socketService: SocketService
  ) {
    effect(async () => {
      const serverId = this.serverService.currentServer()?.id;
      if (serverId) {
        console.log("server id is " + serverId);
        // Get all users in the server
        const userIds = await this.userService.getAllUsers(Number(serverId));
        const users = await Promise.all(userIds.map(async (userId: any) => {
          return await this.userService.getUserInfo(userId);
        }));
        this.userList.set(users);
        await this.userService.getOnlineUsers(Number(serverId)).then((users) => {
          this.onlineUsers.set(users);
        });
        console.log(this.userList());
      }
    });

    this.listenToSocket();
  }

  listenToSocket() {
    this.socketService.onServerMessage((data: any) => {
      console.log(data);
      const [userId, status] = data.split(': ');
      if (status === 'online') {
        this.onlineUsers.set([...this.onlineUsers(), Number(userId)]);
      } else if (status === 'offline') {
        this.onlineUsers.set(this.onlineUsers().filter((id) => id !== Number(userId)));
      }
      console.log(this.onlineUsers());
    });
  }


  isOnline(userId: string): boolean {
    if (this.onlineUsers().includes(userId)) {
      return true;
    } else {
      return false;
    }
  };
}
