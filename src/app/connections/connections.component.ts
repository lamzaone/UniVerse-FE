import { CommonModule } from '@angular/common';
import { Component, effect, HostListener, signal } from '@angular/core';
import { ServersService } from '../services/servers.service';
import { UsersService } from '../services/users.service';
import { SocketService } from '../services/socket.service';
import { AuthService } from '../services/auth.service';
import api from '../services/api.service';

interface User {
  id: number;
  name: string;
  picture: string;
  isOnline: boolean;
  access_level?: number;
}

@Component({
  selector: 'app-connections',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './connections.component.html',
  styleUrls: ['./connections.component.scss']
})
export class ConnectionsComponent {
  userList = signal<User[]>([]);
  currentUser = signal<User>({ id: 0, name: 'Loading...', picture: 'default-avatar.png', isOnline: true });
  onlineUsers = signal<User[]>([]);
  offlineUsers = signal<User[]>([]);
  assistants = signal<User[]>([]);
  professors = signal<User[]>([]);
  isUser = false;
  showContextMenu = false;
  clickedUserId: string | null = null;
  clickedUser: User | null = null;
  serverAccessLevel = 0;
  contextMenuPosition: { x: number; y: number } = { x: 0, y: 0 };
  currentUserId: number = 0;

  constructor(
    private userService: UsersService,
    private serverService: ServersService,
    private socketService: SocketService,
    private authService: AuthService
  ) {
    // Initialize currentUser
    const user = this.authService.getUser();
    console.log('authService.getUser():', user);
    this.currentUser.set({
      id: Number(user.id) || 0,
      name: user.name || 'Loading...',
      picture: user.picture || 'default-avatar.png', // Fallback for picture
      isOnline: true
    });

    // Update serverAccessLevel when currentServer changes
    const interval = setInterval(() => {
      const currentServer = this.serverService.currentServer();
      if (currentServer && currentServer.access_level !== undefined) {
        this.serverAccessLevel = currentServer.access_level;
        console.log('current user:', this.currentUser());
        clearInterval(interval);
      }
    }, 100);

    // Fetch users and access levels when server changes
    effect(async () => {
      const serverId = this.serverService.currentServer()?.id;
      if (serverId) {
        console.log('server id is ' + serverId);
        const userIds = await this.userService.getAllUsers(Number(serverId));
        const onlineUserIds = await this.userService.getOnlineUsers(Number(serverId));

        // Fetch user info and access levels
        const users = await Promise.all(
          userIds.map(async (userId: any) => {
            const userInfo = await this.userService.getUserInfo(userId);
            if (userInfo.name.split(' ').length >= 3) {
              userInfo.name = this.simplyfyName(userInfo.name);
            }
            const accessLevel = await this.getUserAccessLevel(serverId, Number(userId));
            console.log('userInfo:', userInfo);
            return {
              id: Number(userInfo.id),
              name: userInfo.name,
              picture: userInfo.picture || 'default-avatar.png',
              isOnline: onlineUserIds.includes(userId),
              access_level: accessLevel
            };
          })
        );

        // Exclude currentUser from userList
        this.userList.set(users.filter(user => user.id !== this.currentUserId));
        console.log('userList:', this.userList());
        this.updateUseruserEvent();
        this.categorizeUsers();
      }
    });

    // Update currentUserId and serverAccessLevel when signals change
    effect(() => {
      this.serverAccessLevel = this.serverService.currentServer().access_level || 0;
      this.currentUserId = this.currentUser().id;
    });

    this.listenToSocket();
  }

  // Fetch access level for a user
  async getUserAccessLevel(serverId: number, userId: number): Promise<number> {
    try {
      const response = await api.get(`/server/${serverId}/user/${userId}/access_level`);
      return response?.data?.access_level ?? 0;
    } catch (error) {
      console.error(`Error fetching access level for user ${userId}:`, error);
      return 0; // Fallback access level
    }
  }

  // Categorize users into assistants and professors
  categorizeUsers() {
    const users = this.userList();
    this.assistants.set(users.filter(user => user.access_level === 1));
    this.professors.set(users.filter(user => user.access_level! > 1));
    console.log('Assistants:', this.assistants());
    console.log('Professors:', this.professors());
  }

