import { Component } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { map } from 'rxjs/operators';
import { ServersService } from '../services/servers.service';
import { AuthService } from '../services/auth.service';
import { switchMap } from 'rxjs/operators';


@Component({
  selector: 'app-server-page',
  standalone: true,
  imports: [RouterModule],
  templateUrl: './server-page.component.html',
  styleUrls: ['./server-page.component.scss']
})
export class ServerPageComponent {
  route_id:number | null = null;
  server:any = null;

  constructor(
    private route: ActivatedRoute,
    private serverService: ServersService,
    private authService: AuthService,
    private router: Router
  ) {
    this.route.params.pipe(
      map(params => params.id),
      switchMap(id => {
        this.route_id = +id;  // Ensure that `id` is treated as a number
        // Fetch the server details asynchronously
        return this.serverService.getServer(this.route_id, this.authService.getUser().id);
      })
    ).subscribe(
      server => {
        this.server = server;  // Update the server data when available
        console.log(this.server);  // Log the server to see the fetched data
      },
      error => {
        console.error('Error fetching server:', error);  // Handle any errors
      }
    );
  }
}
