import { Injectable, computed, signal, WritableSignal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class SharedServiceService {


  public leftSidebar_isCollapsed: WritableSignal<boolean> = signal(false);


  constructor() {
  }

  toggleColapsed(){
    this.leftSidebar_isCollapsed.set(!this.leftSidebar_isCollapsed());
  }
}
