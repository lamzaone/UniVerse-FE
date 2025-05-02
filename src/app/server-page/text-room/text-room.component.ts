import { SocketService } from '../../services/socket.service';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Component, ElementRef, OnInit, ViewChild, signal } from '@angular/core';
import { ServersService } from '../../services/servers.service';
import axios from 'axios';
import { AuthService } from '../../services/auth.service';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';
import { FormsModule, NgModel } from '@angular/forms';
import { skip } from 'node:test';

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

  paramz:any;
  private previousRouteId: number | null = null; // Store the previous route_id

  // TODO: ADD MARKDOWN (RICH TEXT EDITOR) SUPPORT
  constructor(
    private socketService: SocketService,
    private route: ActivatedRoute,
    private serversService: ServersService,
    private authService: AuthService,
    private usersService: UsersService,
    private router: Router
  ) {

    this.listenForMessages();
  }

  ngOnInit(): void {
    // Initialize the route_id and join the text room
    this.paramz=this.route.params.subscribe(params => {
      this.route_id = +params['room_id'];
      console.log("Room id: "+this.route_id)
      this.socketService.joinTextRoom(this.route_id!.toString());
      this.fetchMessages();
    });

    // Initialize the room signal
    // this.room = this.serversService.currentRoom;
  }

  // FIXME: FIX FETCHING A TEXTROOM THAT DOESNT EXIST
  // FIXME: FIX FETCHING A TEXTROOM FROM ANOTHER SERVER
  async fetchMessages() {
    if (this.previousRouteId === this.route_id) {
      return; // Prevent fetch if it's the same room
    }

    this.previousRouteId = this.route_id; // Update the previous route_id
    try {
      this.serversService.fetchMessages(this.route_id!);
      const response = await this.serversService.fetchMessages(this.route_id!);


      const groupedMessages = []; // Array of message groups
      let messageGroup = [];      // Current group of messages

      for (let i = 0; i < response.data.length; i++) {
        const message = response.data[i];
        const user = await this.usersService.getUserInfo(message.user_id);
        message.user = user;      // Add user info to the message for picture etc.


        // If there's a next message, check if it's from the same user and within 2 minutes
        const nextMessage = response.data[i + 1];
        const messageTime = new Date(message.timestamp).getTime();

        // Format the timestamp to be more readable
        const today = new Date();
        if (new Date(message.timestamp).toDateString() === today.toDateString()) {
          // If the message was sent today, only show the time
          message.timestamp = 'Today at ' + (new Date(message.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
        } else { // If the message was sent on a different day, show the date and time
          message.timestamp = new Date(message.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) + ' ' + new Date(message.timestamp).toLocaleDateString('en-US', {year: 'numeric', month: 'short', day: 'numeric' });
        }

        if (nextMessage) {  // If there's a next message after the current one
          const nextMessageTime = new Date(nextMessage.timestamp).getTime();
          const isWithinTimeLimit = nextMessageTime - messageTime < 180000;     // Check if the next message was sent within 1 minutes

          if (nextMessage.user_id === message.user_id && isWithinTimeLimit) {
            if (messageGroup.length === 0) { // If the group is empty, push the current message
              messageGroup.push(message);
            }
            messageGroup.push(nextMessage);  // Push the next message to the group
            } else {
            // If the group has multiple messages, push it to the groupedMessages array
            if (messageGroup.length > 0) {
              groupedMessages.push(messageGroup);
              messageGroup = [];
            } else {
              // Push individual message (not part of a group)
              groupedMessages.push([message]);
            }
          }
        } else {
          // Last message (no next message to compare), push it either as a group or single message
          if (messageGroup.length > 0) {
            groupedMessages.push(messageGroup);
            messageGroup = [];
          } else {
            groupedMessages.push([message]);
          }
        }
      }

      // Update the messages signal with grouped messages
      this.messages.set(groupedMessages);
      this.previousRouteId = 0;
      // Scroll to the last message if necessary
      const lastMessage = document.getElementById('last-message');
      const isLastMessageInView = lastMessage ? lastMessage.getBoundingClientRect().top <= window.innerHeight : false;

      if (isLastMessageInView) this.scrollToLast();

    } catch (error) {
      this.router.navigate(['server', this.serversService.currentServer().id, 'dashboard']);
      return;
    }
  }



  listenForMessages() {
    this.socketService.onTextRoomMessage((data: any) => {
      console.log("Received message from socket:", data);
      if (data === 'room_deleted') {
        this.router.navigate(['server', this.serversService.currentServer().id, 'dashboard']);
        return;
        // TODO: check if this works
      }
      this.fetchMessages();
    });

  }

  async sendMessage(isPrivate: boolean = false): Promise<void> {

    if (this.messageText.trim() == '') return;
    try {
      const response = await axios.post('http://lamzaone.go.ro:8000/api/message', {
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
