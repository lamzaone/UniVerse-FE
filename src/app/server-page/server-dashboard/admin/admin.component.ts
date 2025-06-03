import { Component, Signal, effect, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ServersService } from '../../../services/servers.service';
import api from '../../../services/api.service';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss'
})


export class AdminComponent {

  server = signal<any>({});
  server_id:number = 0;
  weeks: Array<any> = [];

  constructor(
    private serverService: ServersService
  ) {
    // Initialize the server data if needed
    this.server = this.serverService.currentServer();

    effect(() => {
      this.server = this.serverService.currentServer();
      // console.log('Server data updated:', this.server);
      this.server_id = this.serverService.currentServer().id;
      this.weeks = this.serverService.currentServer().weeks || [];
    });
  }



  ngOnInit() {
    // Any additional setup after component initialization
  }


  async startNewWeek() {
    try {
      await api.post('http://lamzaone.go.ro:8000/api/server/' + this.server_id + '/weeks/create', {});


    } catch (error) {
      console.error('Error starting new week:', error);

    }

  }

}
