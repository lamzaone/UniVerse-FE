import { Injectable, computed, signal, WritableSignal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class SharedServiceService {


  public leftSidebar_isCollapsed: WritableSignal<boolean> = signal(false);
  public rightSidebar_isCollapsed: WritableSignal<boolean> = signal(true)

  constructor() {
  }

  toggleColapsed(){
    this.leftSidebar_isCollapsed.set(!this.leftSidebar_isCollapsed());
  }

  toggleColapsed_right(){
    this.rightSidebar_isCollapsed.set(!this.rightSidebar_isCollapsed());
  }
}
