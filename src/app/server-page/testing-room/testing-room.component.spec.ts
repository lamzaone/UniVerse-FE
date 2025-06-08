import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TestingRoomComponent } from './testing-room.component';

describe('TestingRoomComponent', () => {
  let component: TestingRoomComponent;
  let fixture: ComponentFixture<TestingRoomComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestingRoomComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(TestingRoomComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
