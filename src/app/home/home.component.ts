import { Component, ElementRef, HostListener, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { isForInitializer } from 'typescript';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss']
})
export class HomeComponent implements OnInit {
  @ViewChild('sidebar') sidebar!: ElementRef;
  @ViewChild('maincontent') maincontent!: ElementRef;
  @ViewChild('leftsidebar') leftsidebar!: ElementRef;
  @ViewChild('container') container!: ElementRef;

  constructor(
    private router: Router,
    private authService: AuthService,
  ) { }

  ngOnInit(): void {
    console.log('HomeComponent INIT');
    this.adjustSidebarVisibility();
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  user = this.authService.getUser();

  private touchstartX = 0;
  private touchendX = 0;

  @HostListener('window:resize')
  onResize() {
    this.adjustSidebarVisibility();
    this.adjustGridLayout()
  }

  @HostListener('document:touchstart', ['$event'])
  onTouchStart(event: TouchEvent) {
    this.touchstartX = event.changedTouches[0].screenX;
  }

  @HostListener('document:touchend', ['$event'])
  onTouchEnd(event: TouchEvent) {
    this.touchendX = event.changedTouches[0].screenX;
    this.handleSwipe();
  }

  private adjustSidebarVisibility() {
    if (window.innerWidth >= 768) {
      this.sidebar.nativeElement.style.display = 'block';
    } else {
      this.sidebar.nativeElement.style.display = 'none';
    }
  }

  private handleSwipe() {
    if (this.touchendX < this.touchstartX && this.touchstartX > window.innerWidth ) {
      // Swipe left
      this.sidebar.nativeElement.style.display = 'block';

    } else if (this.touchstartX > window.outerWidth - 150){
      // Swipe right
      this.sidebar.nativeElement.style.display = 'none';
    } else if (this.touchstartX < window.innerWidth-70 && this.touchendX < this.touchstartX) {
      this.leftsidebar.nativeElement.style.display = 'none';
    } else if (this.touchstartX < window.innerWidth-70 && this.touchendX > this.touchstartX) {
      this.leftsidebar.nativeElement.style.display = 'block';
      this.container.nativeElement.style.gridTemplateColumns ='70px 1fr 15rem';
    }

    this.adjustGridLayout()

  }

  private adjustGridLayout() {
    if (this.leftsidebar.nativeElement.style.display == 'none' && this.sidebar.nativeElement.style.display == 'none'){
      this.container.nativeElement.style.gridTemplateColumns ='1fr';
    } else if (this.leftsidebar.nativeElement.style.display == 'none' ){
      this.container.nativeElement.style.gridTemplateColumns ='1fr 15rem';
      if (this.sidebar.nativeElement.style.display == 'none'){
      }
    } else if (this.sidebar.nativeElement.style.display == 'none'){
      this.container.nativeElement.style.gridTemplateColumns ='70px 1fr';
    } else {
      this.container.nativeElement.style.gridTemplateColumns ='70px 1fr 15rem';
    }
  }
}
