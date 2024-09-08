import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { map, switchMap } from 'rxjs/operators';
import { ServersService } from '../services/servers.service';
import { AuthService } from '../services/auth.service';
import { SocketService } from '../services/socket.service';
import { RoomListComponent } from "./room-list/room-list.component";

interface Server{
  id: number;
  name: string;
  description: string;
  owner_id: number;
  invite_code: string;
}

@Component({
  selector: 'app-server-page',
  standalone: true,
  imports: [RouterModule, RoomListComponent],
  templateUrl: './server-page.component.html',
  styleUrls: ['./server-page.component.scss']
})

export class ServerPageComponent {

  route_id: number | null = null;
  server = signal({} as Server);

  constructor(
    private route: ActivatedRoute,
    private serverService: ServersService,
    private authService: AuthService,
    private socketService: SocketService
  ) {
    this.route.params.pipe(
      map(params => params.id),
      switchMap(id => {
        this.route_id = +id;
        return this.serverService.getServer(this.route_id, this.authService.getUser().id);
      })
    ).subscribe({
      next: server => {
        this.server.set(server);  // Update the server details
        this.socketService.joinServer(this.route_id!.toString());  // Connect to the server socket
      },
      error: error => {
        console.error('Error fetching server:', error);  // Handle any errors
      }
    });
  }

  openMenu($event: any) {
    console.log($event);
    // Join text room logic can be added here if needed
  }

  joinRoom(roomId: number) {
    this.socketService.joinTextRoom(roomId.toString());  // Connect to the room socket
  }
}
