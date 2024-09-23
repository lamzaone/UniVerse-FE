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
  styleUrls: ['./connections.component.scss']
})
export class ConnectionsComponent {
  userList = signal([] as any[]);
  onlineUsers = signal([] as any[]);
  offlineUsers = signal([] as any[]);

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
        const onlineUserIds = await this.userService.getOnlineUsers(Number(serverId));
        const users = await Promise.all(userIds.map(async (userId: any) => {
          const userInfo = await this.userService.getUserInfo(userId);
          if(userInfo.name.split(' ').length >= 3){
            userInfo.name = userInfo.name.split(' ')[0] + ' ' + userInfo.name.split(' ')[1];
          }
          return { ...userInfo, isOnline: onlineUserIds.includes(userId) };
        }));
        this.userList.set(users);
        this.updateUserStatus();
        console.log(onlineUserIds);
        console.log(this.onlineUsers());
        console.log(this.userList());
      }
    });

    this.listenToSocket();
  }

  listenToSocket() {
    this.socketService.onServerMessage((data: any) => {
      console.log(data);
      const [userId, status] = data.split(': ');
      this.userList.update((list) => {
        return list.map(user => {
          if (user.id === Number(userId)) {
            user.isOnline = status === 'online';
          }
          return user;
        });
      });
      this.updateUserStatus();
      console.log(this.userList());
    });
  }

  updateUserStatus() {
    const users = this.userList();
    this.onlineUsers.set(users.filter(user => user.isOnline));
    this.offlineUsers.set(users.filter(user => !user.isOnline));
  }
}
