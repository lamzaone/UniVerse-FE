import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ServerDashboardComponent } from './server-dashboard.component';

describe('ServerDashboardComponent', () => {
  let component: ServerDashboardComponent;
  let fixture: ComponentFixture<ServerDashboardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ServerDashboardComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(ServerDashboardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
