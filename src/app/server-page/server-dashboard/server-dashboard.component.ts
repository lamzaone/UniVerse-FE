import { Component, Input, Signal, signal} from '@angular/core';
import { ServersService } from '../../services/servers.service';
import { AdminComponent } from './admin/admin.component';
import { AuthGuard } from '../../auth.guard';
import { AuthService } from '../../services/auth.service';
import { StudentComponent } from './student/student.component';

@Component({
  selector: 'app-server-dashboard',
  standalone: true,
  imports: [AdminComponent, StudentComponent],
  templateUrl: './server-dashboard.component.html',
  styleUrl: './server-dashboard.component.scss'
})


export class ServerDashboardComponent {
  server: Signal<any> = this.serversService.currentServer(); // Signal to hold the current server data
  accessLevel: any;
  constructor(private serversService: ServersService,
    private authService:AuthService,
  ) {
    // console.log("ServerDashboardComponent initialized");
    // console.log("Current server:", this.server);
    // console.log("Server service:", this.serversService.currentServer());
    // console.log("Access level:", this.accessLevel);
  }

  private initializeServer(): boolean {
    const currentServer = this.serversService.currentServer();
    if (currentServer && currentServer.access_level !== undefined) {
      this.accessLevel = currentServer.access_level;
      // console.log("current user", this.authService.userData());
      return true; // Initialization successful
    }
    return false; // Not yet initialized
  }

  ngOnInit() {
    const interval = setInterval(() => {
      if (this.initializeServer()) {
        clearInterval(interval); // Stop checking once initialized
      }
    }, 10); // Check every 100ms
  }

  ngOnDestroy(): void {
    //Called once, before the instance is destroyed.
    //Add 'implements OnDestroy' to the class.
  }

}
