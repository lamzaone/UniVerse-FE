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

  @Output() close = new EventEmitter<void>();

  constructor(private router: Router, private serversService: ServersService) {}

  // emit cancel to close the component form within the parent component
  cancel() {
    this.close.emit();
  }

  // create a new server observable
  addServer() {
    this.serversService.createServer(this.serverName, this.description).subscribe((response) => {
      this.router.navigate(['/server/' + response.id]);
      this.close.emit();
    });
  }

  // join a server observable
  joinServer() {
    this.serversService.joinServer(this.serverCode).subscribe((response) => {
      this.router.navigate(['/server/' + response.id]);
      this.close.emit();
    });
  }
}
