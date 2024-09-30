import { Component, EventEmitter, Output } from '@angular/core';
import { ServersService } from '../../../services/servers.service';
import { FormsModule } from '@angular/forms';
import { NONE_TYPE } from '@angular/compiler';

@Component({
  selector: 'app-create-room',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './create-room.component.html',
  styleUrl: './create-room.component.scss'
})
export class CreateRoomComponent {
  @Output() close = new EventEmitter<void>();
roomTypeOptions = ["Text", "Voice"];
roomType = "text";
roomName="";

  constructor (
    private serverService:ServersService
  ){}

  close_page(){
    this.close.emit();
  }

  createRoom(categoryId: number|null = null){
    console.log("Create Room");
    this.serverService.createRoom(this.serverService.currentServer().id, this.roomName, this.roomType, null);
    this.close_page();
  }
}