  listenToSocket() {
    this.socketService.onServerMessage((data: any) => {
      try {
        const [userId, userEvent] = data.split(': ');
        const numericUserId = Number(userId);
        if (isNaN(numericUserId)) {
          console.error('Invalid userId:', userId);
          return;
        }

        if (userEvent === 'joined') {
          this.userService.getUserInfo(String(numericUserId)).then(async (userInfo: any) => {
            if (userInfo.name.split(' ').length >= 3) {
              userInfo.name = this.simplyfyName(userInfo.name);
            }
            const serverId = this.serverService.currentServer()?.id;
            const accessLevel = serverId ? await this.getUserAccessLevel(serverId, numericUserId) : 0;
            this.userList.update(list => {
              if (!list.some(user => user.id === numericUserId) && numericUserId !== this.currentUserId) {
                return [
                  ...list,
                  {
                    id: Number(userInfo.id),
                    name: userInfo.name,
                    picture: userInfo.picture || 'default-avatar.png',
                    isOnline: true,
                    access_level: accessLevel
                  }
                ];
              }
              return list;
            });
            this.updateUseruserEvent();
            this.categorizeUsers();
          });
        }

        if (userEvent === 'online' || userEvent === 'offline') {
          this.userList.update(list => {
            return list.map(user => {
              if (user.id === numericUserId) {
                user.isOnline = userEvent === 'online';
              }
              return user;
            });
          });
          this.updateUseruserEvent();
          this.categorizeUsers();
        }
      } catch (error) {
        console.error('Socket error:', error);
      }
    });
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    this.showContextMenu = false;
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscapePress(event: KeyboardEvent): void {
    this.showContextMenu = false;
  }

  onRightClick(event: MouseEvent): void {
    event.preventDefault();
    let targetElement = event.target as HTMLElement;

    while (targetElement && !targetElement.classList.contains('user')) {
      targetElement = targetElement.parentElement as HTMLElement;
    }

    this.isUser = !!targetElement;
    if (this.isUser) {
      this.clickedUserId = targetElement.getAttribute('user-id');
      this.clickedUser = this.getUserById(this.clickedUserId);
      console.log('clickedUser:', this.clickedUser);
    } else {
      this.clickedUserId = null;
      this.clickedUser = null;
    }

    this.contextMenuPosition = { x: event.clientX - 300, y: event.clientY };
    this.showContextMenu = true;
  }

  getUserById(userId: string | null): User | null {
    if (!userId) return null;
    return this.userList().find(user => user.id === Number(userId)) || null;
  }

  updateUseruserEvent() {
    const users = this.userList();
    this.onlineUsers.set(
      users
      .filter(user => user.isOnline)
      .filter(user => user.id !== this.currentUser().id)
      .filter(user => (user.access_level ?? 0) === 0)
    );
    this.offlineUsers.set(
      users
      .filter(user => !user.isOnline)
      .filter(user => user.id !== this.currentUser().id)
      .filter(user => (user.access_level ?? 0) === 0)
    );
  }

  simplyfyName(name: string) {
    return name.split(' ')[0] + ' ' + name.split(' ')[name.split(' ').length - 1];
  }

  // Promote user to assistant (access_level = 1)
  async promoteToAssistant() {
    if (!this.clickedUser || this.serverAccessLevel !== 3) return;
    const serverId = this.serverService.currentServer()?.id;
    if (!serverId) return;

    try {
      await api.patch(`/server/${serverId}/user/${this.clickedUser.id}/access_level`, {access_level:1});
      this.userList.update(list =>
        list.map(user =>
          user.id === this.clickedUser!.id ? { ...user, access_level: 1 } : user
        )
      );
      this.categorizeUsers();
      this.showContextMenu = false;
    } catch (error) {
      console.error(`Error promoting user ${this.clickedUser.id} to assistant:`, error);
    }
  }

  // Promote assistant to level 2 (access_level = 2)
  async promoteToLevel2() {
    if (!this.clickedUser || this.serverAccessLevel !== 3) return;
    const serverId = this.serverService.currentServer()?.id;
    if (!serverId) return;

    try {
      await api.patch(`/server/${serverId}/user/${this.clickedUser.id}/access_level`,{ access_level: 2 });
      this.userList.update(list =>
        list.map(user =>
          user.id === this.clickedUser!.id ? { ...user, access_level: 2 } : user
        )
      );
      this.categorizeUsers();
      this.showContextMenu = false;
    } catch (error) {
      console.error(`Error promoting user ${this.clickedUser.id} to level 2:`, error);
    }
  }

  // Demote user (reduce access_level by 1, minimum 0)
  async demoteUser() {
    if (!this.clickedUser || this.serverAccessLevel !== 3 || !this.clickedUser.access_level) return;
    const serverId = this.serverService.currentServer()?.id;
    if (!serverId) return;

    const newAccessLevel = Math.max(0, this.clickedUser.access_level - 1);
    try {
      await api.patch(
        `/server/${serverId}/user/${this.clickedUser.id}/access_level`,
        { access_level: newAccessLevel }
      );
      this.userList.update(list =>
        list.map(user =>
          user.id === this.clickedUser!.id ? { ...user, access_level: newAccessLevel } : user
        )
      );
      this.categorizeUsers();
      this.showContextMenu = false;
    } catch (error) {
      console.error(`Error demoting user ${this.clickedUser.id}:`, error);
    }
  }

  // Remove user from server
  async removeUser() {
    if (!this.clickedUser || this.serverAccessLevel !== 3) return;
    const serverId = this.serverService.currentServer()?.id;
    if (!serverId) return;

    try {
      await api.delete(`/server/${serverId}/user/${this.clickedUser.id}`);
      this.userList.update(list => list.filter(user => user.id !== this.clickedUser!.id));
      this.categorizeUsers();
      this.showContextMenu = false;
    } catch (error) {
      console.error(`Error removing user ${this.clickedUser.id}:`, error);
    }
  }

  LogOut(){
    this.authService.logout();
  }
}
