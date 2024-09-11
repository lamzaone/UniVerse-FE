import { AuthService } from './../../services/auth.service';
import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import axios from 'axios';

@Component({
  selector: 'app-callback',
  templateUrl: './callback.component.html',
  styleUrl: './callback.component.scss'
})
export class CallbackComponent implements OnInit {

  constructor(private authService: AuthService, private router: Router) {}

  ngOnInit() {
    this.handleGoogleCallback();
  }

  private async handleGoogleCallback() {
    const url = window.location.href;
    const idTokenMatch = url.match(/id_token=([^&]*)/);
    const accessTokenMatch = url.match(/access_token=([^&]*)/);
    if (idTokenMatch && accessTokenMatch) {
        const idToken = idTokenMatch[1];
        const accessToken = accessTokenMatch[1];
        console.log('ID Token:', idToken);
        console.log('Access Token:', accessToken);

        try {
            const response = await axios.post('http://79.113.73.5.nip.io:8000/auth/google', { id_token: idToken, access_token: accessToken });
            console.log('Server Response:', response.data);
            this.authService.setUser(response.data);
            localStorage.setItem('jwt_token', response.data.token);
            localStorage.setItem('refresh_token', response.data.refresh_token);
            console.log('jwt_token:', response.data.token);
            this.router.navigate(['/']);
        } catch (error) {
            console.error('Login error:', error);
            this.router.navigate(['/login']);
        }
    } else {
        console.error('No ID token found in the URL');
        this.router.navigate(['/login']);
    }
}

}
