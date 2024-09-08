import { Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import axios from 'axios';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  // Use Angular signal for user data
  public userData = signal<any>(null);
  private ipcRenderer: any;

  constructor(private router: Router) {
    if (this.isElectron()) {
      this.ipcRenderer = window.require('electron').ipcRenderer;
      this.ipcRenderer.on('google-oauth-success', (event: any, data: any) => {
        this.setUser(data);
        localStorage.setItem('jwt_token', data.token); // Store JWT token
        localStorage.setItem('refresh_token', data.refresh_token); // Store refresh token
        this.router.navigate(['/']); // Navigate to the main application
      });

      this.ipcRenderer.on('google-oauth-error', (event: any, error: any) => {
        console.error('OAuth Error:', error);
      });
    }

    if (localStorage.getItem('jwt_token')) {
      this.checkToken();
    }
  }

  private isElectron(): boolean {
    return !!(window && window.process && window.process.type);
  }

  private async checkToken() {
    const token = localStorage.getItem('jwt_token');
    const refreshToken = localStorage.getItem('refresh_token');

    if (token) {
      try {
        // Validate the token with the backend
        const response = await axios.post('http://localhost:8000/auth/validate', { token });

        // If the token is valid, update the user information
        this.setUser(response.data);
        localStorage.setItem('jwt_token', response.data.token);
        localStorage.setItem('refresh_token', response.data.refresh_token);
        this.router.navigate(['/']); // Navigate to the main application
      } catch (error) {
        console.error('Token validation error:', error);

        if (refreshToken) {
          try {
            // Attempt to refresh the token
            const refreshResponse = await axios.post('http://localhost:8000/auth/refresh', { token: refreshToken });

            // If successful, update the user information and store the new tokens
            this.setUser(refreshResponse.data);
            this.router.navigate(['/']);
            localStorage.setItem('jwt_token', refreshResponse.data.token);
            localStorage.setItem('refresh_token', refreshResponse.data.refresh_token);
          } catch (refreshError) {
            console.error('Token refresh error:', refreshError);
            this.clearUser();
            this.router.navigate(['/login']); // Redirect to login on failure
          }
        } else {
          this.clearUser();
          this.router.navigate(['/login']); // Redirect to login if no refresh token is available
        }
      }
    } else {
      this.clearUser();
      this.router.navigate(['/login']); // Redirect to login if no token is available
    }
  }

  // Set user data using signal
  setUser(data: any) {
    this.userData.set(data);
  }

  // Get user data from signal
  getUser() {
    return this.userData();
  }

  isLoggedIn(): boolean {
    return !!this.userData(); // Check if user is logged in
  }

  // Clear user data and remove tokens
  clearUser() {
    this.userData.set(null);
    localStorage.removeItem('jwt_token'); // Clear JWT token
    localStorage.removeItem('refresh_token'); // Clear refresh token
  }

  loginWithGoogle() {
    if (this.isElectron()) {
      this.ipcRenderer.send('google-oauth-login');
    } else {
      window.location.href = this.getGoogleOAuthUrl();
    }
  }

  logout() {
    this.clearUser();
    this.router.navigate(['/login']); // Redirect to login
  }

  private getGoogleOAuthUrl(): string {
    const clientId = '167769953872-b5rnqtgjtuhvl09g45oid5r9r0lui2d6.apps.googleusercontent.com';
    const redirectUri = encodeURIComponent('http://localhost:4200/auth/callback');
    const scope = encodeURIComponent('openid email profile'); // Correct scopes
    const responseType = 'token id_token';
    return `https://accounts.google.com/o/oauth2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=${responseType}&scope=${scope}`;
  }
}
