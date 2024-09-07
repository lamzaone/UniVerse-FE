import { Component, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ServersService } from '../../services/servers.service';

@Component({
  selector: 'app-add-server',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './add-server.component.html',
  styleUrls: ['./add-server.component.scss']
})
export class AddServerComponent {
  serverName: string = "";
  description: string = "";
  serverCode: string = "";

  @Output() close = new EventEmitter<void>(); // EventEmitter to close the component from parent

  constructor(private router: Router, private serversService: ServersService) {}

  // Emit cancel to close the component form within the parent component
  cancel() {
    this.close.emit();
  }

  // Create a new server using the ServersService and navigate to it
  async addServer() {
    try {
      const response = await this.serversService.createServer(this.serverName, this.description);
      this.router.navigate(['/server/' + response.id]);
      this.close.emit();
    } catch (error) {
      console.error('Error adding server:', error);
    }
  }

  // Join a server using the server code and navigate to it
  async joinServer() {
    try {
      const response = await this.serversService.joinServer(this.serverCode);
      this.router.navigate(['/server/' + response.id]);
      this.close.emit();
    } catch (error) {
      console.error('Error joining server:', error);
    }
  }
}
