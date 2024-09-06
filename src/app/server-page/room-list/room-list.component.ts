import { Component, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { ServersService } from '../../services/servers.service';
import { Observable, BehaviorSubject } from 'rxjs';
import { filter, tap } from 'rxjs/operators';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs/operators';

@Component({
  selector: 'app-room-list',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './room-list.component.html',
  styleUrl: './room-list.component.scss'
})
export class RoomListComponent {
  categories$:Observable<any> = new Observable<any>();

  constructor(private serversService:ServersService,
    private route:ActivatedRoute){
      this.route.params.subscribe(params => {
        this.categories$ = this.serversService.fetchCategoriesAndRooms(params.id).pipe(filter((categories: any[]) => {
          categories.forEach((category: any) => {
            category.rooms = category.rooms.sort((a: any, b: any) => a.position - b.position);
          });
          return true;
        }));
    });
  }

  showContextMenu = false;
  contextMenuPosition = { x: 0, y: 0 };
  uncategorizedRooms: any[] = [];


  // drop(event: CdkDragDrop<any[]>, categoryId: number | null): void {
  //   if (event.previousContainer === event.container) {
  //     // Reorder within the same category
  //     moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
  //     this.reorderRoom(event.container.data[event.currentIndex].id, event.currentIndex);
  //   } else {
  //     // Move to a different category
  //     transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex);
  //     this.moveRoom(event.container.data[event.currentIndex].id, categoryId, event.currentIndex);
  //   }
  // }


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
