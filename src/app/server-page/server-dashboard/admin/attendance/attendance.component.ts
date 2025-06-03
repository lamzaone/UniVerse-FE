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
    this.http.get<Week[]>(`/api/server/${this.serverId}/weeks`).subscribe((weeks) => {
      this.weeks = weeks;
      if (weeks.length) {
        this.selectedWeek = weeks[0].week_number;
        this.fetchAttendance(weeks[0].week_number);
      }
    });
  }

  fetchAttendance(weekNumber: number) {
    this.selectedWeek = weekNumber;
    this.http
      .get<{ week: number; attendance: AttendanceRecord[] }>(
        `/api/server/${this.serverId}/week/${weekNumber}/attendance`
      )
      .subscribe((data) => {
        this.attendance[weekNumber] = data.attendance;
      });
  }

  exportAttendance() {
    this.http.get(`/api/server/${this.serverId}/attendance/export`, {
      responseType: 'blob',
    }).subscribe((blob) => {
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'attendance.csv';
      anchor.click();
      window.URL.revokeObjectURL(url);
    });
  }
}
