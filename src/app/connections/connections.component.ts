import { CommonModule } from '@angular/common';
import { Component, effect, signal } from '@angular/core';
import { ServersService } from '../services/servers.service';
import { UsersService } from '../services/users.service';

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

  constructor(
    private userService: UsersService,
    private serverService: ServersService
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
        console.log(this.userList());
      }
    });
  }
}
