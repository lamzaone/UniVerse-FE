import { Component, EventEmitter, Input, Output } from '@angular/core';
import { ServersService } from '../../../services/servers.service';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-create-assignment',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './create-assignment.component.html',
  styleUrl: './create-assignment.component.scss'
})
export class CreateAssignmentComponent {
  @Output() close = new EventEmitter<void>();
  @Input() categoryId: number|null = null;
  dueDate: Date = new Date(); // Default to today
  dueTime: string = '00:00';
  roomName="";

  constructor (
    private serverService:ServersService
  ){}

  close_page(){
    this.close.emit();
  }

  createRoom(){
    console.log("Create Assignment");
    const formattedDueDate = (this.dueDate instanceof Date ? this.dueDate : new Date(this.dueDate)).toISOString().split('T')[0]; // Format as YYYY-MM-DD
    const formattedDueTime = this.dueTime; // Assuming dueTime is already in HH:mm format
    this.serverService.createRoom(this.serverService.currentServer().id, this.roomName, `assignments+${formattedDueDate}+${formattedDueTime}`, this.categoryId);
    this.close_page();
  }
}
