import { Component, effect, OnInit } from '@angular/core';
import { ServersService } from '../../../services/servers.service';
import { UsersService } from '../../../services/users.service';
import { Chart, registerables } from 'chart.js';
import api from '../../../services/api.service';
import { CommonModule } from '@angular/common';


// Define interfaces for type safety
interface Grade {
  assignment_id: string;
  room_id: number;
  grade: number | string;
  date?: string;
}

interface AttendanceSummary {
  [week: string]: {
    present: number;
    absent: number;
    excused: number;
  };
}

interface Assignment {
  assignment_id: string;
  grade: number | string;
  date?: string;
  due_date?: string;
}

interface AssignmentsSummary {
  [room_id: string]: Assignment[];
}

interface ServerOverview {
  server_name: string;
  grades: { [key: string]: Grade };
  attendance_summary: AttendanceSummary;
  assignments_summary: AssignmentsSummary;
}

@Component({
  selector: 'app-student',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './student.component.html',
  styleUrls: ['./student.component.scss']
})
export class StudentComponent implements OnInit {
  grades: { [key: string]: Grade } = {};
  attendances: AttendanceSummary = {};
  current_server = this.serversService.currentServer;
  assignments: AssignmentsSummary = {};
  errorMessage: string | null = null;

  constructor(
    private serversService: ServersService,
    private userService: UsersService,
  ) {
    Chart.register(...registerables);



    effect(() => {
      const server = this.serversService.currentServer();
      const serverId = server?.id;
      (async () => {
        try {
          const response = await api.get<ServerOverview>(`/server/${serverId}/overview`);
          const data = response.data;
          this.grades = data.grades || {};
          this.attendances = data.attendance_summary || {};
          this.assignments = data.assignments_summary || {};
        } catch (err: any) {
          this.errorMessage = err?.response?.data?.detail || 'Failed to load server overview';
          console.error('API error:', err);
        }
      })();
    });
  }

  ngOnInit(): void {
    if (this.current_server()) {
    } else {
      this.errorMessage = 'No server selected';
    }


  }




  getWeeks(): number[] {
    const maxWeeks = 14;
    const existingWeeks = Object.keys(this.attendances).map(week => parseInt(week, 10)).sort((a, b) => a - b);
    const weeks: number[] = [];
    for (let i = 1; i <= maxWeeks; i++) {
      weeks.push(i);
    }
    return weeks;
  }

  getWeekStatus(week: number): string {
    const weekStr = week.toString();
    if (this.attendances[weekStr]) {
      const { present, absent, excused } = this.attendances[weekStr];
      if (present > 0 && absent === 0 && excused === 0) return 'present';
      if (absent > 0 && present === 0 && excused === 0) return 'absent';
      if (excused > 0 && present === 0 && absent === 0) return 'excused';
      return 'missing'; // Fallback if mixed or no clear majority
    }
    return 'missing';
  }
}
