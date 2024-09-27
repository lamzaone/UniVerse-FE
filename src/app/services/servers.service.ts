import { Injectable, signal } from '@angular/core';
import { AuthService } from './auth.service';
import axios from 'axios';

@Injectable({
  providedIn: 'root'
})
export class ServersService {
  // public currentRoom = signal<any>(null);  // Signal to hold current room data
  public servers = signal<any[]>([]); // Signal to hold server data
  public currentServer = signal<any>(null);
  user = this.authService.getUser();  // Fetch user from AuthService

  constructor(private authService: AuthService) {
    this.fetchServers();  // Fetch initial servers

    this.servers().forEach((server) => {
      console.log('Server:', server);
    });
  }


  // TODO: Add a signal to hold the current server data

  // async setCurrentRoom(room:{}) {
  //   this.currentRoom.set(room);
  // }

  async setCurrentServer(server: any) {
    this.currentServer.set(server);
  }


  // Create a server and update servers signal
  async createServer(serverName: string, description: string) {
    try {
      const response = await axios.post('https://coldra.in/api/server/create', {
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
      const response = await axios.post('https://coldra.in/api/server/' + serverId + '/category/create', {
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

  // Fetch servers for the user and update servers signal
  async fetchServers() {
    if (!this.authService.isLoggedIn()) return;
    try {
      const response = await axios.get('https://coldra.in/api/server/user/' + this.user.id);
      if (response.status === 200) {
        this.servers.set(response.data);  // Update the servers signal
      } else {
        console.error('Error getting servers for current user');
      }
    } catch (error) {
      console.error('Error fetching servers:', error);
    }
  }

  // Join a server and update servers signal
  async joinServer(serverCode: string) {
    if (this.authService.isLoggedIn()) {
      try {
        const response = await axios.post('https://coldra.in/api/server/join', {
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
  async getServer(serverId: number, userId: number) {
    try {
      const response = await axios.post('https://coldra.in/api/server', { server_id: serverId, user_id: userId });
      if (response.status === 200) {
        return response.data;
      } else {
        console.error('Error getting server with id:', serverId);
      }
    } catch (error) {
      console.error('Error fetching server:', error);
      throw error;
    }
  }

  // Fetch categories and rooms for a server
  async fetchCategoriesAndRooms(serverId: number) {
    try {
      const response = await axios.get('https://coldra.in/api/server/' + serverId + '/categories');
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
      const response = await axios.post('https://coldra.in/api/server/access', {
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
