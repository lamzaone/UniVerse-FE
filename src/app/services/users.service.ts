import { Injectable } from '@angular/core';
import axios from 'axios';

interface UserInfo {
  id: string;
  name: string;
  avatar: string;
  // Add any other fields that you expect from the user data
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

  getUsersInfo(userIds: string[]): Promise<UserInfo[]> {
    return axios.post('https://coldra.in/api/users/info', { userIds:userIds }).then(response => {
      const usersInfo = response.data;
      for (const userInfo of usersInfo) {
        this.userCache[userInfo.id] = userInfo; // Store user info in cache
      }
      return usersInfo;
    }).catch(error => {
      console.error('Failed to fetch users info', error);
      throw error;
    }
    );
  }

  // Method to get user info either from the cache or from the API
  getUserInfo(userId: string): Promise<UserInfo> {
    // Check if the user is already in the cache
    const cachedUser = this.getUserFromCache(userId);
    if (cachedUser) {
      return Promise.resolve(cachedUser); // Return cached user info
    }

    // If the user is not in the cache, fetch from the API
    return axios.get(`https://coldra.in/api/user/${userId}`).then(response => {
      const userInfo = response.data;
      this.userCache[userId] = userInfo; // Store user info in cache
      return userInfo;
    }).catch(error => {
      console.error(`Failed to fetch user info for userId: ${userId}`, error);
      throw error;
    });
  }

  // Method to clear a user from the cache (useful if user info is outdated)
  clearUserCache(userId: string): void {
    delete this.userCache[userId];
  }

  // Method to clear the entire cache if needed
  clearAllCache(): void {
    this.userCache = {};
  }
}
