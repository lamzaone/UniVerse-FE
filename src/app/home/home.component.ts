import { Component, ElementRef, HostListener, Input, OnInit, ViewChild, effect } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { ServerPageComponent } from '../server-page/server-page.component';
import { SharedServiceService } from '../services/shared-service.service';
import { timer } from 'rxjs';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss']
})
export class HomeComponent implements OnInit {
  @ViewChild('rightSidebar') rightSidebar!: ElementRef;
  @ViewChild('maincontent') maincontent!: ElementRef;
  @ViewChild('leftsidebar') leftsidebar!: ElementRef;
  @ViewChild('container') container!: ElementRef;

  rightSidebarCollapsed = false;
  leftSidebarCollapsed = false;

  constructor(
    private router: Router,
    private authService: AuthService,
    private sharedService: SharedServiceService
  ) {
    effect(() => {
      // Listen for changes in the left sidebar collapsed state from the shared service and update the view
      // LEFT SIDE BAR COLLAPSE
      this.leftSidebarCollapsed = this.sharedService.leftSidebar_isCollapsed();
      this.leftsidebar.nativeElement.classList.toggle('collapsed', this.leftSidebarCollapsed);
      this.updateMainContentWidth();
    })

    // this.toggleRightSidebar();
    // this.adjustSidebarVisibility();
  }

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


  // TODO: FIX SWIPE GESTURE + REMAKE BUTTONS
  @HostListener('document:touchend', ['$event'])
  onTouchEnd(event: TouchEvent) {
    this.touchendX = event.changedTouches[0].screenX;
    // this.handleSwipe();
  }

  toggleRightSidebar() {
    this.rightSidebarCollapsed = !this.rightSidebarCollapsed;
    this.rightSidebar.nativeElement.classList.toggle('collapsed', this.rightSidebarCollapsed);
    this.updateMainContentWidth();
  }

  private adjustSidebarVisibility() {
    if (window.innerWidth >= 768) {
      this.rightSidebarCollapsed = false;
      this.rightSidebar.nativeElement.classList.remove('collapsed');
    } else {
      this.rightSidebarCollapsed = true;
      this.rightSidebar.nativeElement.classList.add('collapsed');
    }
    this.updateMainContentWidth();
  }

  private updateMainContentWidth() {
    const leftWidth = this.leftSidebarCollapsed ? 0 : 70;
    const rightWidth = this.rightSidebarCollapsed ? 0 : 240; // 15rem
    this.maincontent.nativeElement.style.width = `calc(100% - ${leftWidth}px - ${rightWidth}px)`;
  }
}
