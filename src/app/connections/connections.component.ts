import { CommonModule } from '@angular/common';
import { Component, effect, signal } from '@angular/core';
import { ServersService } from '../services/servers.service';
import { UsersService } from '../services/users.service';
import { SocketService } from '../services/socket.service';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-connections',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './connections.component.html',
  styleUrls: ['./connections.component.scss']
})
export class ConnectionsComponent {
  userList = signal([] as any[]);           // All users in the server (or friends)
  currentUser = signal({} as any);          // Current user
  onlineUsers = signal([] as any[]);        // All online users list
  offlineUsers = signal([] as any[]);       // All offline users list


  constructor(
    private userService: UsersService,
    private serverService: ServersService,
    private socketService: SocketService,
    private authService: AuthService
  ) {
    this.currentUser.set(this.authService.getUser());  // Set the current user

    // Wait for changes in the currentServer signal (on server change) and fetch users on server change
    effect(async () => {
      const serverId = this.serverService.currentServer()?.id;
      if (serverId) {
        console.log("server id is " + serverId);
        // Get all users in the server
        const userIds = await this.userService.getAllUsers(Number(serverId));
        // Get online users in the server
        const onlineUserIds = await this.userService.getOnlineUsers(Number(serverId));

        // Fetch user info for each user, add the isOnline property and shorten long names
        const users = await Promise.all(userIds.map(async (userId: any) => {
          const userInfo = await this.userService.getUserInfo(userId);
          if(userInfo.name.split(' ').length >= 3){
            // if the user has more than 2 names, combine the first and last
              userInfo.name = this.simplyfyName(userInfo.name);
          }
          // Add isOnline property to the user
          return { ...userInfo, isOnline: onlineUserIds.includes(userId) };
        }));
        this.userList.set(users);

        // Call the function to update online and offline user lists
        this.updateUseruserEvent();
      }
    });

    this.listenToSocket();  // Listen for new Connections coming on/off-line
  }



  listenToSocket() {
    this.socketService.onServerMessage((data: any) => {
      try{
        const [userId, userEvent] = data.split(': ');      // Split the data coming as 'userId: userEvent'

        // handle user join
        if (userEvent === 'joined'){
          void this.userService.getUserInfo(String(userId)).then((userInfo: any) => {
            if (userInfo.name.split(' ').length >= 3) {
              // if the user has more than 2 names, combine the first and last
              userInfo.name = this.simplyfyName(userInfo.name);
            }
            // Update the userList signal
            this.userList.update((list) => {
              return [...list, { ...userInfo, isOnline: true }];
            });

            this.updateUseruserEvent();
          });


        }

         // handle user online status
        if (userEvent === 'online' || userEvent === 'offline') {  // Check if the userEvent is online or offline
          this.userList.update((list) => {                // Update the userList signal with the new user userEvent (based on current value)
            return list.map(user => {
              if (user.id === Number(userId)) {               // if the user id matches the userId from the data
                user.isOnline = userEvent === 'online';          // update the isOnline property
              }
              return user;
            });
          });

          this.updateUseruserEvent();
        }
      } catch (error) {
        console.error(error);
      }



      // if (this.userList().map(user => user.id).includes(Number(userId))) {
      //   this.userList.set(this.userList().map(user => {
      //     if (user.id === Number(userId)) {
      //       user.isOnline = userEvent === 'online';
      //     }
      //     return user;
      //   }));
      // }

      // Call the function to update online and offline user lists
      this.updateUseruserEvent();
      console.log(this.userList());
    });
  }

  updateUseruserEvent() {
  const users = this.userList(); // Get the current user list (after being updated or just fetched)
  this.onlineUsers.set(users.filter(user => user.isOnline)
    .filter(user => user.id !== this.currentUser().id)); // Exclude current user;
  this.offlineUsers.set(users.filter(user => !user.isOnline)
    .filter(user => user.id !== this.currentUser().id)); // Exclude current user;
  }

  simplyfyName(name: string) {
    return name.split(' ')[0] + ' ' + name.split(' ')[name.split(' ').length - 1];
  }
}
