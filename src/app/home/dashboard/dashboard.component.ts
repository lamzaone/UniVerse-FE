import { CommonModule } from '@angular/common';
import { Component, computed } from '@angular/core';
import { SharedModule } from '../../shared/shared.module';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { AddServerComponent } from "../add-server/add-server.component";

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, SharedModule, AddServerComponent],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent {
  user = computed(() => this.authService.getUser());

  constructor(private authService: AuthService, private router: Router) {}

  ngOnInit(): void {
    console.log('HomeComponent INIT');
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
