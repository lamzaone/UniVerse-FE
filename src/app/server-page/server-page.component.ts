import { Component, ElementRef, Signal, ViewChild, effect, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { map, switchMap } from 'rxjs/operators';
import { ServersService } from '../services/servers.service';
import { AuthService } from '../services/auth.service';
import { SocketService } from '../services/socket.service';
import { RoomListComponent } from "./room-list/room-list.component";
import { View } from 'electron';
import { SharedServiceService } from '../services/shared-service.service';

interface Server {
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

  @ViewChild('serverinfo') serverinfo!: ElementRef;
  @ViewChild('maincontent') maincontent!: ElementRef;
  route_id: number | null = null;
  server = signal({} as Server);
  is_collapsed = this.sharedService.leftSidebar_isCollapsed;



  constructor(
    private route: ActivatedRoute,
    private serverService: ServersService,
    private authService: AuthService,
    private socketService: SocketService,
    private sharedService: SharedServiceService
  ) {
    // Listen to route changes and fetch server data
    this.route.params.pipe(
      map(params => params.id),
      switchMap(id => {
        this.route_id = +id;
        return this.serverService.getServer(this.route_id, this.authService.getUser().id);
      })
    ).subscribe({
      next: server => {
        this.server.set(server);  // Update the server details
        this.serverService.setCurrentServer(server);
        // console.log('Server data fetched:', server);  // Log the fetched server data
        this.socketService.joinServer(this.route_id!.toString());  // Connect to the server socket
        this.listenForServerUpdates();  // Start listening for server updates
      },
      error: error => {
        console.error('Error fetching server:', error);  // Handle any errors
      }
    });

    effect(() => {
      this.serverinfo.nativeElement.classList.toggle('collapsed', this.sharedService.leftSidebar_isCollapsed());
    })
  }

  listenForServerUpdates() {
    // Listen for messages from the server socket
    this.socketService.onServerMessage((data: any) => {
      if (data === "server_updated") {
        this.refreshServerData();  // Refresh server data if server is updated
      }
    });
  }

  refreshServerData() {
    if (this.route_id) {
      // Re-fetch server details from the server
      this.serverService.getServer(this.route_id, this.authService.getUser().id).then(server => {
        this.server.set(server);  // Update server data
      }).catch(error => {
        console.error('Error fetching server on update:', error);
      });
    }
  }

  openMenu($event: any) {
    console.log($event);
    // Join text room logic can be added here if needed
  }

  joinRoom(roomId: number) {
    this.socketService.joinTextRoom(roomId.toString());  // Connect to the room socket
  }


  // serverinfoElement = this.serverinfo.nativeElement;
  toggleLeftSidebar(){
    this.sharedService.toggleColapsed();
    this.sharedService.leftSidebar_isCollapsed()? this.maincontent.nativeElement.style.width='100%': this.maincontent.nativeElement.style.width='calc(100% - 70px)'
  }
}
