import { Component, computed, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AddServerComponent } from '../add-server/add-server.component';
import { ServersService } from '../../services/servers.service';

@Component({
  selector: 'app-left-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, CommonModule, AddServerComponent],
  templateUrl: './left-sidebar.component.html',
  styleUrls: ['./left-sidebar.component.scss']
})
export class LeftSidebarComponent {
  showAddServer: boolean = false; // Flag to show/hide AddServerComponent

  // Signal to hold servers data from ServersService
  servers = this.serverService.servers;

  constructor(private serverService: ServersService) {}

  // Method for toggling AddServerComponent
  toggleAddServer() {
    this.showAddServer = !this.showAddServer;
  }

  // Method to hide AddServerComponent
  closeAddServer() {
    this.showAddServer = false;
  }

  // Method to retrieve initials from server name
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
