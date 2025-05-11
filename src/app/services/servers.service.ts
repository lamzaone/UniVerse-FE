import { Injectable, signal } from '@angular/core';
import { AuthService } from './auth.service';
import axios from 'axios';
import { Router } from '@angular/router';
import api from './api.service';

@Injectable({
  providedIn: 'root'
})
export class ServersService {
  // public currentRoom = signal<any>(null);  // Signal to hold current room data
  public servers = signal<any[]>([]); // Signal to hold server data
  public currentServer = signal<any>(null);
  user = this.authService.getUser();  // Fetch user from AuthService

  constructor(private authService: AuthService, private router: Router) {
    this.fetchServers();  // Fetch initial servers

    this.servers().forEach((server) => {
      console.log('Server:', server);
    });
  }


  // TODO: Add a signal to hold the current server data


  async setCurrentServer(server: any) {
    this.currentServer.set(server);
  }


  // Create a server and update servers signal
  async createServer(serverName: string, description: string) {
    try {
      const response = await api.post('http://lamzaone.go.ro:8000/api/server/create', {
        name: serverName,
        description: description,
        owner_id: this.user.id
      });

      if (response.status === 200) {
        this.fetchServers();  // Refresh server list
        return response.data;
      } else {
        throw new Error('Server creation failed');
      }
    } catch (error) {
      console.error('Server creation error:', error);
      throw error;
    }
  }


  async createCategory(serverId: number, categoryName: string, categoryDescription: string) {
    try {
      const response = await api.post('http://lamzaone.go.ro:8000/api/server/' + serverId + '/category/create', {
        category_name: categoryName,
      });
      if (response.status === 200) {
        return response.data;
      } else {
        throw new Error('Category creation failed');
      }
    } catch (error) {
      console.error('Category creation error:', error);
      throw error;
    }
  }

  async createRoom(serverId: number, roomName: string, roomType: string, categoryId: number|null ) {
    try {
      if (categoryId === null) categoryId = 0;
      const response = await api.post('http://lamzaone.go.ro:8000/api/server/' + serverId + '/room/create?room_name='+roomName+'&room_type='+roomType+'&category_id='+categoryId);
      // server_id: int, room_name: str, room_type: str, db: db_dependency, category_id:
      if (response.status === 200) {
        return response.data;
      } else {
        throw new Error('Room creation failed');
      }
    } catch (error) {
      console.error('Room creation error:', error);
      throw error;
    }
  }

  // Fetch servers for the user and update servers signal
  async fetchServers() {
    if (!this.authService.isLoggedIn()) return;
    try {
      const response = await api.get('http://lamzaone.go.ro:8000/api/server/user/' + this.user.id);
      if (response.status === 200) {
        this.servers.set(response.data);  // Update the servers signal
      } else {
        console.error('Error getting servers for current user');
      }
    } catch (error) {
      console.error('Error fetching servers:', error);
    }
  }

  async fetchMessages(route_id:number){
    const response = await api.post(
      'http://lamzaone.go.ro:8000/api/messages',
      {
        room_id: route_id,
        user_token: this.authService.getUser().token
      }
    );
    return response;
  }

  // Join a server and update servers signal
  async joinServer(serverCode: string) {
    if (this.authService.isLoggedIn()) {
      try {
        const response = await api.post('http://lamzaone.go.ro:8000/api/server/join', {
          invite_code: serverCode,
          user_id: this.user.id
        });

        if (response.status === 200) {
          this.fetchServers();  // Refresh server list
          return response.data;
        } else {
          throw new Error('Joining server failed');
        }
      } catch (error) {
        console.error('Error joining server with code:', serverCode);
        throw error;
      }
    }
  }

  // Fetch a specific server
  // TODO: switch userID to user token for security reasons
  async getServer(serverId: number, userId: number) {
    try {
      const response = await api.post('http://lamzaone.go.ro:8000/api/server', { server_id: serverId, user_id: userId });
      if (response.status === 200) {
        return response.data;
      } else {
        console.error('Error getting server with id:', serverId);
        this.router.navigate(['dashboard']);
      }
    } catch (error) {
      this.router.navigate(['dashboard']);
      console.error('Error fetching server:', error);
      throw error;
    }
  }

  // Fetch categories and rooms for a server
  async fetchCategoriesAndRooms(serverId: number) {
    try {
      const response = await api.get('http://lamzaone.go.ro:8000/api/server/' + serverId + '/categories');
      if (response.status === 200) {
        return response.data;
      } else {
        throw new Error('Error fetching categories and rooms');
      }
    } catch (error) {
      console.error('Error fetching categories and rooms:', error);
      throw error;
    }
  }



  async getAccessLevel(serverId: number):Promise<number> {
    try {
      const response = await api.post('http://lamzaone.go.ro:8000/api/server/access', {
        token: this.authService.getUser().token,
        server_id: serverId
      });

      if (response.status === 200) {
        return response.data;
      } else {
        throw new Error('Error getting access level');
      }
    } catch (error) {
      console.error('Error getting access level:', error);
      throw error;
    }
  }

}
