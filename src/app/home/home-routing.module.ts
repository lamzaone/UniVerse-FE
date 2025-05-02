import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Routes, RouterModule } from '@angular/router';
import { HomeComponent } from './home.component';
import { AuthGuard } from '../auth.guard';
import { DashboardComponent } from './dashboard/dashboard.component';
import { ServerPageComponent } from '../server-page/server-page.component';
import { TextRoomComponent } from '../server-page/text-room/text-room.component';
import { ServerDashboardComponent } from '../server-page/server-dashboard/server-dashboard.component';

const routes: Routes = [
  {
    path: '',
    canActivate: [AuthGuard],
    component: HomeComponent,
    children: [
      {
        path: '',
        // redirectTo: 'dashboard',
        redirectTo: '/dashboard',
        pathMatch: 'full'
      },
      {
        path: 'dashboard',
        component: DashboardComponent,
        canActivate: [AuthGuard],
      },
      {
        // TODO: TEST IF PEOPLE THAT ARE NOT PART OF THE SERVER CAN ACCESS LINK LEADING TO STUFF IN THE SERVER
        path: 'server/:id',
        component: ServerPageComponent,
        canActivate: [AuthGuard],
        children: [
          {
            path:'',
            redirectTo: 'dashboard',
            pathMatch: 'full'
          },
          {
            path: 'dashboard',
            component: ServerDashboardComponent,
            canActivate: [AuthGuard],
          },
          {
            path: 'text/:room_id',
            component: TextRoomComponent,
            canActivate: [AuthGuard],
          }
        ]
      },

    ]
  }
];

@NgModule({
  declarations: [],
  imports: [
    CommonModule, RouterModule.forChild(routes)
  ],
  exports: [RouterModule]
})
export class HomeRoutingModule {}
