import { Component, OnInit, Signal, signal, computed} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import api from '../../../../services/api.service';
import { ServersService } from '../../../../services/servers.service';
import { log } from 'console';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';


interface AttendanceRecord {
  user_id: number;
  user_name: string;
  status: string;
  date: string;
  attendance_id: number;
  total: number;
}

interface BulkEditPayload {
  updates: { attendance_id: number; status: string }[];
}

interface Week {
  id: number;
  week_number: number;
}

@Component({
  selector: 'app-attendance',
  imports: [FormsModule, CommonModule],
  standalone: true,
  styleUrls: ['./attendance.component.scss'],
  templateUrl: './attendance.component.html',
})
export class AttendanceComponent implements OnInit {
  serverId = this.serversService.currentServer()?.id;
  weeks = signal([] as Week[]);
  attendance: Record<number, AttendanceRecord[]> = {};
  editableAttendance: Record<number, AttendanceRecord[]> = {};
  selectedWeek: number = 0;
  searchQuery = signal('');

  constructor(private serversService: ServersService) {
    if (!this.serverId) {
      const interval = setInterval(() => {
        this.serverId = this.serversService.currentServer()?.id;
        if (this.serverId) {
          clearInterval(interval);
          this.fetchWeeks();
        }
      }, 100);
    }
  }

  ngOnInit(): void {
    this.fetchWeeks();
  }

  filteredAttendance = computed(() => {
    const query = this.searchQuery().toLowerCase();
    return this.editableAttendance[this.selectedWeek]?.filter(record =>
      record.user_name.toLowerCase().includes(query)
    ) || [];
  });

  fetchWeeks() {
    api.get<Week[]>(`http://lamzaone.go.ro:8000/api/server/${this.serverId}/weeks`).then((response) => {
      const weeks = response.data;
      this.weeks.set(weeks);
      if (weeks.length) {
        this.selectedWeek = weeks.length;
        this.fetchAttendance(this.selectedWeek);
      }
    });
  }

  userAttendanceCount: Record<number, number> = {};
  fetchAttendance(weekNumber: number) {
    this.selectedWeek = weekNumber;
    api.get<{ week: number; attendance: AttendanceRecord[] }>(
      `http://lamzaone.go.ro:8000/api/server/${this.serverId}/week/${weekNumber}/attendance`
    ).then((response) => {
      const records = response.data.attendance;
      this.attendance[weekNumber] = records;
      // Deep copy for editable binding
      this.editableAttendance[weekNumber] = records.map(r => ({ ...r }));

      // Add total attendance count for each user
      records.forEach(record => {
        this.userAttendanceCount[record.user_id] = (this.userAttendanceCount[record.user_id] || 0) + 1;
      });

      console.log('Total attendance count per user:', this.userAttendanceCount);
    });
  }

  saveChanges() {
    const updates = this.editableAttendance[this.selectedWeek].map(record => ({
      attendance_id: record.attendance_id,
      status: record.status
    }));

    const payload: BulkEditPayload = { updates };

    api.put(
      `http://lamzaone.go.ro:8000/api/server/${this.serverId}/week/${this.selectedWeek}/attendance/bulk_edit`,
      payload
    ).then(() => {
      alert("Attendance updated successfully!");
      this.fetchAttendance(this.selectedWeek); // Refresh to sync
    }).catch(() => {
      alert("Failed to save changes.");
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
