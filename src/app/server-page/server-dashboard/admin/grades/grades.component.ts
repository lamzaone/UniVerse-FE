import { Component, computed, OnInit, Signal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import api from '../../../../services/api.service';
import { ServersService } from '../../../../services/servers.service';

interface GradeEntry {
  assignment_id: string | null;
  room_id: number | null;
  grade: number;
  date: string | null;
}

interface UserGradeGroup {
  user_id: number;
  name?: string; // optional, if you want to display usernames
  grades: GradeEntry[];
  newGrade?: number; // for adding a new manual grade
}


@Component({
  selector: 'app-grades',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrls: ['./grades.component.scss'],
  templateUrl: './grades.component.html',
})
export class GradesComponent implements OnInit {
  serverId = this.serversService.currentServer().id;
  groupedGrades = signal<UserGradeGroup[]>([]);
  expandedUserIds = signal<Set<number>>(new Set());
  searchQuery = signal('');


  constructor(private serversService: ServersService) {}

  ngOnInit(): void {
    this.fetchGrades();
  }

  filteredGrades = computed(() =>
    this.groupedGrades().filter(user =>
      user.name?.toLowerCase().includes(this.searchQuery().toLowerCase())
    )
  );

  saveAllGrades() {
    const serverId = this.serversService.currentServer()?.id;
    if (!serverId) return;

    const bulkPayload = this.groupedGrades().flatMap(userGroup =>
      userGroup.grades.map(grade => ({
        user_id: userGroup.user_id,
        grade: grade.grade,
        date: new Date().toISOString(),
        assignment_id: grade.assignment_id,
        room_id: grade.room_id
      }))
    );

    api.put(`/server/${serverId}/grades/bulk_edit`, { updates: bulkPayload })
      .then(() => alert("All grades updated successfully!"))
      .catch(() => alert("Failed to update grades."));
  }

  fetchGrades() {
    api.get<UserGradeGroup[]>(`/server/${this.serverId}/grades`).then((res) => {
      this.groupedGrades.set(res.data);
    });
  }

  addManualGrade(userGroup: UserGradeGroup) {
    const gradeValue = userGroup.newGrade;
    if (gradeValue == null || isNaN(gradeValue)) {
      alert("Enter a valid number for the grade.");
      return;
    }

    userGroup.grades.push({
      assignment_id: null,
      room_id: null,
      grade: gradeValue,
      date: null, // optional
    });

    userGroup.newGrade = undefined;
  }

  toggleExpand(userId: number) {
    const current = new Set(this.expandedUserIds());
    current.has(userId) ? current.delete(userId) : current.add(userId);
    this.expandedUserIds.set(current);
  }

  isExpanded(userId: number): boolean {
    return this.expandedUserIds().has(userId);
  }



  saveGrades(userGroup: UserGradeGroup) {
    const manualGrades = userGroup.grades.filter(g => !g.assignment_id);
    const assignmentGrades = userGroup.grades.filter(g => g.assignment_id);

    for (const g of manualGrades) {
      if (!g.date) {
      // New grade, use POST
      api.post(`/server/${this.serverId}/admin/grade`, {
        user_id: userGroup.user_id,
        grade: g.grade,
        date: new Date().toISOString(),
      });
      } else {
      // Existing grade, use PUT
      api.put(`/server/${this.serverId}/admin/grade`, {
        user_id: userGroup.user_id,
        grade: g.grade,
        date: g.date,
      });
      }
    }

    for (const g of assignmentGrades) {
      api.put(`/assignment/grade`, {
        assignment_id: g.assignment_id,
        room_id: g.room_id,
        grade: g.grade,
      });
    }

    alert(`Grades for user #${userGroup.user_id} saved.`);
  }
}
