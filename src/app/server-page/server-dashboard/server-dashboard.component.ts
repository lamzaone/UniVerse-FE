import { Component, Input} from '@angular/core';
import { ServersService } from '../../services/servers.service';

@Component({
  selector: 'app-server-dashboard',
  standalone: true,
  imports: [],
  templateUrl: './server-dashboard.component.html',
  styleUrl: './server-dashboard.component.scss'
})
export class ServerDashboardComponent {
  @Input() server:{} | null = null;

  constructor(private serversService:ServersService){

  }

}
