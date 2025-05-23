import { Router } from '@angular/router';
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

import { HomeRoutingModule } from './home-routing.module';

import { HomeComponent } from './home.component';
import { SharedModule } from '../shared/shared.module';
import { LeftSidebarComponent } from "./left-sidebar/left-sidebar.component";
import { ConnectionsComponent } from "../connections/connections.component";

@NgModule({
  declarations: [HomeComponent],
  imports: [CommonModule, SharedModule, HomeRoutingModule, LeftSidebarComponent, ConnectionsComponent]
})
export class HomeModule {


}
