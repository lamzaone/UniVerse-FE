import { Component, Signal, effect, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ServersService } from '../../../services/servers.service';


@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss'
})


export class AdminComponent {

  server: Signal<any> = this.serverService.currentServer();

  constructor(
    private serverService: ServersService
  ) {
    // Initialize the server data if needed
    this.server = this.serverService.currentServer();

    effect(() => {
      this.server = this.serverService.currentServer();
      // console.log('Server data updated:', this.server);
    });
  }



  ngOnInit() {
    // Any additional setup after component initialization
  }

}
