import { Component, EventEmitter, HostListener, Input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { ServersService } from '../../services/servers.service';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { SocketService } from '../../services/socket.service';
import axios from 'axios';
import { CreateCategoryComponent } from './create-category/create-category.component';
import { CreateRoomComponent } from './create-room/create-room.component';
@Component({
  selector: 'app-room-list',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, DragDropModule, CreateCategoryComponent, CreateRoomComponent],
  templateUrl: './room-list.component.html',
  styleUrls: ['./room-list.component.scss']
})
export class RoomListComponent {
  categories = signal<any[]>([]); // Signal to hold categories and rooms
  @Input() close = new EventEmitter<void>(); // EventEmitter to close the component from parent


  showContextMenu = false;
  showCreateCategory = false;
  showCreateRoom = false;
  contextMenuPosition = { x: 0, y: 0 };
  uncategorizedRooms: any[] = [];
  route_id: number | null = null;

  serverAccessLevel:number = 0;
  isRoom: any;
  isCategory: any;
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

      // TODO: rework getAccessLevel to be stored in the currentServer signal
      this.serversService.getAccessLevel(this.route_id).then((res) => {
        this.serverAccessLevel = res;
        console.log(res);
      });
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
      categories.forEach((category: any) => {
        category.rooms = category.rooms.sort((a: any, b: any) => a.position - b.position);
      });
      this.categories.set(categories); // Update the signal with sorted categories and rooms
    } catch (error) {
      console.error('Error fetching categories and rooms:', error);
    }
  }

  connectedLists() {
    // Create an array of list ids that the drop list can connect to
    return this.categories().map(category => `cdk-drop-list-${category.id}`);
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
    await axios.post('http://lamzaone.go.ro:8000/api/room/' + room_id + '/reorder', {
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
  async deleteRoom(room_id: Number): Promise<void> {
    console.log('Deleted room', room_id);
    console.log(await axios.put('http://lamzaone.go.ro:8000/api/server/' + this.route_id + '/room/' + room_id + '/delete'));
    // navigate to the server page after deletion
    this.router.navigate(['server', this.route_id, 'dashboard']);
    this.showContextMenu = false;
  }

  async deleteCategory(category_id: Number): Promise<void> {
    console.log('Deleted category', category_id);
    console.log(await axios.put('http://lamzaone.go.ro:8000/api/server/' + this.route_id + '/category/' + category_id + '/delete'));
    this.showContextMenu = false;
  }


  onRightClick(event: MouseEvent): void {
    event.preventDefault();
    this.isRoom = (event.target instanceof HTMLElement && event.target.classList.contains('room'));
    this.isCategory = (event.target instanceof HTMLElement && event.target.classList.contains('category'));
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

  getRoomIcon(type: string): string {
    switch (type) {
      case 'text':
        return '#';
      case 'audio':
        return '🔊';
      default:
        return ' ';
    }
  }
}



