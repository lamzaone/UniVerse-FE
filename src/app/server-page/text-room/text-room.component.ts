import { SocketService } from '../../services/socket.service';
import { ActivatedRoute } from '@angular/router';
import { Component, OnInit, signal } from '@angular/core';
import { ServersService } from '../../services/servers.service';
import axios from 'axios';
import { AuthService } from '../../services/auth.service';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';

@Component({
  selector: 'app-text-room',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './text-room.component.html',
  styleUrls: ['./text-room.component.scss']
})
export class TextRoomComponent implements OnInit {
  route_id: number | null = null;
  room = signal<any>(null);
  messages = signal<any>(null);

  constructor(
    private socketService: SocketService,
    private route: ActivatedRoute,
    private serversService: ServersService,
    private authService: AuthService,
    private usersService: UsersService
  ) {

    this.listenForMessages();
  }

  ngOnInit(): void {
    // Initialize the route_id and join the text room
    this.route.params.subscribe(params => {
      this.route_id = +params['room_id'];
      this.socketService.joinTextRoom(this.route_id!.toString());
      this.fetchMessages();
    });

    // Initialize the room signal
    this.room = this.serversService.currentRoom;
    // Fetch messages
  }

  async fetchMessages() {
    try {
      const response = await axios.post(
        'https://coldra.in/api/messages',
        {
          room_id: this.route_id,
          user_token: this.authService.userData().token
        }
      );

      // Fetch user info for each message
      for (const message of response.data) {
        const user = await this.usersService.getUserInfo(message.user_id);
        message.user = user;
      }

      this.messages.set(response.data); // Assuming response.data contains the messages
    } catch (error) {
      console.error('Error fetching messages:', error);
    }
  }


  listenForMessages() {
    this.socketService.onTextRoomMessage((data: any) => {
      console.log("Received message from socket:", data);
      this.fetchMessages();
    });

  }

  adjustHeight(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    textarea.style.height = 'auto'; // Reset height to auto
    textarea.style.height = `${textarea.scrollHeight}px`; // Set height based on scrollHeight
  }
}
