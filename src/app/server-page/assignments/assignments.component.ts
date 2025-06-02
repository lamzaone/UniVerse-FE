
import { SocketService } from '../../services/socket.service';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Component, ElementRef, HostListener, OnInit, ViewChild, signal } from '@angular/core';
import { ServersService } from '../../services/servers.service';
import axios from 'axios';
import { AuthService } from '../../services/auth.service';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';
import { FormsModule, NgModel } from '@angular/forms';
import { MarkdownComponent, provideMarkdown } from 'ngx-markdown';
import { LMarkdownEditorModule } from 'ngx-markdown-editor';
import api from '../../services/api.service';
import { Pipe, PipeTransform } from '@angular/core';


@Pipe({ name: 'truncate' })
export class TruncatePipe implements PipeTransform {
  transform(value: string, limit: number = 50): string {
    return value.length > limit
      ? value.substring(0, limit) + '...'
      : value;
  }
}@Component({
  selector: 'app-assignments',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownComponent, LMarkdownEditorModule],
  templateUrl: './assignments.component.html',
  styleUrl: './assignments.component.scss',
  providers: [provideMarkdown()]
})

export class AssignmentsComponent implements OnInit {
  @ViewChild('messageInput') messageInput!: ElementRef<HTMLTextAreaElement>;
  route_id: number | null = null;
  room = signal<any>(null);
  messages = signal<any>(null);
  messageText = '';
  clickedMessageId: string | null = null; // Store the ID of the clicked message for context menu
  showContextMenu = false;
  isMessage = false;
  serverAccessLevel:number = 0;
  contextMenuPosition: { x: number; y: number } = { x: 0, y: 0 };
  currentUser = this.authService.userData();
  clickedMessage: any = null; // Store the clicked message for context menu
  grade: number = 1; // Default grade value
  paramz:any;
  showGrading: boolean = false; // Flag to show/hide grading options
  private previousRouteId: number | null = null; // Store the previous route_id
  editingMessageId: string | null = null; // Store the ID of the message being edited
  searchQuery: any;
  originalMessages = signal<any[][]>([]);
  selectedUser: any = "All Users"; // Default selected user for filtering
  usersWithoutGrades: any;
  // TODO: ADD MARKDOWN (RICH TEXT EDITOR) SUPPORT
  constructor(
    private socketService: SocketService,
    private route: ActivatedRoute,
    private serversService: ServersService,
    private authService: AuthService,
    private usersService: UsersService,
    private router: Router
  ) {

    const waitForServer = async () => {
      while (!this.serversService.currentServer()) {
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for 100ms
      }
      this.listenForMessages();
      this.serverAccessLevel = this.serversService.currentServer().access_level; // Get the access level from the current server
    };


    waitForServer();
    console.log("current user", this.authService.userData());

  }

  replyingTo: any = null;

  setReplyTo(message: any) {
    this.replyingTo = message;
    console.log("Replying to message:", message);
  }

  cancelReply() {
    this.replyingTo = null;
  }

  getRepliedMessage(replyId: number): string {
    const allMessages = this.messages().flat();
    const original = allMessages.find((m: { _id: number; message: string }) => m._id === replyId);
    return original?.message || '';
  }

  getRepliedUser(replyId: number): any {
    const allMessages = this.messages().flat();
    const original = allMessages.find((m: { _id: number; user: any }) => m._id === replyId);
    return original?.user || null;
  }

  editorOptions = {
    autofocus: true, // Auto-focus the editor
    showPreviewPanel: false, // Show the preview panel
    showToolbar: true, // Show the toolbar with buttons like bold, italic, etc.
    toolbarPosition: 'top', // Position of the toolbar (top/bottom)
    showSaveButton: false, // Option to hide the save button
    height: '300px', // Set editor height
    theme: 'dark', // Theme can be light or dark depending on the library
    showPreviewButton: false, // Show the preview button
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
      const response = await this.serversService.fetchAssignments(this.route_id!);


      const groupedMessages = []; // Array of message groups
      let messageGroup = [];      // Current group of messages

      for (let i = 0; i < response.data.length; i++) {
        const message = response.data[i];
        // Replace newline with <br> for markdown support if the next line is not starting with a space, number, dash, or '`', and exclude code blocks enclosed in triple backticks
        // message.message = message.message.replace(/```[\s\S]*?```|(\r\n|\n|\r)(?![ \d\-`>])/g, (match: string, newline: string) => newline ? '<br>' : match);

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
      this.originalMessages.set(groupedMessages); // Store original for filtering
      this.previousRouteId = 0;
      // Scroll to the last message if necessary
      const lastMessage = document.getElementById('last-message');
      const isLastMessageInView = lastMessage ? lastMessage.getBoundingClientRect().top <= window.innerHeight : false;

      if (isLastMessageInView) this.scrollToLast();

    // Collect users that have grades
    const usersWithGrades = new Set();
    this.messages().flat().forEach((message: any) => {
      if (message.grade && message.grade > 0) {
        usersWithGrades.add(message.user_id);
      }
    });

    // Filter out users that have no grades at all and exclude the current user
    this.usersWithoutGrades = Array.from(
      new Set(
        this.messages()
          .flat()
          .filter((message: any) => !usersWithGrades.has(message.user_id) && message.user_id !== this.authService.userData().id)
          .map((message: any) => message.user)
      )
    );
    console.log("Users without grades:", this.usersWithoutGrades);


      // this.scrollToLast();

    } catch (error) {
      this.router.navigate(['server', this.serversService.currentServer().id, 'dashboard']);
      return;
    }
  }

