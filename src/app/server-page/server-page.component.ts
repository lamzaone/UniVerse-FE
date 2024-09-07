import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { map } from 'rxjs/operators';
import { ServersService } from '../services/servers.service';
import { AuthService } from '../services/auth.service';
import { switchMap } from 'rxjs/operators';
import { RoomListComponent } from "./room-list/room-list.component";


@Component({
  selector: 'app-server-page',
  standalone: true,
  imports: [RouterModule, RoomListComponent],
  templateUrl: './server-page.component.html',
  styleUrls: ['./server-page.component.scss']
})
export class ServerPageComponent {
  route_id:number | null = null;
  server = signal([]);

  constructor(
    private route: ActivatedRoute,
    private serverService: ServersService,
    private authService: AuthService
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
      },
      error: error => {
        console.error('Error fetching server:', error);  // Handle any errors
      }
    });
  }

  openMenu($event:any) {
    console.log($event);

  }
}
