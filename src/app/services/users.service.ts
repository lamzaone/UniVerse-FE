import { Injectable } from '@angular/core';
import axios from 'axios';
import api from './api.service';
export interface UserInfo {
  id: number;
  name: string;
  email: string;
  nickname: string;
  picture: string;
}

@Injectable({
  providedIn: 'root'
})
export class UsersService {

  // Cache to store user information
  private userCache: { [userId: string]: UserInfo } = {};

  constructor() { }

  // Method to get a user from the cache if it exists
  getUserFromCache(userId: string): UserInfo | null {
    return this.userCache[userId] || null;
  }

  async getUsersInfo(userIds: string[]): Promise<UserInfo[]> {
    return await api.post('http://lamzaone.go.ro:8000/api/users/info', { userIds:userIds }).then(response => {
      const usersInfo = response.data;
      for (const userInfo of usersInfo) {
        this.userCache[userInfo.id] = userInfo; // Store user info in cache
        console.log(userInfo.picture);

      }
      return usersInfo;
    }).catch(error => {
      console.error('Failed to fetch users info', error);
      throw error;
    }
    );
  }

  // Method to get user info either from the cache or from the API
  async getUserInfo(userId: string): Promise<UserInfo> {
    // Check if the user is already in the cache
    const cachedUser = this.getUserFromCache(userId);
    if (cachedUser) {
      return Promise.resolve(cachedUser);
    }

    // If the user is not in the cache, fetch from the API
    try {
      const response = await api.get(`/user/${userId}`);
      const userInfo: UserInfo = response.data;
      this.userCache[userId] = userInfo; // Store user info in cache
      return userInfo;
    } catch (error) {
      console.error(`Failed to fetch user info for userId: ${userId}`, error);
      throw error;
    }
  }

    async getUsersInfoByIds(userIds: string[]): Promise<UserInfo[]> {
      // Check cache for each userId and collect missing ones
      const cachedUsers: UserInfo[] = [];
      const missingUserIds: string[] = [];

      for (const userId of userIds) {
        const cachedUser = this.getUserFromCache(userId);
        if (cachedUser) {
          cachedUsers.push(cachedUser);
        } else {
          missingUserIds.push(userId);
        }
      }

      // If all users are cached, return them
      if (missingUserIds.length === 0) {
        return Promise.resolve(cachedUsers);
      }

      // Fetch missing users from API
      try {
        const response = await api.post('http://lamzaone.go.ro:8000/api/users/info', { userIds: missingUserIds });
        const fetchedUsers: UserInfo[] = response.data;
        for (const userInfo of fetchedUsers) {
          this.userCache[userInfo.id] = userInfo;
        }
        return [...cachedUsers, ...fetchedUsers];
      } catch (error) {
        console.error('Failed to fetch users info', error);
        throw error;
      }
    }


  // Method to clear a user from the cache (useful if user info is outdated)
  clearUserCache(userId: string): void {
    delete this.userCache[userId];
  }

  // Method to clear the entire cache if needed
  clearAllCache(): void {
    this.userCache = {};
  }

  async getOnlineUsers(server_id: number = 0) : Promise<string[]> {

    return await api.get(`http://lamzaone.go.ro:8000/api/server/${server_id}/online`).then(response => {
      return response.data;
    }).catch(error => {
      console.error('Failed to fetch online users', error);
      throw error;
    });
  }

  async getAllUsers(server_id: number = 0) : Promise<string[]> {

    return await api.get(`http://lamzaone.go.ro:8000/api/server/${server_id}/users`).then(response => {
      return response.data;
    }
    ).catch(error => {
      console.error('Failed to fetch all users', error);
      throw error;
    });
  }


}
