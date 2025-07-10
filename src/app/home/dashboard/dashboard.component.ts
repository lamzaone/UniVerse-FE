import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { SharedModule } from '../../shared/shared.module';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { ServersService } from '../../services/servers.service';
import api from '../../services/api.service';
import { RouterLink } from '@angular/router';
interface Grade {
  assignment_id: string;
  room_id: number;
  grade: number;
  date: string | null;
}

interface Assignment {
  assignment_name: string;
  server_id: number;
  assignment_id: string;
  grade: number | null;
  date: string | null;
  due_date: string | null;
}

interface AttendanceSummary {
  [week: number]: { present: number; absent: number; excused: number };
}

interface ProfessorStats {
  member_count: number;
  ungraded_assignments: number;
}

interface ServerOverview {
  server_id: number;
  server_name: string;
  access_level: number;
  grades: Grade[];
  attendance_summary: AttendanceSummary;
  assignments_summary: { [room_id: number]: Assignment[] };
  professor_stats: ProfessorStats | null;
}

interface User {
  id: number;
  name: string;
  picture: string;
  email: string;
}
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, SharedModule, RouterLink],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent {
  user = signal<User | null>(null);
  servers = signal<ServerOverview[]>([]);
  upcomingDeadlines = computed(() => {
    const now = new Date();
    return this.servers().flatMap(server =>
      Object.values(server.assignments_summary).flatMap(assignments =>
        assignments
          .filter(a => a.due_date && new Date(a.due_date) > now && a.grade === null)
          .map(a => ({
            server_id: server.server_id,
            server_name: server.server_name,
            assignment_name: a.assignment_name,
            assignment_id: a.assignment_id,
            due_date: a.due_date
          }))
      )
      .sort((a, b) => new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime())
      .slice(0, 5)); // Show top 5 upcoming deadlines
  });

  constructor(private authService: AuthService, private serverService: ServersService) {
    // Initialize user
    this.serverService.currentServer.set(null); // Reset current server
    const user = this.authService.getUser();
    this.user.set(user ? {
      id: Number(user.id) || 0,
      name: user.name || 'Unknown',
      picture: user.picture || 'default-avatar.png',
      email: user.email || ''
    } : null);

    // Fetch server overview
    this.fetchOverview();
  }

  async fetchOverview() {
    try {

      const response = await api.get(`/user/overview/`);
      this.servers.set(response.data);
      console.log('Server overview:', this.servers());
    } catch (error) {
      console.error('Error fetching server overview:', error);
    }
  }

  logout() {
    this.authService.logout();
  }

  formatDate(date: string | null): string {
    if (!date) return 'N/A';
    return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  getRole(accessLevel: number): string {
    switch (accessLevel) {
      case 0: return 'Student';
      case 1: return 'Assistant';
      case 2: return 'Professor';
      case 3: return 'Admin';
      default: return 'Unknown';
    }
  }
}
