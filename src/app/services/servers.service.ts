import { Injectable } from '@angular/core';
import { AuthService } from './auth.service';
import axios from 'axios';
import { BehaviorSubject, from, Observable } from 'rxjs';
@Injectable({
  providedIn: 'root'
})
export class ServersService {

  private serversSubject: BehaviorSubject<any[]> = new BehaviorSubject<any[]>([]); // BehaviorSubject to hold server data
  public servers$: Observable<any[]> = this.serversSubject.asObservable(); // Observable to expose server data

  constructor(private authService: AuthService) {
    this.fetchServers();
  }

  user = this.authService.getUser();


  createServer(serverName: string, description: string): Observable<any> {
    return from(
      axios.post('http://localhost:8000/server/create', {
        name: serverName,
        description: description,
        owner_id: this.user.id
      })
      .then((createdResponse) => {
        if (createdResponse.status === 200) {
          this.fetchServers();
          return createdResponse.data;
        }
        throw new Error('Server creation failed');
      })
      .catch((error) => {
        console.error('Server creation error:', error);
        throw error;
      })
    );
  }

  fetchServers() {
    from(axios.get('http://localhost:8000/server/user/' + this.user.id))
      .subscribe({
        next: (response) => {
          if (response.status === 200) {
            this.serversSubject.next(response.data);
          } else {
            console.error('Error getting servers for current user');
          }
        },
        error: (error) => {
          console.error('Error fetching servers:', error);
        }
      });
  }

  joinServer(serverCode: string): Observable<any> {
    return from(
      axios.post('http://localhost:8000/server/join', {
        invite_code: serverCode,
        user_id: this.user.id
      })
      .then((response) => {
        if (response.status === 200) {
          this.fetchServers();
          return response.data;
        }
        throw new Error('Joining server failed');
      })
      .catch((error) => {
        console.error('Error joining server with code:', serverCode);
        throw error;
      })
    );
  }

  async getServer(serverId:number, userId:number){
    const response = await axios.post('http://localhost:8000/server', {server_id:serverId, user_id:userId});
    if (response.status === 200){
      return response.data;
    }else{
      console.error('Error getting server with id:', serverId);
    }
  }
}
