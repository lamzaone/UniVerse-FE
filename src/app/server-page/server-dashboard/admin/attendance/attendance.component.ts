import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import api from '../../../../services/api.service';
interface AttendanceRecord {
  user_id: number;
  status: string;
  date: string;
}

interface Week {
  id: number;
  week_number: number;
}

@Component({
  selector: 'app-attendance',
  templateUrl: './attendance.component.html',
})
export class AttendanceComponent implements OnInit {
  serverId = 1; // Replace with dynamic source
  weeks: Week[] = [];
  attendance: Record<number, AttendanceRecord[]> = {};
  selectedWeek: number = 0;

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.fetchWeeks();
  }

  fetchWeeks() {
    api.get<Week[]>(`http://lamzaone.go.ro:8000/api/server/${this.serverId}/weeks`).then((response) => {
      const weeks: Week[] = response.data;
      this.weeks = weeks;
      if (weeks.length) {
        this.selectedWeek = weeks[0].week_number;
        this.fetchAttendance(weeks[0].week_number);
      }
    });
  }

  fetchAttendance(weekNumber: number) {
    this.selectedWeek = weekNumber;
    api.get<{ week: number; attendance: AttendanceRecord[] }>(
        `http://lamzaone.go.ro:8000/api/server/${this.serverId}/week/${weekNumber}/attendance`
      )
      .then((response) => {
        const data: { week: number; attendance: AttendanceRecord[] } = response.data;
        this.attendance[weekNumber] = data.attendance;
      });
  }

  exportAttendance() {
    api.get(`http://lamzaone.go.ro:8000/api/server/${this.serverId}/attendance/export`, {
      responseType: 'blob',
    }).then((response) => {
      const blob: Blob = response.data;
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'attendance.csv';
      anchor.click();
      window.URL.revokeObjectURL(url);
    });
  }
}
