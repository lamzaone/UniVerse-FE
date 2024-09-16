import { Component, ElementRef, HostListener, OnInit, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

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

  leftSidebarCollapsed = false;
  rightSidebarCollapsed = false;

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

  toggleLeftSidebar() {
    this.leftSidebarCollapsed = !this.leftSidebarCollapsed;
    this.leftsidebar.nativeElement.classList.toggle('collapsed', this.leftSidebarCollapsed);
    this.updateMainContentWidth();
  }

  toggleRightSidebar() {
    this.rightSidebarCollapsed = !this.rightSidebarCollapsed;
    this.sidebar.nativeElement.classList.toggle('collapsed', this.rightSidebarCollapsed);
    this.updateMainContentWidth();
  }

  private adjustSidebarVisibility() {
    if (window.innerWidth >= 768) {
      this.sidebar.nativeElement.style.display = 'block';
      this.leftsidebar.nativeElement.style.display = 'block';
    } else {
      this.sidebar.nativeElement.style.display = 'none';
      this.leftsidebar.nativeElement.style.display = 'none';
    }
    this.updateMainContentWidth();
  }

  private updateMainContentWidth() {
    const leftWidth = this.leftSidebarCollapsed ? 0 : 70;
    const rightWidth = this.rightSidebarCollapsed ? 0 : 240; // 15rem
    this.maincontent.nativeElement.style.width = `calc(100% - ${leftWidth}px - ${rightWidth}px)`;
  }

  private handleSwipe() {
    if (this.touchendX < this.touchstartX && this.touchstartX > window.outerWidth - 200) {
      // Swipe left
      this.rightSidebarCollapsed = false;
      this.sidebar.nativeElement.style.display = 'block';
      this.sidebar.nativeElement.classList.remove('collapsed');
    } else if (this.touchstartX > window.outerWidth - 200) {
      // Swipe right
      this.rightSidebarCollapsed = true;
      this.sidebar.nativeElement.classList.add('collapsed');
    } else if (this.touchstartX < 100 && this.touchendX < this.touchstartX) {
      this.leftSidebarCollapsed = true;
      this.leftsidebar.nativeElement.classList.add('collapsed');
    } else if (this.touchstartX < 100 && this.touchendX > this.touchstartX) {
      this.leftSidebarCollapsed = false;
      this.leftsidebar.nativeElement.classList.remove('collapsed');
    }
    this.updateMainContentWidth();
  }
}
