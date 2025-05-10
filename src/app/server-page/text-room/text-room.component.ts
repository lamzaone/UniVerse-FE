import { SocketService } from '../../services/socket.service';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Component, ElementRef, OnInit, ViewChild, signal } from '@angular/core';
import { ServersService } from '../../services/servers.service';
import axios from 'axios';
import { AuthService } from '../../services/auth.service';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';
import { FormsModule, NgModel } from '@angular/forms';
import { MarkdownComponent, provideMarkdown } from 'ngx-markdown';
import { LMarkdownEditorModule } from 'ngx-markdown-editor';

@Component({
  selector: 'app-text-room',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownComponent, LMarkdownEditorModule],
  templateUrl: './text-room.component.html',
  styleUrls: ['./text-room.component.scss'],
  providers: [provideMarkdown()]
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

  editorOptions = {
    autofocus: true, // Auto-focus the editor
    showPreviewPanel: false, // Show the preview panel
    showToolbar: true, // Show the toolbar with buttons like bold, italic, etc.
    toolbarPosition: 'top', // Position of the toolbar (top/bottom)
    showSaveButton: false, // Option to hide the save button
    height: '300px', // Set editor height
    theme: 'dark', // Theme can be light or dark depending on the library
    syntaxHighlighting: true, // Enable syntax highlighting in code blocks
    enableAdvancedFeatures: true // Enable or disable advanced features like tables, strikethrough, etc.
  };
  // TODO: Fix calling fetchMessages multiple times when switching rooms ( the more you switch rooms, the more requests are sent every time )
  ngOnInit(): void {
    // Initialize the route_id and join the text room
    this.paramz = this.route.params.subscribe(params => {
      const newRouteId = +params['room_id'];
      if (this.route_id !== newRouteId) {
        this.route_id = newRouteId;
        console.log("Room id: " + this.route_id);
        this.socketService.joinTextRoom(this.route_id.toString());
        this.fetchMessages();
      }
    });

    // Initialize the room signal
    // this.room = this.serversService.currentRoom;
  }

  ngOnDestroy(): void {
    // Called once, before the instance is destroyed.
    // Add 'implements OnDestroy' to the class.
    this.paramz.unsubscribe(); // Unsubscribe from the route params to prevent memory leaks
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

      // this.scrollToLast();

    } catch (error) {
      this.router.navigate(['server', this.serversService.currentServer().id, 'dashboard']);
      return;
    }
  }

  getFileName(url: string): string {
    return url.split('/').pop() || url;
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

  selectedFiles: any[] = [];

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      this.selectedFiles = Array.from(input.files).map(file => {
        const reader = new FileReader();
        const preview = { name: file.name, type: file.type, file: file, preview: '' };
        reader.onload = (e: any) => {
          preview.preview = e.target.result;
        };
        reader.readAsDataURL(file);
        return preview;
      });
    }
  }

  async sendMessage(isPrivate: boolean = false): Promise<void> {
    if (this.messageText.trim() === '' && this.selectedFiles.length === 0) return;

    const formData = new FormData();
    formData.append('message', this.messageText);
    formData.append('room_id', this.route_id!.toString());
    formData.append('is_private', isPrivate.toString());
    formData.append('user_token', this.authService.userData().token);
    formData.append('reply_to', '0');

    for (let i = 0; i < this.selectedFiles.length; i++) {
      formData.append('attachments', this.selectedFiles[i].file);
    }

    try {
      const response = await axios.post('http://lamzaone.go.ro:8000/api/message', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      this.messageText = '';
      this.selectedFiles = [];
      this.scrollToLast();
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }

  getFileType(fileUrl: string): 'image' | 'video' | 'file' {
    const extension = fileUrl.split('.').pop()?.toLowerCase();
    if (!extension) return 'file';

    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
    const videoExtensions = ['mp4', 'webm', 'ogg'];

    if (imageExtensions.includes(extension)) return 'image';
    if (videoExtensions.includes(extension)) return 'video';
    return 'file';
  }

  isImage(fileUrl: string): boolean {
    return this.getFileType(fileUrl) === 'image';
  }

  isVideo(fileUrl: string): boolean {
    return this.getFileType(fileUrl) === 'video';
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
