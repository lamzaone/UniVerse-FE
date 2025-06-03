import { CommonModule } from '@angular/common';
import { Component, computed } from '@angular/core';
import { SharedModule } from '../../shared/shared.module';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { ServersService } from '../../services/servers.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, SharedModule],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent {
  user = computed(() => this.authService.getUser());

  constructor(private authService: AuthService,
      private router: Router,
      private serverService: ServersService) {
        this.serverService.setCurrentServer(null);
      }

  ngOnInit(): void {
    console.log('HomeComponent INIT');
    this.serverService.setCurrentServer(null);
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