  getFileName(url: string): string {
    let name = url.split('/').pop() || url;
    name = name.split('_').slice(1).join('_'); // Remove the first part of the name (before the first underscore)
    return name;
  }

  listenForMessages() {
    this.socketService.onTextRoomMessage((data: any) => {
      console.log("Received message from socket:", data);
      if (data === 'room_deleted') {
        this.router.navigate(['server', this.serversService.currentServer().id, 'dashboard']);
        return;
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
    this.messageText = this.messageText.replace(/(\r\n|\n|\r)(?!\n)/g, '\n\n').trim(); // Normalize newlines
    formData.append('message', this.messageText);
    formData.append('room_id', this.route_id!.toString());
    formData.append('is_private', isPrivate.toString());
    formData.append('user_token', this.authService.userData().token);
    formData.append('reply_to', this.replyingTo?._id?.toString() || '0');

    for (let i = 0; i < this.selectedFiles.length; i++) {
      formData.append('attachments', this.selectedFiles[i].file);
    }

    try {
      // replace 1 newline with two newlines
      if (this.editingMessageId !== null) {
        if (this.editingMessageId !== null) {
          formData.append('assignment_id', this.editingMessageId);
          this.editingMessageId = null; // Reset editing message ID after sending
          this.messageText = ''; // Clear the input field
        }
        formData.delete('reply_to'); // Remove reply_to if editing a message
        formData.delete('user_token'); // Remove user_token if editing
        formData.delete('is_private'); // Remove is_private if editing
        await api.put('http://lamzaone.go.ro:8000/api/assignment/edit', formData, {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        });
      } else {
        const response = await api.post('http://lamzaone.go.ro:8000/api/assignment', formData, {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        });
      }

      this.messageText = '';
      this.selectedFiles = [];
      this.scrollToLast();
      if (this.replyingTo) {
        this.replyingTo = null;
      }
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
  handleEnter(event: Event) {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === 'Enter' && !keyboardEvent.shiftKey) {
      keyboardEvent.preventDefault();
      this.sendMessage();
    }
  }

  async gradeAssignment(assignmentId: string, grade: number) {
    try {
      const response = await api.put('http://lamzaone.go.ro:8000/api/assignment/grade', {
        assignment_id: assignmentId,
        room_id: this.route_id,
        grade: grade,
      });

      if (response.status === 200) {
        console.log('Assignment graded successfully:', response.data);
      } else {
        console.error('Failed to grade assignment:', response.data.message);
      }
      this.showGrading = false; // Hide grading options after grading
    } catch (error) {
      console.error('Error grading assignment:', error);
    }
  }

  onRightClick(event: MouseEvent): void {
    event.preventDefault();
    let targetElement = event.target as HTMLElement;

    // Traverse up the DOM tree to check for the parent element with the desired class
    while (targetElement && !targetElement.classList.contains('msg-text-container')) {
      targetElement = targetElement.parentElement as HTMLElement;
    }

    this.isMessage = !!targetElement; // Check if a valid element with the class was found
    if (this.isMessage) {
      this.clickedMessageId = targetElement.getAttribute('message-id');
      this.clickedMessage = this.getMessageById(this.clickedMessageId);
      console.log('Message:', this.clickedMessageId);
    }

    this.contextMenuPosition = { x: event.clientX, y: event.clientY };
    this.showContextMenu = true;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    this.showContextMenu = false;
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscapePress(event: KeyboardEvent): void {
    this.showContextMenu = false;
  }

  getMessageById(messageId: string | null): any {
    const allMessages = this.messages().flat();
    return allMessages.find((m: { _id: string }) => m._id === messageId) || null;
  }

  async editMessage(messageId: string | null): Promise<void> {
    this.editingMessageId = messageId;
    this.messageText = this.clickedMessage?.message || '';
  }

  filterMessages() {
    const searchTerm = this.searchQuery?.toLowerCase().trim();

    if (!searchTerm) {
      this.messages.set(this.originalMessages());
      return;
    }

    const filteredGroups = this.originalMessages().filter(group => {
      return group.some(message =>
        message.user?.name?.toLowerCase().includes(searchTerm)
      );
    });

    // Collect all message IDs from the filtered groups
    const filteredMessageIds = new Set(
      filteredGroups.flat().map(message => message._id)
    );

    // Add messages that have reply_to pointing to a message in the filtered groups
    const additionalMessages = this.originalMessages().flat().filter(message =>
      filteredMessageIds.has(message.reply_to)
    );

    // Merge the filtered groups with the additional messages while maintaining the original order
    const mergedMessages = this.originalMessages().flat().filter(message =>
      filteredMessageIds.has(message._id) || additionalMessages.includes(message)
    );

    // Group the merged messages back into their original structure
    const groupedMessages = [];
    let currentGroup = [];

    for (const message of mergedMessages) {
      if (
        currentGroup.length > 0 &&
        currentGroup[currentGroup.length - 1].user_id !== message.user_id
      ) {
        groupedMessages.push(currentGroup);
        currentGroup = [];
      }
      currentGroup.push(message);
    }

    if (currentGroup.length > 0) {
      groupedMessages.push(currentGroup);
    }

    this.messages.set(groupedMessages);
  }

  clearSearch() {
    this.searchQuery = '';
    this.selectedUser = "All Users"; // Reset selected user
    this.filterMessages();
  }
}
