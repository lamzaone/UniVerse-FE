import { Component, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { ServersService } from '../../services/servers.service';
import { Observable, BehaviorSubject } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs/operators';
import { DragDropModule } from '@angular/cdk/drag-drop';

@Component({
  selector: 'app-room-list',
  standalone: true,
  imports: [CommonModule, DragDropModule],
  templateUrl: './room-list.component.html',
  styleUrls: ['./room-list.component.scss'],
})
export class RoomListComponent {
  public categoriesSubject: BehaviorSubject<any[]> = new BehaviorSubject<any[]>([]);
  public categories$: Observable<any[]> = this.categoriesSubject.asObservable();

  showContextMenu = false;
  contextMenuPosition = { x: 0, y: 0 };
  uncategorizedRooms: any[] = [];

  constructor(private serversService: ServersService, private route:ActivatedRoute) {
    this.loadCategoriesAndRooms();
  }

  loadCategoriesAndRooms(): void {
    this.categories$ = this.serversService.categories$.pipe(
      tap((categories) => {
        this.categoriesSubject.next(categories);
      })
    );

    let id = this.route.params.pipe(
      map((params: any) => params.id)
    );
    id.subscribe((value) => {
      this.serversService.fetchCategoriesAndRooms(value);
    });
  }

  ngOnInit(): void {
    this.loadCategoriesAndRooms();
  }

  drop(event: CdkDragDrop<any[]>, categoryId: number | null): void {
    const previousContainerData = event.previousContainer.data;
    const containerData = event.container.data;

    if (!previousContainerData || !containerData) {
      console.error('Invalid drag and drop data', event);
      return; // Ensure both are defined
    }

    if (event.previousContainer === event.container) {
      // Reorder within the same category
      moveItemInArray(containerData, event.previousIndex, event.currentIndex);
      this.updateRoomPositions(containerData, categoryId); // Update room positions after reorder
    } else {
      // Move to a different category
      transferArrayItem(previousContainerData, containerData, event.previousIndex, event.currentIndex);
      this.updateRoomPositions(containerData, categoryId); // Update room positions after moving to a different category
    }
  }

  updateRoomPositions(rooms: any[], categoryId: number | null): void {
    rooms.forEach((room, index) => {
      if (room.category_id === categoryId) {
        room.position = index; // Ensure index is set correctly for its category
        this.moveRoom(room.id, categoryId, index); // Call backend to update the room position
      }
    });
  }

  reorderRoom(roomId: number, newPosition: number) {
    this.serversService.reorderRoom(roomId, newPosition).subscribe(() => {
      console.log(`Room ${roomId} reordered to position ${newPosition}`);
    });
  }

  moveRoom(roomId: number, newCategoryId: number | null, newPosition: number) {
    this.serversService.moveRoom(roomId, newCategoryId, newPosition).subscribe(() => {
      console.log(`Room ${roomId} moved to category ${newCategoryId} at position ${newPosition}`);
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
