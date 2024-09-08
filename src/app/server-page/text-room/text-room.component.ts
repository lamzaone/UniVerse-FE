import { SocketService } from '../../services/socket.service';
import { ActivatedRoute } from '@angular/router';
import { Component, OnInit } from '@angular/core'; // Add the missing import statement

@Component({
  selector: 'app-text-room',
  standalone: true,
  imports: [],
  templateUrl: './text-room.component.html',
  styleUrl: './text-room.component.scss'
})
export class TextRoomComponent implements OnInit { // Implement the OnInit interface
  route_id: number | null = null;


  constructor(
    private socketService: SocketService,
    private route: ActivatedRoute,
    ) {
      this.route.params.subscribe(params => {
        this.route_id = +params.room_id;
        this.socketService.joinTextRoom(this.route_id!.toString());
      });
    }

  ngOnInit(): void { // Add the ngOnInit method
    // Add any initialization logic here
  }

}
