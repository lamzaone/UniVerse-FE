import { Injectable, signal } from '@angular/core';
import { AuthService } from './auth.service';
import axios from 'axios';

@Injectable({
  providedIn: 'root'
})
export class ServersService {
  public currentRoom = signal<any>(null);  // Signal to hold current room data
  public servers = signal<any[]>([]); // Signal to hold server data
  user = this.authService.getUser();  // Fetch user from AuthService

  constructor(private authService: AuthService) {
    this.fetchServers();  // Fetch initial servers

    this.servers().forEach((server) => {
      console.log('Server:', server);
    });
  }

  async setCurrentRoom(room:{}) {
    this.currentRoom.set(room);
  }

  // Create a server and update servers signal
  async createServer(serverName: string, description: string) {
    try {
      const response = await axios.post('http://localhost:8000/server/create', {
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

  // Fetch servers for the user and update servers signal
  async fetchServers() {
    try {
      const response = await axios.get('http://localhost:8000/server/user/' + this.user.id);
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
    try {
      const response = await axios.post('http://localhost:8000/server/join', {
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

  // Fetch a specific server
  async getServer(serverId: number, userId: number) {
    try {
      const response = await axios.post('http://localhost:8000/server', { server_id: serverId, user_id: userId });
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
      const response = await axios.get('http://localhost:8000/server/' + serverId + '/categories');
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
}
