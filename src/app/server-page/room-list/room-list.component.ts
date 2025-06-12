import { Component, EventEmitter, HostListener, Input, computed, effect, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { ServersService } from '../../services/servers.service';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { SocketService } from '../../services/socket.service';
import axios from 'axios';
import { CreateCategoryComponent } from './create-category/create-category.component';
import { CreateRoomComponent } from './create-room/create-room.component';
import { CreateAssignmentComponent } from './create-assignment/create-assignment.component';
import api from '../../services/api.service';
@Component({
  selector: 'app-room-list',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, DragDropModule, CreateCategoryComponent, CreateRoomComponent, CreateAssignmentComponent],
  templateUrl: './room-list.component.html',
  styleUrls: ['./room-list.component.scss']
})
export class RoomListComponent {
  categories = signal<any[]>([]); // Signal to hold categories and rooms
  @Input() close = new EventEmitter<void>(); // EventEmitter to close the component from parent


  showContextMenu = false;
  showCreateCategory = false;
  showCreateAssignment = false;
  showCreateRoom = false;
  contextMenuPosition = { x: 0, y: 0 };
  uncategorizedRooms: any[] = [];
  route_id: number | null = null;

  serverAccessLevel:number = 0;
  isRoom: any;
  isCategory: any;
  isAssignments: any;
  clickedRoomId:any;
  clickedCategoryId:any;
  clickedCategoryLength:any;


  constructor(private serversService: ServersService,
    private route: ActivatedRoute,
    private router: Router,
    private socketService: SocketService,
    ) {
    // Fetch categories and rooms based on the route parameter
    this.route.params.subscribe(params => {
      this.route_id = +params.id;
      this.fetchCategoriesAndRooms(this.route_id.toString());

    });

    effect(() => {
      const currentServer = this.serversService.currentServer;
      if (currentServer) {
        this.serverAccessLevel = currentServer().access_level;
        console.log('Current server access level:', this.serverAccessLevel);
      }
    });

    this.listenToServerUpdates();
  }

  // selectRoom(room: {}) {
  //   this.serversService.setCurrentRoom(room);
  // }

  listenToServerUpdates() {
    // Listen for server updates
    this.socketService.onServerMessage((data: any) => {
      if (data === 'rooms_updated') {
        this.fetchCategoriesAndRooms(this.route_id!.toString());
      }
    });
  }

  // Fetch categories and rooms and update the signal
  async fetchCategoriesAndRooms(serverId: string) {
    try {
      const categories = await this.serversService.fetchCategoriesAndRooms(+serverId);
      categories.sort((a: any, b: any) => {
        if (a.category_type === 'Assignments' && b.category_type !== 'Assignments') {
          return -1;
        }
        if (a.category_type !== 'Assignments' && b.category_type === 'Assignments') {
          return 1;
        }
        return 0;
      });
      console.log('Fetched categories:', categories);
      categories.forEach((category: any) => {
        const assignments = category.rooms
          .filter((room: any) => typeof room.type === 'string' && room.type.split(' ')[0] === 'assignments')
          .sort((a: any, b: any) => a.position - b.position);
        if (assignments.length > 0) {
          category.assignments = assignments;
        }
        category.rooms = category.rooms
          .filter((room: any) => typeof room.type === 'string' && room.type.split(' ')[0] !== 'assignments')
          .sort((a: any, b: any) => a.position - b.position);
      });
      this.categories.set(categories); // Update the signal with sorted categories and rooms
      console.log('Fetched categories and rooms:', this.categories());
    } catch (error) {
      console.error('Error fetching categories and rooms:', error);
    }
  }

  connectedLists() {
    // Create an array of list ids that the drop list can connect to, excluding categories with type 'assignment'
    return this.categories()
      .filter(category => category.category_type !== 'Assignments')
      .map(category => `cdk-drop-list-${category.id}`)
  }


  drop(event: CdkDragDrop<any[]>, targetCategoryId: number | null): void {
    if (event.previousContainer === event.container) {
      // Reorder within the same category
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
      this.reorderRoom(event.container.data[event.currentIndex].id, event.currentIndex, targetCategoryId );
    } else {
      // Move to a different category
      transferArrayItem(
          event.previousContainer.data,
        event.container.data,
        event.previousIndex,
        event.currentIndex
      );
      // this.moveRoom(
      this.reorderRoom(
        event.container.data[event.currentIndex].id,     // Room ID
        event.currentIndex,                             // New Position
        targetCategoryId                               // New Category ID
      );
    }
  }

  // Function for reordering rooms within the same category
  async reorderRoom(room_id: number, position: number, category: number | null) {
    // console.log('Reordering room with ID', room_id, 'to position', position);
    await api.post('http://lamzaone.go.ro:8000/api/room/' + room_id + '/reorder', {
      room_id,
      position,
      category
    });
  }


//////////////////////////////////////////////////////
//////////////////// Context Menu ////////////////////
//////////////////////////////////////////////////////

  createCategory(): void {
    console.log('Create a category');
    this.showContextMenu = false;
    this.toggleCreateCategory();
    // Implement logic to create a new category here
  }
  createRoom(): void {
    console.log('Create a new room');
    this.showContextMenu = false;
    this.toggleCreateRoom();
  }

  createAssignment(): void {
    console.log('Create a new assignment');
    this.showContextMenu = false;
    this.toggleCreateAssignment();
  }

  async deleteRoom(room_id: Number): Promise<void> {
    console.log('Deleted room', room_id);
    console.log(await api.put('http://lamzaone.go.ro:8000/api/server/' + this.route_id + '/room/' + room_id + '/delete'));
    // navigate to the server page after deletion
    this.router.navigate(['server', this.route_id, 'dashboard']);
    this.showContextMenu = false;
  }

  async deleteCategory(category_id: Number): Promise<void> {
    console.log('Deleted category', category_id);
    console.log(await api.put('http://lamzaone.go.ro:8000/api/server/' + this.route_id + '/category/' + category_id + '/delete'));
    this.showContextMenu = false;
  }


  onRightClick(event: MouseEvent): void {
    event.preventDefault();
    this.isRoom = (event.target instanceof HTMLElement && event.target.classList.contains('room'));
    this.isCategory = (event.target instanceof HTMLElement && event.target.classList.contains('category'));
    this.isAssignments = (event.target instanceof HTMLElement && event.target.classList.contains('Assignments'));
    if (this.isRoom) {
      this.clickedRoomId = (event.target as HTMLElement).getAttribute('room-id');
    }
    else if (this.isCategory){
      this.clickedCategoryId= (event.target as HTMLElement).getAttribute('category-id');
      this.clickedCategoryLength= (event.target as HTMLElement).getAttribute('categoryLength');
    }
    console.log(this.isRoom);
    console.log(this.isCategory);
    console.log(this.clickedCategoryLength);
    console.log(this.clickedRoomId);
    console.log(this.clickedCategoryId);

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

  toggleCreateCategory() {
    this.showCreateCategory = !this.showCreateCategory;
  }

  toggleCreateRoom() {
    this.showCreateRoom = !this.showCreateRoom;
  }

  toggleCreateAssignment() {
    this.showCreateAssignment = !this.showCreateAssignment;
  }

  getRoomIcon(type: string): string {
    switch (type.split(' ')[0]) {
      case 'text':
        return '#';
      case 'audio':
        return '🔊';
      case 'assignments':
        return '📚';
      case 'test':
        return '📝';
      default:
        return ' ';
    }
  }

}



