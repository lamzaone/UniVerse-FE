import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { RouterLinkActive } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AddServerComponent } from '../add-server/add-server.component';
import { ServersService } from '../../services/servers.service';
import { Observable } from 'rxjs';

@Component({
  selector: 'app-left-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, CommonModule, AddServerComponent],
  templateUrl: './left-sidebar.component.html',
  styleUrls: ['./left-sidebar.component.scss']
})
export class LeftSidebarComponent {
  showAddServer: boolean = false;
  servers$: Observable<any[]>;

  constructor(private serverService: ServersService) {
    this.servers$ = this.serverService.servers$; // subscribe to servers$ observable
  }

  // method for toggling AddServerComponent
  toggleAddServer() {
    this.showAddServer = !this.showAddServer;
  }

  // method to hide AddServerComponent
  closeAddServer() {
    this.showAddServer = false;
  }

  // method to retrieve initials
  getServerInitials(serverName: string) {
    serverName = serverName.trim();
    let nameParts = serverName.split(' ');
    let initials = '';
    for (let i = 0; i < nameParts.length; i++) {
      if (nameParts[i].length > 3 || !isNaN(Number(nameParts[i]))) { // use isNaN to check if the value is Not a Number
        initials += nameParts[i].charAt(0);
      }
    }
    return initials.toUpperCase();
  }
}
