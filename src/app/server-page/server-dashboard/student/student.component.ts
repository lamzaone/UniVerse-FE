import { Component, OnInit } from '@angular/core';
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
  assignments: AssignmentsSummary = {};
  current_server: { id: number; name: string } | null = null;
  errorMessage: string | null = null;

  constructor(
    private serversService: ServersService,
    private userService: UsersService,
  ) {
    Chart.register(...registerables);
  }

  ngOnInit(): void {
    this.current_server = this.serversService.currentServer();
    if (this.current_server) {
      this.fetchServerOverview();
    } else {
      this.errorMessage = 'No server selected';
    }
  }

  private fetchServerOverview(): void {
    const serverId = this.current_server?.id;


    (async () => {
      try {
        const response = await api.get<ServerOverview>(`/server/${serverId}/overview`);
        const data = response.data;
        this.grades = data.grades || {};
        this.attendances = data.attendance_summary || {};
        this.assignments = data.assignments_summary || {};
        this.renderAttendanceChart();
      } catch (err: any) {
        this.errorMessage = err?.response?.data?.detail || 'Failed to load server overview';
        console.error('API error:', err);
      }
    })();
  }

  private renderAttendanceChart(): void {
    const ctx = document.getElementById('attendanceChart') as HTMLCanvasElement;
    if (!ctx) {
      console.error('Canvas element not found');
      return;
    }

    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: Object.keys(this.attendances).map(week => `Week ${week}`),
        datasets: [
          {
            label: 'Present',
            data: Object.values(this.attendances).map((week: any) => week.present || 0),
            backgroundColor: '#10b981',
            borderColor: '#059669',
            borderWidth: 1
          },
          {
            label: 'Absent',
            data: Object.values(this.attendances).map((week: any) => week.absent || 0),
            backgroundColor: '#ef4444',
            borderColor: '#dc2626',
            borderWidth: 1
          },
          {
            label: 'Excused',
            data: Object.values(this.attendances).map((week: any) => week.excused || 0),
            backgroundColor: '#f59e0b',
            borderColor: '#d97706',
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            stacked: true,
            title: { display: true, text: 'Week' }
          },
          y: {
            stacked: true,
            beginAtZero: true,
            title: { display: true, text: 'Count' }
          }
        },
        plugins: {
          legend: { position: 'top' }
        }
      }
    });
  }
}
