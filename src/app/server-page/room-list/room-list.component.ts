import { Component, HostListener, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { ServersService } from '../../services/servers.service';
import { ActivatedRoute, RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-room-list',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  templateUrl: './room-list.component.html',
  styleUrls: ['./room-list.component.scss']
})
export class RoomListComponent {
  categories = signal<any[]>([]); // Signal to hold categories and rooms

  showContextMenu = false;
  contextMenuPosition = { x: 0, y: 0 };
  uncategorizedRooms: any[] = [];

  constructor(private serversService: ServersService, private route: ActivatedRoute) {
    // Fetch categories and rooms based on the route parameter
    this.route.params.subscribe(params => {
      this.fetchCategoriesAndRooms(params.id);
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

  // Handle drag and drop events
  drop(event: CdkDragDrop<any[]>, categoryId: number | null): void {
    if (event.previousContainer === event.container) {
      // Reorder within the same category
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
      this.reorderRoom(event.container.data[event.currentIndex].id, event.currentIndex);
    } else {
      // Move to a different category
      transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex);
      this.moveRoom(event.container.data[event.currentIndex].id, categoryId, event.currentIndex);
    }
  }

  // Placeholder function for reordering rooms
  reorderRoom(roomId: number, newPosition: number): void {
    console.log('Reordering room with ID', roomId, 'to position', newPosition);
    // Implement logic to reorder room
  }

  // Placeholder function for moving rooms to a different category
  moveRoom(roomId: number, categoryId: number | null, newPosition: number): void {
    console.log('Moving room with ID', roomId, 'to category ID', categoryId, 'at position', newPosition);
    // Implement logic to move room
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
