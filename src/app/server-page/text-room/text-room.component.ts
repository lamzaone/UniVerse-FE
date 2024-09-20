import { SocketService } from '../../services/socket.service';
import { ActivatedRoute } from '@angular/router';
import { Component, ElementRef, OnInit, ViewChild, signal } from '@angular/core';
import { ServersService } from '../../services/servers.service';
import axios from 'axios';
import { AuthService } from '../../services/auth.service';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';
import { FormsModule, NgModel } from '@angular/forms';

@Component({
  selector: 'app-text-room',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './text-room.component.html',
  styleUrls: ['./text-room.component.scss']
})
export class TextRoomComponent implements OnInit {
  @ViewChild('messageInput') messageInput!: ElementRef<HTMLTextAreaElement>;
  route_id: number | null = null;
  room = signal<any>(null);
  messages = signal<any>(null);
  messageText = '';

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

      // TODO: Edit to take all the user IDs and fetch them in one request
      // fetch all IDs and send to API to get all user info (only save the ids once) in a []

      for (const message of response.data) {
        const user = await this.usersService.getUserInfo(message.user_id);
        message.user = user;

        // edit timestamp to readable format
        message.timestamp = new Date(message.timestamp).toLocaleString();
      }

      // check if lastMessage is in view
      const lastMessage = document.getElementById('last-message');
      const isLastMessageInView = lastMessage ? lastMessage.getBoundingClientRect().top <= window.innerHeight : false;

      this.messages.set(response.data);

      if (isLastMessageInView) this.scrollToLast();
      // scroll to ngModel "last-message" to show the latest message

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

  async sendMessage(isPrivate: boolean = false): Promise<void> {

    if (this.messageText.trim() == '') return;
    try {
      const response = await axios.post('https://coldra.in/api/message', {
        message: this.messageText,
        room_id: this.route_id,
        is_private: isPrivate,
        user_token: this.authService.userData().token,
        reply_to: 0
      });

      this.messageText = '';

      if (this.messageInput) {
        const textarea = this.messageInput.nativeElement;
        textarea.style.height = 'auto';
      }

      this.scrollToLast();
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }

  scrollToLast(){
    const lastMessage = document.getElementById('last-message');
    if (lastMessage) {

      lastMessage.scrollIntoView({ behavior: 'smooth' , block:'end'});
      setTimeout(() => {
        lastMessage.scrollIntoView({ behavior: 'smooth' , block:'end'});
      }, 100);

    }
  }

  adjustHeight(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    const messages = document.getElementById('messages') as HTMLElement;

    // TODO: style textarea
    textarea.style.height = '1rem';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  // handle enter to sendMessage()
  handleEnter(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }


}
