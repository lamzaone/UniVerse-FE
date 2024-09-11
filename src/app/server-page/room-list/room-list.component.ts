import { Component, HostListener, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { ServersService } from '../../services/servers.service';
import { ActivatedRoute, RouterLink, RouterLinkActive } from '@angular/router';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { SocketService } from '../../services/socket.service';
import axios from 'axios';
@Component({
  selector: 'app-room-list',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, DragDropModule],
  templateUrl: './room-list.component.html',
  styleUrls: ['./room-list.component.scss']
})
export class RoomListComponent {
  categories = signal<any[]>([]); // Signal to hold categories and rooms

  showContextMenu = false;
  contextMenuPosition = { x: 0, y: 0 };
  uncategorizedRooms: any[] = [];
  route_id: number | null = null;

  constructor(private serversService: ServersService, private route: ActivatedRoute, private socketService: SocketService) {
    // Fetch categories and rooms based on the route parameter
    this.route.params.subscribe(params => {
      this.route_id = +params.id;
      this.fetchCategoriesAndRooms(this.route_id.toString());
      this.listenToServerUpdates();
    });
  }

  selectRoom(room: {}) {
    this.serversService.setCurrentRoom(room);
  }


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
      transferArrayItem( //TODO: check if the function works without transferArrayItem
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
    await axios.post('http://79.113.73.5.nip.io:8000/room/' + room_id + '/reorder', {
      room_id,
      position,
      category
    });
  }




  createCategory(): void {
    console.log('Create a category');
    this.showContextMenu = false;
    // Implement logic to create a new category here
  }

  createRoom(): void {
    console.log('Create a new room');
    this.showContextMenu = false;
    // Implement logic to create a new room here
  }

  onRightClick(event: MouseEvent): void {
    event.preventDefault();
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

}
